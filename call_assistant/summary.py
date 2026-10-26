"""End of call: summary, key points and memory proposals, saved locally."""

from __future__ import annotations

import datetime as dt
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .i18n import LANGUAGE_NAMES
from .llm import LLM, CostTracker, LLMError
from .memory import Memory, MemoryUpdate
from .prompts import SUMMARY_SCHEMA, summary_system, summary_user
from .transcript import TranscriptStore, fmt_time

log = logging.getLogger(__name__)

HEADINGS = {
    "it": {
        "date": "Data",
        "duration": "Durata",
        "cost": "Costo stimato",
        "summary": "Riassunto",
        "key_points": "Punti chiave",
        "actions": "Da fare",
        "due": "entro",
        "notes": "Appunti presi durante la chiamata",
        "memory": "Proposte per la memoria",
        "new": "nuovo file",
        "transcript": "Trascrizione completa",
        "untitled": "Chiamata",
        "no_summary": "Riassunto non disponibile",
    },
    "en": {
        "date": "Date",
        "duration": "Duration",
        "cost": "Estimated cost",
        "summary": "Summary",
        "key_points": "Key points",
        "actions": "To do",
        "due": "due",
        "notes": "Notes taken during the call",
        "memory": "Memory proposals",
        "new": "new file",
        "transcript": "Full transcript",
        "untitled": "Call",
        "no_summary": "Summary not available",
    },
}


@dataclass
class SummaryResult:
    call_dir: Path
    title: str
    summary_file: Path
    data: dict[str, Any] = field(default_factory=dict)
    proposals: list[MemoryUpdate] = field(default_factory=list)
    error: str | None = None


def generate_summary(
    llm: LLM,
    store: TranscriptStore,
    memory: Memory,
    live_remember: list[str],
    started_at: dt.datetime,
    duration_s: float,
    model: str,
    effort: str,
    ui_language: str,
    costs: CostTracker,
) -> dict[str, Any]:
    memory_text, _ = memory.load_text()
    system = summary_system(
        memory_text,
        memory.relative_names(),
        LANGUAGE_NAMES.get(ui_language, "Italian"),
        dt.date.today().isoformat(),
    )
    meta = f"Call started {started_at:%Y-%m-%d %H:%M}, duration {fmt_time(duration_s)}."
    reply = llm.complete_json(
        purpose="summary",
        model=model,
        system=system,
        user=summary_user(meta, store.text(), live_remember),
        schema=SUMMARY_SCHEMA,
        max_tokens=16000,
        effort=effort,
        timeout=300,
        cache_system=False,  # one request per call: caching would only cost more
    )
    costs.add("summary", reply.model, reply.usage)
    return reply.data


def render_markdown(
    data: dict[str, Any],
    started_at: dt.datetime,
    duration_s: float,
    cost: float,
    live_remember: list[str],
    ui_language: str,
    error: str | None = None,
) -> str:
    h = HEADINGS.get(ui_language, HEADINGS["en"])
    title = data.get("title") or f"{h['untitled']} {started_at:%d/%m/%Y %H:%M}"
    out = [
        f"# {title}",
        "",
        f"**{h['date']}:** {started_at:%d/%m/%Y %H:%M} · **{h['duration']}:** {fmt_time(duration_s)}"
        f" · **{h['cost']}:** ${cost:.4f}",
        "",
    ]
    if error:
        out += [f"> {h['no_summary']}: {error}", ""]
    if data.get("summary"):
        out += [f"## {h['summary']}", "", str(data["summary"]).strip(), ""]
    if data.get("key_points"):
        out += [f"## {h['key_points']}", ""] + [f"- {p}" for p in data["key_points"]] + [""]
    if data.get("action_items"):
        out += [f"## {h['actions']}", ""]
        for item in data["action_items"]:
            due = f" ({h['due']} {item['due']})" if item.get("due") else ""
            out.append(f"- [ ] **{item.get('owner', '')}:** {item.get('task', '')}{due}")
        out.append("")
    if live_remember:
        out += [f"## {h['notes']}", ""] + [f"- {r}" for r in live_remember] + [""]
    if data.get("memory_updates"):
        out += [f"## {h['memory']}", ""]
        for u in data["memory_updates"]:
            new = f" ({h['new']})" if u.get("action") == "create" else ""
            content = str(u.get("content", "")).strip().replace("\n", "\n  ")
            out.append(f"- `{u.get('file', '')}`{new}: {content}")
        out.append("")
    out += [f"[{h['transcript']}](transcript.md)", ""]
    return "\n".join(out)


def finish_call(
    llm: LLM | None,
    store: TranscriptStore,
    memory: Memory,
    call_dir: Path,
    live_remember: list[str],
    started_at: dt.datetime,
    duration_s: float,
    model: str,
    effort: str,
    ui_language: str,
    costs: CostTracker,
) -> SummaryResult:
    """Write transcript.md, summary.md and summary.json. Never raises for LLM problems."""
    call_dir.mkdir(parents=True, exist_ok=True)
    store.write_file()
    data: dict[str, Any] = {}
    error: str | None = None
    if not store.lines():
        error = "empty transcript" if ui_language == "en" else "trascrizione vuota"
    elif llm is None:
        error = "no API key" if ui_language == "en" else "manca la chiave API"
    else:
        try:
            data = generate_summary(
                llm, store, memory, live_remember, started_at, duration_s, model, effort, ui_language, costs
            )
        except LLMError as exc:
            error = str(exc)
        except Exception as exc:  # never lose the transcript because of the summary
            log.exception("Summary failed")
            error = str(exc)

    summary_file = call_dir / "summary.md"
    summary_file.write_text(
        render_markdown(data, started_at, duration_s, costs.total, live_remember, ui_language, error),
        encoding="utf-8",
    )
    record = {
        "started_at": started_at.isoformat(timespec="seconds"),
        "duration_seconds": round(duration_s),
        "estimated_cost_usd": round(costs.total, 6),
        "cost_breakdown_usd": {k: round(v, 6) for k, v in costs.by_purpose.items()},
        "live_remember": live_remember,
        "error": error,
        **data,
    }
    (call_dir / "summary.json").write_text(json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8")

    title = data.get("title") or HEADINGS.get(ui_language, HEADINGS["en"])["untitled"]
    _append_index(call_dir.parent, call_dir, title, started_at, duration_s)
    proposals = [MemoryUpdate.from_dict(u) for u in data.get("memory_updates", []) if isinstance(u, dict)]
    return SummaryResult(call_dir, title, summary_file, data, proposals, error)


def _append_index(calls_root: Path, call_dir: Path, title: str, started_at: dt.datetime, duration_s: float) -> None:
    index = calls_root / "index.md"
    try:
        if not index.exists():
            index.write_text("# Calls\n\n", encoding="utf-8")
        with index.open("a", encoding="utf-8") as f:
            f.write(
                f"- {started_at:%Y-%m-%d %H:%M} · {fmt_time(duration_s)} · "
                f"[{title}]({call_dir.name}/summary.md)\n"
            )
    except OSError:
        log.exception("Could not update %s", index)


def record_applied(call_dir: Path, applied: list[MemoryUpdate]) -> None:
    """Remember which proposals the user approved (in summary.json)."""
    path = call_dir / "summary.json"
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
        record["memory_updates_applied"] = [
            {"file": u.file, "action": u.action, "content": u.content} for u in applied
        ]
        path.write_text(json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8")
    except (OSError, ValueError):
        log.exception("Could not update %s", path)
