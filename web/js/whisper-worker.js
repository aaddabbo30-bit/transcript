// Web Worker: speech-to-text with Whisper running in the browser through
// Transformers.js (https://github.com/huggingface/transformers.js, Apache-2.0).
// The model is downloaded once from Hugging Face and cached by the browser, or
// loaded by hand by the user (see model-files.js).

const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1";
const LANGUAGES = { it: "italian", en: "english" };

let asr = null;
let core = null; // whisper-core.js: our own decoding on top of the pipeline
let LogitsProcessor = null;
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
  // Workers don't see the page's import map: pass on this file's "?v=" (see web/tools/stamp.mjs).
  const version = new URL(import.meta.url).search;
  const { MODEL_REPOS, hasManualModel } = await import(`./model-files.js${version}`);
  core = await import(`./whisper-core.js${version}`);
  const transformers = await import(TRANSFORMERS_URL);
  const { pipeline, env } = transformers;
  LogitsProcessor = transformers.LogitsProcessor;
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
    return { device: "wasm, modello caricato a mano", windowMs: await warmUp() };
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
  return { device, windowMs: await warmUp() };
}

/** The first run is slow (shaders, buffers): do it before the call needs it. The second one times a window. */
async function warmUp() {
  try {
    await transcribe(new Float32Array(16000), { language: "en" });
  } catch (err) {
    // Our own decoding didn't run with this version of the library: fall back to the plain pipeline.
    console.warn("Whisper: own decoding unavailable, using the plain pipeline.", err);
    LogitsProcessor = null;
    await transcribe(new Float32Array(16000), { language: "en" });
  }
  const started = Date.now();
  await transcribe(new Float32Array(16000), { language: "en" });
  return Date.now() - started;
}

function transcribe(audio, { language = "auto", prefer = null, prompt = "" } = {}) {
  if (!LogitsProcessor) {
    // Older Transformers.js without the hooks: the plain pipeline.
    const options = { task: "transcribe", chunk_length_s: 30 };
    if (LANGUAGES[language]) options.language = LANGUAGES[language];
    return asr(audio, options).then((out) => ({ text: ((out && out.text) || "").trim(), language: LANGUAGES[language] ? language : null }));
  }
  return core.transcribeWith(asr, LogitsProcessor, audio, { language, prefer, promptIds: core.promptTokenIds(asr, prompt) });
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "load") {
    load(msg.model).then(
      ({ device, windowMs }) => post({ type: "ready", device, windowMs }),
      (err) => post({ type: "error", message: String((err && err.message) || err) }),
    );
  } else if (msg.type === "transcribe") {
    queue = queue.then(async () => {
      try {
        const out = await transcribe(msg.audio, { language: msg.language, prefer: msg.prefer, prompt: msg.prompt });
        post({ type: "result", id: msg.id, ...out });
      } catch (err) {
        post({ type: "result", id: msg.id, text: "", error: String((err && err.message) || err) });
      }
    });
  }
};
