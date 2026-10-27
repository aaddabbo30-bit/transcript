// Audio helpers shared by the live capture and the tests: resampling to 16 kHz
// and an utterance segmenter that cuts the stream at pauses.
// Same algorithm as call_assistant/audio.py in the desktop app.

export const TARGET_RATE = 16000;
export const ME = "me"; // the user's microphone
export const THEM = "them"; // the shared tab/screen audio: the other people, or a video

const kernels = new Map();

function lowpassKernel(cutoff, taps = 63) {
  const k = new Float32Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - (taps - 1) / 2;
    const x = 2 * cutoff * n;
    const sinc = n === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
    k[i] = sinc * hamming;
    sum += k[i];
  }
  for (let i = 0; i < taps; i++) k[i] /= sum;
  return k;
}

/** Resample mono float audio; low-pass filters first when downsampling. */
export function resample(samples, srcRate, dstRate = TARGET_RATE) {
  if (srcRate === dstRate || samples.length === 0) return Float32Array.from(samples);
  let x = samples;
  if (dstRate < srcRate) {
    const key = `${srcRate}>${dstRate}`;
    if (!kernels.has(key)) kernels.set(key, lowpassKernel((0.45 * dstRate) / srcRate));
    const k = kernels.get(key);
    const half = (k.length - 1) / 2;
    const y = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      let acc = 0;
      for (let j = 0; j < k.length; j++) {
        const idx = i + j - half;
        if (idx >= 0 && idx < samples.length) acc += samples[idx] * k[j];
      }
      y[i] = acc;
    }
    x = y;
  }
  const nOut = Math.round((x.length * dstRate) / srcRate);
  const out = new Float32Array(Math.max(0, nOut));
  const ratio = srcRate / dstRate;
  for (let i = 0; i < nOut; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, x.length - 1);
    const frac = pos - i0;
    out[i] = x[Math.min(i0, x.length - 1)] * (1 - frac) + x[i1] * frac;
  }
  return out;
}

export function rms(frame) {
  let s = 0;
  for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
  return Math.sqrt(s / Math.max(1, frame.length));
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Splits a continuous stream into utterances, cutting at pauses. Energy
 * detector with an adaptive noise floor that follows quiet frames quickly and
 * rises slowly, so steady background noise is learned in a few seconds while
 * speech (which always has short pauses) is not.
 */
export class Segmenter {
  constructor(source, opts = {}) {
    const o = {
      rate: TARGET_RATE,
      frameMs: 30,
      startMs: 90,
      silenceEndMs: 500, // a pause this long ends a sentence: shorter means text sooner
      maxChunkS: 8, // continuous speech is cut at a quiet point by then
      preRollMs: 300,
      minVoicedMs: 250,
      absThreshold: 0.004,
      snr: 3,
      ...opts,
    };
    this.source = source;
    this.rate = o.rate;
    this.frameLen = Math.round((o.rate * o.frameMs) / 1000);
    this.frameS = this.frameLen / o.rate;
    this.startFrames = Math.max(1, Math.floor(o.startMs / o.frameMs));
    this.endFrames = Math.max(1, Math.floor(o.silenceEndMs / o.frameMs));
    this.maxFrames = Math.floor((o.maxChunkS * 1000) / o.frameMs);
    this.minVoiced = Math.max(1, Math.floor(o.minVoicedMs / o.frameMs));
    this.preRollMax = Math.max(1, Math.floor(o.preRollMs / o.frameMs));
    this.absThreshold = o.absThreshold;
    this.snr = o.snr;
    this.noise = o.absThreshold / o.snr; // assume a quiet start
    this.preRoll = [];
    this.pending = new Float32Array(0);
    this.pendingT = 0;
    this.frames = []; // {audio, t, rms}
    this.inSpeech = false;
    this.speechRun = 0;
    this.silenceRun = 0;
    this.voiced = 0;
    this.lastAudioTime = 0;
  }

  threshold() {
    return Math.max(this.absThreshold, this.noise * this.snr);
  }

  trackNoise(level) {
    if (level < this.noise) this.noise += 0.2 * (level - this.noise);
    else this.noise = Math.min(level, this.noise * 1.01);
  }

  /** Feed audio starting at session time tStart (s). Returns finished chunks. */
  push(samples, tStart) {
    const expected = this.pendingT + this.pending.length / this.rate;
    if (this.pending.length === 0) {
      this.pendingT = tStart;
    } else if (Math.abs(tStart - expected) > 0.5) {
      // A gap (shared audio sends nothing while silent): realign the clock.
      this.pending = new Float32Array(0);
      this.pendingT = tStart;
    }
    this.pending = concat([this.pending, samples]);
    this.lastAudioTime = this.pendingT + this.pending.length / this.rate;
    const out = [];
    while (this.pending.length >= this.frameLen) {
      const frame = this.pending.slice(0, this.frameLen);
      const t = this.pendingT;
      this.pending = this.pending.slice(this.frameLen);
      this.pendingT += this.frameS;
      const chunk = this.processFrame(frame, t);
      if (chunk) out.push(chunk);
    }
    return out;
  }

  processFrame(frame, t) {
    const level = rms(frame);
    const isSpeech = level > this.threshold();
    this.trackNoise(level);
    const entry = { audio: frame, t, rms: level };
    if (!this.inSpeech) {
      this.preRoll.push(entry);
      if (this.preRoll.length > this.preRollMax) this.preRoll.shift();
      this.speechRun = isSpeech ? this.speechRun + 1 : 0;
      if (this.speechRun >= this.startFrames) {
        this.inSpeech = true;
        this.frames = this.preRoll.slice();
        this.preRoll = [];
        this.voiced = this.speechRun;
        this.silenceRun = 0;
      }
      return null;
    }
    this.frames.push(entry);
    if (isSpeech) {
      this.voiced += 1;
      this.silenceRun = 0;
    } else {
      this.silenceRun += 1;
    }
    if (this.silenceRun >= this.endFrames) {
      const keep = this.frames.length - this.silenceRun + Math.min(this.silenceRun, 7);
      return this.emit(keep, true);
    }
    if (this.frames.length >= this.maxFrames) return this.emit(this.quietestCut(), false);
    return null;
  }

  quietestCut() {
    const window = Math.min(this.frames.length - 1, Math.floor(1.5 / this.frameS));
    const start = this.frames.length - window;
    let best = start;
    for (let i = start; i < this.frames.length; i++) if (this.frames[i].rms < this.frames[best].rms) best = i;
    return best + 1;
  }

  emit(keep, endOfSpeech) {
    const frames = this.frames.slice(0, keep);
    const rest = this.frames.slice(keep);
    const voiced = this.voiced;
    if (endOfSpeech) {
      this.inSpeech = false;
      this.frames = [];
      this.speechRun = 0;
      this.voiced = 0;
    } else {
      this.frames = rest;
      this.voiced = rest.filter((f) => f.rms > this.absThreshold).length;
    }
    this.silenceRun = 0;
    if (frames.length === 0 || voiced < this.minVoiced) return null;
    const audio = concat(frames.map((f) => f.audio));
    const start = frames[0].t;
    return { source: this.source, audio, start, end: start + audio.length / this.rate };
  }

  /** Close the current utterance (end of call, or the stream went quiet). */
  flush() {
    if (!this.inSpeech) {
      this.preRoll = [];
      return null;
    }
    return this.emit(this.frames.length, true);
  }
}

/** Segments each source separately; closes utterances when a source goes quiet. */
export class AudioRouter {
  constructor(onChunk, clock) {
    this.onChunk = onChunk;
    this.clock = clock; // session time in seconds
    this.segmenters = new Map();
    this.levels = {};
    this.lastFeed = {};
  }

  feed(source, samples16k, tArrival = this.clock()) {
    let seg = this.segmenters.get(source);
    if (!seg) {
      seg = new Segmenter(source);
      this.segmenters.set(source, seg);
    }
    const tStart = tArrival - samples16k.length / TARGET_RATE;
    if (samples16k.length) {
      this.levels[source] = rms(samples16k);
      this.lastFeed[source] = tArrival;
    }
    for (const chunk of seg.push(samples16k, tStart)) this.onChunk(chunk);
  }

  checkStale(maxGap = 0.9) {
    const now = this.clock();
    for (const seg of this.segmenters.values()) {
      if (seg.inSpeech && now - seg.lastAudioTime > maxGap) {
        const chunk = seg.flush();
        if (chunk) this.onChunk(chunk);
      }
    }
  }

  flushAll() {
    for (const seg of this.segmenters.values()) {
      const chunk = seg.flush();
      if (chunk) this.onChunk(chunk);
    }
  }
}
