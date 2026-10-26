// One call, from Start to Stop: audio -> segmenter -> Whisper -> transcript ->
// live insights every ~25 s -> on Stop, summary + memory proposals.
// The page receives (kind, payload) events through onEvent.

import { AudioRouter, ME, THEM } from "./segmenter.js";
import { CostTracker, LLMError } from "./claude.js";
import { INSIGHT_SCHEMA, SUMMARY_SCHEMA, insightSystem, insightUser, summarySystem, summaryUser } from "./prompts.js";
import { TranscriptStore, cleanTranscription, fmtTime } from "./transcript.js";

const LANGUAGE_NAMES = { it: "Italian", en: "English" };
const CALL_LANGUAGE_NAMES = { auto: "automatic (Italian or English)", it: "Italian", en: "English" };
const MIN_WORDS_FOR_FIRST_INSIGHT = 12;
const BACKLOG_WARNING = 6;
const SILENT_SHARED_AFTER_S = 45;

export class CallSession {
  constructor({ settings, memory, llm, transcriber = null, capture = null, replay = null, onEvent, clock }) {
    this.settings = settings;
    this.memory = memory;
    this.llm = llm;
    this.transcriber = transcriber;
    this.capture = capture;
    this.replay = replay;
    this.onEvent = onEvent || (() => {});
    this.clock = clock || (() => performance.now() / 1000);
    this.language = settings.callLanguage || "auto";
    this.interval = settings.insightInterval || 25;
    this.store = new TranscriptStore();
    this.costs = new CostTracker();
    this.startedAt = new Date();
    this.t0 = null;
    this.running = false;
    this.stopping = false;
    this.done = false;
    this.lastInsight = null;
    this.lastInsightSeq = 0;
    this.lastInsightAt = 0;
    this.insightBusy = false;
    this.forceInsight = false;
    this.insightsDisabled = !llm;
    this.backlogWarned = false;
    this.sharedWarned = false;
    this.pendingTranscriptions = new Set();
    this.result = null;
  }

  emit(kind, payload) {
    try {
      this.onEvent(kind, payload);
    } catch (err) {
      console.error(err);
    }
  }

  elapsed() {
    return this.t0 === null ? 0 : this.clock() - this.t0;
  }

  setLanguage(lang) {
    this.language = lang;
  }

  requestInsight() {
    this.forceInsight = true;
  }

  nextInsightIn() {
    if (this.insightsDisabled) return null;
    if (this.insightBusy) return 0;
    return Math.max(0, this.lastInsightAt + this.interval - this.elapsed());
  }

  async start() {
    const { text, truncated } = this.memory.loadText();
    this.memoryText = text;
    if (truncated) this.emit("warning", "memory_truncated");
    if (!this.llm) this.emit("warning", "no_api_key");
    this.system = insightSystem(text, LANGUAGE_NAMES[this.settings.uiLanguage] || "Italian");
    this.t0 = this.clock();
    this.running = true;
    this.router = new AudioRouter((chunk) => this.transcribe(chunk), () => this.elapsed());
    this.timer = setInterval(() => this.tick(), 250);

    if (this.transcriber) {
      this.emit("status", "loading");
      this.transcriberReady = this.transcriber.load().then(
        (device) => {
          this.emit("model_ready", device);
          if (!this.stopping) this.emit("status", "listening");
        },
        (err) => {
          this.transcriberFailed = err;
          this.emit("error_text", err.code === "model_download" ? "model_download_failed" : ["whisper_failed", { error: err.message }]);
        },
      );
    } else {
      this.emit("status", "listening");
    }
    const devices = [];
    if (this.capture) devices.push(...(await this.capture.start((s, x, t) => this.router.feed(s, x, t), () => this.elapsed())));
    if (this.replay) devices.push(...this.replay.start((line) => this.addLine(line), () => this.elapsed()));
    this.emit("audio", devices.join(" · "));
  }

  async transcribe(chunk) {
    if (!this.transcriber || this.transcriberFailed) return;
    const job = (async () => {
      await this.transcriberReady;
      if (this.transcriberFailed) return;
      const text = cleanTranscription(await this.transcriber.transcribe(chunk.audio, this.language));
      if (text) this.addLine({ t: chunk.start, speaker: chunk.source, text });
    })();
    this.pendingTranscriptions.add(job);
    job.finally(() => this.pendingTranscriptions.delete(job));
  }

  addLine(line) {
    const added = this.store.add(line);
    if (added) this.emit("transcript", added);
  }

  tick() {
    if (!this.running) return;
    if (!this.stopping) this.router.checkStale();
    const backlog = this.pendingTranscriptions.size;
    if (backlog >= BACKLOG_WARNING && !this.backlogWarned) {
      this.backlogWarned = true;
      this.emit("warning", ["backlog", { n: backlog }]);
    } else if (backlog < 2) {
      this.backlogWarned = false;
    }
    this.checkSharedAudio();
    if (this.insightDue()) this.runInsight();
  }

  checkSharedAudio() {
    if (this.sharedWarned || !this.capture || !this.capture.wantShared || this.elapsed() < SILENT_SHARED_AFTER_S) return;
    const lines = this.store.lines;
    if (lines.filter((l) => l.speaker === ME).length >= 3 && !lines.some((l) => l.speaker === THEM)) {
      this.sharedWarned = true;
      this.emit("warning", "no_system_audio");
    }
  }

  insightDue() {
    if (this.insightsDisabled || this.insightBusy || this.stopping) return false;
    const hasNews = this.store.seq > this.lastInsightSeq;
    if (!hasNews) {
      this.forceInsight = false;
      return false;
    }
    if (this.forceInsight) return true;
    if (!this.lastInsight && this.store.wordCount() < MIN_WORDS_FOR_FIRST_INSIGHT) return false;
    return this.elapsed() - this.lastInsightAt >= this.interval;
  }

  buildInsightPrompt(now) {
    const lines = this.store.window(this.settings.transcriptWindow || 240, now);
    return insightUser({
      elapsed: fmtTime(now),
      transcript: this.store.text(lines, this.lastInsightSeq) || "(nothing said yet)",
      previousSummary: this.lastInsight ? this.lastInsight.running_summary : "",
      previousRemember: this.lastInsight ? this.lastInsight.remember : [],
      callLanguage: CALL_LANGUAGE_NAMES[this.language] || this.language,
    });
  }

  async runInsight() {
    this.insightBusy = true;
    this.forceInsight = false;
    this.emit("insight_pending");
    const now = this.elapsed();
    const seq = this.store.seq;
    try {
      const reply = await this.llm.completeJson({
        model: this.settings.insightModel,
        system: this.system,
        user: this.buildInsightPrompt(now),
        schema: INSIGHT_SCHEMA,
        maxTokens: 4000,
        effort: "low",
        timeoutMs: 45000,
      });
      const d = reply.data;
      const insight = {
        topic: String(d.topic || "").trim(),
        suggestions: (d.suggestions || [])
          .filter((s) => s && String(s.text || "").trim())
          .slice(0, 3)
          .map((s) => ({ kind: s.kind || "comment", text: String(s.text).trim() })),
        remember: (d.remember || []).map((r) => String(r).trim()).filter(Boolean).slice(0, 6),
        running_summary: String(d.running_summary || "").trim(),
        at: now,
        cost: this.costs.add("live", reply.model, reply.usage),
      };
      this.lastInsight = insight;
      this.lastInsightSeq = seq;
      this.emit("insight", insight);
    } catch (err) {
      if (err instanceof LLMError && err.fatal) this.insightsDisabled = true;
      this.emit("warning", ["insight_error", { error: err.message }]);
    } finally {
      this.lastInsightAt = now;
      this.insightBusy = false;
      this.emit("cost", this.costs);
    }
  }

  /** Start failed (e.g. the share dialog was cancelled): clean up without saving anything. */
  abort() {
    clearInterval(this.timer);
    this.running = false;
    this.stopping = true;
    this.done = true;
    if (this.capture) this.capture.stop();
    if (this.replay) this.replay.stop();
    if (this.transcriber) this.transcriber.dispose();
  }

  async waitFor(predicate, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  }

  /** Stop listening, finish transcribing, write the summary. */
  async stop() {
    if (this.stopping) return this.result;
    this.stopping = true;
    this.emit("status", "stopping");
    const duration = this.elapsed();
    if (this.capture) this.capture.stop();
    if (this.replay) this.replay.stop();
    this.router.flushAll();
    await this.waitFor(() => this.pendingTranscriptions.size === 0, 120000);
    await this.waitFor(() => !this.insightBusy, 20000);
    clearInterval(this.timer);
    this.running = false;
    if (this.transcriber) this.transcriber.dispose();

    this.emit("status", "summarizing");
    const liveRemember = this.lastInsight ? this.lastInsight.remember : [];
    let data = {};
    let error = null;
    if (!this.store.length) error = "empty transcript";
    else if (!this.llm) error = "no API key";
    else {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const reply = await this.llm.completeJson({
          model: this.settings.summaryModel,
          system: summarySystem(this.memoryText, this.memory.names(), LANGUAGE_NAMES[this.settings.uiLanguage] || "Italian", today),
          user: summaryUser(
            `Call started ${this.startedAt.toISOString().slice(0, 16).replace("T", " ")}, duration ${fmtTime(duration)}.`,
            this.store.text(),
            liveRemember,
          ),
          schema: SUMMARY_SCHEMA,
          maxTokens: 16000,
          effort: "medium",
          timeoutMs: 300000,
          cacheSystem: false, // one request per call: caching would only cost more
        });
        data = reply.data;
        this.costs.add("summary", reply.model, reply.usage);
      } catch (err) {
        error = err.message;
      }
    }
    this.result = {
      id: this.startedAt.toISOString(),
      startedAt: this.startedAt.toISOString(),
      durationS: Math.round(duration),
      data,
      error,
      liveRemember,
      cost: this.costs.total,
      costBreakdown: { ...this.costs.byPurpose },
      transcript: this.store.lines.map(({ t, speaker, text }) => ({ t, speaker, text })),
      proposals: (data.memory_updates || []).filter((u) => u && u.file && u.content),
    };
    this.done = true;
    this.emit("cost", this.costs);
    this.emit("summary", this.result);
    this.emit("status", "done");
    return this.result;
  }
}

/** Replays a written transcript as a live call (demo mode). */
export class TranscriptReplay {
  constructor(lines, speed = 1) {
    this.lines = lines;
    this.speed = Math.max(0.1, speed);
    this.timers = [];
  }
  start(addLine, clock) {
    this.finished = new Promise((resolve) => {
      this.lines.forEach((line, i) => {
        this.timers.push(
          setTimeout(() => {
            addLine({ t: clock(), speaker: line.speaker, text: line.text });
            if (i === this.lines.length - 1) resolve();
          }, (line.t * 1000) / this.speed),
        );
      });
      if (!this.lines.length) resolve();
    });
    return [`demo x${this.speed}`];
  }
  stop() {
    this.timers.forEach(clearTimeout);
  }
}
