// One call, from Start to Stop: audio -> segmenter -> Whisper -> transcript.
// Claude reads the transcript from the bridge (see bridge.js) or from what
// «Ask Claude» copies; this file only listens and writes it down.
// The page receives (kind, payload) events through onEvent.

import { AudioRouter, ME, TARGET_RATE, THEM } from "./segmenter.js";
import { TranscriptStore, cleanTranscription } from "./transcript.js";

const BACKLOG_WARNING = 6;
const SILENT_SHARED_AFTER_S = 45;

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

  async start() {
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

  async transcribe(chunk) {
    if (!this.transcriber || this.transcriberFailed) return;
    // When the speech ended (the audio is handed over to the worker, so measure it now).
    const end = chunk.start + chunk.audio.length / TARGET_RATE;
    const job = (async () => {
      await this.transcriberReady;
      if (this.transcriberFailed) return;
      const text = cleanTranscription(await this.transcriber.transcribe(chunk.audio, this.language));
      if (text) {
        this.addLine({ t: chunk.start, speaker: chunk.source, text });
        this.emit("latency", Math.max(0, this.elapsed() - end)); // seconds from the end of the speech to its text
      }
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
    await this.waitFor(() => this.pendingTranscriptions.size === 0, 120000);
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
