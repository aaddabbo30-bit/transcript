// The page's own Whisper decoding (web/js/whisper-core.js) with the real model,
// on Node: Transformers.js + onnxruntime-node, the same 8-bit whisper-base the
// page uses when the model is loaded by hand. Needs the model download from
// Hugging Face, so it runs in CI, not in the unit tests.
//   npm install --no-save @huggingface/transformers@4.3.1
//   node web/tests/whisper-real.mjs
// Checks: Italian and English told apart, silence and noise recognised as such,
// the glossary prompt not echoed back, and the same words as the plain pipeline.

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { Segmenter, TARGET_RATE, resample } from "../js/segmenter.js";
import { cleanTranscription, normalize } from "../js/transcript.js";
import { judgeSegment, promptTokenIds, transcribeWith } from "../js/whisper-core.js";

const require = createRequire(import.meta.url);
const transformers = await import(require.resolve("@huggingface/transformers"));
const { pipeline, env, LogitsProcessor } = transformers;
assert.equal(typeof LogitsProcessor, "function", "Transformers.js exports LogitsProcessor");
env.cacheDir = process.env.WHISPER_CACHE || join(homedir(), ".cache", "whisper-models");

function readWav16k(url) {
  const buf = readFileSync(url);
  const rate = buf.readUInt32LE(24);
  let offset = 12;
  while (buf.toString("ascii", offset, offset + 4) !== "data") offset += 8 + buf.readUInt32LE(offset + 4);
  const size = buf.readUInt32LE(offset + 4);
  const pcm = new Float32Array(size / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(offset + 8 + i * 2) / 32768;
  return resample(pcm, rate, TARGET_RATE);
}

const started = Date.now();
const asr = await pipeline("automatic-speech-recognition", "onnx-community/whisper-base", { dtype: "q8" });
console.log(`model loaded in ${((Date.now() - started) / 1000).toFixed(1)} s`);

const speech = readWav16k(new URL("../../tests/fixtures/speech_it_en.wav", import.meta.url));
const seg = new Segmenter("them");
const chunks = [];
for (let i = 0; i < speech.length; i += 1600) chunks.push(...seg.push(speech.subarray(i, i + 1600), i / TARGET_RATE));
const last = seg.flush();
if (last) chunks.push(last);
assert.ok(chunks.length >= 3, `${chunks.length} utterances`);

const show = (label, r) => {
  const line = `${label.padEnd(14)} ${String(r.language).padEnd(4)} nospeech ${r.noSpeechProb.toFixed(2)}  logprob ${r.avgLogprob.toFixed(2)}  ${String(r.ms).padStart(5)} ms  ${JSON.stringify(r.text)}`;
  console.log(line);
  // On GitHub, also a notice on the check: the numbers can be read without opening the log.
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=${label.replace(/[:,]/g, " ")}::${line.replace(/%/g, "%25")}`);
};

// 1. Each utterance, language left to Whisper (Italian or English only).
const auto = [];
for (const [i, c] of chunks.entries()) {
  const r = await transcribeWith(asr, LogitsProcessor, c.audio, { language: "auto" });
  show(`utterance ${i + 1}`, r);
  auto.push(r);
}
const kept = auto.filter((r) => judgeSegment(r) === "ok" && cleanTranscription(r.text, r));
assert.ok(kept.length >= Math.ceil(chunks.length * 0.6), `speech kept: ${kept.length} of ${chunks.length}`);
assert.ok(auto.every((r) => ["it", "en"].includes(r.language)));
assert.ok(auto.some((r) => r.language === "it") && auto.some((r) => r.language === "en"), "both Italian and English heard");
assert.ok(kept.every((r) => r.noSpeechProb < 0.5 && r.avgLogprob > -1.2));

// 2. The same words as the plain pipeline, when the language is given.
let same = 0;
for (const [i, c] of chunks.entries()) {
  const lang = auto[i].language;
  const ours = await transcribeWith(asr, LogitsProcessor, c.audio, { language: lang });
  assert.equal(ours.language, lang);
  const plain = await asr(c.audio, { language: lang === "it" ? "italian" : "english", task: "transcribe" });
  if (normalize(ours.text) === normalize(plain.text)) same++;
  else console.log(`differs from the pipeline: ${JSON.stringify(ours.text)} vs ${JSON.stringify(plain.text)}`);
}
assert.ok(same >= chunks.length - 1, `same words as the pipeline in ${same} of ${chunks.length}`);

// 3. The whole recording in one window (what the page does when sentences pile up).
const whole = await transcribeWith(asr, LogitsProcessor, speech.subarray(0, Math.min(speech.length, 28 * TARGET_RATE)), { language: "auto" });
show("whole", whole);
assert.ok(whole.text.split(/\s+/).length >= 10);

// 4. Silence and noise: not speech.
const silence = await transcribeWith(asr, LogitsProcessor, new Float32Array(3 * TARGET_RATE), { language: "en" });
show("silence", silence);
let seed = 7;
const hiss = Float32Array.from({ length: 3 * TARGET_RATE }, () => {
  seed = (seed * 16807) % 2147483647;
  return (seed / 2147483647 - 0.5) * 0.01;
});
const noise = await transcribeWith(asr, LogitsProcessor, hiss, { language: "en" });
show("noise", noise);
for (const [name, r] of [["silence", silence], ["noise", noise]]) {
  const verdict = judgeSegment(r);
  assert.notEqual(verdict, "ok", `${name}: Whisper's own numbers should give it away`);
  const text = verdict === "ok" ? cleanTranscription(r.text, r) : "";
  assert.equal(text, "", `${name} gave ${JSON.stringify(r.text)} (${verdict})`);
}

// 5. A glossary prompt: accepted, and not echoed back as speech.
const prompt = "Jaromir, X-13, MATLAB, Navigli.";
for (const [i, c] of chunks.entries()) {
  const r = await transcribeWith(asr, LogitsProcessor, c.audio, { language: auto[i].language, promptIds: promptTokenIds(asr, prompt) });
  show(`with glossary ${i + 1}`, r);
  assert.notEqual(judgeSegment(r, prompt), "prompt_echo");
}
const quiet = await transcribeWith(asr, LogitsProcessor, new Float32Array(3 * TARGET_RATE), { language: "en", promptIds: promptTokenIds(asr, prompt) });
show("glossary/quiet", quiet);
const quietVerdict = judgeSegment(quiet, prompt);
assert.equal(quietVerdict === "ok" ? cleanTranscription(quiet.text, quiet) : "", "", `silence with a prompt gave ${JSON.stringify(quiet.text)}`);

console.log(`ok - Whisper with the real model: ${chunks.length} utterances, Italian and English told apart, silence and noise dropped, glossary prompt`);
