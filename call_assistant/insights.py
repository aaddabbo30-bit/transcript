"""Live insights: every ~25 s, ask Claude what is going on and what to say."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from .i18n import LANGUAGE_NAMES
from .llm import LLM, CostTracker
from .prompts import INSIGHT_SCHEMA, insight_system, insight_user
from .transcript import TranscriptStore, fmt_time

log = logging.getLogger(__name__)

CALL_LANGUAGE_NAMES = {"auto": "automatic (Italian or English)", "it": "Italian", "en": "English"}


@dataclass
class Suggestion:
    kind: str
    text: str


@dataclass
class Insight:
    topic: str
    suggestions: list[Suggestion]
    remember: list[str]
    running_summary: str
    at: float  # session time
    cost: float = 0.0
    model: str = ""

    def to_dict(self) -> dict:
        return {
            "at": round(self.at, 1),
            "topic": self.topic,
            "suggestions": [{"kind": s.kind, "text": s.text} for s in self.suggestions],
            "remember": self.remember,
            "running_summary": self.running_summary,
            "cost_usd": round(self.cost, 6),
            "model": self.model,
        }


@dataclass
class InsightEngine:
    llm: LLM
    store: TranscriptStore
    memory_text: str
    model: str = "claude-haiku-5-5"
    effort: str = "low"
    ui_language: str = "it"
    window_seconds: float = 240
    costs: CostTracker = field(default_factory=CostTracker)
    last: Insight | None = None
    last_seq: int = 0
    _system: str = ""

    def __post_init__(self) -> None:
        # Built once per call: an identical system prompt is what makes caching work.
        self._system = insight_system(self.memory_text, LANGUAGE_NAMES.get(self.ui_language, "Italian"))

    @property
    def system_prompt(self) -> str:
        return self._system

    def has_news(self) -> bool:
        return self.store.last_seq > self.last_seq

    def build_user_prompt(self, now: float, call_language: str) -> str:
        lines = self.store.window(self.window_seconds, now)
        return insight_user(
            elapsed=fmt_time(now),
            transcript=self.store.text(lines, new_after_seq=self.last_seq) or "(nothing said yet)",
            previous_summary=self.last.running_summary if self.last else "",
            previous_remember=self.last.remember if self.last else [],
            call_language=CALL_LANGUAGE_NAMES.get(call_language, call_language),
        )

    def run(self, now: float, call_language: str = "auto") -> Insight:
        seq = self.store.last_seq
        reply = self.llm.complete_json(
            purpose="insight",
            model=self.model,
            system=self._system,
            user=self.build_user_prompt(now, call_language),
            schema=INSIGHT_SCHEMA,
            max_tokens=4000,
            effort=self.effort,
            timeout=45,
        )
        cost = self.costs.add("live", reply.model, reply.usage)
        d = reply.data
        insight = Insight(
            topic=str(d.get("topic", "")).strip(),
            suggestions=[
                Suggestion(str(s.get("kind", "comment")), str(s.get("text", "")).strip())
                for s in d.get("suggestions", [])[:3]
                if isinstance(s, dict) and str(s.get("text", "")).strip()
            ],
            remember=[str(r).strip() for r in d.get("remember", []) if str(r).strip()][:6],
            running_summary=str(d.get("running_summary", "")).strip(),
            at=now,
            cost=cost,
            model=reply.model,
        )
        self.last = insight
        self.last_seq = seq
        return insight
