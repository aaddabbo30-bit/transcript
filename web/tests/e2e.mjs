// End-to-end test of the web app in a real Chromium (Playwright).
//   node web/tests/e2e.mjs [path/to/fake-mic.wav] [screenshot-dir]
// The Claude API is mocked at the network level (no key, no cost); Whisper is
// replaced by a scripted engine (?engine=scripted) because the model download is
// not needed to test the app. The microphone is Chromium's fake device playing a WAV.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// CommonJS require also finds a globally installed Playwright (NODE_PATH).
const { chromium } = createRequire(import.meta.url)("playwright");

const ROOT = fileURLToPath(new URL("../", import.meta.url)); // web/
const FAKE_MIC = process.argv[2] || fileURLToPath(new URL("../../tests/fixtures/speech_it_en.wav", import.meta.url));
const SHOTS = process.argv[3] || null;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".txt": "text/plain" };

function serve() {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([/\\])+/, "") || "index.html";
    try {
      const body = await readFile(join(ROOT, path));
      res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "POST, OPTIONS",
};
const INSIGHT = {
  topic: "Giulia ha un'offerta di lavoro a Milano",
  suggestions: [
    { kind: "answer", text: "Secondo me dovresti accettare." },
    { kind: "question", text: "Quando dovresti iniziare?" },
  ],
  remember: ["Festa sabato 14 novembre alle 20"],
  running_summary: "Giulia valuta un lavoro a Milano.",
};
const SUMMARY = {
  title: "Giulia e il lavoro a Milano",
  summary: "Giulia ha ricevuto un'offerta a Milano.",
  key_points: ["Inizio il 1 dicembre"],
  action_items: [{ owner: "Me", task: "Portare il vino", due: "14/11" }],
  memory_updates: [{ file: "people/Giulia.md", action: "create", content: "- Architetta, vive a Bologna.", reason: "Persona nuova" }],
};

async function mockClaude(page, requests) {
  await page.route("https://api.anthropic.com/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const body = JSON.parse(req.postData());
    requests.push({ body, headers: await req.allHeaders() });
    const data = body.output_config.format.schema.properties.topic ? INSIGHT : SUMMARY;
    return route.fulfill({
      status: 200,
      headers: { ...CORS, "content-type": "application/json" },
      body: JSON.stringify({
        id: "msg_e2e",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: JSON.stringify(data) }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1500, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000 },
      }),
    });
  });
}

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${FAKE_MIC}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const errors = [];
let failed = false;

async function newPage(query, { apiKey = "sk-ant-e2e-test" } = {}) {
  const context = await browser.newContext({ viewport: { width: 900, height: 1000 }, locale: "it-IT" });
  await context.addInitScript((key) => {
    if (key) localStorage.setItem("ca.apiKey", key);
    localStorage.setItem("ca.settings.v1", JSON.stringify({ uiLanguage: "it", insightInterval: 10 }));
  }, apiKey);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(base + query);
  return page;
}

async function step(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed = true;
    console.log(`not ok - ${name}\n  ${String(err.stack || err).split("\n").slice(0, 6).join("\n  ")}`);
  }
}

await step("demo call through the real Claude SDK (mocked network): live insight, summary, memory proposal", async () => {
  const requests = [];
  const page = await newPage("?speed=25");
  await mockClaude(page, requests);
  await page.click("#demo");
  await page.waitForSelector("#transcript .line");
  await page.waitForFunction(() => document.querySelectorAll("#transcript .line").length > 30, null, { timeout: 20000 });
  await page.click("#refresh");
  await page.waitForSelector(".suggestion", { timeout: 15000 });
  assert.equal(await page.textContent("#topic"), INSIGHT.topic);
  assert.equal(await page.locator(".suggestion").count(), 2);
  assert.match(await page.textContent("#cost"), /^\$0\.0\d+/);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "web-live.png") });
  const live = requests[0];
  assert.equal(live.body.model, "claude-haiku-5-5");
  assert.equal(live.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.deepEqual(live.body.system[0].cache_control, { type: "ephemeral" });
  await page.click("#stop");
  await page.waitForSelector("#summary:not(.hidden)", { timeout: 20000 });
  assert.equal(await page.textContent("#summary-title"), SUMMARY.title);
  const summaryReq = requests.find((r) => r.body.model === "claude-opus-5-5");
  assert.equal(summaryReq.body.fallbacks, "default");
  assert.match(summaryReq.headers["anthropic-beta"], /server-side-fallback/);
  assert.equal(await page.locator(".proposal").count(), 1);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "web-summary.png"), fullPage: true });
  await page.click("#apply-proposals");
  assert.match(await page.textContent("#review-status"), /1/);
  await page.click('[data-tab="memory"]');
  await page.selectOption("#mem-file", "people/Giulia.md");
  assert.match(await page.inputValue("#mem-text"), /Architetta/);
  await page.click('[data-tab="history"]');
  assert.match(await page.textContent("#history"), /Giulia e il lavoro a Milano/);
  await page.context().close();
});

await step("live microphone (Chromium fake device) -> segmenter -> scripted Whisper -> transcript", async () => {
  const page = await newPage("?engine=scripted&llm=fake", { apiKey: "" });
  await page.uncheck("#src-shared");
  await page.click("#start");
  await page.waitForFunction(() => document.querySelectorAll("#transcript .line").length >= 2, null, { timeout: 30000 });
  const first = await page.textContent("#transcript .line");
  assert.match(first, /Io: frase di prova 1/);
  assert.match(await page.textContent("#audio-info"), /mic/i);
  assert.match(await page.textContent("#status"), /ascolto/i);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "web-mic.png") });
  await page.click("#stop");
  await page.waitForSelector("#summary:not(.hidden)", { timeout: 20000 });
  await page.context().close();
});

await step("memory import of the Claude export and settings", async () => {
  const page = await newPage("", { apiKey: "" });
  assert.match(await page.textContent("#key-missing"), /chiave API/i);
  await page.click('[data-tab="memory"]');
  await page.fill("#import-text", "- Ti chiami Andrea e lavori come designer");
  await page.click("#import-save");
  assert.match(await page.textContent("#import-status"), /claude-memory-export\.md/);
  await page.selectOption("#mem-file", "claude-memory-export.md");
  assert.match(await page.inputValue("#mem-text"), /designer/);
  await page.click('[data-tab="settings"]');
  // Model loaded by hand (company proxies that check downloads in a tab).
  assert.equal(await page.locator("#manual-links a").count(), 2);
  assert.match(await page.getAttribute("#manual-links a >> nth=0", "href"), /huggingface\.co\/onnx-community\/whisper-base\/resolve\/main\/onnx\/encoder_model_quantized\.onnx$/);
  const onnx = (fill) => Buffer.concat([Buffer.from([0x08, 0x07]), Buffer.alloc(1_100_000, fill)]);
  await page.setInputFiles("#manual-files", [
    { name: "encoder_model_quantized.onnx", mimeType: "application/octet-stream", buffer: Buffer.from("<!DOCTYPE html><html>Security check</html>") },
  ]);
  await page.waitForFunction(() => /non è il file/.test(document.querySelector("#manual-status").textContent));
  await page.setInputFiles("#manual-files", [
    { name: "encoder_model_quantized.onnx", mimeType: "application/octet-stream", buffer: onnx(1) },
  ]);
  await page.waitForFunction(() => /Manca ancora: decoder_model_merged_quantized\.onnx/.test(document.querySelector("#manual-status").textContent));
  await page.setInputFiles("#manual-files", [
    { name: "decoder_model_merged_quantized (1).onnx", mimeType: "application/octet-stream", buffer: onnx(2) },
  ]);
  await page.waitForFunction(() => /pronto/.test(document.querySelector("#manual-status").textContent));
  const cached = await page.evaluate(async () => {
    const cache = await caches.open("transformers-cache");
    const base = "https://huggingface.co/onnx-community/whisper-base/resolve/main/onnx/";
    const enc = await cache.match(base + "encoder_model_quantized.onnx");
    const dec = await cache.match(base + "decoder_model_merged_quantized.onnx");
    return [enc && enc.headers.get("content-length"), dec && (await dec.arrayBuffer()).byteLength];
  });
  assert.deepEqual(cached, ["1100002", 1100002]);
  await page.fill("#api-key", "not-a-key");
  await page.click("#key-save");
  assert.match(await page.textContent("#key-status"), /sk-ant-/);
  await page.selectOption("#ui-language", "en");
  await page.click("#settings-save");
  assert.equal(await page.textContent('[data-tab="memory"]'), "Memory");
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "web-settings.png") });
  await page.context().close();
});

await browser.close();
server.close();
const unexpected = errors.filter((e) => !/favicon|Failed to load resource/.test(e));
if (unexpected.length) {
  failed = true;
  console.log("not ok - page errors:\n  " + unexpected.join("\n  "));
}
process.exit(failed ? 1 : 0);
