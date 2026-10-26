"""One call, from Start to Stop.

    audio input ──► AudioRouter (per-source segmenter) ──► TranscriptionWorker (Whisper)
                                                               │
    transcript replay (demo) ─────────────────────────────────►├──► TranscriptStore ──► UI
                                                               │
                         every ~25 s: InsightEngine (Claude) ◄─┘ ──► UI
    Stop: flush audio → finish transcription → summary (Claude) → files → UI

Worker threads never touch the UI: they put ``(kind, payload)`` events on a
queue that the window polls.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import queue
import threading
import time
from typing import Any, Callable

from .audio import ME, THEM, AudioChunk, AudioRouter
from .config import Paths, Settings
from .i18n import Translator
from .insights import Insight, InsightEngine
from .llm import LLM, CostTracker, LLMError
from .memory import Memory
from .summary import SummaryResult, finish_call
from .transcriber import SpeechToText, TranscriptionResult, TranscriptionWorker
from .transcript import TranscriptLine, TranscriptStore

log = logging.getLogger(__name__)

MIN_WORDS_FOR_FIRST_INSIGHT = 12
BACKLOG_WARNING = 6


class CallSession:
    def __init__(
        self,
        *,
        settings: Settings,
        paths: Paths,
        llm: LLM | None,
        audio_input: Any = None,
        speech: SpeechToText | None = None,
        replay: Any = None,
        events: queue.Queue | None = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        if audio_input is not None and speech is None:
            raise ValueError("audio input needs a speech-to-text engine")
        self.settings = settings
        self.paths = paths
        self.llm = llm
        self.audio_input = audio_input
        self.speech = speech
        self.replay = replay
        self.events: queue.Queue = events if events is not None else queue.Queue()
        self._clock = clock
        self.ui_language = settings["ui_language"]
        self.t = Translator(self.ui_language)
        self.language = settings["call_language"]
        self.interval = float(settings["insight_interval_seconds"])

        self.started_at = dt.datetime.now()
        self.call_dir = paths.calls / self.started_at.strftime("%Y-%m-%d_%H-%M-%S")
        labels = {ME: self.t("speaker_me"), THEM: self.t("speaker_them")}
        self.store = TranscriptStore(self.call_dir / "transcript.md", labels, self.t("sec_transcript").capitalize())
        self.memory = Memory(paths.memory, self.ui_language)
        self.costs = CostTracker(pricing=settings["pricing_usd_per_million_tokens"])
        self.insights: InsightEngine | None = None
        self.insight_log: list[Insight] = []

        self._t0: float | None = None
        self._stop = threading.Event()
        self._stopping = False
        self._force_insight = threading.Event()
        self._insight_busy = threading.Event()
        self._last_insight_at = 0.0
        self._insights_disabled = False
        self._backlog_warned = False
        self.worker: TranscriptionWorker | None = None
        self.router: AudioRouter | None = None
        self.result: SummaryResult | None = None
        self.done = threading.Event()

    # -- helpers ---------------------------------------------------------
    def elapsed(self) -> float:
        return 0.0 if self._t0 is None else self._clock() - self._t0

    def emit(self, kind: str, payload: Any = None) -> None:
        self.events.put((kind, payload))

    @property
    def running(self) -> bool:
        return self._t0 is not None and not self._stop.is_set()

    @property
    def stopping(self) -> bool:
        return self._stopping

    def set_language(self, language: str) -> None:
        self.language = language
        log.info("Call language set to %s", language)

    def request_insight(self) -> None:
        self._force_insight.set()

    def next_insight_in(self) -> float | None:
        if self.insights is None or self._insights_disabled:
            return None
        if self._insight_busy.is_set():
            return 0.0
        return max(0.0, self._last_insight_at + self.interval - self.elapsed())

    # -- start -----------------------------------------------------------
    def start(self) -> None:
        self.call_dir.mkdir(parents=True, exist_ok=True)
        self.memory.ensure()
        memory_text, truncated = self.memory.load_text()
        if truncated:
            self.emit("warning", self.t("memory_truncated", chars=len(memory_text)))
        if self.llm is not None:
            self.insights = InsightEngine(
                llm=self.llm,
                store=self.store,
                memory_text=memory_text,
                model=self.settings["insight_model"],
                effort=self.settings["insight_effort"],
                ui_language=self.ui_language,
                window_seconds=float(self.settings["insight_transcript_window_seconds"]),
                costs=self.costs,
            )
        else:
            self.emit("warning", self.t("no_api_key"))

        self._t0 = self._clock()
        self._last_insight_at = 0.0

        if self.speech is not None:
            self.emit("status", "loading")
            self.worker = TranscriptionWorker(self.speech, self._on_text, lambda: self.language, self._on_status)
            self.worker.start()
            self.router = AudioRouter(self.worker.submit, self.elapsed)

        devices: list[str] = []
        try:
            if self.audio_input is not None:
                devices += self.audio_input.start(self.router.feed, self.elapsed)
            if self.replay is not None:
                devices += self.replay.start(self.add_line, self.elapsed)
        except Exception as exc:
            log.exception("Could not start the audio")
            self.emit("error", str(exc))
        self.emit("audio", ", ".join(devices) if devices else self.t("audio_none"))

        threading.Thread(target=self._wait_model_then_listen, name="model-wait", daemon=True).start()
        threading.Thread(target=self._loop, name="session-loop", daemon=True).start()

    def _wait_model_then_listen(self) -> None:
        if self.worker is not None:
            self.worker.ready.wait()
            if self.worker.failed is not None:
                return
        self.emit("status", "listening")

    def _on_status(self, kind: str, message: str) -> None:
        self.emit(kind, message)

    # -- transcript --------------------------------------------------------
    def _on_text(self, chunk: AudioChunk, result: TranscriptionResult) -> None:
        self.add_line(TranscriptLine(chunk.start, chunk.source, result.text, result.language))

    def add_line(self, line: TranscriptLine) -> None:
        added = self.store.add(line)
        if added is not None:
            self.emit("transcript", added)

    # -- periodic work -----------------------------------------------------
    def _loop(self) -> None:
        while not self._stop.wait(0.25):
            if self.router is not None and not self._stopping:
                self.router.check_stale()
            if self.worker is not None:
                backlog = self.worker.backlog
                if backlog >= BACKLOG_WARNING and not self._backlog_warned:
                    self._backlog_warned = True
                    self.emit("warning", self.t("backlog", n=backlog))
                elif backlog < 2:
                    self._backlog_warned = False
            if self._insight_due():
                self._insight_busy.set()
                self.emit("insight_pending")
                threading.Thread(target=self._run_insight, name="insight", daemon=True).start()

    def _insight_due(self) -> bool:
        if self.insights is None or self._insights_disabled or self._insight_busy.is_set() or self._stopping:
            return False
        forced = self._force_insight.is_set()
        if not self.insights.has_news():
            self._force_insight.clear()
            return False
        if forced:
            return True
        if self.insights.last is None and self.store.word_count() < MIN_WORDS_FOR_FIRST_INSIGHT:
            return False
        return self.elapsed() - self._last_insight_at >= self.interval

    def _run_insight(self) -> None:
        self._force_insight.clear()
        now = self.elapsed()
        try:
            insight = self.insights.run(now, self.language)
            self.insight_log.append(insight)
            self._log_insight(insight)
            self.emit("insight", insight)
        except LLMError as exc:
            log.warning("Insight failed: %s", exc)
            if "401" in str(exc) or "403" in str(exc) or "credit" in str(exc):
                self._insights_disabled = True  # no point retrying every 25 s
            self.emit("insight_error", self.t("insight_error", error=exc))
        except Exception as exc:
            log.exception("Insight failed")
            self.emit("insight_error", self.t("insight_error", error=exc))
        finally:
            self._last_insight_at = now
            self.emit("cost", self.costs.total)
            self._insight_busy.clear()

    def _log_insight(self, insight: Insight) -> None:
        try:
            with (self.call_dir / "insights.jsonl").open("a", encoding="utf-8") as f:
                f.write(json.dumps(insight.to_dict(), ensure_ascii=False) + "\n")
        except OSError:
            log.exception("Could not write insights log")

    # -- stop --------------------------------------------------------------
    def stop(self, wait: bool = False) -> None:
        """Stop listening, finish transcribing, write the summary. Runs in the background."""
        if self._stopping:
            return
        self._stopping = True
        thread = threading.Thread(target=self._finish, name="finish", daemon=True)
        thread.start()
        if wait:
            thread.join()

    def _finish(self) -> None:
        self.emit("status", "stopping")
        duration = self.elapsed()
        for source in (self.audio_input, self.replay):
            if source is not None:
                try:
                    source.stop()
                except Exception:
                    log.exception("Error stopping input")
        if self.router is not None:
            self.router.flush_all()
        if self.worker is not None and not self.worker.finish(timeout=180):
            log.warning("Transcription did not finish in time; summarizing what is there")
        # Let a running insight finish so its cost is counted.
        for _ in range(200):
            if not self._insight_busy.is_set():
                break
            time.sleep(0.1)
        self._stop.set()

        self.emit("status", "summarizing")
        live_remember = self.insights.last.remember if self.insights and self.insights.last else []
        try:
            self.result = finish_call(
                llm=self.llm,
                store=self.store,
                memory=self.memory,
                call_dir=self.call_dir,
                live_remember=live_remember,
                started_at=self.started_at,
                duration_s=duration,
                model=self.settings["summary_model"],
                effort=self.settings["summary_effort"],
                ui_language=self.ui_language,
                costs=self.costs,
            )
            if self.result.error and self.llm is not None and self.store.lines():
                self.emit("warning", self.t("summary_failed", error=self.result.error))
            self.emit("cost", self.costs.total)
            self.emit("summary", self.result)
        except Exception as exc:
            log.exception("Could not save the call")
            self.emit("error", str(exc))
        finally:
            self.emit("status", "done")
            self.done.set()
