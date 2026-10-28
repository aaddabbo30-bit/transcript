// Page-side wrapper of the Whisper worker, plus a scripted stand-in for tests.

import { LANGS } from "./whisper-core.js";

export class WhisperTranscriber {
  constructor({ model = "base", onProgress = () => {} } = {}) {
    this.model = model;
    this.onProgress = onProgress;
    this.worker = null;
    this.nextId = 1;
    this.waiting = new Map();
    this.device = null;
  }

  load() {
    if (this.loading) return this.loading;
    // import.meta.resolve applies the page's import map: the worker of the same version.
    const url = import.meta.resolve ? import.meta.resolve("./whisper-worker.js") : new URL("./whisper-worker.js", import.meta.url);
    this.worker = new Worker(url, { type: "module" });
    this.loading = new Promise((resolve, reject) => {
      this.worker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === "progress") this.onProgress(msg.percent);
        else if (msg.type === "ready") {
          this.device = msg.device;
          this.windowMs = msg.windowMs || null; // time for one 30 s window, measured at load
          resolve(msg.device);
        } else if (msg.type === "error") {
          const err = new Error(msg.message);
          // A network failure while downloading the model (blocked site, proxy, offline).
          if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg.message)) {
            err.code = "model_download";
            err.url = (msg.message.match(/https?:\/\/[^\s)]+/) || [""])[0];
          }
          reject(err);
        }
        else if (msg.type === "result") {
          const done = this.waiting.get(msg.id);
          this.waiting.delete(msg.id);
          if (done) done(msg.error ? { text: "", error: msg.error } : msg);
        }
      };
      this.worker.onerror = (e) => reject(new Error(e.message || "worker error"));
    });
    this.worker.postMessage({ type: "load", model: this.model });
    return this.loading;
  }

  /**
   * Resolves with {text, language, noSpeechProb, avgLogprob, ms} (text "" on failure).
   * options: prefer (the language of this speaker so far), prompt (the meeting's names and terms).
   */
  transcribe(audio, languageMode, { prefer = null, prompt = "" } = {}) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.worker.postMessage({ type: "transcribe", id, audio, language: languageMode, prefer, prompt }, [audio.buffer]);
    });
  }

  get pending() {
    return this.waiting.size;
  }

  dispose() {
    if (this.worker) this.worker.terminate();
    for (const done of this.waiting.values()) done({ text: "" });
    this.waiting.clear();
  }
}

/**
 * Test double: returns the given texts in order (a string, or a full result
 * such as {text, noSpeechProb, avgLogprob}), after a delay.
 */
export class ScriptedTranscriber {
  constructor(texts = [], delayMs = 20) {
    this.texts = [...texts];
    this.delayMs = delayMs;
    this.calls = [];
    this.pending = 0;
    this.device = "scripted";
    this.windowMs = delayMs;
  }
  async load() {
    return "scripted";
  }
  async transcribe(audio, languageMode, options = {}) {
    this.pending++;
    this.calls.push({ seconds: audio.length / 16000, languageMode, ...options });
    await new Promise((r) => setTimeout(r, typeof this.delayMs === "function" ? this.delayMs(audio) : this.delayMs));
    this.pending--;
    const next = this.texts.length ? this.texts.shift() : `frase di prova ${this.calls.length}`;
    const result = typeof next === "string" ? { text: next } : { ...next };
    return { language: LANGS.includes(languageMode) ? languageMode : "it", noSpeechProb: 0, avgLogprob: -0.2, ...result };
  }
  dispose() {}
}
