"""Smoke test of the real Tk window (runs under a display, e.g. xvfb-run; skipped otherwise)."""

import os
import queue
import sys
import time

import pytest

tk = pytest.importorskip("tkinter")

from call_assistant.config import APP_DIR  # noqa: E402
from call_assistant.llm import FakeClaude  # noqa: E402
from call_assistant.session import CallSession  # noqa: E402
from call_assistant.simulate import TranscriptReplay  # noqa: E402

pytestmark = pytest.mark.skipif(
    sys.platform != "win32" and not os.environ.get("DISPLAY"), reason="needs a display (try xvfb-run)"
)


def pump(root, seconds: float, until=None) -> None:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        root.update()
        if until is not None and until():
            return
        time.sleep(0.02)


def test_overlay_runs_a_demo_call(settings, paths):
    from call_assistant.ui.overlay import Overlay

    root = tk.Tk()
    try:
        made = []

        def make_session(events: queue.Queue) -> CallSession:
            replay = TranscriptReplay(APP_DIR / "samples" / "demo_call_it.txt", speed=60)
            made.append(CallSession(settings=settings, paths=paths, llm=FakeClaude(), replay=replay, events=events))
            return made[-1]

        overlay = Overlay(root, settings=settings, paths=paths, make_session=make_session, subtitle="test")
        pump(root, 0.3)
        assert "Avvia" in overlay.start_btn.cget("text")

        overlay.start_call()
        session = made[0]
        assert "Stop" in overlay.start_btn.cget("text")
        pump(root, 10, until=lambda: session.replay.finished.is_set())
        session.request_insight()
        pump(root, 5, until=lambda: bool(overlay.suggestions.winfo_children()))
        assert overlay.topic.cget("text").startswith("(demo)")
        assert len(overlay.suggestions.winfo_children()) == 2
        assert int(overlay.transcript.index("end-1c").split(".")[0]) > 30

        # Clicking a suggestion copies it.
        first = overlay.suggestions.winfo_children()[0]
        first.event_generate("<Button-1>")
        pump(root, 0.2)
        assert root.clipboard_get() == "Come ti sei trovato con questa cosa?"

        overlay.stop_call()
        pump(root, 10, until=lambda: overlay.summary_panel.winfo_ismapped())
        assert overlay.summary_panel.winfo_ismapped()
        assert "Chiamata demo" in overlay.summary_title.cget("text")
        assert overlay._review_open  # memory proposals dialog opened
        dialogs = [w for w in root.winfo_children() if isinstance(w, tk.Toplevel)]
        review = [d for d in dialogs if hasattr(d, "rows")][0]
        review._apply()
        pump(root, 0.5)
        assert (paths.memory / "people" / "Giulia.md").exists()
        assert not overlay._review_open
    finally:
        root.destroy()


def test_dialogs_open(settings, paths):
    from call_assistant.i18n import Translator
    from call_assistant.memory import Memory
    from call_assistant.ui.dialogs import ImportMemoryDialog, SettingsDialog
    from call_assistant.ui.theme import Fonts

    root = tk.Tk()
    try:
        fonts = Fonts(root)
        t = Translator("en")
        memory = Memory(paths.memory, "en")
        memory.ensure()
        dlg = ImportMemoryDialog(root, t, fonts, memory)
        dlg.box.insert("1.0", "- You are a designer in Turin")
        dlg._save()
        assert "designer in Turin" in (paths.memory / "claude-memory-export.md").read_text(encoding="utf-8")
        saved = []
        sd = SettingsDialog(root, t, fonts, settings, paths, lambda: saved.append(True))
        sd.whisper.set("base")
        sd._save()
        assert settings["whisper_model"] == "base" and saved
        pump(root, 0.2)
    finally:
        root.destroy()


def test_closing_during_summary_waits_for_the_files(settings, paths):
    from call_assistant.llm import FakeClaude as Fake
    from call_assistant.ui.overlay import Overlay

    class SlowSummary(Fake):
        def complete_json(self, **kw):
            if kw["purpose"] == "summary":
                time.sleep(1.5)
            return super().complete_json(**kw)

    root = tk.Tk()
    made = []

    def make_session(events):
        replay = TranscriptReplay(APP_DIR / "samples" / "demo_call_en.txt", speed=80)
        made.append(CallSession(settings=settings, paths=paths, llm=SlowSummary(), replay=replay, events=events))
        return made[-1]

    overlay = Overlay(root, settings=settings, paths=paths, make_session=make_session)
    overlay.start_call()
    pump(root, 5, until=lambda: made[0].replay.finished.is_set())
    overlay.stop_call()
    pump(root, 0.3)
    overlay.on_close()  # the user closes the window while the summary is being written
    pump(root, 0.3)
    assert root.winfo_exists()  # still open
    assert not made[0].done.is_set()
    destroyed = False
    end = time.monotonic() + 10
    while time.monotonic() < end:
        try:
            root.update()
            # The summary proposes a memory update: approve it to let the app close.
            for w in root.winfo_children():
                if isinstance(w, tk.Toplevel) and hasattr(w, "rows"):
                    w._apply()
        except tk.TclError:
            destroyed = True
            break
        time.sleep(0.02)
    assert destroyed, "window closes once the summary is saved"
    assert made[0].done.is_set()
    assert (made[0].call_dir / "summary.md").exists()
