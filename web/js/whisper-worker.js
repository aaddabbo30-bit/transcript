// Web Worker: speech-to-text with Whisper running in the browser through
// Transformers.js (https://github.com/huggingface/transformers.js, Apache-2.0).
// The model is downloaded once from Hugging Face and cached by the browser, or
// loaded by hand by the user (see model-files.js).

import { MODEL_REPOS, hasManualModel } from "./model-files.js";

const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1";
const LANGUAGES = { it: "italian", en: "english" };

let asr = null;
let queue = Promise.resolve();

const post = (msg) => self.postMessage(msg);

async function pickDevice() {
  try {
    if (self.navigator && self.navigator.gpu && (await self.navigator.gpu.requestAdapter())) return "webgpu";
  } catch {
    /* no WebGPU */
  }
  return "wasm";
}

async function load(modelKey) {
  const { pipeline, env } = await import(TRANSFORMERS_URL);
  env.allowLocalModels = false;
  // Report which download failed: a bare "Failed to fetch" doesn't say what was blocked.
  env.fetch = async (input, init) => {
    try {
      return await fetch(input, init);
    } catch (err) {
      throw new Error(`Failed to fetch ${String(input)} (${(err && err.message) || err})`);
    }
  };
  const model = MODEL_REPOS[modelKey] || MODEL_REPOS.base;
  const files = {};
  const progress_callback = (p) => {
    if (p.status === "progress" && p.total) {
      files[p.file] = { loaded: p.loaded, total: p.total };
      const all = Object.values(files);
      const loaded = all.reduce((n, f) => n + f.loaded, 0);
      const total = all.reduce((n, f) => n + f.total, 0);
      post({ type: "progress", percent: Math.round((100 * loaded) / Math.max(1, total)) });
    }
  };
  if (await hasManualModel(modelKey)) {
    // Files loaded by hand are the 8-bit ones, which run on the WASM backend.
    asr = await pipeline("automatic-speech-recognition", model, { device: "wasm", dtype: "q8", progress_callback });
    await asr(new Float32Array(16000), { language: "english", task: "transcribe" }); // warm-up
    return "wasm, modello caricato a mano";
  }
  let device = await pickDevice();
  try {
    asr = await pipeline("automatic-speech-recognition", model, {
      device,
      // WebGPU: full-precision encoder (accuracy) + 4-bit decoder (speed); WASM: 8-bit.
      dtype: device === "webgpu" ? { encoder_model: "fp32", decoder_model_merged: "q4" } : "q8",
      progress_callback,
    });
  } catch (err) {
    if (device !== "webgpu") throw err;
    device = "wasm";
    asr = await pipeline("automatic-speech-recognition", model, { device, dtype: "q8", progress_callback });
  }
  await asr(new Float32Array(16000), { language: "english", task: "transcribe" }); // warm-up
  return device;
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "load") {
    load(msg.model).then(
      (device) => post({ type: "ready", device }),
      (err) => post({ type: "error", message: String((err && err.message) || err) }),
    );
  } else if (msg.type === "transcribe") {
    queue = queue.then(async () => {
      try {
        const options = { task: "transcribe", chunk_length_s: 30 };
        if (LANGUAGES[msg.language]) options.language = LANGUAGES[msg.language];
        const out = await asr(msg.audio, options);
        post({ type: "result", id: msg.id, text: ((out && out.text) || "").trim() });
      } catch (err) {
        post({ type: "result", id: msg.id, text: "", error: String((err && err.message) || err) });
      }
    });
  }
};
