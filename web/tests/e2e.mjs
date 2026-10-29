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
    colorScheme: process.env.E2E_SCHEME === "dark" ? "dark" : "light", // E2E_SCHEME=dark: screenshots in dark mode
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
    // On GitHub, also an annotation: readable on the check without opening the log.
    if (process.env.GITHUB_ACTIONS) {
      const escape = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
      const title = escape(`e2e: ${name}`).replace(/:/g, "%3A").replace(/,/g, "%2C");
      const where = (String(err.stack || "").match(/e2e\.mjs:(\d+)/) || [])[1];
      console.log(`::error title=${title}${where ? ` (line ${where})` : ""}::${escape(String(err.message || err).split("\n").slice(0, 3).join("\n"))}`);
    }
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
  // At x5 the demo lasts ~45 s: still running however slowly the window opens.
  const page = await newPage("?speed=5");
  await page.click("#demo");
  await page.waitForSelector("#transcript .line");
  const [pip] = await Promise.all([page.context().waitForEvent("page"), page.click("#pip")]);
  await pip.waitForSelector("#live #transcript");
  const before = await pip.evaluate(() => document.querySelectorAll("#transcript .line").length);
  await pip.waitForFunction((n) => document.querySelectorAll("#transcript .line").length > n + 2, before, { timeout: 20000 });
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
  await page.setViewportSize({ width: 1200, height: 800 });
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
  assert.ok(await page.isHidden("#live-hint"), "with the bridge, the hint is in Claude's column");
  await page.waitForSelector("#bridge-state.ok");
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "web-live.png"), clip: { x: 0, y: 0, width: 900, height: 620 } });
  // Claude: the ready-made prompt carries the transcript; the tool finds the app's link once the call is over.
  await untilBridge(connector, /Status: in progress[\s\S]*\[\d\d:\d\d\] (Me|Them): /, appEnv);
  const prompt = await mcp(connector, "prompts/get", { name: "cosa_dico_adesso" }, appEnv);
  assert.match(prompt.messages[0].content.text, /^Sono in una chiamata adesso\.[\s\S]*<call>\nCall /);
  // Claude's suggestions, sent with show_suggestions, appear left of the transcript.
  assert.ok(await page.evaluate(() => document.getElementById("live-body").classList.contains("two")));
  assert.match(await page.textContent("#sug-topic"), /Fai seguire a Claude/);
  // One click: the request to follow the call, ready to paste in Claude's chat.
  assert.equal((await page.textContent("#ask-claude")).trim(), "Fai seguire a Claude ↗");
  await Promise.all([page.waitForEvent("popup"), page.click("#ask-claude")]);
  assert.match(await clipboard(page), /^Segui la mia call in diretta con il connector Call Assistant[\s\S]*follow_call[\s\S]*set_meeting_context[\s\S]*show_suggestions/);
  assert.match(await page.textContent("#notice"), /^Copiato: incollalo nella chat di Claude/);
  // A new call starts without a briefing. Claude follows it: its first round has the call so far; the page shows it is following.
  assert.ok(await page.isHidden("#meeting"));
  assert.match(await page.textContent("#follow-state"), /^Claude non sta seguendo la call/);
  const round = await readBridge(connector, "follow_call", {}, appEnv);
  const [, tag] = /^Round 1 · call ([0-9a-z]+) · call time /.exec(round) || [];
  assert.ok(tag, round);
  assert.match(round, /This call has no briefing yet: every call starts without one\.[\s\S]*How to follow, every round:/);
  await page.waitForFunction(() => /^Claude segue la call: giro 1, \d+ s fa$/.test(document.querySelector("#follow-state").textContent), null, { timeout: 15000 });
  // The chat knows the meeting: Claude saves its briefing for this call. Its title and questions show above the suggestions.
  const briefing = await mcp(connector, "tools/call", {
    name: "set_meeting_context",
    arguments: {
      title: "Offerta Milano",
      goal: "Chiudere la data di inizio",
      objectives: ["Data di inizio"],
      questions: ["Chi paga il trasloco?", "Quando si inizia?"],
      glossary: ["Giulia", "Navigli"],
      call: tag,
    },
  }, appEnv);
  assert.match(briefing.content[0].text, /^Briefing saved for «Offerta Milano»: 1 objectives, 2 questions, 2 glossary terms[\s\S]*for the call in progress/);
  await page.waitForSelector("#meeting:not(.hidden)", { timeout: 15000 });
  assert.equal(await page.textContent("#meeting-title"), "Offerta Milano");
  assert.equal(await page.textContent("#meeting-goal"), "Chiudere la data di inizio");
  assert.equal(await page.textContent("#questions-count"), "2 aperte su 2");
  const shown = await mcp(connector, "tools/call", {
    name: "show_suggestions",
    arguments: {
      topic: "Giulia ha un'offerta di lavoro a Milano",
      suggestions: [
        { kind: "question", say: "Quando dovresti iniziare?", why: "serve la data per decidere" },
        { kind: "warning", say: "Non promettere una risposta entro oggi.", why: "prima parlane con Luca" },
      ],
      remember: ["Decidere entro venerdì"],
      answered: ["Chi paga il trasloco?"],
      call: tag,
    },
  }, appEnv);
  assert.match(shown.content[0].text, new RegExp(`^Shown in the Call Assistant window, next to the transcript\\. Next: call follow_call with cursor="${tag}:\\d+"\\.$`));
  await page.waitForFunction(() => document.querySelectorAll("#suggestions .suggestion").length === 2, null, { timeout: 15000 });
  assert.equal(await page.textContent("#sug-topic"), "Giulia ha un'offerta di lavoro a Milano");
  assert.equal(await page.textContent("#suggestions .suggestion >> nth=0"), "DomandaQuando dovresti iniziare?serve la data per decidere");
  assert.match(await page.textContent("#suggestions .suggestion >> nth=1"), /^Attenzione/);
  assert.equal(await page.textContent("#remember"), "Decidere entro venerdì");
  assert.match(await page.textContent("#sug-time"), /^(adesso|\d+ s fa)$/);
  assert.match(await page.getAttribute("#sug-time", "title"), /^aggiornati alle /);
  // Fresh suggestions glow for a moment.
  assert.ok(await page.evaluate(() => document.getElementById("now").classList.contains("fresh")));
  // The answered question is ticked, and listed after the open one.
  await page.waitForFunction(() => document.querySelector("#questions-count").textContent === "1 aperte su 2", null, { timeout: 15000 });
  assert.deepEqual(await page.$$eval("#questions li", (lis) => lis.map((li) => [li.textContent, li.className])), [["Quando si inizia?", ""], ["Chi paga il trasloco?", "done"]]);
  if (SHOTS) {
    // After the arrival animation; then the same panel as narrow as the always-on-top window.
    await page.waitForFunction(() => !document.getElementById("now").classList.contains("fresh"), null, { timeout: 5000 });
    await page.screenshot({ path: join(SHOTS, "web-suggestions.png"), clip: { x: 0, y: 0, width: 1200, height: 700 } });
    await page.setViewportSize({ width: 400, height: 640 });
    await page.evaluate(() => document.body.classList.add("pip"));
    await page.screenshot({ path: join(SHOTS, "web-pip.png") });
    await page.evaluate(() => document.body.classList.remove("pip"));
    await page.setViewportSize({ width: 1200, height: 800 });
  }
  await page.click("#suggestions .suggestion >> nth=0");
  assert.equal(await clipboard(page), "Quando dovresti iniziare?");
  // The next set takes "now"; the earlier ones stay in the script below: nothing disappears.
  await mcp(connector, "tools/call", { name: "show_suggestions", arguments: { topic: "La data", suggestions: [{ kind: "answer", say: "Posso iniziare a gennaio." }] } }, appEnv);
  await page.waitForFunction(() => document.querySelectorAll("#script .item").length === 2, null, { timeout: 15000 });
  assert.equal(await page.textContent("#suggestions .suggestion .text"), "Posso iniziare a gennaio.");
  assert.deepEqual(await page.$$eval("#script .item .say", (els) => els.map((e) => e.textContent)), ["Quando dovresti iniziare?", "Non promettere una risposta entro oggi."]);
  assert.match(await page.textContent("#script .group-head"), /^\d\d:\d\dGiulia ha un'offerta di lavoro a Milano$/);
  // Filter by kind (all answers, the one in "now" too), pin one: it stays on top of the script.
  await page.click("#script-filter .filter >> text=Risposte 1");
  assert.deepEqual(await page.$$eval("#script .item .say", (els) => els.map((e) => e.textContent)), ["Posso iniziare a gennaio."]);
  await page.click("#script-filter .filter >> text=Tutte 3");
  await page.click("#script .item.warning .pin");
  assert.equal(await page.textContent("#pinned .item .say"), "Non promettere una risposta entro oggi.");
  await page.click("#script .item.question .say");
  assert.equal(await clipboard(page), "Quando dovresti iniziare?");
  if (SHOTS) {
    await page.evaluate(() => document.getElementById("notice").classList.add("hidden")); // no toast in the picture
    await page.mouse.move(0, 0);
    await page.screenshot({ path: join(SHOTS, "web-script.png"), clip: { x: 0, y: 0, width: 1200, height: 800 } });
  }
  await page.click("#stop");
  await page.waitForSelector("#ended:not(.hidden)", { timeout: 20000 });
  assert.match(await page.textContent("#ended-hint"), /Claude ha tutta la chiamata/);
  // After the call, and in the history: everything Claude suggested.
  assert.equal(await page.textContent("#ended-script-count"), "3");
  assert.equal(await page.locator("#ended-script .item").count(), 3);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "web-ended-script.png"), fullPage: true });
  await untilBridge(connector, /Status: ended\. To follow a new call, the user opens the Call Assistant at https:\/\/app\.test\/ and presses Start\./, appEnv);
  // A new call starts clean: no briefing, no suggestions of the last one.
  await page.click("#new-call");
  await page.click("#demo");
  await page.waitForFunction(() => document.querySelectorAll("#transcript .line").length > 2, null, { timeout: 20000 });
  await page.waitForTimeout(3000); // a few rounds with the bridge
  assert.ok(await page.isHidden("#meeting"));
  assert.ok(await page.isHidden("#questions-box"));
  assert.ok(await page.isHidden("#script-box"));
  assert.equal(await page.locator("#suggestions .suggestion").count(), 0);
  assert.doesNotMatch(await readBridge(connector, "get_current_call", {}, appEnv), /Offerta Milano/);
  await page.click("#stop");
  await page.waitForSelector("#ended:not(.hidden)", { timeout: 20000 });
  await context.close();
});

await step("the bridge doesn't answer when the page opens: the call starts anyway, and Claude joins it when the bridge answers", async () => {
  const context = await newContext();
  const lateEnv = { DB: memoryD1(), ASSETS: appEnv.ASSETS };
  let down = true;
  await context.route("https://late.test/**", async (r) => {
    const req = r.request();
    if (down && new URL(req.url()).pathname.startsWith("/api/")) return r.abort("connectionrefused");
    const res = await worker.fetch(
      new Request(req.url(), { method: req.method(), body: ["GET", "HEAD"].includes(req.method()) ? undefined : req.postDataBuffer() }),
      lateEnv,
    );
    await r.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("https://late.test/?engine=scripted&speed=4");
  await page.waitForFunction(() => /ponte/.test(document.querySelector("#claude-text").textContent), null, { timeout: 15000 });
  await page.click("#demo");
  await page.waitForFunction(() => document.querySelectorAll("#transcript .line").length > 1, null, { timeout: 20000 });
  assert.ok(await page.isHidden("#claude-col"), "no bridge yet: no Claude column");
  assert.equal((await page.textContent("#ask-claude")).trim(), "Chiedi a Claude ↗");
  // The network is back: the page connects by itself, Claude's column appears, and the bridge gets the whole call so far.
  down = false;
  await page.waitForSelector("#claude-col:not(.hidden)", { timeout: 20000 });
  assert.equal((await page.textContent("#ask-claude")).trim(), "Fai seguire a Claude ↗");
  await page.waitForSelector("#bridge-state.ok", { timeout: 15000 });
  const key = await page.evaluate(() => JSON.parse(localStorage.getItem("ca.settings.v1")).bridgeKey);
  const text = await untilBridge(`https://late.test/mcp/${key}`, /Status: in progress[\s\S]*\[00:0\d\] (Me|Them): /, lateEnv);
  assert.match(text, /\] Them: Ciao! Finalmente riusciamo a sentirci/, "the start of the call too");
  assert.match(await readBridge(`https://late.test/mcp/${key}`, "follow_call", {}, lateEnv), /^Round 1 · call [0-9a-z]+ · /);
  await page.click("#stop");
  await page.waitForSelector("#ended:not(.hidden)", { timeout: 20000 });
  await untilBridge(`https://late.test/mcp/${key}`, /Status: ended/, lateEnv);
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
  // «Let Claude follow» copies only the request: Claude reads the call itself.
  await Promise.all([page.waitForEvent("popup"), page.click("#ask-claude")]);
  assert.match(await clipboard(page), /^Segui la mia call in diretta con il connector Call Assistant/);

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
  assert.equal(await page.locator("#manual-links a").count(), 7);
  assert.equal(await page.textContent("#manual-status"), "");
  assert.match(await page.getAttribute("#manual-links a >> nth=0", "href"), /huggingface\.co\/onnx-community\/whisper-base\/resolve\/main\/onnx\/encoder_model_quantized\.onnx$/);
  const onnx = (fill) => Buffer.concat([Buffer.from([0x08, 0x07]), Buffer.alloc(1_100_000, fill)]);
  await page.setInputFiles("#manual-files", [
    { name: "encoder_model_quantized.onnx", mimeType: "application/octet-stream", buffer: Buffer.from("<!DOCTYPE html><html>Security check</html>") },
  ]);
  await page.waitForFunction(() => /non è il file/.test(document.querySelector("#manual-status").textContent));
  await page.setInputFiles("#manual-files", [
    { name: "encoder_model_quantized.onnx", mimeType: "application/octet-stream", buffer: onnx(1) },
  ]);
  await page.waitForFunction(() => /Manca ancora: decoder_model_merged_quantized\.onnx, config\.json, /.test(document.querySelector("#manual-status").textContent));
  await page.setInputFiles("#manual-files", [
    { name: "decoder_model_merged_quantized (1).onnx", mimeType: "application/octet-stream", buffer: onnx(2) },
  ]);
  await page.waitForFunction(() => /Manca ancora: config\.json, generation_config\.json, preprocessor_config\.json, tokenizer\.json, tokenizer_config\.json\.$/.test(document.querySelector("#manual-status").textContent));
  // A security-check page saved under a .json name is refused too.
  await page.setInputFiles("#manual-files", [{ name: "config.json", mimeType: "application/json", buffer: Buffer.from("Access blocked by policy") }]);
  await page.waitForFunction(() => /config\.json non è il file/.test(document.querySelector("#manual-status").textContent));
  const json = (name, data) => ({ name, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(data)) });
  await page.setInputFiles("#manual-files", [
    json("config.json", { model_type: "whisper" }),
    json("generation_config.json", {}),
    json("preprocessor_config.json", {}),
    json("tokenizer.json", { model: {} }),
    json("tokenizer_config.json", {}),
  ]);
  await page.waitForFunction(() => /pronto/.test(document.querySelector("#manual-status").textContent));
  const cached = await page.evaluate(async () => {
    const cache = await caches.open("transformers-cache");
    const base = "https://huggingface.co/onnx-community/whisper-base/resolve/main/onnx/";
    const enc = await cache.match(base + "encoder_model_quantized.onnx");
    const dec = await cache.match(base + "decoder_model_merged_quantized.onnx");
    const config = await cache.match(base.replace("onnx/", "") + "config.json");
    return [enc && enc.headers.get("content-length"), dec && (await dec.arrayBuffer()).byteLength, config && (await config.json()).model_type];
  });
  assert.deepEqual(cached, ["1100002", 1100002, "whisper"]);
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
