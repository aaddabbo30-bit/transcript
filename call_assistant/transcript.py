"""The live transcript: ordered lines, echo removal and saving to disk."""

from __future__ import annotations

import difflib
import logging
import threading
from dataclasses import dataclass, field
from pathlib import Path

from .audio import ME, THEM
from .transcriber import normalize

log = logging.getLogger(__name__)

# Labels used in prompts sent to Claude (always English, whatever the UI language).
PROMPT_LABELS = {ME: "Me", THEM: "Them"}


def fmt_time(seconds: float) -> str:
    seconds = max(0, int(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


@dataclass
class TranscriptLine:
    t: float  # seconds since the call started
    speaker: str  # ME or THEM
    text: str
    language: str | None = None
    seq: int = field(default=0, compare=False)  # arrival order, used to find "new" lines


class TranscriptStore:
    """Thread-safe list of transcript lines.

    Without headphones the microphone also hears the other people through the
    speakers, so the same sentence would appear twice (once as "Them" from the
    PC audio, once as "Me" from the microphone). Such echoes are dropped,
    keeping the PC-audio version.
    """

    ECHO_WINDOW_S = 10.0
    ECHO_SIMILARITY = 0.72

    def __init__(self, path: Path | None = None, labels: dict[str, str] | None = None, title: str = "Transcript"):
        self.path = path
        self.labels = labels or PROMPT_LABELS
        self.title = title
        self._lines: list[TranscriptLine] = []
        self._seq = 0
        self._lock = threading.Lock()
        self.echoes_dropped = 0

    @staticmethod
    def _similar(a: str, b: str) -> bool:
        na, nb = normalize(a), normalize(b)
        if not na or not nb:
            return False
        if na in nb or nb in na:
            return min(len(na), len(nb)) >= 12
        return difflib.SequenceMatcher(None, na, nb).ratio() >= TranscriptStore.ECHO_SIMILARITY

    def add(self, line: TranscriptLine) -> TranscriptLine | None:
        """Add a line; returns it, or None if it was an echo."""
        with self._lock:
            nearby = [
                other for other in self._lines[-30:] if abs(other.t - line.t) <= self.ECHO_WINDOW_S
            ]
            if line.speaker == ME:
                if any(o.speaker == THEM and self._similar(o.text, line.text) for o in nearby):
                    self.echoes_dropped += 1
                    return None
            elif line.speaker == THEM:
                for o in nearby:
                    if o.speaker == ME and self._similar(o.text, line.text):
                        self._lines.remove(o)
                        self.echoes_dropped += 1
            self._seq += 1
            line.seq = self._seq
            self._lines.append(line)
            self._lines.sort(key=lambda x: x.t)
        self._append_to_file(line)
        return line

    def _append_to_file(self, line: TranscriptLine) -> None:
        if not self.path:
            return
        with self._lock:
            try:
                new_file = not self.path.exists()
                with self.path.open("a", encoding="utf-8") as f:
                    if new_file:
                        f.write(f"# {self.title}\n\n")
                    f.write(f"- [{fmt_time(line.t)}] **{self.labels.get(line.speaker, line.speaker)}:** {line.text}\n")
            except OSError:  # e.g. OneDrive or antivirus holding the file: it is rewritten at the end
                log.warning("Could not append to %s", self.path, exc_info=True)

    def write_file(self, header: str = "") -> None:
        """Rewrite the file from the final, ordered, echo-free lines (end of call)."""
        if not self.path:
            return
        body = "\n".join(
            f"- [{fmt_time(ln.t)}] **{self.labels.get(ln.speaker, ln.speaker)}:** {ln.text}" for ln in self.lines()
        )
        with self._lock:
            self.path.write_text(f"# {self.title}\n\n{header}{body}\n", encoding="utf-8")

    def lines(self) -> list[TranscriptLine]:
        with self._lock:
            return list(self._lines)

    @property
    def last_seq(self) -> int:
        with self._lock:
            return self._seq

    def __len__(self) -> int:
        with self._lock:
            return len(self._lines)

    def window(self, seconds: float, now: float | None = None) -> list[TranscriptLine]:
        lines = self.lines()
        if not lines:
            return []
        end = now if now is not None else lines[-1].t
        return [ln for ln in lines if ln.t >= end - seconds]

    def text(self, lines: list[TranscriptLine] | None = None, new_after_seq: int | None = None) -> str:
        """Render lines as ``[mm:ss] Me: ...``; lines newer than ``new_after_seq`` get a ``*``."""
        out = []
        for ln in self.lines() if lines is None else lines:
            mark = "*" if new_after_seq is not None and ln.seq > new_after_seq else ""
            out.append(f"{mark}[{fmt_time(ln.t)}] {PROMPT_LABELS.get(ln.speaker, ln.speaker)}: {ln.text}")
        return "\n".join(out)

    def word_count(self) -> int:
        return sum(len(ln.text.split()) for ln in self.lines())
