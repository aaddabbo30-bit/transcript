// End-to-end test of the web app in a real Chromium (Playwright).
//   node web/tests/e2e.mjs [path/to/fake-mic.wav] [screenshot-dir]
// Whisper is replaced by a scripted engine (?engine=scripted) because the model
// download is not needed to test the app. The microphone is Chromium's fake
// device playing a WAV. The bridge to Claude is the real Worker code
// (bridge/src/worker.js) on Node's SQLite, and claude.ai is a stand-in page.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { currentStamp } from "../tools/stamp.mjs";
import worker from "../../bridge/src/worker.js";
import { memoryD1 } from "../../bridge/test/d1.mjs";

// CommonJS require also finds a globally installed Playwright (NODE_PATH).
const { chromium } = createRequire(import.meta.url)("playwright");

const ROOT = fileURLToPath(new URL("../", import.meta.url)); // web/
const FAKE_MIC = process.argv[2] || fileURLToPath(new URL("../../tests/fixtures/speech_it_en.wav", import.meta.url));
const SHOTS = process.argv[3] || null;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".txt": "text/plain" };

const served = []; // every URL the page asked our server for

/** A file of web/ as the static host serves it, or null. */
async function webFile(pathname) {
  const path = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "") || "index.html";
  try {
    return { body: await readFile(join(ROOT, path)), type: TYPES[extname(path)] || "application/octet-stream" };
  } catch {
    return null;
  }
}

function serve() {
  const server = createServer(async (req, res) => {
    served.push(req.url);
    const file = await webFile(new URL(req.url, "http://x").pathname);
    if (!file) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": file.type, "cache-control": "no-store" });
    res.end(file.body);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
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

async function newContext() {
  const context = await browser.newContext({
    viewport: { width: 900, height: 1000 },
    locale: "it-IT",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  // «Ask Claude» opens claude.ai: answer with a stand-in page.
  await context.route("https://claude.ai/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>Claude</title>" }));
  await context.addInitScript(() => {
    try {
      if (location.hostname === "claude.ai" || localStorage.getItem("ca.settings.v1")) return;
      localStorage.setItem("ca.settings.v1", JSON.stringify({ uiLanguage: "it" }));
      localStorage.setItem("ca.apiKey", "sk-ant-left-by-an-older-version");
    } catch {
      /* a document without storage (error page, always-on-top window) */
    }
  });
  return context;
}

async function newPage(query, url = base) {
  const context = await newContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(url + query);
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

async function clipboard(page) {
  await page.bringToFront();
  return page.evaluate(() => navigator.clipboard.readText());
}

const claudeTitle = (page, pattern) =>
  page.waitForFunction((source) => new RegExp(source).test(document.querySelector("#claude-title").textContent), pattern.source, { timeout: 15000 });

await step("demo call without a bridge: transcript, end of the call, summary request for Claude, history, download", async () => {
  const page = await newPage("?speed=25");
  await claudeTitle(page, /^Claude non è collegato$/);
  assert.equal(await page.evaluate(() => localStorage.getItem("ca.apiKey")), null, "the old API key is forgotten");
  assert.ok(await page.isVisible("#go-settings"));
  await page.click("#demo");
  await page.waitForFunction(() => document.querySelectorAll("#transcript .line").length > 30, null, { timeout: 20000 });
  assert.match(await page.textContent("#live-hint"), /premi «Chiedi a Claude» e incolla/);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "web-live-copy.png") });
  await page.click("#stop");
  await page.waitForSelector("#ended:not(.hidden)", { timeout: 20000 });
  assert.match(await page.textContent("#ended-hint"), /Premi «Riassunto con Claude»/);
  const [claude] = await Promise.all([page.waitForEvent("popup"), page.click("#summary-claude")]);
  assert.equal(claude.url(), "https://claude.ai/new");
  const summary = await clipboard(page);
  assert.match(summary, /^Ho appena finito una chiamata \(/);
  assert.match(summary, /Trascrizione:\n\[\d\d:\d\d\] (Io|Altri): /);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "web-ended.png") });

  const [file] = await Promise.all([page.waitForEvent("download"), page.click("#dl-transcript")]);
  assert.match(file.suggestedFilename(), /^\d{4}-\d\d-\d\d-\d\d-\d\d-transcript\.md$/);
  const markdown = await readFile(await file.path(), "utf8");
  assert.match(markdown, /^# Trascrizione\n\n.+ · \d\d:\d\d\n\n- \[\d\d:\d\d\] \*\*(Io|Altri):\*\* /);

  await page.click('[data-tab="history"]');
  assert.equal(await page.locator(".call-item").count(), 1);
  await page.click(".call-item .title");
  await page.waitForSelector("#ended:not(.hidden)");
  await page.context().close();
});

await step("live microphone -> scripted Whisper -> transcript -> «Ask Claude» copies it for the Claude chat", async () => {
  const page = await newPage("?engine=scripted");
  await page.uncheck("#src-shared");
  await page.click("#start");
  await page.waitForFunction(() => document.querySelectorAll("#transcript .line").length >= 2, null, { timeout: 30000 });
  const first = await page.textContent("#transcript .line");
  assert.match(first, /Io: frase di prova 1/);
  assert.match(await page.textContent("#audio-info"), /mic/i);
  assert.match(await page.textContent("#status"), /ascolto/i);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "web-mic.png") });

  // First request: copied, and Claude opens in a new tab.
  const [claude] = await Promise.all([page.waitForEvent("popup"), page.click("#ask-claude")]);
  assert.equal(claude.url(), "https://claude.ai/new");
  await page.waitForSelector("#notice.ok");
  const ask = await clipboard(page);
  assert.match(ask, /^Sono in una chiamata adesso\./);
  assert.match(ask, /Trascrizione:\n\[\d\d:\d\d\] Io: frase di prova 1/);
  // Later requests only copy: the Claude tab is already open.
  let popups = 0;
  page.on("popup", () => popups++);
  await page.waitForFunction(() => document.querySelectorAll("#transcript .line").length >= 3, null, { timeout: 30000 });
  await page.click("#ask-claude");
  await page.waitForFunction(() => /frase di prova 3/.test(document.querySelector("#transcript").textContent));
  assert.match(await clipboard(page), /Io: frase di prova 3/);
  assert.equal(popups, 0);

  await page.click("#stop");
  await page.waitForSelector("#ended:not(.hidden)", { timeout: 20000 });
  const [again] = await Promise.all([page.waitForEvent("popup"), page.click("#summary-claude")]);
  assert.equal(again.url(), "https://claude.ai/new");
  assert.match(await clipboard(page), /Io: frase di prova 1/);
  await page.context().close();
});

await step("always-on-top window: the live panel keeps updating there, and Stop works from it", async () => {
  const page = await newPage("?speed=25");
  await page.click("#demo");
  await page.waitForSelector("#transcript .line");
  const [pip] = await Promise.all([page.context().waitForEvent("page"), page.click("#pip")]);
  await pip.waitForSelector("#live #transcript");
  const before = await pip.evaluate(() => document.querySelectorAll("#transcript .line").length);
  await pip.waitForFunction((n) => document.querySelectorAll("#transcript .line").length > n + 5, before, { timeout: 15000 });
  await pip.waitForFunction(() => document.getElementById("timer").textContent !== "00:00", null, { timeout: 5000 });
  await pip.click("#stop");
  await page.waitForSelector("#ended:not(.hidden)", { timeout: 20000 });
  assert.ok(await page.evaluate(() => Boolean(document.getElementById("live"))), "the panel is back in the page");
  await page.context().close();
});

// The user's bridge (bridge/src/worker.js), run here on Node's SQLite. The page
// reaches it at https://bridge.test (bridge alone, like the Deploy button) or
// at https://app.test (deployed with the app, like the repository imported as
// it is); Claude's side is a direct MCP request.
const bridgeEnv = { DB: memoryD1() };
const appEnv = {
  DB: bridgeEnv.DB,
  ASSETS: {
    async fetch(request) {
      const file = await webFile(new URL(request.url).pathname);
      return file ? new Response(file.body, { headers: { "content-type": file.type } }) : new Response("not found", { status: 404 });
    },
  },
};

async function routeBridge(context) {
  const route = (env) => async (r) => {
    const req = r.request();
    const res = await worker.fetch(
      new Request(req.url(), {
        method: req.method(),
        headers: { "content-type": (await req.headerValue("content-type")) || "text/plain" },
        body: ["GET", "HEAD"].includes(req.method()) ? undefined : req.postDataBuffer(),
        redirect: "manual",
      }),
      env,
    );
    await r.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
  };
  await context.route("https://bridge.test/**", route(bridgeEnv));
  await context.route("https://app.test/**", route(appEnv));
  await context.route("https://down.test/**", (r) => r.abort("connectionrefused"));
}

async function mcp(connector, method, params, env = bridgeEnv) {
  const res = await worker.fetch(new Request(connector, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), env);
  return (await res.json()).result;
}

const readBridge = async (connector, name, args = {}, env) => (await mcp(connector, "tools/call", { name, arguments: args }, env)).content[0].text;

async function untilBridge(connector, pattern, env, tries = 60) {
  let text = "";
  for (let i = 0; i < tries && !pattern.test(text); i++) {
    await new Promise((r) => setTimeout(r, 500));
    text = await readBridge(connector, "get_current_call", {}, env);
  }
  assert.match(text, pattern);
  return text;
}

await step("app served by its bridge: connected by itself, last step in the Call tab, Claude reads the call", async () => {
  const context = await newContext();
  await routeBridge(context);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  // (Old links to /web/... are redirected; the bridge's own tests cover it.)
  await page.goto("https://app.test/?engine=scripted&speed=25");
  await claudeTitle(page, /^Ultimo passo: aggiungi il connector su claude\.ai$/);
  const connector = await page.inputValue("#setup-connector");
  assert.match(connector, /^https:\/\/app\.test\/mcp\/[A-Za-z0-9_-]{32}$/);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "web-setup.png") });
  await page.click("#setup-copy");
  assert.equal(await clipboard(page), connector);
  assert.match(await page.textContent("#claude-text"), /^Copiato\. Su claude\.ai/);
  await page.click("#setup-done");
  await claudeTitle(page, /^Claude è collegato$/);
  assert.ok(await page.isHidden("#claude-connector-row"));

  await page.click('[data-tab="settings"]');
  assert.ok(await page.isHidden("#bridge-manual"));
  assert.ok(await page.isVisible("#bridge-here"));
  assert.equal(await page.inputValue("#bridge-connector"), connector);

  await page.click('[data-tab="call"]');
  await page.click("#demo");
  await page.waitForFunction(() => document.querySelectorAll("#transcript .line").length > 10, null, { timeout: 20000 });
  assert.match(await page.textContent("#live-hint"), /legge lui la chiamata/);
  await page.waitForSelector("#bridge-state.ok");
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "web-live.png"), clip: { x: 0, y: 0, width: 900, height: 620 } });
  // Claude: the ready-made prompt carries the transcript; the tool finds the app's link once the call is over.
  await untilBridge(connector, /Status: in progress[\s\S]*\[\d\d:\d\d\] (Me|Them): /, appEnv);
  const prompt = await mcp(connector, "prompts/get", { name: "cosa_dico_adesso" }, appEnv);
  assert.match(prompt.messages[0].content.text, /^Sono in una chiamata adesso\.[\s\S]*<call>\nCall /);
  await page.click("#stop");
  await page.waitForSelector("#ended:not(.hidden)", { timeout: 20000 });
  assert.match(await page.textContent("#ended-hint"), /Claude ha tutta la chiamata/);
  await untilBridge(connector, /Status: ended\. To follow a new call, the user opens the Call Assistant at https:\/\/app\.test\/ and presses Start\./, appEnv);
  await context.close();
});

await step("bridge at another address (e.g. the app on GitHub Pages): connect it in Settings", async () => {
  const page = await newPage("?engine=scripted");
  await routeBridge(page.context());
  await claudeTitle(page, /^Claude non è collegato$/);
  await page.click("#go-settings");
  assert.ok(await page.isVisible("#bridge-manual"));
  await page.fill("#bridge-url", "https://down.test");
  await page.click("#bridge-connect");
  await page.waitForFunction(() => /Non riesco a raggiungere il ponte/.test(document.querySelector("#bridge-status").textContent));
  assert.ok(await page.isHidden("#bridge-connector-box"));
  await page.fill("#bridge-url", "bridge.test/");
  await page.click("#bridge-connect");
  await page.waitForFunction(() => /^Collegato/.test(document.querySelector("#bridge-status").textContent));
  const connector = await page.inputValue("#bridge-connector");
  assert.match(connector, /^https:\/\/bridge\.test\/mcp\/[A-Za-z0-9_-]{32}$/);
  await page.click("#bridge-copy");
  assert.equal(await clipboard(page), connector);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "web-connector.png"), fullPage: true });

  await page.click('[data-tab="call"]');
  await claudeTitle(page, /^Ultimo passo/);
  await page.uncheck("#src-shared");
  await page.click("#start");
  await page.waitForFunction(() => document.querySelectorAll("#transcript .line").length >= 2, null, { timeout: 30000 });
  // Claude's side: the transcript arrives within a few seconds.
  const live = await untilBridge(connector, /Me: frase di prova 2/);
  assert.match(live, /Status: in progress/);
  await page.waitForSelector("#bridge-state.ok");
  // «Ask Claude» now copies only the request: Claude reads the call itself.
  await Promise.all([page.waitForEvent("popup"), page.click("#ask-claude")]);
  assert.match(await clipboard(page), /^Usa il connector della mia pagina Assistente chiamate \(strumento get_current_call\)/);

  await page.click("#stop");
  await page.waitForSelector("#ended:not(.hidden)", { timeout: 20000 });
  await untilBridge(connector, /Status: ended/);
  await page.click('[data-tab="settings"]');
  await page.click("#bridge-clear");
  await page.waitForFunction(() => /^Fatto/.test(document.querySelector("#bridge-status").textContent));
  assert.match(await readBridge(connector, "list_calls"), /^No calls yet/);
  await page.context().close();
});

await step("settings: speech model loaded by hand, Claude chat link, interface language", async () => {
  const page = await newPage("");
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
  await page.fill("#claude-url", "https://example.com/chat");
  await page.click("#settings-save");
  assert.match(await page.textContent("#settings-status"), /claude\.ai/);
  await page.fill("#claude-url", "https://claude.ai/project/0123");
  await page.selectOption("#ui-language", "en");
  await page.click("#settings-save");
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem("ca.settings.v1"))).claudeUrl, "https://claude.ai/project/0123");
  assert.equal(await page.textContent('[data-tab="history"]'), "History");
  assert.equal(await page.locator('[data-tab="memory"], #api-key').count(), 0, "no memory tab and no API key any more");
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "web-settings.png"), fullPage: true });
  await page.context().close();
});

await step("every script and the Whisper worker load with the version stamp of index.html", async () => {
  const { version } = currentStamp();
  served.length = 0;
  const page = await newPage("");
  // A stand-in for Transformers.js, so the worker stops right after its own imports.
  await page.context().route("https://cdn.jsdelivr.net/npm/@huggingface/transformers@*", (route) =>
    route.fulfill({
      headers: { "content-type": "text/javascript", "access-control-allow-origin": "*" },
      body: "export const env = {}; export async function pipeline() { throw new Error('stub transformers'); }",
    }),
  );
  await page.waitForFunction(() => window.__callAssistant);
  const loaded = await page.evaluate(async () => {
    const { WhisperTranscriber } = await import("./js/transcriber.js");
    const whisper = new WhisperTranscriber();
    try {
      return await whisper.load();
    } catch (err) {
      return err.message;
    } finally {
      whisper.dispose();
    }
  });
  assert.match(loaded, /stub transformers/);
  const scripts = served.filter((url) => /\.(m?js|css)(\?|$)/.test(url));
  assert.ok(scripts.includes(`/js/app.js?v=${version}`), scripts.join(" "));
  assert.ok(scripts.includes(`/js/whisper-worker.js?v=${version}`), scripts.join(" "));
  assert.ok(scripts.includes(`/js/bridge.js?v=${version}`), scripts.join(" "));
  // The worker's own import too: workers don't see the page's import map.
  assert.equal(scripts.filter((url) => url.startsWith("/js/model-files.js")).length, 2, scripts.join(" "));
  for (const url of scripts) assert.ok(url.endsWith(`?v=${version}`), `${url} has no ?v=${version}`);
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
