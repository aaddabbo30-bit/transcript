// Live audio in the browser: the microphone (getUserMedia) and the call audio
// from a shared tab or screen (getDisplayMedia with "Share audio").

import { ME, THEM, resample } from "./segmenter.js";

export class CaptureError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code; // "unsupported" | "mic_denied" | "no_shared_audio" | "cancelled"
  }
}

export function captureSupported() {
  return Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.AudioWorkletNode);
}

export class BrowserAudioCapture {
  constructor({ mic = true, shared = true, onWarning = () => {}, onSharedEnded = () => {} } = {}) {
    this.wantMic = mic;
    this.wantShared = shared;
    this.onWarning = onWarning;
    this.onSharedEnded = onSharedEnded;
    this.streams = [];
    this.nodes = [];
    this.ctx = null;
    this.description = [];
    this.sharedActive = false;
  }

  /** Must be called from a click: Chrome only shows the share dialog after a user gesture. */
  async start(feed, clock) {
    if (!captureSupported()) throw new CaptureError("unsupported");
    let shared = null;
    if (this.wantShared) {
      if (!navigator.mediaDevices.getDisplayMedia) throw new CaptureError("unsupported");
      try {
        shared = await navigator.mediaDevices.getDisplayMedia({
          video: true, // required by browsers; the video is never used
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          systemAudio: "include",
          selfBrowserSurface: "exclude",
          surfaceSwitching: "include",
        });
      } catch (err) {
        if (!this.wantMic) throw new CaptureError("cancelled", String(err && err.message));
        this.onWarning("no_shared_audio");
      }
      if (shared && shared.getAudioTracks().length === 0) {
        shared.getTracks().forEach((t) => t.stop());
        shared = null;
        if (!this.wantMic) throw new CaptureError("no_shared_audio");
        this.onWarning("no_shared_audio");
      }
    }
    let mic = null;
    if (this.wantMic) {
      try {
        // Echo cancellation also removes most of the call audio the microphone hears from the speakers.
        mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (err) {
        if (!shared) throw new CaptureError("mic_denied", String(err && err.message));
        this.onWarning("mic_denied");
      }
    }

    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule(new URL("./audio-worklet.js", import.meta.url));
    if (this.ctx.state === "suspended") await this.ctx.resume();
    const sink = this.ctx.createGain();
    sink.gain.value = 0; // keeps the graph running without playing anything back
    sink.connect(this.ctx.destination);
    const rate = this.ctx.sampleRate;
    const connect = (stream, source, label) => {
      const node = new AudioWorkletNode(this.ctx, "capture", {
        processorOptions: { blockSize: Math.round(rate / 10) },
      });
      node.port.onmessage = (e) => feed(source, resample(e.data, rate), clock());
      this.ctx.createMediaStreamSource(stream).connect(node);
      node.connect(sink);
      this.nodes.push(node);
      this.streams.push(stream);
      this.description.push(label);
    };
    if (shared) {
      const track = shared.getAudioTracks()[0];
      connect(new MediaStream([track]), THEM, `audio condiviso / shared: ${track.label || "tab/screen"}`);
      this.sharedActive = true;
      // The user pressed "Stop sharing" in Chrome's bar.
      track.addEventListener("ended", () => {
        this.sharedActive = false;
        this.onSharedEnded();
      });
      this.streams.push(shared);
    }
    if (mic) connect(mic, ME, `mic: ${mic.getAudioTracks()[0].label || "default"}`);
    return this.description;
  }

  stop() {
    for (const node of this.nodes) {
      node.port.onmessage = null;
      node.disconnect();
    }
    for (const stream of this.streams) stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) this.ctx.close().catch(() => {});
    this.nodes = [];
    this.streams = [];
    this.ctx = null;
  }
}
