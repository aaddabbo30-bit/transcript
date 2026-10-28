// Without headphones the microphone also hears the other people through the
// speakers. Whisper then writes their words (garbled, since the sound is faint)
// as if the user had said them. The shared audio is exactly what the speakers
// play, so an utterance from the microphone whose loudness rises and falls with
// the shared audio, a fraction of a second later, is that echo, not the user.

export const FRAME_S = 0.02; // 20 ms frames at 16 kHz
const FRAME = 320;
const FLOOR_DB = -80;

/** Loudness of each 20 ms frame, in dB. */
export function frameLevels(samples) {
  const n = Math.floor(samples.length / FRAME);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) s += samples[i] * samples[i];
    out[f] = Math.max(FLOOR_DB, 10 * Math.log10(s / FRAME + 1e-12));
  }
  return out;
}

function pearson(a, b) {
  const n = a.length;
  if (n < 5) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  return saa > 1e-6 && sbb > 1e-6 ? sab / Math.sqrt(saa * sbb) : 0;
}

export class EchoDetector {
  constructor({ keepS = 120, minLagS = -0.1, maxLagS = 0.6, minCorr = 0.75, minActive = 0.4, activeDb = 12 } = {}) {
    this.keepFrames = Math.round(keepS / FRAME_S);
    this.minLag = Math.round(minLagS / FRAME_S);
    this.maxLag = Math.round(maxLagS / FRAME_S);
    this.minCorr = minCorr; // how closely the microphone must follow the shared audio
    this.minActive = minActive; // share of the utterance during which the shared audio was playing
    this.activeDb = activeDb; // "playing": this many dB above the shared audio's quiet level
    this.ref = []; // shared audio: frame levels
    this.refStart = null; // session time of this.ref[0]
    this.refFloor = null; // quiet level of the shared audio (slow minimum)
    this.pending = new Float32Array(0);
    this.dropped = 0;
    this.checked = 0;
  }

  /** Feed the shared audio as it arrives (16 kHz, starting at session time tStart). */
  addReference(samples, tStart) {
    if (this.refStart === null) this.refStart = tStart;
    // Frames are aligned on the stream; a gap in the audio (a dropped block) is filled with silence.
    const expected = this.refStart + (this.ref.length * FRAME + this.pending.length) / 16000;
    if (tStart > expected + 0.25) {
      const missing = Math.round((tStart - expected) / FRAME_S);
      for (let i = 0; i < missing; i++) this.ref.push(FLOOR_DB);
      this.pending = new Float32Array(0);
    }
    const all = new Float32Array(this.pending.length + samples.length);
    all.set(this.pending);
    all.set(samples, this.pending.length);
    const n = Math.floor(all.length / FRAME);
    const levels = frameLevels(all.subarray(0, n * FRAME));
    for (const db of levels) {
      this.ref.push(db);
      // Quiet level: follows drops at once, rises slowly.
      this.refFloor = this.refFloor === null ? db : db < this.refFloor ? db : this.refFloor + 0.002 * (db - this.refFloor);
    }
    this.pending = all.slice(n * FRAME);
    if (this.ref.length > this.keepFrames * 1.5) {
      const cut = this.ref.length - this.keepFrames;
      this.ref = this.ref.slice(cut);
      this.refStart += cut * FRAME_S;
    }
  }

  refAt(t) {
    if (this.refStart === null) return FLOOR_DB;
    const i = Math.round((t - this.refStart) / FRAME_S);
    return i >= 0 && i < this.ref.length ? this.ref[i] : FLOOR_DB;
  }

  /** How much a microphone utterance {audio, start} follows the shared audio: {corr, lagS, active}. */
  score(chunk) {
    const mic = frameLevels(chunk.audio);
    let best = { corr: 0, lagS: 0, active: 0 };
    if (!mic.length || this.refStart === null) return best;
    const playing = (this.refFloor ?? FLOOR_DB) + this.activeDb;
    const ref = new Float32Array(mic.length);
    for (let lag = this.minLag; lag <= this.maxLag; lag++) {
      let active = 0;
      for (let i = 0; i < mic.length; i++) {
        ref[i] = this.refAt(chunk.start + (i - lag) * FRAME_S);
        if (ref[i] > playing) active++;
      }
      const corr = pearson(mic, ref);
      if (corr > best.corr) best = { corr, lagS: lag * FRAME_S, active: active / mic.length };
    }
    return best;
  }

  /** True when the utterance is the shared audio heard by the microphone. */
  isEcho(chunk) {
    this.checked++;
    const s = this.score(chunk);
    chunk.echo = s;
    const echo = s.corr >= this.minCorr && s.active >= this.minActive;
    if (echo) this.dropped++;
    return echo;
  }
}
