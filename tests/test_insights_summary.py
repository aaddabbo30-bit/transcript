import datetime as dt
import json

from call_assistant.insights import InsightEngine
from call_assistant.llm import CostTracker, FakeClaude, JsonReply, Usage
from call_assistant.memory import Memory
from call_assistant.summary import finish_call, record_applied
from call_assistant.transcript import TranscriptLine, TranscriptStore


def store_with(lines):
    store = TranscriptStore()
    for t, who, text in lines:
        store.add(TranscriptLine(t, who, text))
    return store


class Scripted:
    """LLM double returning fixed data and recording requests."""

    def __init__(self, data, model="claude-haiku-5-5"):
        self.data = data
        self.model = model
        self.requests = []

    def complete_json(self, **kw):
        self.requests.append(kw)
        return JsonReply(self.data, Usage(1000, 200, 0, 4000), self.model)


INSIGHT = {
    "topic": "Giulia ha ricevuto un'offerta di lavoro a Milano.",
    "suggestions": [
        {"kind": "answer", "text": "Secondo me dovresti accettare."},
        {"kind": "question", "text": "Quando dovresti iniziare?"},
        {"kind": "comment", "text": "È il progetto che sognavi!"},
        {"kind": "comment", "text": "Una quarta di troppo"},
    ],
    "remember": ["Festa il 14 novembre", "  ", "Decisione entro venerdì"],
    "running_summary": "Giulia valuta un lavoro a Milano.",
}


def test_insight_prompt_contains_memory_window_and_new_marks():
    store = store_with([(10, "them", "Mi hanno offerto il posto a Milano"), (500, "me", "Che bello!")])
    llm = Scripted(INSIGHT)
    engine = InsightEngine(llm=llm, store=store, memory_text="<file>Giulia è un'amica</file>",
                           window_seconds=240, ui_language="it")
    assert "Giulia è un'amica" in engine.system_prompt
    assert "Italian" in engine.system_prompt
    user = engine.build_user_prompt(now=510, call_language="auto")
    assert "*[08:20] Me: Che bello!" in user
    assert "Milano" not in user  # outside the 4-minute window
    assert "(none yet)" in user


def test_insight_run_parses_and_tracks_cost():
    store = store_with([(1, "them", "ciao")])
    llm = Scripted(INSIGHT)
    costs = CostTracker()
    engine = InsightEngine(llm=llm, store=store, memory_text="m", costs=costs)
    assert engine.has_news()
    insight = engine.run(now=30)
    assert len(insight.suggestions) == 3  # capped
    assert insight.remember == ["Festa il 14 novembre", "Decisione entro venerdì"]
    assert insight.cost > 0 and costs.by_purpose["live"] == insight.cost
    assert not engine.has_news()
    req = llm.requests[0]
    assert req["model"] == "claude-haiku-5-5" and req["effort"] == "low" and req["purpose"] == "insight"
    # The next prompt carries the previous summary and notes forward.
    store.add(TranscriptLine(40, "me", "nuova riga"))
    nxt = engine.build_user_prompt(now=45, call_language="it")
    assert "Giulia valuta un lavoro a Milano." in nxt and "- Festa il 14 novembre" in nxt
    assert engine.system_prompt == llm.requests[0]["system"]  # unchanged: cache hit


SUMMARY = {
    "title": "Giulia e il lavoro a Milano",
    "summary": "Giulia ha ricevuto un'offerta.",
    "key_points": ["Inizio il 1 dicembre", "Festa il 14 novembre"],
    "action_items": [{"owner": "Me", "task": "Portare il vino portoghese", "due": "14/11"}],
    "memory_updates": [
        {"file": "people/Giulia.md", "action": "create", "content": "- Architetta.", "reason": "nuova persona"}
    ],
}


def test_finish_call_writes_files(tmp_path):
    memory = Memory(tmp_path / "memory")
    memory.ensure()
    store = store_with([(1, "them", "Mi hanno offerto il posto"), (3, "me", "Che bello")])
    store.path = tmp_path / "calls" / "c1" / "transcript.md"
    llm = Scripted(SUMMARY, model="claude-opus-5-5")
    costs = CostTracker()
    started = dt.datetime(2026, 10, 26, 15, 30)
    result = finish_call(llm, store, memory, tmp_path / "calls" / "c1", ["Festa il 14"], started, 754, "claude-opus-5-5",
                         "medium", "it", costs)
    assert result.error is None and result.title == SUMMARY["title"]
    md = result.summary_file.read_text(encoding="utf-8")
    assert md.startswith("# Giulia e il lavoro a Milano")
    assert "12:34" in md and "- [ ] **Me:** Portare il vino portoghese (entro 14/11)" in md
    assert "## Proposte per la memoria" in md and "[Trascrizione completa](transcript.md)" in md
    record = json.loads((tmp_path / "calls" / "c1" / "summary.json").read_text(encoding="utf-8"))
    assert record["duration_seconds"] == 754 and record["estimated_cost_usd"] > 0
    assert (tmp_path / "calls" / "c1" / "transcript.md").exists()
    assert "Giulia e il lavoro a Milano" in (tmp_path / "calls" / "index.md").read_text(encoding="utf-8")
    assert [p.file for p in result.proposals] == ["people/Giulia.md"]
    request = llm.requests[0]
    assert request["purpose"] == "summary" and request["model"] == "claude-opus-5-5"
    assert request["cache_system"] is False
    assert "people/" in request["system"] or "about-me.md" in request["system"]
    assert "[00:01] Them: Mi hanno offerto il posto" in request["user"]
    record_applied(result.call_dir, result.proposals)
    record = json.loads((tmp_path / "calls" / "c1" / "summary.json").read_text(encoding="utf-8"))
    assert record["memory_updates_applied"][0]["file"] == "people/Giulia.md"


def test_finish_call_without_llm_or_on_failure_keeps_transcript(tmp_path):
    memory = Memory(tmp_path / "memory")
    store = store_with([(1, "them", "ciao")])
    store.path = tmp_path / "c2" / "transcript.md"
    started = dt.datetime(2026, 10, 26, 9, 0)
    no_key = finish_call(None, store, memory, tmp_path / "c2", [], started, 60, "m", "medium", "en", CostTracker())
    assert no_key.error == "no API key" and no_key.summary_file.exists() and store.path.exists()
    failing = FakeClaude(fail_with="Claude API error 529")
    res = finish_call(failing, store, memory, tmp_path / "c3", ["note"], started, 60, "m", "medium", "it", CostTracker())
    assert res.error == "Claude API error 529"
    text = res.summary_file.read_text(encoding="utf-8")
    assert "Riassunto non disponibile" in text and "- note" in text
