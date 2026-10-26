"""Replay a written transcript as if it were a live call.

Lets you try the window, the live suggestions and the final summary without
a call, a microphone or Whisper. File format, one line per utterance::

    [00:05] Them: Ciao! Come stai?
    [00:09] Me: Bene, grazie. Ho appena finito il trasloco.

The time is optional (lines without it are spaced 5 seconds apart). "Me", "Io"
and "I" mean you; any other name means the other side of the call.
"""

from __future__ import annotations

import re
import threading
from pathlib import Path
from typing import Callable

from .audio import ME, THEM
from .transcript import TranscriptLine

_LINE = re.compile(r"^\s*(?:\[(?:(\d+):)?(\d+):(\d+)\]\s*)?([^:\[\]]{1,40}):\s*(.+?)\s*$")
_ME = {"me", "io", "i", "user", "utente"}


def parse_transcript(text: str, gap: float = 5.0) -> list[TranscriptLine]:
    lines: list[TranscriptLine] = []
    t = 0.0
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        m = _LINE.match(raw)
        if not m:
            continue
        h, mm, ss, speaker, body = m.groups()
        if mm is not None:
            t = int(h or 0) * 3600 + int(mm) * 60 + int(ss)
        elif lines:
            t = lines[-1].t + gap
        who = ME if speaker.strip().lower() in _ME else THEM
        lines.append(TranscriptLine(float(t), who, body))
    return lines


class TranscriptReplay:
    def __init__(self, path: Path, speed: float = 1.0):
        self.path = Path(path)
        self.lines = parse_transcript(self.path.read_text(encoding="utf-8"))
        if not self.lines:
            raise ValueError(f"No transcript lines found in {self.path}")
        self.speed = max(0.1, speed)
        self._stop = threading.Event()
        self.finished = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self, add_line: Callable[[TranscriptLine], None], clock: Callable[[], float]) -> list[str]:
        def run() -> None:
            t0 = clock()
            for line in self.lines:
                delay = line.t / self.speed - (clock() - t0)
                if delay > 0 and self._stop.wait(delay):
                    break
                if self._stop.is_set():
                    break
                # Timestamps follow the session clock so the UI and prompts agree.
                add_line(TranscriptLine(clock(), line.speaker, line.text))
            self.finished.set()

        self._thread = threading.Thread(target=run, name="replay", daemon=True)
        self._thread.start()
        speed = f" x{self.speed:g}" if self.speed != 1 else ""
        return [f"demo: {self.path.name}{speed}"]

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)

