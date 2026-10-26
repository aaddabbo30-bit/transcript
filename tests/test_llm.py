"""ClaudeClient against the real ``anthropic`` SDK with a mocked HTTP transport."""

import json

import anthropic
import httpx2
import pytest

from call_assistant.llm import ClaudeClient, CostTracker, FakeClaude, LLMError, Usage, estimate_cost
from call_assistant.prompts import INSIGHT_SCHEMA

REPLY = {"topic": "Vacanze", "suggestions": [], "remember": ["Partenza il 3"], "running_summary": "..."}


def api_response(text: str, model: str = "claude-haiku-5-5", stop_reason: str = "end_turn", **usage):
    body = {
        "id": "msg_test",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": [{"type": "thinking", "thinking": "", "signature": "sig"}, {"type": "text", "text": text}],
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "usage": {
            "input_tokens": usage.get("input_tokens", 120),
            "output_tokens": usage.get("output_tokens", 80),
            "cache_creation_input_tokens": usage.get("cache_creation_input_tokens", 0),
            "cache_read_input_tokens": usage.get("cache_read_input_tokens", 3000),
        },
    }
    return httpx2.Response(200, json=body)


def make_client(handler):
    sdk = anthropic.Anthropic(
        api_key="sk-ant-test",
        max_retries=0,
        http_client=anthropic.DefaultHttpxClient(transport=httpx2.MockTransport(handler)),
    )
    return ClaudeClient(client=sdk)


def call(client, model="claude-haiku-5-5", **kw):
    return client.complete_json(
        purpose="insight",
        model=model,
        system="SYSTEM PROMPT",
        user="USER PROMPT",
        schema=INSIGHT_SCHEMA,
        max_tokens=4000,
        effort="low",
        timeout=30,
        **kw,
    )


def test_live_request_shape_and_parsing():
    seen = {}

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen["url"] = str(request.url)
        seen["headers"] = dict(request.headers)
        seen["body"] = json.loads(request.content)
        return api_response(json.dumps(REPLY))

    reply = call(make_client(handler))
    body = seen["body"]
    assert seen["url"].endswith("/v1/messages")
    assert body["model"] == "claude-haiku-5-5"
    assert body["max_tokens"] == 4000
    # Memory + instructions are cached; the transcript goes in the user turn.
    assert body["system"] == [{"type": "text", "text": "SYSTEM PROMPT", "cache_control": {"type": "ephemeral"}}]
    assert body["messages"] == [{"role": "user", "content": "USER PROMPT"}]
    assert body["output_config"]["effort"] == "low"
    assert body["output_config"]["format"]["type"] == "json_schema"
    assert body["output_config"]["format"]["schema"] == INSIGHT_SCHEMA
    for removed in ("temperature", "top_p", "top_k", "fallbacks"):
        assert removed not in body
    assert "server-side-fallback" not in seen["headers"].get("anthropic-beta", "")
    assert reply.data == REPLY
    assert reply.usage == Usage(120, 80, 0, 3000)
    assert reply.model == "claude-haiku-5-5"


def test_summary_model_uses_server_side_fallback():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["beta"] = request.headers.get("anthropic-beta", "")
        seen["body"] = json.loads(request.content)
        return api_response(json.dumps({"ok": True}), model="claude-opus-5-5")

    reply = call(make_client(handler), model="claude-opus-5-5", cache_system=False)
    assert seen["body"]["system"] == [{"type": "text", "text": "SYSTEM PROMPT"}]
    assert "server-side-fallback-2026-07-01" in seen["beta"]
    assert seen["body"]["fallbacks"] == "default"
    assert reply.data == {"ok": True}


@pytest.mark.parametrize(
    "status,payload,expected",
    [
        (401, {"type": "authentication_error", "message": "invalid x-api-key"}, "401"),
        (404, {"type": "not_found_error", "message": "model not found"}, "not found"),
        (400, {"type": "invalid_request_error", "message": "Your credit balance is too low"}, "credit"),
        (429, {"type": "rate_limit_error", "message": "slow down"}, "rate limit"),
        (529, {"type": "overloaded_error", "message": "overloaded"}, "529"),
    ],
)
def test_api_errors_become_readable(status, payload, expected):
    def handler(request):
        return httpx2.Response(status, json={"type": "error", "error": payload})

    with pytest.raises(LLMError, match=expected):
        call(make_client(handler))


def test_refusal_and_truncation_are_errors():
    with pytest.raises(LLMError, match="declined"):
        call(make_client(lambda r: api_response("", stop_reason="refusal")))
    with pytest.raises(LLMError, match="max_tokens"):
        call(make_client(lambda r: api_response('{"topic": "tr', stop_reason="max_tokens")))


def test_connection_error():
    def handler(request):
        raise httpx2.ConnectError("offline")

    with pytest.raises(LLMError, match="connection"):
        call(make_client(handler))


def test_missing_api_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(LLMError):
        ClaudeClient()


def test_cost_estimate():
    haiku = Usage(input_tokens=90_000, output_tokens=0)
    assert estimate_cost("claude-haiku-5-5", haiku) == pytest.approx(90_000 * 0.10 / 1e6)
    cached = Usage(input_tokens=500, output_tokens=200, cache_read_input_tokens=5000)
    assert estimate_cost("claude-haiku-5-5", cached) == pytest.approx((500 * 0.1 + 200 * 0.5 + 5000 * 0.01) / 1e6)
    long_prompt = Usage(input_tokens=150_000)
    assert estimate_cost("claude-haiku-5-5", long_prompt) == pytest.approx(150_000 * 0.5 / 1e6)
    assert estimate_cost("claude-opus-5-5", Usage(output_tokens=1000)) == pytest.approx(0.02)
    assert estimate_cost("unknown-model", Usage(1000, 1000)) == 0.0


def test_cost_tracker_totals():
    tracker = CostTracker()
    tracker.add("live", "claude-haiku-5-5", Usage(1000, 100))
    tracker.add("summary", "claude-opus-5-5", Usage(1000, 100))
    assert tracker.calls == 2
    assert tracker.total == pytest.approx(tracker.by_purpose["live"] + tracker.by_purpose["summary"])


def test_fake_claude_answers_both_purposes():
    fake = FakeClaude()
    common = dict(model="m", system="s", schema={}, max_tokens=1, effort="low", timeout=1)
    insight = fake.complete_json(purpose="insight", user="[00:01] Them: ciao", **common)
    assert set(insight.data) == {"topic", "suggestions", "remember", "running_summary"}
    summary = fake.complete_json(purpose="summary", user="[00:01] Them: ciao", **common)
    assert {"title", "summary", "key_points", "action_items", "memory_updates"} <= set(summary.data)
