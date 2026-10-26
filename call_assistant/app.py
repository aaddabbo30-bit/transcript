"""Entry point: builds the session for live calls, demo or audio files and starts the window."""

from __future__ import annotations

import argparse
import logging
import platform
import queue
import sys
import threading
import time
from pathlib import Path

from . import __version__
from .config import APP_DIR, WHISPER_MODELS, Paths, Settings, default_home, setup_logging
from .llm import ClaudeClient, FakeClaude, LLMError, api_key_available
from .platform_utils import load_api_key_from_user_env
from .session import CallSession

log = logging.getLogger("call_assistant")

SAMPLES = APP_DIR / "samples"
ICON_ICO = APP_DIR / "assets" / "icon.ico"
ICON_PNG = APP_DIR / "assets" / "icon.png"


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="python -m call_assistant",
        description="Personal live assistant for calls and videos (Whisper + Claude).",
    )
    p.add_argument("--demo", nargs="?", const="auto", metavar="TRANSCRIPT",
                   help="replay a written transcript instead of listening (default: the sample call)")
    p.add_argument("--audio-file", metavar="WAV", help="use a WAV recording as the computer audio")
    p.add_argument("--speed", type=float, default=1.0, help="replay speed for --demo / --audio-file")
    p.add_argument("--fake-llm", action="store_true", help="use an offline fake model instead of Claude")
    p.add_argument("--headless", action="store_true", help="no window; print events (with --demo or --audio-file)")
    p.add_argument("--check", action="store_true", help="check the installation (audio, Whisper, API key)")
    p.add_argument("--list-devices", action="store_true", help="list audio devices (Windows)")
    p.add_argument("--download-model", nargs="?", const="", metavar="SIZE", choices=[""] + WHISPER_MODELS,
                   help="download the Whisper model (and make it the default if SIZE is given)")
    p.add_argument("--home", help="data folder (default: Documents/Call Assistant)")
    p.add_argument("--verbose", "-v", action="store_true")
    p.add_argument("--version", action="version", version=__version__)
    return p.parse_args(argv)


# ----------------------------------------------------------------- factories
def make_llm(args: argparse.Namespace):
    if args.fake_llm:
        return FakeClaude()
    load_api_key_from_user_env()
    if not api_key_available():
        return None
    try:
        return ClaudeClient()
    except (LLMError, ImportError) as exc:
        log.warning("Claude unavailable: %s", exc)
        return None


def demo_transcript(arg: str, settings: Settings) -> Path:
    if arg and arg != "auto":
        return Path(arg)
    lang = settings["call_language"] if settings["call_language"] in ("it", "en") else settings["ui_language"]
    return SAMPLES / f"demo_call_{lang}.txt"


def make_speech(settings: Settings, paths: Paths):
    from .transcriber import WhisperTranscriber

    return WhisperTranscriber(
        model_size=settings["whisper_model"],
        device=settings["whisper_device"],
        compute_type=settings["whisper_compute_type"],
        beam_size=settings["whisper_beam_size"],
        download_root=paths.models,
    )


def session_factory(args: argparse.Namespace, settings: Settings, paths: Paths):
    speech_cache: dict[tuple, object] = {}

    def speech():
        # Keep the loaded Whisper model between calls unless its settings changed.
        key = tuple(settings[k] for k in ("whisper_model", "whisper_device", "whisper_compute_type", "whisper_beam_size"))
        if key not in speech_cache:
            speech_cache.clear()
            speech_cache[key] = make_speech(settings, paths)
        return speech_cache[key]

    def make(events: queue.Queue) -> CallSession:
        llm = make_llm(args)
        kwargs: dict = dict(settings=settings, paths=paths, llm=llm, events=events)
        if args.demo:
            from .simulate import TranscriptReplay

            kwargs["replay"] = TranscriptReplay(demo_transcript(args.demo, settings), speed=args.speed)
        elif args.audio_file:
            from .audio import WavFileInput

            kwargs["speech"] = speech()
            kwargs["audio_input"] = WavFileInput(Path(args.audio_file), speed=args.speed)
        else:
            if sys.platform != "win32":
                raise RuntimeError("Live capture works on Windows. Try --demo or --audio-file.")
            from .capture_windows import WindowsAudioInput

            kwargs["speech"] = speech()
            kwargs["audio_input"] = WindowsAudioInput(
                capture_microphone=settings["capture_microphone"],
                capture_system_audio=settings["capture_system_audio"],
                microphone_hint=settings["microphone_device"],
                speaker_hint=settings["speaker_device"],
            )
        return CallSession(**kwargs)

    return make


# ------------------------------------------------------------------ commands
def run_headless(args: argparse.Namespace, settings: Settings, paths: Paths) -> int:
    """Run a demo or audio-file session without a window and print what happens."""
    events: queue.Queue = queue.Queue()
    session = session_factory(args, settings, paths)(events)
    session.start()
    source = session.replay or session.audio_input
    printer_stop = threading.Event()

    def printer() -> None:
        while not printer_stop.is_set() or not events.empty():
            try:
                kind, payload = events.get(timeout=0.2)
            except queue.Empty:
                continue
            if kind == "transcript":
                print(f"  [{payload.t:6.1f}s] {payload.speaker:>4}: {payload.text}")
            elif kind == "insight":
                print(f"\n=== INSIGHT @ {payload.at:.0f}s (${payload.cost:.5f}) ===\n  topic: {payload.topic}")
                for s in payload.suggestions:
                    print(f"  say ({s.kind}): {s.text}")
                for r in payload.remember:
                    print(f"  remember: {r}")
                print()
            elif kind == "summary":
                print(f"\n=== SUMMARY: {payload.title} -> {payload.summary_file}")
                if payload.error:
                    print(f"  error: {payload.error}")
                for prop in payload.proposals:
                    print(f"  memory proposal: {prop.action} {prop.file}: {prop.content[:80]!r}")
            elif kind in ("status", "audio", "warning", "error", "insight_error", "cost"):
                print(f"  <{kind}> {payload}")

    thread = threading.Thread(target=printer, daemon=True)
    thread.start()
    source.finished.wait()
    # Give the last utterances time to be transcribed and one more insight to run.
    time.sleep(2.0)
    if session.insights is not None:
        session.request_insight()
        time.sleep(0.5)
        while session.next_insight_in() == 0.0:
            time.sleep(0.2)
    session.stop(wait=True)
    printer_stop.set()
    thread.join(timeout=5)
    return 0 if session.result and not (session.result.error and session.llm) else 1


def download_model(size: str, settings: Settings, paths: Paths) -> int:
    if size:
        settings.update(whisper_model=size)
    size = settings["whisper_model"]
    print(f"Downloading the Whisper model '{size}' to {paths.models} (only the first time)...")
    from faster_whisper.utils import download_model as fw_download

    paths.models.mkdir(parents=True, exist_ok=True)
    path = fw_download(size, cache_dir=str(paths.models))
    print(f"OK: {path}")
    print("Loading it once to check it works...")
    make_speech(settings, paths).load()
    print("Whisper is ready.")
    return 0


def check(settings: Settings, paths: Paths) -> int:
    ok = True
    print(f"Call Assistant {__version__} · Python {platform.python_version()} · {platform.platform()}")
    print(f"Data folder: {paths.home}")
    from .memory import Memory

    memory = Memory(paths.memory, settings["ui_language"])
    memory.ensure()
    text, _ = memory.load_text()
    print(f"Memory: {len(memory.files())} file(s), {len(text)} characters used as context")

    try:
        import tkinter

        tkinter.Tcl()
        print("Window toolkit (tkinter): OK")
    except Exception as exc:
        ok = False
        print(f"Window toolkit (tkinter): MISSING ({exc}) - reinstall Python with 'tcl/tk' enabled")

    try:
        from faster_whisper.utils import download_model as fw_download

        fw_download(settings["whisper_model"], local_files_only=True, cache_dir=str(paths.models))
        print(f"Whisper model '{settings['whisper_model']}': downloaded")
    except Exception:
        ok = False
        print(f"Whisper model '{settings['whisper_model']}': NOT downloaded - run install.ps1 again")

    load_api_key_from_user_env()
    if api_key_available():
        try:
            import anthropic

            reply = anthropic.Anthropic(max_retries=0).messages.create(
                model=settings["insight_model"],
                max_tokens=300,
                output_config={"effort": "low"},
                messages=[{"role": "user", "content": "Reply with the single word OK."}],
            )
            print(f"Claude API ({settings['insight_model']}): OK (stop_reason={reply.stop_reason})")
        except Exception as exc:
            ok = False
            print(f"Claude API: ERROR {type(exc).__name__}: {exc}")
    else:
        ok = False
        print("Claude API key (ANTHROPIC_API_KEY): NOT SET - live suggestions disabled")

    if sys.platform == "win32":
        try:
            from .capture_windows import measure_levels

            print("\nRecording 5 seconds: say something and play some audio on the PC...")
            peaks = measure_levels(
                5.0,
                capture_microphone=settings["capture_microphone"],
                capture_system_audio=settings["capture_system_audio"],
                microphone_hint=settings["microphone_device"],
                speaker_hint=settings["speaker_device"],
            )
            for source, label in (("me", "Microphone"), ("them", "PC audio")):
                level = peaks.get(source)
                verdict = "no data (silence?)" if level is None else ("OK" if level > 0.01 else "very quiet")
                print(f"  {label}: peak {0 if level is None else level:.3f} -> {verdict}")
        except Exception as exc:
            ok = False
            print(f"Audio: ERROR {exc}")
    else:
        print("Audio capture: Windows only (skipped)")
    print("\nAll good!" if ok else "\nSome checks failed: see above.")
    return 0 if ok else 1


def list_audio_devices() -> int:
    from .capture_windows import list_devices

    for d in list_devices():
        flags = [k for k in ("default_input", "default_output", "loopback") if d[k]]
        print(f"{d['index']:3d}  in={d['inputs']} out={d['outputs']} {d['rate']}Hz  {d['name']}  {' '.join(flags)}")
    return 0


# ------------------------------------------------------------------- window
def run_window(args: argparse.Namespace, settings: Settings, paths: Paths) -> int:
    if sys.platform == "win32":
        try:  # crisp text on high-DPI screens, own taskbar icon
            import ctypes

            ctypes.windll.shcore.SetProcessDpiAwareness(1)
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("CallAssistant")
        except Exception:
            pass
    import tkinter as tk

    from .ui.overlay import Overlay

    root = tk.Tk()
    root.report_callback_exception = lambda *exc: log.error("UI error", exc_info=exc)
    try:
        if sys.platform == "win32" and ICON_ICO.exists():
            root.iconbitmap(default=str(ICON_ICO))
        elif ICON_PNG.exists():
            root.iconphoto(True, tk.PhotoImage(file=str(ICON_PNG)))
    except tk.TclError:
        pass
    subtitle = "demo" if args.demo else (Path(args.audio_file).name if args.audio_file else "")
    overlay = Overlay(root, settings=settings, paths=paths, make_session=session_factory(args, settings, paths),
                      subtitle=subtitle)
    load_api_key_from_user_env()
    if not args.fake_llm and not api_key_available():
        root.after(400, overlay.ask_api_key)
    root.mainloop()
    return 0


def _prepare_environment() -> None:
    import os

    # pythonw.exe (the desktop shortcut) has no console: sys.stdout/stderr are None and
    # anything that writes to them (e.g. download progress bars) would crash.
    if sys.stdout is None or sys.stderr is None:
        devnull = open(os.devnull, "w", encoding="utf-8")
        sys.stdout = sys.stdout or devnull
        sys.stderr = sys.stderr or devnull
        os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    for stream in (sys.stdout, sys.stderr):
        try:  # a piped Windows console uses cp1252: never crash on "…" or "→"
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")  # harmless on Windows without symlinks
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")


def main(argv: list[str] | None = None) -> int:
    _prepare_environment()
    args = parse_args(argv)
    paths = Paths(Path(args.home).expanduser() if args.home else default_home()).ensure()
    log_file = setup_logging(paths, args.verbose)
    settings = Settings.load(paths.settings_file)
    log.info("Starting %s (args=%s)", __version__, vars(args))
    try:
        if args.check:
            return check(settings, paths)
        if args.list_devices:
            return list_audio_devices()
        if args.download_model is not None:
            return download_model(args.download_model, settings, paths)
        if args.headless:
            if not (args.demo or args.audio_file):
                print("--headless needs --demo or --audio-file")
                return 2
            return run_headless(args, settings, paths)
        return run_window(args, settings, paths)
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        log.exception("Fatal error")
        try:  # pythonw has no console: show the error in a box
            import tkinter as tk
            from tkinter import messagebox

            r = tk.Tk()
            r.withdraw()
            messagebox.showerror("Call Assistant", f"{exc}\n\nDetails: {log_file}")
            r.destroy()
        except Exception:
            print(f"Error: {exc} (details: {log_file})", file=sys.stderr)
        return 1
