"""Whole-call tests: replayed transcript or WAV audio, fake Whisper, fake Claude."""

import queue
import time

from call_assistant.audio import WavFileInput
from call_assistant.config import APP_DIR
from call_assistant.llm import FakeClaude
from call_assistant.session import CallSession
from call_assistant.simulate import TranscriptReplay, parse_transcript
from call_assistant.transcriber import ScriptedSpeechToText

from .conftest import SPEECH_WAV


def drain(events: queue.Queue) -> list:
    out = []
    while True:
        try:
            out.append(events.get_nowait())
        except queue.Empty:
            return out


def test_parse_transcript_formats():
    lines = parse_transcript(
        "# comment\n[00:05] Giulia: Ciao!\n[1:00:02] Io: Eccomi\nMe: senza orario\nriga senza speaker\nThem: altra"
    )
    assert [(ln.t, ln.speaker, ln.text) for ln in lines] == [
        (5.0, "them", "Ciao!"),
        (3602.0, "me", "Eccomi"),
        (3607.0, "me", "senza orario"),
        (3612.0, "them", "altra"),
    ]


def test_sample_transcripts_parse():
    for name in ("demo_call_it.txt", "demo_call_en.txt"):
        lines = parse_transcript((APP_DIR / "samples" / name).read_text(encoding="utf-8"))
        assert len(lines) > 20 and {ln.speaker for ln in lines} == {"me", "them"}


def test_demo_session_end_to_end(settings, paths):
    events: queue.Queue = queue.Queue()
    replay = TranscriptReplay(APP_DIR / "samples" / "demo_call_it.txt", speed=40)
    llm = FakeClaude()
    session = CallSession(settings=settings, paths=paths, llm=llm, replay=replay, events=events)
    session.start()
    assert replay.finished.wait(15)
    session.request_insight()
    deadline = time.monotonic() + 5
    while not session.insight_log and time.monotonic() < deadline:
        time.sleep(0.05)
    session.stop(wait=True)

    kinds = [k for k, _ in drain(events)]
    assert "transcript" in kinds and "insight" in kinds and "summary" in kinds
    assert kinds[-1] == "status"
    assert len(session.store) == len(replay.lines)
    assert session.insight_log, "at least one live insight"
    assert {r["purpose"] for r in llm.requests} == {"insight", "summary"}
    files = {p.name for p in session.call_dir.iterdir()}
    assert {"transcript.md", "summary.md", "summary.json", "insights.jsonl"} <= files
    assert session.result is not None and session.result.proposals


def test_audio_session_with_scripted_whisper(settings, paths):
    """WAV -> segmenter -> (fake) Whisper -> transcript -> summary, as in a live call."""
    events: queue.Queue = queue.Queue()
    speech = ScriptedSpeechToText(["Ciao Marco, come stai?", "Ti chiamo per la cena di sabato.",
                                   "Did you finish the presentation?", "Perfetto, a presto!"])
    audio = WavFileInput(SPEECH_WAV, speed=8)
    session = CallSession(settings=settings, paths=paths, llm=FakeClaude(), audio_input=audio, speech=speech,
                          events=events)
    session.set_language("auto")
    session.start()
    assert audio.finished.wait(10)
    session.stop(wait=True)
    texts = [ln.text for ln in session.store.lines()]
    assert texts[0] == "Ciao Marco, come stai?"
    assert 3 <= len(texts) <= 5
    assert all(lang == "auto" for _, lang in speech.calls)
    statuses = [p for k, p in drain(events) if k == "status"]
    assert statuses[0] == "loading" and "listening" in statuses and statuses[-1] == "done"
    transcript = (session.call_dir / "transcript.md").read_text(encoding="utf-8")
    assert "**Altri:** Ciao Marco, come stai?" in transcript


def test_session_without_api_key_still_transcribes(settings, paths):
    events: queue.Queue = queue.Queue()
    replay = TranscriptReplay(APP_DIR / "samples" / "demo_call_en.txt", speed=60)
    session = CallSession(settings=settings, paths=paths, llm=None, replay=replay, events=events)
    session.start()
    assert replay.finished.wait(10)
    assert session.next_insight_in() is None
    session.stop(wait=True)
    got = drain(events)
    assert any(k == "warning" for k, _ in got)
    assert not any(k == "insight" for k, _ in got)
    assert session.result.error and session.result.summary_file.exists()


def test_auth_error_disables_live_insights(settings, paths):
    events: queue.Queue = queue.Queue()
    replay = TranscriptReplay(APP_DIR / "samples" / "demo_call_it.txt", speed=60)
    llm = FakeClaude(fail_with="API key not valid (401)")
    session = CallSession(settings=settings, paths=paths, llm=llm, replay=replay, events=events)
    session.start()
    assert replay.finished.wait(10)
    session.request_insight()
    deadline = time.monotonic() + 5
    while session.next_insight_in() is not None and time.monotonic() < deadline:
        time.sleep(0.05)
    assert session.next_insight_in() is None  # disabled after a 401
    session.stop(wait=True)
    assert any(k == "insight_error" for k, _ in drain(events))


class SilentPcAudio:
    """Stands in for the live capture: only the microphone produces speech."""

    capture_system_audio = True

    def start(self, feed, clock):
        return ["mic: test", "PC: test"]

    def stop(self):
        pass


def test_warns_when_pc_audio_stays_silent(settings, paths):
    from call_assistant.transcript import TranscriptLine

    events: queue.Queue = queue.Queue()
    now = [0.0]
    session = CallSession(settings=settings, paths=paths, llm=None, audio_input=SilentPcAudio(),
                          speech=ScriptedSpeechToText(), events=events, clock=lambda: now[0])
    session.start()
    for i in range(3):
        session.add_line(TranscriptLine(i * 5.0, "me", f"pronto, mi senti? {i}"))
    now[0] = 30.0
    session._check_pc_audio()
    assert not session._pc_audio_warned  # too early
    now[0] = 60.0
    session._check_pc_audio()
    assert session._pc_audio_warned
    session.stop(wait=True)
    warnings = [p for k, p in drain(events) if k == "warning"]
    assert any("audio del PC" in w for w in warnings)
