// Speech-model files loaded by hand. Some company networks let downloads
// through only after a security check in a browser tab, which a page cannot do
// in the background. The user downloads the files from a tab (so they are
// checked) and picks them here; they are stored in the browser cache under the
// same address Transformers.js would download them from, so it finds them there.
// Whisper needs the two large .onnx files and five small .json files. Where
// the browser has a GPU (WebGPU), two more large files let it run there, much
// faster than on the processor: the full-precision encoder and a 4-bit decoder.

export const CACHE_NAME = "transformers-cache"; // Transformers.js' browser cache
const HF = "https://huggingface.co";
const ORT_WASM = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort-wasm-simd-threaded.asyncify.wasm";

export const MODEL_REPOS = { base: "onnx-community/whisper-base", small: "onnx-community/whisper-small" };
// The two large files of the 8-bit model, used when the model was loaded by hand.
export const BIG_FILES = ["onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx"];
export const SMALL_FILES = ["config.json", "generation_config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json"];
const MANUAL_FILES = [...BIG_FILES, ...SMALL_FILES];
// The GPU's files (the names Transformers.js asks for with dtype {encoder_model: "fp32", decoder_model_merged: "q4"}).
export const GPU_FILES = ["onnx/encoder_model.onnx", "onnx/decoder_model_merged_q4.onnx"];
const ALL_FILES = [...MANUAL_FILES, ...GPU_FILES];
export const GPU_DTYPE = { encoder_model: "fp32", decoder_model_merged: "q4" };

/** Whether this browser offers a GPU to WebGPU (also in a worker). */
export async function hasWebGpu() {
  try {
    const gpu = typeof navigator !== "undefined" && navigator.gpu;
    return Boolean(gpu && (await gpu.requestAdapter()));
  } catch {
    return false;
  }
}

export class ModelFileError extends Error {}

export function fileUrl(model, path) {
  return `${HF}/${MODEL_REPOS[model] || MODEL_REPOS.base}/resolve/main/${path}`;
}

/** The files to download by hand; with `gpu`, also the GPU's two (marked gpu: true). */
export function manualDownloadLinks(model, { gpu = false } = {}) {
  const link = (path, isGpu) => ({ name: path.split("/").pop(), url: fileUrl(model, path), gpu: isGpu });
  return [...MANUAL_FILES.map((p) => link(p, false)), ...(gpu ? GPU_FILES.map((p) => link(p, true)) : [])];
}

/** Where a picked file belongs, by its name ("x (1).onnx" = the browser renamed a second download). */
export function targetUrl(model, fileName) {
  const name = String(fileName).replace(/ \(\d+\)(?=\.[^.]+$)/, "");
  const path = ALL_FILES.find((p) => p.split("/").pop() === name);
  if (path) return fileUrl(model, path);
  if (name === ORT_WASM.split("/").pop()) return ORT_WASM;
  return null;
}

async function looksValid(file) {
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const text = new TextDecoder().decode(head).trimStart().toLowerCase();
  // A saved proxy/security-check page instead of the real file.
  if (text.startsWith("<") || text.startsWith("<!doctype")) return false;
  if (/\.(onnx|wasm)$/i.test(file.name) && file.size < 1_000_000) return false;
  if (/\.json$/i.test(file.name)) {
    try {
      JSON.parse(await file.text());
    } catch {
      return false;
    }
  }
  return true;
}

/** Store picked files in the browser cache. Returns {stored, skipped}; throws ModelFileError for a bad file. */
export async function importModelFiles(model, files) {
  if (typeof caches === "undefined") throw new ModelFileError("browser cache not available");
  const cache = await caches.open(CACHE_NAME);
  const stored = [];
  const skipped = [];
  for (const file of files) {
    const url = targetUrl(model, file.name);
    if (!url) {
      skipped.push(file.name);
      continue;
    }
    if (!(await looksValid(file))) throw new ModelFileError(file.name);
    await cache.put(
      url,
      new Response(file, {
        headers: { "content-type": file.type || "application/octet-stream", "content-length": String(file.size) },
      }),
    );
    stored.push(file.name);
  }
  return { stored, skipped };
}

/** True when both large files of this model were loaded by hand. */
export async function hasManualModel(model) {
  if (typeof caches === "undefined") return false;
  try {
    const cache = await caches.open(CACHE_NAME);
    for (const path of BIG_FILES) if (!(await cache.match(fileUrl(model, path)))) return false;
    return true;
  } catch {
    return false;
  }
}

/** True when the GPU's two files of this model were loaded by hand. */
export async function hasManualGpuModel(model) {
  return (await missingManualFiles(model, GPU_FILES)).length === 0;
}

/** The files of this model not loaded by hand yet, by name (the processor's, or the given list). */
export async function missingManualFiles(model, paths = MANUAL_FILES) {
  const names = paths.map((p) => p.split("/").pop());
  if (typeof caches === "undefined") return names;
  try {
    const cache = await caches.open(CACHE_NAME);
    const missing = [];
    for (const path of paths) if (!(await cache.match(fileUrl(model, path)))) missing.push(path.split("/").pop());
    return missing;
  } catch {
    return names;
  }
}
