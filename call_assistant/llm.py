"""Claude API access, cost estimate and an offline fake model for tests/demo."""

from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import dataclass, field
from typing import Any, Protocol

from .config import DEFAULT_PRICING

log = logging.getLogger(__name__)

# Models that support server-side refusal fallbacks (fallbacks="default").
FALLBACK_MODELS = {"claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"}
FALLBACK_BETA = "server-side-fallback-2026-07-01"
HAIKU_LONG_PROMPT_TOKENS = 100_000  # Haiku 5.5 bills prompts above this at a higher rate


class LLMError(RuntimeError):
    """An error with a message that can be shown to the user."""


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0

    @classmethod
    def from_api(cls, usage: Any) -> "Usage":
        return cls(
            input_tokens=getattr(usage, "input_tokens", 0) or 0,
            output_tokens=getattr(usage, "output_tokens", 0) or 0,
            cache_creation_input_tokens=getattr(usage, "cache_creation_input_tokens", 0) or 0,
            cache_read_input_tokens=getattr(usage, "cache_read_input_tokens", 0) or 0,
        )

    @property
    def prompt_tokens(self) -> int:
        return self.input_tokens + self.cache_creation_input_tokens + self.cache_read_input_tokens


def estimate_cost(model: str, usage: Usage, pricing: dict[str, dict[str, float]] | None = None) -> float:
    """Estimated USD cost of one request."""
    table = pricing or DEFAULT_PRICING
    price = table.get(model)
    if price is None:
        # Unknown model id (e.g. a dated snapshot): use the closest family price.
        family = next((k for k in table if k.split("-")[1] in model), None)
        price = table.get(family) if family else None
    if price is None:
        return 0.0
    factor = 1.0
    if model.startswith("claude-haiku-5") and usage.prompt_tokens > HAIKU_LONG_PROMPT_TOKENS:
        factor = 5.0  # $0.50 / $2.50 rate card for long prompts
    return factor * (
        usage.input_tokens * price["input"]
        + usage.output_tokens * price["output"]
        + usage.cache_creation_input_tokens * price.get("cache_write", price["input"] * 1.25)
        + usage.cache_read_input_tokens * price.get("cache_read", price["input"] * 0.1)
    ) / 1_000_000


@dataclass
class CostTracker:
    pricing: dict[str, dict[str, float]] | None = None
    by_purpose: dict[str, float] = field(default_factory=dict)
    calls: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def add(self, purpose: str, model: str, usage: Usage) -> float:
        cost = estimate_cost(model, usage, self.pricing)
        with self._lock:
            self.by_purpose[purpose] = self.by_purpose.get(purpose, 0.0) + cost
            self.calls += 1
        return cost

    @property
    def total(self) -> float:
        with self._lock:
            return sum(self.by_purpose.values())


@dataclass
class JsonReply:
    data: dict[str, Any]
    usage: Usage
    model: str


class LLM(Protocol):
    def complete_json(
        self,
        *,
        purpose: str,
        model: str,
        system: str,
        user: str,
        schema: dict[str, Any],
        max_tokens: int,
        effort: str,
        timeout: float,
        cache_system: bool = True,
    ) -> JsonReply: ...


def api_key_available() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


class ClaudeClient:
    """Thin wrapper around the official ``anthropic`` SDK.

    * The system prompt (instructions + personal memory) is identical for every
      live update, so it is marked for prompt caching: after the first request
      it is billed at a fraction of the price. One-off requests (the final
      summary) skip caching, which would only add the cache-write premium.
    * Replies use structured outputs (a JSON schema), so they always parse.
    """

    def __init__(self, client: Any = None, max_retries: int = 2):
        if client is None:
            import anthropic

            if not api_key_available():
                raise LLMError("ANTHROPIC_API_KEY is not set")
            client = anthropic.Anthropic(max_retries=max_retries)
        self._client = client

    def complete_json(
        self,
        *,
        purpose: str,
        model: str,
        system: str,
        user: str,
        schema: dict[str, Any],
        max_tokens: int,
        effort: str,
        timeout: float,
        cache_system: bool = True,
    ) -> JsonReply:
        import anthropic

        system_block: dict[str, Any] = {"type": "text", "text": system}
        if cache_system:
            system_block["cache_control"] = {"type": "ephemeral"}
        params: dict[str, Any] = dict(
            model=model,
            max_tokens=max_tokens,
            system=[system_block],
            messages=[{"role": "user", "content": user}],
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
        )
        client = self._client.with_options(timeout=timeout)
        try:
            if model in FALLBACK_MODELS:
                # If a safety classifier declines, the API retries on a fallback model.
                response = client.beta.messages.create(betas=[FALLBACK_BETA], fallbacks="default", **params)
            else:
                response = client.messages.create(**params)
        except anthropic.AuthenticationError as exc:
            raise LLMError("API key not valid (401)") from exc
        except anthropic.PermissionDeniedError as exc:
            raise LLMError("API key without access to this model (403)") from exc
        except anthropic.NotFoundError as exc:
            raise LLMError(f"model {model!r} not found (404)") from exc
        except anthropic.RateLimitError as exc:
            raise LLMError("rate limit reached, retrying at the next update") from exc
        except anthropic.BadRequestError as exc:
            message = getattr(exc, "message", str(exc))
            if "credit balance" in message.lower():
                raise LLMError("API credit balance too low (console.anthropic.com → Billing)") from exc
            raise LLMError(f"request rejected: {message}") from exc
        except anthropic.APIStatusError as exc:
            raise LLMError(f"Claude API error {exc.status_code}") from exc
        except anthropic.APITimeoutError as exc:
            raise LLMError("Claude did not answer in time") from exc
        except anthropic.APIConnectionError as exc:
            raise LLMError("no connection to the Claude API") from exc

        usage = Usage.from_api(response.usage)
        served = getattr(response, "model", None) or model
        if response.stop_reason == "refusal":
            raise LLMError("Claude declined this request")
        if response.stop_reason == "max_tokens":
            raise LLMError("reply too long (max_tokens reached)")
        text = "".join(b.text for b in response.content if getattr(b, "type", "") == "text")
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            log.error("Unparseable reply (%s): %r", purpose, text[:500])
            raise LLMError("unreadable reply from Claude") from exc
        log.info(
            "%s via %s: in=%d cache_write=%d cache_read=%d out=%d",
            purpose,
            served,
            usage.input_tokens,
            usage.cache_creation_input_tokens,
            usage.cache_read_input_tokens,
            usage.output_tokens,
        )
        return JsonReply(data, usage, served)


class FakeClaude:
    """Offline stand-in used by the demo (``--fake-llm``) and the tests.

    Builds plausible answers from the transcript text so the whole app can be
    exercised without an API key or network access.
    """

    def __init__(self, fail_with: str | None = None):
        self.requests: list[dict[str, Any]] = []
        self.fail_with = fail_with

    def complete_json(
        self, *, purpose, model, system, user, schema, max_tokens, effort, timeout, cache_system=True
    ) -> JsonReply:
        self.requests.append(dict(purpose=purpose, model=model, system=system, user=user, schema=schema))
        if self.fail_with:
            raise LLMError(self.fail_with)
        lines = [ln for ln in user.splitlines() if ln.lstrip("*").startswith("[")]
        last = lines[-1].split(": ", 1)[-1] if lines else ""
        words = len(user.split())
        usage = Usage(input_tokens=words * 2, output_tokens=180, cache_read_input_tokens=len(system.split()) * 2)
        if purpose == "insight":
            data = {
                "topic": f"(demo) Si parla di: {last[:90]}" if last else "(demo) In attesa di conversazione.",
                "suggestions": [
                    {"kind": "question", "text": "Come ti sei trovato con questa cosa?"},
                    {"kind": "comment", "text": "Interessante, raccontami di più."},
                ],
                "remember": [ln.split(": ", 1)[-1][:80] for ln in lines[-3:]],
                "running_summary": f"(demo) Conversazione di {len(lines)} battute.",
            }
        else:
            data = {
                "title": "Chiamata demo",
                "summary": f"(demo) Riassunto finto di {len(lines)} battute. Usa una chiave API per un vero riassunto.",
                "key_points": [ln.split(": ", 1)[-1][:100] for ln in lines[:3]],
                "action_items": [{"owner": "Me", "task": "Richiamare la settimana prossima", "due": ""}],
                "memory_updates": [
                    {
                        "file": "people/Giulia.md",
                        "action": "create",
                        "content": "- Amica, parlato il giorno della chiamata demo.",
                        "reason": "Persona nuova emersa nella chiamata",
                    }
                ],
            }
        return JsonReply(data, usage, model)
