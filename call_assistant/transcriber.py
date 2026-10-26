"""Speech to text with faster-whisper (https://github.com/SYSTRAN/faster-whisper, MIT).

Runs locally on the CPU: audio never leaves the computer, only text is sent
to Claude.
"""

from __future__ import annotations

import logging
import os
import queue
import re
import threading
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol

import numpy as np

from .audio import AudioChunk

log = logging.getLogger(__name__)

ALLOWED_LANGUAGES = ("it", "en")

# Subtitle credits Whisper invents on silence or music (it learned them from
# subtitled videos). Never real speech: always dropped.
ALWAYS_DROP = re.compile(r"amara\.?org|qtss|sottotitoli (creati|e revisione|a cura)", re.IGNORECASE)

# Phrases that are real speech sometimes, hallucinations other times: dropped
# only when Whisper itself is unsure about the segment.
SUSPICIOUS = {
    "grazie per la visione",
    "grazie a tutti per la visione",
    "iscriviti al canale",
    "thank you for watching",
    "thanks for watching",
    "thank you so much for watching",
    "please subscribe",
    "you",
    "grazie",
    "thank you",
    "music",
    "musica",
    "applause",
}


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"[^\w\s]", "", text.lower())
    return re.sub(r"\s+", " ", text).strip()


def collapse_repetitions(text: str, max_repeats: int = 2) -> str:
    """'ok ok ok ok ok' -> 'ok ok'; also catches repeated phrases (a Whisper failure mode)."""
    words = text.split()
    for n in range(1, 7):
        i = 0
        out: list[str] = []
        while i < len(words):
            gram = words[i : i + n]
            repeats = 1
            while len(gram) == n and words[i + repeats * n : i + (repeats + 1) * n] == gram:
                repeats += 1
            if repeats > max_repeats:
                out.extend(gram * max_repeats)
                i += repeats * n
            else:
                out.append(words[i])
                i += 1
        words = out
    return " ".join(words)


def keep_segment(text: str, no_speech_prob: float = 0.0, avg_logprob: float = 0.0) -> bool:
    norm = normalize(text)
    if not norm or ALWAYS_DROP.search(text) or no_speech_prob > 0.8:
        return False
    if norm in SUSPICIOUS and (no_speech_prob > 0.3 or avg_logprob < -0.7):
        return False
    return True


def clean_text(text: str) -> str:
    return collapse_repetitions(" ".join(text.split()))


@dataclass
class TranscriptionResult:
    text: str
    language: str | None


class SpeechToText(Protocol):
    def load(self) -> None: ...

    def transcribe(self, audio: np.ndarray, language_mode: str) -> TranscriptionResult: ...


class WhisperTranscriber:
    def __init__(
        self,
        model_size: str = "small",
        device: str = "cpu",
        compute_type: str = "int8",
        beam_size: int = 1,
        download_root: Path | None = None,
        model_factory: Callable[..., object] | None = None,
    ):
        self.model_size = model_size
        self.device = device
        self.compute_type = compute_type
        self.beam_size = max(1, int(beam_size))
        self.download_root = download_root
        self._model_factory = model_factory
        self._model = None
        self._lock = threading.Lock()

    def load(self) -> None:
        with self._lock:
            if self._model is not None:
                return
            factory = self._model_factory
            if factory is None:
                from faster_whisper import WhisperModel

                factory = WhisperModel
            threads = min(8, max(2, (os.cpu_count() or 4) // 2))  # leave CPU for the call app
            kwargs = dict(device=self.device, compute_type=self.compute_type, cpu_threads=threads)
            if self.download_root:
                kwargs["download_root"] = str(self.download_root)
            try:
                self._model = factory(self.model_size, **kwargs)
            except Exception:
                if self.device == "cpu":
                    raise
                log.exception("Could not load Whisper on %s; falling back to CPU", self.device)
                kwargs.update(device="cpu", compute_type="int8")
                self._model = factory(self.model_size, **kwargs)
            log.info("Whisper model %s loaded (%s)", self.model_size, kwargs)

    def _run(self, audio: np.ndarray, language: str | None):
        assert self._model is not None
        return self._model.transcribe(
            audio,
            language=language,
            beam_size=self.beam_size,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            condition_on_previous_text=False,
            without_timestamps=True,
        )

    def transcribe(self, audio: np.ndarray, language_mode: str = "auto") -> TranscriptionResult:
        self.load()
        language = language_mode if language_mode in ALLOWED_LANGUAGES else None
        segments, info = self._run(audio, language)
        detected = getattr(info, "language", None)
        if language is None and detected not in ALLOWED_LANGUAGES:
            # Auto mode only chooses between Italian and English.
            probs = dict(getattr(info, "all_language_probs", None) or [])
            best = max(ALLOWED_LANGUAGES, key=lambda lang: probs.get(lang, 0.0))
            log.debug("Detected %r, re-running as %r", detected, best)
            segments, info = self._run(audio, best)
            detected = best
        parts = [
            seg.text.strip()
            for seg in segments
            if keep_segment(seg.text, getattr(seg, "no_speech_prob", 0.0), getattr(seg, "avg_logprob", 0.0))
        ]
        return TranscriptionResult(clean_text(" ".join(parts)), language or detected)


class TranscriptionWorker:
    """Transcribes chunks one at a time, in order, on a background thread."""

    def __init__(
        self,
        engine: SpeechToText,
        on_text: Callable[[AudioChunk, TranscriptionResult], None],
        language_mode: Callable[[], str],
        on_status: Callable[[str, str], None] = lambda kind, msg: None,
    ):
        self.engine = engine
        self.on_text = on_text
        self.language_mode = language_mode
        self.on_status = on_status
        self._queue: queue.Queue[AudioChunk | None] = queue.Queue()
        self._thread: threading.Thread | None = None
        self.ready = threading.Event()
        self.failed: Exception | None = None

    def submit(self, chunk: AudioChunk) -> None:
        self._queue.put(chunk)

    @property
    def backlog(self) -> int:
        return self._queue.qsize()

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="transcriber", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        try:
            self.engine.load()
        except Exception as exc:  # model download failed, out of memory, ...
            log.exception("Could not load the speech model")
            self.failed = exc
            self.on_status("error", f"Whisper: {exc}")
            self.ready.set()
            return
        self.ready.set()
        while True:
            chunk = self._queue.get()
            if chunk is None:
                break
            try:
                result = self.engine.transcribe(chunk.audio, self.language_mode())
            except Exception as exc:
                log.exception("Transcription failed")
                self.on_status("error", f"Whisper: {exc}")
                continue
            if result.text:
                try:
                    self.on_text(chunk, result)
                except Exception:  # never let one bad line stop the transcription
                    log.exception("Could not store a transcript line")

    def finish(self, timeout: float | None = None) -> bool:
        """Transcribe everything queued, then stop. Returns False on timeout."""
        self._queue.put(None)
        if self._thread:
            self._thread.join(timeout)
            return not self._thread.is_alive()
        return True


class ScriptedSpeechToText:
    """Test double: returns the text attached to each chunk's audio length."""

    def __init__(self, texts: list[str] | None = None, language: str = "it"):
        self.texts = list(texts or [])
        self.language = language
        self.calls: list[tuple[float, str]] = []

    def load(self) -> None:
        pass

    def transcribe(self, audio: np.ndarray, language_mode: str = "auto") -> TranscriptionResult:
        self.calls.append((len(audio) / 16_000, language_mode))
        text = self.texts.pop(0) if self.texts else f"frase di prova {len(self.calls)}"
        return TranscriptionResult(text, self.language)
