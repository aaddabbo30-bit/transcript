import numpy as np
import pytest

from call_assistant.audio import (
    TARGET_RATE,
    AudioRouter,
    Segmenter,
    WavFileInput,
    pcm16_to_float_mono,
    read_wav_mono_16k,
    resample,
)

from .conftest import SPEECH_WAV


def tone(freq: float, seconds: float, rate: int = TARGET_RATE, amp: float = 0.3) -> np.ndarray:
    t = np.arange(int(seconds * rate)) / rate
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def speech_like(seconds: float) -> np.ndarray:
    """A tone with syllable-rate loudness changes and a 150 ms breath every 2 s."""
    t = np.arange(int(seconds * TARGET_RATE)) / TARGET_RATE
    envelope = 0.2 + 0.8 * np.abs(np.sin(2 * np.pi * 3 * t))
    envelope[(t % 2.0) > 1.85] = 0.0
    return (0.3 * envelope * np.sin(2 * np.pi * 300 * t)).astype(np.float32)


def dominant_freq(x: np.ndarray, rate: int) -> float:
    spectrum = np.abs(np.fft.rfft(x * np.hanning(len(x))))
    return float(np.fft.rfftfreq(len(x), 1 / rate)[np.argmax(spectrum)])


def test_pcm16_stereo_to_mono():
    stereo = np.array([[1000, 3000], [-2000, 0]], dtype="<i2").reshape(-1).tobytes()
    mono = pcm16_to_float_mono(stereo, 2)
    assert mono.dtype == np.float32
    assert np.allclose(mono, [2000 / 32768, -1000 / 32768])


@pytest.mark.parametrize("src", [48000, 44100, 32000, 8000])
def test_resample_keeps_frequency_and_length(src):
    x = tone(440, 1.0, rate=src)
    y = resample(x, src, TARGET_RATE)
    assert abs(len(y) - TARGET_RATE) <= 1
    assert abs(dominant_freq(y, TARGET_RATE) - 440) < 3


def test_resample_filters_frequencies_above_nyquist():
    # 12 kHz is above the 8 kHz Nyquist limit of 16 kHz audio: it must be attenuated, not aliased.
    x = tone(12000, 1.0, rate=48000)
    y = resample(x, 48000, TARGET_RATE)
    assert np.sqrt(np.mean(y**2)) < 0.05 * np.sqrt(np.mean(x**2))


def feed(seg: Segmenter, audio: np.ndarray, block: int = 1600):
    chunks = []
    for i in range(0, len(audio), block):
        chunks += seg.push(audio[i : i + block], i / TARGET_RATE)
    last = seg.flush()
    return chunks + ([last] if last else [])


def test_segmenter_splits_on_pauses():
    silence = np.zeros(TARGET_RATE, dtype=np.float32)
    audio = np.concatenate([silence, tone(300, 1.5), silence, tone(500, 2.0), silence])
    chunks = feed(Segmenter("them"), audio)
    assert len(chunks) == 2
    assert chunks[0].start == pytest.approx(1.0, abs=0.35)
    assert chunks[0].duration == pytest.approx(1.5, abs=0.6)
    assert chunks[1].start == pytest.approx(3.5, abs=0.35)
    assert all(c.source == "them" for c in chunks)


def test_segmenter_ignores_clicks_and_noise():
    rng = np.random.default_rng(0)
    noise = rng.normal(0, 0.001, TARGET_RATE * 3).astype(np.float32)
    noise[16000:16080] = 0.5  # a 5 ms click
    assert feed(Segmenter("me"), noise) == []


def test_segmenter_adapts_to_background_noise():
    rng = np.random.default_rng(1)
    audio = rng.normal(0, 0.01, TARGET_RATE * 10).astype(np.float32)  # a noisy room, above abs threshold
    audio[6 * TARGET_RATE : 8 * TARGET_RATE] += speech_like(2.0)
    chunks = feed(Segmenter("me"), audio)
    # The noise level is learned within ~3 s; after that only the speech is detected.
    late = [c for c in chunks if c.start > 3.5]
    assert len(late) == 1
    assert late[0].start == pytest.approx(6.0, abs=0.4)
    assert late[0].duration < 3.0


def test_segmenter_cuts_long_speech():
    audio = speech_like(30.0)
    chunks = feed(Segmenter("them", max_chunk_s=12.0), audio)
    assert len(chunks) >= 3
    assert all(c.duration <= 12.1 for c in chunks)
    assert sum(c.duration for c in chunks) == pytest.approx(30.0, abs=1.0)


def test_continuous_hum_is_eventually_ignored():
    # A fan or music that never pauses becomes "background" instead of endless speech.
    chunks = feed(Segmenter("me"), tone(120, 40.0, amp=0.05))
    assert sum(c.duration for c in chunks) < 15


def test_segmenter_on_real_speech_fixture():
    audio = read_wav_mono_16k(SPEECH_WAV)
    chunks = feed(Segmenter("them"), audio)
    # Three sentences (the first one has a pause after the question) separated by 1.3 s of silence.
    assert 3 <= len(chunks) <= 5
    starts = [c.start for c in chunks]
    assert starts == sorted(starts)
    assert all(0.8 < c.duration < 12 for c in chunks)


def test_router_flushes_stale_utterance():
    now = [0.0]
    got = []
    router = AudioRouter(got.append, clock=lambda: now[0])
    speech = speech_like(1.5)
    for i in range(0, len(speech), 1600):
        now[0] = (i + 1600) / TARGET_RATE
        router.feed("them", speech[i : i + 1600], now[0])
    assert got == []  # still "speaking": no silence received
    now[0] += 0.5
    router.check_stale()
    assert got == []
    now[0] += 1.0  # loopback sent nothing for 1.5 s
    router.check_stale()
    assert len(got) == 1 and got[0].source == "them"


def test_wav_file_input_plays_whole_file():
    blocks = []
    inp = WavFileInput(SPEECH_WAV, speed=50)
    inp.start(lambda source, samples, t: blocks.append((source, len(samples), t)), clock=lambda: 0.0)
    assert inp.finished.wait(5)
    total = sum(n for _, n, _ in blocks)
    assert total == len(inp.audio)
    assert blocks[-1][2] == pytest.approx(total / TARGET_RATE)
