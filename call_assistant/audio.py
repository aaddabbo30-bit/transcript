"""Audio helpers: format conversion, resampling and utterance segmentation.

Platform independent (numpy only), so it is fully tested in CI. Windows
capture lives in ``capture_windows.py``.
"""

from __future__ import annotations

import collections
import threading
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np

TARGET_RATE = 16_000  # what Whisper expects

ME = "me"  # the user's microphone
THEM = "them"  # computer audio: the other people in the call, or a video


@dataclass
class AudioChunk:
    """One utterance, ready for transcription."""

    source: str
    audio: np.ndarray  # float32, mono, 16 kHz
    start: float  # seconds since the session started
    end: float

    @property
    def duration(self) -> float:
        return len(self.audio) / TARGET_RATE


def pcm16_to_float_mono(data: bytes, channels: int) -> np.ndarray:
    samples = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        usable = len(samples) - len(samples) % channels
        samples = samples[:usable].reshape(-1, channels).mean(axis=1)
    return samples


def _lowpass_kernel(cutoff: float, taps: int = 63) -> np.ndarray:
    """Windowed-sinc low-pass FIR. ``cutoff`` is a fraction of the sample rate (0..0.5)."""
    n = np.arange(taps) - (taps - 1) / 2
    kernel = np.sinc(2 * cutoff * n) * np.hamming(taps)
    return (kernel / kernel.sum()).astype(np.float32)


_KERNELS: dict[tuple[int, int], np.ndarray] = {}


def resample(samples: np.ndarray, src_rate: int, dst_rate: int = TARGET_RATE) -> np.ndarray:
    """Resample mono float32 audio. Low-pass filters first when downsampling.

    Each call is independent (no state across blocks); with 100 ms blocks the
    edge effects are negligible for speech recognition.
    """
    samples = np.asarray(samples, dtype=np.float32)
    if src_rate == dst_rate or len(samples) == 0:
        return samples
    if dst_rate < src_rate:
        key = (src_rate, dst_rate)
        if key not in _KERNELS:
            _KERNELS[key] = _lowpass_kernel(0.45 * dst_rate / src_rate)
        samples = np.convolve(samples, _KERNELS[key], mode="same").astype(np.float32)
    n_out = int(round(len(samples) * dst_rate / src_rate))
    if n_out <= 0:
        return np.zeros(0, dtype=np.float32)
    x_old = np.arange(len(samples), dtype=np.float64) / src_rate
    x_new = np.arange(n_out, dtype=np.float64) / dst_rate
    return np.interp(x_new, x_old, samples).astype(np.float32)


class Segmenter:
    """Splits a continuous audio stream into utterances, cutting at pauses.

    A simple energy detector with an adaptive noise floor that follows quiet
    frames quickly and rises slowly (about +35%/s), so steady background noise
    is learned in a few seconds while speech, which always has short pauses,
    is not. Whisper's own VAD filter then removes any non-speech left inside a
    chunk.
    """

    def __init__(
        self,
        source: str,
        rate: int = TARGET_RATE,
        frame_ms: int = 30,
        start_ms: int = 90,
        silence_end_ms: int = 700,
        max_chunk_s: float = 12.0,
        pre_roll_ms: int = 300,
        min_voiced_ms: int = 250,
        abs_threshold: float = 0.004,
        snr: float = 3.0,
    ):
        self.source = source
        self.rate = rate
        self.frame_len = int(rate * frame_ms / 1000)
        self.frame_s = self.frame_len / rate
        self.start_frames = max(1, start_ms // frame_ms)
        self.end_frames = max(1, silence_end_ms // frame_ms)
        self.max_frames = int(max_chunk_s * 1000 / frame_ms)
        self.min_voiced = max(1, min_voiced_ms // frame_ms)
        self.abs_threshold = abs_threshold
        self.snr = snr
        self._pre_roll: collections.deque = collections.deque(maxlen=max(1, pre_roll_ms // frame_ms))
        self.noise = abs_threshold / snr  # assume a quiet start
        self._pending = np.zeros(0, dtype=np.float32)
        self._pending_t = 0.0  # session time of the first pending sample
        self._frames: list[tuple[np.ndarray, float, float]] = []  # (samples, t, rms)
        self._in_speech = False
        self._speech_run = 0
        self._silence_run = 0
        self._voiced = 0
        self.last_audio_time = 0.0  # session time of the newest sample received

    # -- detection -------------------------------------------------------
    def threshold(self) -> float:
        return max(self.abs_threshold, self.noise * self.snr)

    def _track_noise(self, rms: float) -> None:
        if rms < self.noise:
            self.noise += 0.2 * (rms - self.noise)
        else:
            self.noise = min(rms, self.noise * 1.01)

    def push(self, samples: np.ndarray, t_start: float) -> list[AudioChunk]:
        """Feed audio that starts at session time ``t_start``. Returns finished chunks."""
        samples = np.asarray(samples, dtype=np.float32)
        if len(self._pending) == 0 or abs(t_start - (self._pending_t + len(self._pending) / self.rate)) > 0.5:
            # First block, or a gap (loopback sends nothing during silence): realign the clock.
            if len(self._pending) == 0:
                self._pending_t = t_start
            else:
                self._pending = np.zeros(0, dtype=np.float32)
                self._pending_t = t_start
        self._pending = np.concatenate([self._pending, samples])
        self.last_audio_time = self._pending_t + len(self._pending) / self.rate
        out: list[AudioChunk] = []
        while len(self._pending) >= self.frame_len:
            frame = self._pending[: self.frame_len]
            t = self._pending_t
            self._pending = self._pending[self.frame_len :]
            self._pending_t += self.frame_s
            chunk = self._process_frame(frame, t)
            if chunk is not None:
                out.append(chunk)
        return out

    def _process_frame(self, frame: np.ndarray, t: float) -> AudioChunk | None:
        rms = float(np.sqrt(np.mean(frame * frame)))
        is_speech = rms > self.threshold()
        self._track_noise(rms)
        if not self._in_speech:
            self._pre_roll.append((frame, t, rms))
            self._speech_run = self._speech_run + 1 if is_speech else 0
            if self._speech_run >= self.start_frames:
                self._in_speech = True
                self._frames = list(self._pre_roll)
                self._pre_roll.clear()
                self._voiced = self._speech_run
                self._silence_run = 0
            return None

        self._frames.append((frame, t, rms))
        if is_speech:
            self._voiced += 1
            self._silence_run = 0
        else:
            self._silence_run += 1
        if self._silence_run >= self.end_frames:
            # Keep ~200 ms of the trailing silence, drop the rest.
            keep = len(self._frames) - self._silence_run + min(self._silence_run, 7)
            return self._emit(keep, end_of_speech=True)
        if len(self._frames) >= self.max_frames:
            return self._emit(self._quietest_cut(), end_of_speech=False)
        return None

    def _quietest_cut(self) -> int:
        """Index to cut a too-long utterance: the quietest frame in its last 1.5 s."""
        window = min(len(self._frames) - 1, int(1.5 / self.frame_s))
        start = len(self._frames) - window
        rms = [f[2] for f in self._frames[start:]]
        return start + int(np.argmin(rms)) + 1

    def _emit(self, keep: int, end_of_speech: bool) -> AudioChunk | None:
        frames, rest = self._frames[:keep], self._frames[keep:]
        voiced = self._voiced
        if end_of_speech:
            self._in_speech = False
            self._frames = []
            self._speech_run = 0
            self._voiced = 0
        else:
            self._frames = rest
            self._voiced = sum(1 for f in rest if f[2] > self.abs_threshold)
        self._silence_run = 0
        if not frames or voiced < self.min_voiced:
            return None
        audio = np.concatenate([f[0] for f in frames])
        start = frames[0][1]
        return AudioChunk(self.source, audio, start, start + len(audio) / self.rate)

    def flush(self) -> AudioChunk | None:
        """Close the current utterance (end of call, or the stream went quiet)."""
        if not self._in_speech:
            self._pre_roll.clear()
            return None
        return self._emit(len(self._frames), end_of_speech=True)

    @property
    def in_speech(self) -> bool:
        return self._in_speech


class AudioRouter:
    """Receives audio blocks from any input, segments them per source and
    passes finished utterances on. Also closes utterances when a source stops
    sending data (WASAPI loopback delivers nothing while the PC is silent)."""

    def __init__(self, on_chunk: Callable[[AudioChunk], None], clock: Callable[[], float]):
        self._on_chunk = on_chunk
        self._clock = clock  # session time in seconds
        self._segmenters: dict[str, Segmenter] = {}
        self._lock = threading.Lock()
        self.levels: dict[str, float] = {}

    def feed(self, source: str, samples_16k: np.ndarray, t_arrival: float | None = None) -> None:
        if t_arrival is None:
            t_arrival = self._clock()
        t_start = t_arrival - len(samples_16k) / TARGET_RATE
        with self._lock:
            seg = self._segmenters.get(source)
            if seg is None:
                seg = self._segmenters[source] = Segmenter(source)
            chunks = seg.push(samples_16k, t_start)
            if len(samples_16k):
                self.levels[source] = float(np.sqrt(np.mean(samples_16k * samples_16k)))
        for chunk in chunks:
            self._on_chunk(chunk)

    def check_stale(self, max_gap: float = 0.9) -> None:
        now = self._clock()
        stale: list[AudioChunk] = []
        with self._lock:
            for seg in self._segmenters.values():
                if seg.in_speech and now - seg.last_audio_time > max_gap:
                    chunk = seg.flush()
                    if chunk is not None:
                        stale.append(chunk)
        for chunk in stale:
            self._on_chunk(chunk)

    def flush_all(self) -> None:
        with self._lock:
            chunks = [seg.flush() for seg in self._segmenters.values()]
        for chunk in chunks:
            if chunk is not None:
                self._on_chunk(chunk)


def read_wav_mono_16k(path: Path) -> np.ndarray:
    """Read a PCM WAV file (8/16/32-bit) as float32 mono at 16 kHz."""
    with wave.open(str(path), "rb") as wf:
        channels, width, rate = wf.getnchannels(), wf.getsampwidth(), wf.getframerate()
        raw = wf.readframes(wf.getnframes())
    if width == 2:
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif width == 4:
        samples = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
    elif width == 1:
        samples = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        raise ValueError(f"Unsupported WAV sample width: {width} bytes")
    if channels > 1:
        samples = samples[: len(samples) - len(samples) % channels].reshape(-1, channels).mean(axis=1)
    return resample(samples, rate, TARGET_RATE)


class WavFileInput:
    """Plays a WAV file into the pipeline as if it were live computer audio.
    Used by the demo mode and the tests (no sound card needed)."""

    def __init__(self, path: Path, source: str = THEM, speed: float = 1.0, block_ms: int = 100):
        self.audio = read_wav_mono_16k(path)
        self.source = source
        self.speed = max(0.1, speed)
        self.block = int(TARGET_RATE * block_ms / 1000)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.finished = threading.Event()
        self.description = f"file {Path(path).name}"

    def start(self, feed: Callable[[str, np.ndarray, float | None], None], clock: Callable[[], float]) -> list[str]:
        def run() -> None:
            t0 = clock()
            sent = 0
            while not self._stop.is_set() and sent < len(self.audio):
                block = self.audio[sent : sent + self.block]
                sent += len(block)
                # Timestamps follow the file, so the transcript times match it.
                feed(self.source, block, t0 + sent / TARGET_RATE)
                time.sleep(len(block) / TARGET_RATE / self.speed)
            self.finished.set()

        self._thread = threading.Thread(target=run, name="wav-input", daemon=True)
        self._thread.start()
        return [self.description]

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
