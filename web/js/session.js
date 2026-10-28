// One call, from Start to Stop: audio -> segmenter -> Whisper -> transcript.
// Claude reads the transcript from the bridge (see bridge.js) or from what
// «Ask Claude» copies; this file only listens and writes it down.
// The page receives (kind, payload) events through onEvent.

import { AudioRouter, ME, TARGET_RATE, THEM } from "./segmenter.js";
import { TranscriptStore, cleanTranscription } from "./transcript.js";
import { glossaryPrompt, judgeSegment } from "./whisper-core.js";

const SILENT_SHARED_AFTER_S = 45;
// Whisper always works on a 30 s window, however short the audio: when it is
// busy, the utterances that pile up are joined and transcribed together.
const MERGE_MAX_S = 27;
const MERGE_GAP_S = 12; // utterances further apart than this stay separate lines
const JOIN_PAUSE_S = 0.25; // silence put between joined utterances
const LAG_WARNING_S = 30; // text this late, for a while: the computer is too slow for the model
const ECHO_WARNING = 3; // microphone echoes dropped before telling the user

export class CallSession {
  constructor({ settings, transcriber = null, capture = null, replay = null, onEvent, clock }) {
    this.settings = settings;
    this.transcriber = transcriber;
    this.capture = capture;
    this.replay = replay;
    this.onEvent = onEvent || (() => {});
    this.clock = clock || (() => performance.now() / 1000);
    this.language = settings.callLanguage || "auto";
    this.store = new TranscriptStore();
    this.startedAt = new Date();
    this.t0 = null;
    this.running = false;
    this.stopping = false;
    this.done = false;
    this.lagWarned = false;
    this.sharedWarned = false;
    this.echoWarned = false;
    this.pendingTranscriptions = new Set();
    this.queue = []; // utterances waiting for Whisper
    this.busy = false; // Whisper is transcribing a batch
    this.spans = []; // recent utterances {source, start, end}: who spoke when
    this.languages = { [ME]: [], [THEM]: [] }; // languages Whisper heard lately, per speaker
    this.glossary = "";
    this.stats = { echoes: 0, dropped: 0, batches: 0, joined: 0, audioS: 0, workMs: 0 };
    this.lag = 0;
    this.lateSince = null;
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

  /** Names and terms of the meeting (from the briefing): Whisper spells them right. */
  setGlossary(terms) {
    this.glossary = glossaryPrompt(terms);
  }

  async start() {
    this.t0 = this.clock();
    this.running = true;
    this.router = new AudioRouter((chunk) => this.transcribe(chunk), () => this.elapsed(), {
      onEcho: () => this.echoDropped(),
    });
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
          this.emit(
            "error_text",
            err.code === "model_download" && err.url
              ? ["model_download_failed", { url: err.url }]
              : ["whisper_failed", { error: err.message }],
          );
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

  /** A new utterance: queue it; Whisper takes the oldest when it is free. */
  transcribe(chunk) {
    if (!this.transcriber || this.transcriberFailed) return;
    this.spans.push({ source: chunk.source, start: chunk.start, end: chunk.end });
    if (this.spans.length > 400) this.spans.splice(0, this.spans.length - 300);
    this.queue.push(chunk);
    this.pump();
  }

  echoDropped() {
    this.stats.echoes++;
    if (this.stats.echoes >= ECHO_WARNING && !this.echoWarned) {
      this.echoWarned = true;
      this.emit("warning", "echo");
    }
  }

  pump() {
    if (this.busy || !this.queue.length) return;
    const batch = this.nextBatch();
    this.busy = true;
    const job = this.runBatch(batch)
      .catch((err) => console.error(err))
      .finally(() => {
        this.busy = false;
        this.pendingTranscriptions.delete(job);
        this.pump();
      });
    this.pendingTranscriptions.add(job);
  }

  /** The oldest waiting utterance, joined with the next ones of the same speaker when nobody else spoke in between. */
  nextBatch() {
    this.queue.sort((a, b) => a.start - b.start);
    const first = this.queue.shift();
    const batch = [first];
    let seconds = first.end - first.start;
    for (let i = 0; i < this.queue.length; ) {
      const next = this.queue[i];
      if (next.source !== first.source) {
        i++;
        continue;
      }
      const last = batch[batch.length - 1];
      const length = next.end - next.start;
      const otherSpoke = this.spans.some((s) => s.source !== first.source && s.start < next.start && s.end > last.end);
      if (otherSpoke || next.start - last.end > MERGE_GAP_S || seconds + JOIN_PAUSE_S + length > MERGE_MAX_S) break;
      batch.push(next);
      seconds += JOIN_PAUSE_S + length;
      this.queue.splice(i, 1);
    }
    return batch;
  }

  /** The language this speaker has been speaking (when Whisper hesitates between Italian and English). */
  preferredLanguage(source) {
    const count = (list) => list.reduce((m, l) => ((m[l] = (m[l] || 0) + 1), m), {});
    const pick = (list) => {
      const c = Object.entries(count(list)).sort((a, b) => b[1] - a[1]);
      return c.length && c[0][1] >= 2 ? c[0][0] : null;
    };
    return pick(this.languages[source] || []) || pick([...this.languages[ME], ...this.languages[THEM]]);
  }

  async runBatch(batch) {
    await this.transcriberReady;
    if (this.transcriberFailed) return;
    const source = batch[0].source;
    const pause = new Float32Array(Math.round(JOIN_PAUSE_S * TARGET_RATE));
    const parts = batch.flatMap((c, i) => (i ? [pause, c.audio] : [c.audio]));
    const audio = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      audio.set(p, o);
      o += p.length;
    }
    const seconds = audio.length / TARGET_RATE;
    const started = Date.now();
    let result = await this.transcriber.transcribe(audio, this.language, {
      prefer: this.preferredLanguage(source),
      prompt: this.glossary,
    });
    if (typeof result === "string") result = { text: result };
    this.stats.batches++;
    this.stats.joined += batch.length - 1;
    this.stats.audioS += seconds;
    this.stats.workMs += result.ms ?? Date.now() - started;
    const verdict = judgeSegment(result, this.glossary);
    const text = verdict === "ok" ? cleanTranscription(result.text, result) : "";
    if (!text) {
      if (result.text) this.stats.dropped++;
      return;
    }
    if (result.language) {
      const heard = this.languages[source] || (this.languages[source] = []);
      heard.push(result.language);
      if (heard.length > 6) heard.shift();
    }
    this.addLine({ t: batch[0].start, speaker: source, text, lang: result.language || null });
    this.emit("latency", Math.max(0, this.elapsed() - batch[batch.length - 1].end)); // seconds from the end of the speech to its text
  }

  addLine(line) {
    const added = this.store.add(line);
    if (added) this.emit("transcript", added);
  }

  tick() {
    if (!this.running) return;
    if (!this.stopping) this.router.checkStale();
    this.checkLag();
    this.checkSharedAudio();
  }

  /** How far behind the text is: from the end of the oldest speech still waiting for Whisper. */
  checkLag() {
    const now = this.elapsed();
    this.lag = this.queue.length ? Math.max(0, now - Math.min(...this.queue.map((c) => c.end))) : 0;
    const speed = this.stats.audioS ? this.stats.workMs / 1000 / this.stats.audioS : null; // seconds of work per second of speech
    this.emit("health", { lag: this.lag, waiting: this.queue.length, busy: this.busy, speed, ...this.stats });
    if (this.lag > LAG_WARNING_S) {
      if (this.lateSince === null) this.lateSince = now;
      if (now - this.lateSince > 10 && !this.lagWarned) {
        this.lagWarned = true;
        this.emit("warning", ["slow", { s: Math.round(this.lag) }]);
      }
    } else {
      this.lateSince = null;
      if (this.lag < 5) this.lagWarned = false;
    }
  }

  checkSharedAudio() {
    if (this.sharedWarned || !this.capture || !this.capture.wantShared || this.elapsed() < SILENT_SHARED_AFTER_S) return;
    const lines = this.store.lines;
    if (lines.filter((l) => l.speaker === ME).length >= 3 && !lines.some((l) => l.speaker === THEM)) {
      this.sharedWarned = true;
      this.emit("warning", "no_system_audio");
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

  /** Stop listening and finish transcribing what was already heard. */
  async stop() {
    if (this.stopping) return this.result;
    this.stopping = true;
    this.emit("status", "stopping");
    const duration = this.elapsed();
    if (this.capture) this.capture.stop();
    if (this.replay) this.replay.stop();
    this.router.flushAll();
    await this.waitFor(() => !this.busy && this.queue.length === 0, 120000);
    clearInterval(this.timer);
    this.running = false;
    if (this.transcriber) this.transcriber.dispose();
    this.result = {
      id: this.startedAt.toISOString(),
      startedAt: this.startedAt.toISOString(),
      durationS: Math.round(duration),
      transcript: this.store.lines.map(({ t, speaker, text }) => ({ t, speaker, text })),
    };
    this.done = true;
    this.emit("ended", this.result);
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
