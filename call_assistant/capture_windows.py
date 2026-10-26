"""Live audio capture on Windows: your microphone + what the PC plays.

Computer audio is recorded with WASAPI *loopback* through PyAudioWPatch
(https://github.com/s0d3s/PyAudioWPatch, Apache-2.0), the same approach used
by ecoute (https://github.com/SevaSk/ecoute, MIT). No virtual audio cable or
"Stereo Mix" is needed.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from typing import Any, Callable

import numpy as np

from .audio import ME, THEM, pcm16_to_float_mono, resample

log = logging.getLogger(__name__)


class AudioCaptureError(RuntimeError):
    pass


def _import_pyaudio():
    try:
        import pyaudiowpatch as pyaudio  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover - Windows only
        raise AudioCaptureError(
            "PyAudioWPatch is not installed. Live capture works on Windows only; run install.ps1."
        ) from exc
    return pyaudio


def _matches(device: dict[str, Any], hint: str) -> bool:
    return bool(hint) and hint.lower() in str(device.get("name", "")).lower()


def list_devices() -> list[dict[str, Any]]:
    """All WASAPI devices, for the diagnostics command."""
    pyaudio = _import_pyaudio()
    p = pyaudio.PyAudio()
    try:
        wasapi = p.get_host_api_info_by_type(pyaudio.paWASAPI)
        out = []
        for i in range(p.get_device_count()):
            dev = p.get_device_info_by_index(i)
            if dev.get("hostApi") != wasapi["index"]:
                continue
            out.append(
                {
                    "index": dev["index"],
                    "name": dev["name"],
                    "inputs": dev["maxInputChannels"],
                    "outputs": dev["maxOutputChannels"],
                    "rate": int(dev["defaultSampleRate"]),
                    "loopback": bool(dev.get("isLoopbackDevice", False)),
                    "default_input": dev["index"] == wasapi["defaultInputDevice"],
                    "default_output": dev["index"] == wasapi["defaultOutputDevice"],
                }
            )
        return out
    finally:
        p.terminate()


class WindowsAudioInput:
    """Opens the microphone and the loopback of the speakers, converts the
    audio to 16 kHz mono and hands it to ``feed(source, samples, t_arrival)``."""

    def __init__(
        self,
        capture_microphone: bool = True,
        capture_system_audio: bool = True,
        microphone_hint: str = "",
        speaker_hint: str = "",
    ):
        self.capture_microphone = capture_microphone
        self.capture_system_audio = capture_system_audio
        self.microphone_hint = microphone_hint.strip()
        self.speaker_hint = speaker_hint.strip()
        self._pa = None
        self._streams: list[Any] = []
        self._formats: dict[str, tuple[int, int]] = {}  # source -> (channels, rate)
        self._queue: queue.Queue = queue.Queue(maxsize=2000)
        self._stop = threading.Event()
        self._worker: threading.Thread | None = None
        self.description: list[str] = []

    # -- device selection -------------------------------------------------
    def _find_microphone(self, pyaudio, wasapi: dict[str, Any]) -> dict[str, Any]:
        p = self._pa
        if self.microphone_hint:
            for i in range(p.get_device_count()):
                dev = p.get_device_info_by_index(i)
                if (
                    dev.get("hostApi") == wasapi["index"]
                    and dev["maxInputChannels"] > 0
                    and not dev.get("isLoopbackDevice", False)
                    and _matches(dev, self.microphone_hint)
                ):
                    return dev
            log.warning("No microphone matches %r; using the default one", self.microphone_hint)
        if wasapi.get("defaultInputDevice", -1) >= 0:
            return p.get_device_info_by_index(wasapi["defaultInputDevice"])
        return p.get_default_input_device_info()

    def _find_loopback(self, pyaudio, wasapi: dict[str, Any]) -> dict[str, Any]:
        p = self._pa
        loopbacks = list(p.get_loopback_device_info_generator())
        if not loopbacks:
            raise AudioCaptureError("No WASAPI loopback device found")
        if self.speaker_hint:
            for dev in loopbacks:
                if _matches(dev, self.speaker_hint):
                    return dev
            log.warning("No output device matches %r; using the default one", self.speaker_hint)
        speakers = p.get_device_info_by_index(wasapi["defaultOutputDevice"])
        if speakers.get("isLoopbackDevice", False):
            return speakers
        for dev in loopbacks:
            if speakers["name"] in dev["name"]:
                return dev
        return loopbacks[0]

    # -- streams ----------------------------------------------------------
    def _open(self, pyaudio, source: str, dev: dict[str, Any]) -> None:
        channels = max(1, int(dev["maxInputChannels"]))
        rate = int(dev["defaultSampleRate"])

        def callback(in_data, frame_count, time_info, status):
            try:
                self._queue.put_nowait((source, in_data, time.monotonic()))
            except queue.Full:
                pass  # the worker is stuck; dropping audio beats blocking the driver
            return (None, pyaudio.paContinue)

        stream = self._pa.open(
            format=pyaudio.paInt16,
            channels=channels,
            rate=rate,
            input=True,
            input_device_index=dev["index"],
            frames_per_buffer=max(256, rate // 10),
            stream_callback=callback,
        )
        self._streams.append(stream)
        self._formats[source] = (channels, rate)
        self.description.append(f"{'mic' if source == ME else 'PC'}: {dev['name']}")
        log.info("Opened %s: %s (%d ch, %d Hz)", source, dev["name"], channels, rate)

    def start(self, feed: Callable[[str, np.ndarray, float | None], None], clock: Callable[[], float]) -> list[str]:
        pyaudio = _import_pyaudio()
        self._pa = pyaudio.PyAudio()
        try:
            wasapi = self._pa.get_host_api_info_by_type(pyaudio.paWASAPI)
        except OSError as exc:
            raise AudioCaptureError("WASAPI is not available on this computer") from exc

        errors = []
        if self.capture_system_audio:
            try:
                self._open(pyaudio, THEM, self._find_loopback(pyaudio, wasapi))
            except Exception as exc:
                log.exception("Could not open the computer audio")
                errors.append(f"PC audio: {exc}")
        if self.capture_microphone:
            try:
                self._open(pyaudio, ME, self._find_microphone(pyaudio, wasapi))
            except Exception as exc:
                log.exception("Could not open the microphone")
                errors.append(f"microphone: {exc}")
        if not self._streams:
            self.stop()
            raise AudioCaptureError("; ".join(errors) or "no audio source enabled")

        # Convert in a worker thread: the driver callback must stay fast.
        # ``time.monotonic`` from the callback is translated to session time.
        offset = clock() - time.monotonic()

        def run() -> None:
            while True:
                try:
                    source, data, t = self._queue.get(timeout=0.2)
                except queue.Empty:
                    if self._stop.is_set():
                        break  # streams closed and everything received was processed
                    continue
                try:
                    channels, rate = self._formats[source]
                    samples = resample(pcm16_to_float_mono(data, channels), rate)
                    feed(source, samples, t + offset)
                except Exception:
                    log.exception("Audio processing failed for one block")

        self._worker = threading.Thread(target=run, name="audio-convert", daemon=True)
        self._worker.start()
        for stream in self._streams:
            stream.start_stream()
        return self.description + [f"error: {e}" for e in errors]

    def stop(self) -> None:
        # Close the streams first, then let the worker finish the queued audio,
        # so the last words of the call are not lost.
        for stream in self._streams:
            try:
                stream.stop_stream()
                stream.close()
            except Exception:
                log.debug("Error closing stream", exc_info=True)
        self._streams.clear()
        self._stop.set()
        if self._worker:
            self._worker.join(timeout=5)
        if self._pa is not None:
            try:
                self._pa.terminate()
            except Exception:
                pass
            self._pa = None


def measure_levels(seconds: float = 5.0, **kwargs: Any) -> tuple[dict[str, float], list[str]]:
    """Record for a few seconds; returns (peak level per source, opened devices and errors)."""
    peaks: dict[str, float] = {}

    def feed(source: str, samples: np.ndarray, t: float | None) -> None:
        if len(samples):
            peaks[source] = max(peaks.get(source, 0.0), float(np.max(np.abs(samples))))

    t0 = time.monotonic()
    inp = WindowsAudioInput(**kwargs)
    devices = inp.start(feed, lambda: time.monotonic() - t0)
    try:
        time.sleep(seconds)
    finally:
        inp.stop()
    return peaks, devices
