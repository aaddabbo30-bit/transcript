import threading
from types import SimpleNamespace

import numpy as np

from call_assistant.audio import AudioChunk
from call_assistant.transcriber import (
    ScriptedSpeechToText,
    TranscriptionWorker,
    WhisperTranscriber,
    clean_text,
    collapse_repetitions,
    keep_segment,
)


class FakeWhisperModel:
    """Mimics faster_whisper.WhisperModel.transcribe(): (segments generator, info)."""

    def __init__(self, size, **kwargs):
        self.size = size
        self.kwargs = kwargs
        self.calls = []
        self.detected = "it"
        self.probs = [("it", 0.6), ("en", 0.3)]
        self.segments = [SimpleNamespace(text=" Ciao, come stai?", no_speech_prob=0.01, avg_logprob=-0.2)]

    def transcribe(self, audio, language=None, **kwargs):
        self.calls.append((language, kwargs))
        info = SimpleNamespace(language=language or self.detected, all_language_probs=self.probs)
        return iter(self.segments), info


def make(model: FakeWhisperModel | None = None, **kw):
    holder = {}

    def factory(size, **kwargs):
        holder["model"] = model or FakeWhisperModel(size, **kwargs)
        holder["model"].kwargs = kwargs
        return holder["model"]

    return WhisperTranscriber(model_factory=factory, **kw), holder


AUDIO = np.zeros(16000, dtype=np.float32)


def test_transcribe_uses_fixed_language_and_safe_options():
    tr, holder = make(model_size="small", beam_size=1)
    result = tr.transcribe(AUDIO, "it")
    assert result.text == "Ciao, come stai?"
    assert result.language == "it"
    language, kwargs = holder["model"].calls[0]
    assert language == "it"
    assert kwargs["vad_filter"] is True
    assert kwargs["condition_on_previous_text"] is False
    assert holder["model"].kwargs["compute_type"] == "int8"


def test_auto_mode_keeps_italian_or_english():
    tr, holder = make()
    assert tr.transcribe(AUDIO, "auto").language == "it"
    assert len(holder["model"].calls) == 1


def test_auto_mode_reruns_when_another_language_is_detected():
    model = FakeWhisperModel("small")
    model.detected = "es"
    model.probs = [("es", 0.5), ("en", 0.3), ("it", 0.2)]
    tr, holder = make(model)
    result = tr.transcribe(AUDIO, "auto")
    assert result.language == "en"
    assert [c[0] for c in model.calls] == [None, "en"]


def test_cuda_failure_falls_back_to_cpu():
    attempts = []

    def factory(size, **kwargs):
        attempts.append(kwargs["device"])
        if kwargs["device"] == "cuda":
            raise RuntimeError("cuDNN missing")
        return FakeWhisperModel(size, **kwargs)

    tr = WhisperTranscriber(device="cuda", compute_type="float16", model_factory=factory)
    tr.load()
    assert attempts == ["cuda", "cpu"]


def test_hallucinations_are_filtered():
    assert not keep_segment("Sottotitoli creati dalla comunità Amara.org")
    assert not keep_segment("Sottotitoli e revisione a cura di QTSS")
    assert not keep_segment("Grazie.", no_speech_prob=0.5)
    assert keep_segment("Grazie.", no_speech_prob=0.05, avg_logprob=-0.3)  # really said
    assert not keep_segment("Thank you for watching!", avg_logprob=-1.1)
    assert not keep_segment("Bla", no_speech_prob=0.95)
    assert keep_segment("Ci vediamo alle otto")


def test_whole_transcription_drops_hallucinated_segments():
    model = FakeWhisperModel("small")
    model.segments = [
        SimpleNamespace(text=" Ci vediamo sabato.", no_speech_prob=0.02, avg_logprob=-0.3),
        SimpleNamespace(text=" Sottotitoli creati dalla comunità Amara.org", no_speech_prob=0.1, avg_logprob=-0.4),
    ]
    tr, _ = make(model)
    assert tr.transcribe(AUDIO, "it").text == "Ci vediamo sabato."


def test_collapse_repetitions():
    assert collapse_repetitions("ok ok ok ok ok") == "ok ok"
    assert collapse_repetitions("e poi e poi e poi e poi andiamo") == "e poi e poi andiamo"
    assert collapse_repetitions("una frase normale") == "una frase normale"
    assert clean_text("  ciao   ciao  ") == "ciao ciao"


def test_worker_transcribes_in_order_and_finishes():
    engine = ScriptedSpeechToText(["uno", "due", "tre"])
    got = []
    worker = TranscriptionWorker(engine, lambda chunk, res: got.append((chunk.start, res.text)), lambda: "it")
    worker.start()
    for i in range(3):
        worker.submit(AudioChunk("them", AUDIO, float(i), float(i) + 1))
    assert worker.finish(timeout=5)
    assert got == [(0.0, "uno"), (1.0, "due"), (2.0, "tre")]
    assert [c[1] for c in engine.calls] == ["it", "it", "it"]


def test_worker_reports_model_load_failure():
    class Broken(ScriptedSpeechToText):
        def load(self):
            raise OSError("model download failed")

    statuses = []
    worker = TranscriptionWorker(Broken(), lambda *a: None, lambda: "auto", lambda k, m: statuses.append((k, m)))
    worker.start()
    assert worker.ready.wait(2)
    assert isinstance(worker.failed, OSError)
    assert statuses and statuses[0][0] == "error"


def test_worker_survives_a_failing_chunk():
    class Flaky(ScriptedSpeechToText):
        def transcribe(self, audio, language_mode="auto"):
            if not self.calls:
                self.calls.append(None)
                raise RuntimeError("boom")
            return super().transcribe(audio, language_mode)

    done = threading.Event()
    worker = TranscriptionWorker(Flaky(["ok"]), lambda c, r: done.set(), lambda: "it")
    worker.start()
    worker.submit(AudioChunk("me", AUDIO, 0, 1))
    worker.submit(AudioChunk("me", AUDIO, 1, 2))
    assert done.wait(2)
    worker.finish(2)


def test_worker_survives_a_failing_callback():
    calls = []

    def on_text(chunk, result):
        calls.append(result.text)
        if len(calls) == 1:
            raise OSError("disk full")

    worker = TranscriptionWorker(ScriptedSpeechToText(["a", "b"]), on_text, lambda: "it")
    worker.start()
    worker.submit(AudioChunk("me", AUDIO, 0, 1))
    worker.submit(AudioChunk("me", AUDIO, 1, 2))
    assert worker.finish(timeout=5)
    assert calls == ["a", "b"]
