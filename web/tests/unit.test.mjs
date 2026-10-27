// Run with: node --test web/tests/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Bridge, BridgeError, BridgeSync, cleanBridgeUrl, newBridgeKey } from "../js/bridge.js";
import { ClaudeClient, CostTracker, FakeClaude, LLMError, estimateCost } from "../js/claude.js";
import { Memory, MemoryPathError } from "../js/memory.js";
import { INSIGHT_SCHEMA, chatAskPrompt, chatSummaryPrompt, chatTranscript } from "../js/prompts.js";
import { AudioRouter, Segmenter, TARGET_RATE, resample } from "../js/segmenter.js";
import { CallSession, TranscriptReplay } from "../js/session.js";
import { ScriptedTranscriber } from "../js/transcriber.js";
import { TranscriptStore, cleanTranscription, collapseRepetitions, fmtTime, parseTranscript } from "../js/transcript.js";

const ROOT = new URL("../../", import.meta.url);

// ------------------------------------------------------------------ audio
function tone(freq, seconds, rate = TARGET_RATE, amp = 0.3) {
  const n = Math.round(seconds * rate);
  return Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate));
}

function speechLike(seconds) {
  const n = Math.round(seconds * TARGET_RATE);
  return Float32Array.from({ length: n }, (_, i) => {
    const t = i / TARGET_RATE;
    const env = t % 2 > 1.85 ? 0 : 0.2 + 0.8 * Math.abs(Math.sin(2 * Math.PI * 3 * t));
    return 0.3 * env * Math.sin(2 * Math.PI * 300 * t);
  });
}

function feed(seg, audio, block = 1600) {
  const out = [];
  for (let i = 0; i < audio.length; i += block) out.push(...seg.push(audio.subarray(i, i + block), i / TARGET_RATE));
  const last = seg.flush();
  return last ? [...out, last] : out;
}

function readWav16k(path) {
  const buf = readFileSync(path);
  const rate = buf.readUInt32LE(24);
  let offset = 12;
  while (buf.toString("ascii", offset, offset + 4) !== "data") offset += 8 + buf.readUInt32LE(offset + 4);
  const size = buf.readUInt32LE(offset + 4);
  const pcm = new Float32Array(size / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(offset + 8 + i * 2) / 32768;
  return resample(pcm, rate, TARGET_RATE);
}

test("resample keeps length and filters above Nyquist", () => {
  const y = resample(tone(440, 1, 48000), 48000);
  assert.ok(Math.abs(y.length - 16000) <= 1);
  const high = resample(tone(12000, 1, 48000), 48000);
  const rmsOf = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
  assert.ok(rmsOf(high) < 0.05 * rmsOf(tone(12000, 1, 48000)));
});

test("segmenter splits on pauses and ignores noise", () => {
  const silence = new Float32Array(TARGET_RATE);
  const audio = Float32Array.from([...silence, ...tone(300, 1.5), ...silence, ...tone(500, 2), ...silence]);
  const chunks = feed(new Segmenter("them"), audio);
  assert.equal(chunks.length, 2);
  assert.ok(Math.abs(chunks[0].start - 1.0) < 0.35);
  const noise = Float32Array.from({ length: TARGET_RATE * 3 }, () => (Math.random() - 0.5) * 0.002);
  assert.equal(feed(new Segmenter("me"), noise).length, 0);
});

test("segmenter cuts long speech at quiet points", () => {
  const chunks = feed(new Segmenter("them", { maxChunkS: 12 }), speechLike(30));
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.end - c.start <= 12.1));
});

test("segmenter on real synthesized speech (the desktop tests' fixture)", () => {
  const audio = readWav16k(new URL("tests/fixtures/speech_it_en.wav", ROOT));
  const chunks = feed(new Segmenter("them"), audio);
  assert.ok(chunks.length >= 3 && chunks.length <= 5, `got ${chunks.length}`);
});

test("router closes an utterance when the source goes quiet", () => {
  let now = 0;
  const got = [];
  const router = new AudioRouter((c) => got.push(c), () => now);
  const speech = speechLike(1.5);
  for (let i = 0; i < speech.length; i += 1600) {
    now = (i + 1600) / TARGET_RATE;
    router.feed("them", speech.subarray(i, i + 1600), now);
  }
  assert.equal(got.length, 0);
  now += 1.5;
  router.checkStale();
  assert.equal(got.length, 1);
});

// ------------------------------------------------------------- transcript
test("Whisper hallucinations and loops are cleaned", () => {
  assert.equal(cleanTranscription("Sottotitoli creati dalla comunità Amara.org"), "");
  assert.equal(cleanTranscription("Thanks for watching!"), "");
  assert.equal(cleanTranscription("[Musica]"), "");
  assert.equal(cleanTranscription("Grazie mille, a domani"), "Grazie mille, a domani");
  assert.equal(collapseRepetitions("e poi e poi e poi e poi andiamo"), "e poi e poi andiamo");
});

test("echo of the call audio heard by the microphone is dropped", () => {
  const s = new TranscriptStore();
  s.add({ t: 10, speaker: "them", text: "Domani ci vediamo alle otto in piazza" });
  assert.equal(s.add({ t: 10.4, speaker: "me", text: "domani ci vediamo alle 8 in piazza" }), null);
  assert.ok(s.add({ t: 12, speaker: "me", text: "Perfetto, porto anche Marta" }));
  s.add({ t: 20.2, speaker: "me", text: "Hai visto la partita ieri sera?" });
  s.add({ t: 20, speaker: "them", text: "Hai visto la partita ieri sera" });
  assert.deepEqual(s.lines.map((l) => l.speaker), ["them", "me", "them"]);
  assert.equal(s.text(s.lines, 1).split("\n")[1], "*[00:12] Me: Perfetto, porto anche Marta");
});

test("time format and demo transcript parsing", () => {
  assert.equal(fmtTime(75.9), "01:15");
  assert.equal(fmtTime(3725), "1:02:05");
  const lines = parseTranscript(readFileSync(new URL("web/samples/demo_call_it.txt", ROOT), "utf8"));
  assert.ok(lines.length > 30);
  assert.deepEqual(new Set(lines.map((l) => l.speaker)), new Set(["me", "them"]));
});

// ----------------------------------------------------------------- memory
class FakeStorage {
  constructor() {
    this.data = {};
  }
  getItem(k) {
    return k in this.data ? this.data[k] : null;
  }
  setItem(k, v) {
    this.data[k] = String(v);
  }
  removeItem(k) {
    delete this.data[k];
  }
}

test("memory: templates count as empty, edits are used, paths validated", () => {
  const storage = new FakeStorage();
  const m = new Memory("it", storage);
  assert.match(m.loadText().text, /empty/);
  m.write("about-me.md", "# Chi sono\n<!-- nota -->\nMi chiamo Andrea.\n");
  assert.match(m.loadText().text, /Andrea/);
  assert.doesNotMatch(m.loadText().text, /nota/);
  for (const bad of ["../x.md", "/etc/x.md", "C:/x.md", "notes.txt", ".hidden.md", "a/../b.md"]) {
    assert.throws(() => m.resolve(bad), MemoryPathError, bad);
  }
  const again = new Memory("it", storage); // persisted
  assert.match(again.loadText().text, /Andrea/);
});

test("memory: proposals append, Claude export import, backup round trip", () => {
  const m = new Memory("en", new FakeStorage());
  m.apply({ file: "people/Giulia Bianchi.md", content: "- Architect in Bologna." }, "call-1");
  m.apply({ file: "people/Giulia Bianchi.md", content: "- Turns 30 on 14/11." });
  const text = m.files["people/Giulia Bianchi.md"];
  assert.ok(text.startsWith("# Giulia Bianchi") && text.indexOf("Architect") < text.indexOf("Turns 30"));
  m.importClaudeExport("- You are a designer");
  assert.match(m.loadText().text, /designer/);
  const other = new Memory("en", new FakeStorage());
  assert.ok(other.importBundle(m.exportBundle()) >= 4);
  assert.equal(other.files["people/Giulia Bianchi.md"], m.files["people/Giulia Bianchi.md"]);
});

// ----------------------------------------------------------------- Claude
function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    const call = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) };
    calls.push(call);
    const { status = 200, json } = handler(call);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  };
  fn.calls = calls;
  return fn;
}

const message = (text, extra = {}) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-haiku-5-5",
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  usage: { input_tokens: 120, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 3000 },
  ...extra,
});

const ask = (client, model = "claude-haiku-5-5", extra = {}) =>
  client.completeJson({ model, system: "SYS", user: "USER", schema: INSIGHT_SCHEMA, maxTokens: 4000, effort: "low", timeoutMs: 5000, ...extra });

test("Claude request from the browser: shape, caching, structured output", async () => {
  const fetch = mockFetch(() => ({ json: message('{"topic":"x","suggestions":[],"remember":[],"running_summary":""}') }));
  const reply = await ask(new ClaudeClient("sk-ant-test", { fetch }));
  const { url, headers, body } = fetch.calls[0];
  assert.ok(url.endsWith("/v1/messages"));
  assert.equal(headers.get("anthropic-dangerous-direct-browser-access"), "true");
  assert.equal(headers.get("x-api-key"), "sk-ant-test");
  assert.deepEqual(body.system, [{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }]);
  assert.equal(body.output_config.effort, "low");
  assert.equal(body.output_config.format.type, "json_schema");
  for (const k of ["temperature", "top_p", "top_k", "fallbacks"]) assert.ok(!(k in body), k);
  assert.equal(reply.data.topic, "x");
  assert.deepEqual(reply.usage, { input: 120, output: 80, cacheWrite: 0, cacheRead: 3000 });
});

test("summary on Opus uses server-side fallback and no caching", async () => {
  const fetch = mockFetch(() => ({ json: message('{"ok":true}', { model: "claude-opus-5-5" }) }));
  await ask(new ClaudeClient("sk-ant-test", { fetch }), "claude-opus-5-5", { cacheSystem: false });
  const { url, headers, body } = fetch.calls[0];
  assert.ok(url.includes("/v1/messages"));
  assert.match(headers.get("anthropic-beta") || "", /server-side-fallback-2026-07-01/);
  assert.equal(body.fallbacks, "default");
  assert.deepEqual(body.system, [{ type: "text", text: "SYS" }]);
});

test("API errors become readable; bad key and no credit are fatal", async () => {
  const cases = [
    [401, "authentication_error", /401/, true],
    [400, "invalid_request_error", /credit/, true],
    [429, "rate_limit_error", /rate limit/, false],
  ];
  for (const [status, type, re, fatal] of cases) {
    const fetch = mockFetch(() => ({
      status,
      json: { type: "error", error: { type, message: status === 400 ? "Your credit balance is too low" : "x" } },
    }));
    await assert.rejects(ask(new ClaudeClient("sk-ant-test", { fetch, maxRetries: 0 })), (err) => {
      assert.ok(err instanceof LLMError);
      assert.match(err.message, re);
      assert.equal(err.fatal, fatal);
      return true;
    });
  }
  const refusal = mockFetch(() => ({ json: message("", { stop_reason: "refusal" }) }));
  await assert.rejects(ask(new ClaudeClient("sk-ant-test", { fetch: refusal })), /declined/);
});

test("cost estimate", () => {
  assert.ok(Math.abs(estimateCost("claude-haiku-5-5", { input: 90000, output: 0, cacheWrite: 0, cacheRead: 0 }) - 0.009) < 1e-9);
  assert.ok(Math.abs(estimateCost("claude-opus-5-5", { input: 0, output: 1000, cacheWrite: 0, cacheRead: 0 }) - 0.02) < 1e-9);
  const c = new CostTracker();
  c.add("live", "claude-haiku-5-5", { input: 1000, output: 100, cacheWrite: 0, cacheRead: 0 });
  assert.ok(c.total > 0);
});

// ---------------------------------------------------------------- session
const SETTINGS = {
  uiLanguage: "it",
  callLanguage: "auto",
  insightInterval: 10,
  insightModel: "claude-haiku-5-5",
  summaryModel: "claude-opus-5-5",
  transcriptWindow: 240,
};

test("demo session end to end: transcript, live insight, summary, proposals", async () => {
  const events = [];
  const lines = parseTranscript(readFileSync(new URL("web/samples/demo_call_it.txt", ROOT), "utf8"));
  const replay = new TranscriptReplay(lines, 200);
  const llm = new FakeClaude();
  const s = new CallSession({ settings: SETTINGS, memory: new Memory("it", new FakeStorage()), llm, replay, onEvent: (k, p) => events.push([k, p]) });
  await s.start();
  await replay.finished;
  s.requestInsight();
  await s.waitFor(() => events.some(([k]) => k === "insight"), 5000);
  const result = await s.stop();
  const kinds = events.map(([k]) => k);
  assert.ok(kinds.includes("transcript") && kinds.includes("insight") && kinds.includes("summary"));
  assert.equal(s.store.length, lines.length);
  assert.equal(result.data.title, "Chiamata demo");
  assert.equal(result.proposals[0].file, "people/Giulia.md");
  assert.deepEqual(llm.requests.map((r) => r.model), ["claude-haiku-5-5", "claude-opus-5-5"]);
});

test("audio session: segmenter + (scripted) Whisper, and fatal API errors stop live insights", async () => {
  const events = [];
  const audio = readWav16k(new URL("tests/fixtures/speech_it_en.wav", ROOT));
  let now = 0;
  const capture = {
    wantShared: true,
    async start(feedFn, clock) {
      for (let i = 0; i < audio.length; i += 1600) {
        now = (i + 1600) / TARGET_RATE;
        feedFn("them", audio.subarray(i, i + 1600), clock());
      }
      return ["fake capture"];
    },
    stop() {},
  };
  const failing = { completeJson: async () => { throw new LLMError("API key not valid (401)", { fatal: true }); } };
  const transcriber = new ScriptedTranscriber(["Ciao Marco, come stai?", "Ti chiamo per la cena di sabato.", "Did you finish it?", "A presto!"], 5);
  const s = new CallSession({ settings: SETTINGS, memory: new Memory("it", new FakeStorage()), llm: failing, transcriber, capture, onEvent: (k, p) => events.push([k, p]), clock: () => now });
  await s.start();
  s.requestInsight();
  await s.waitFor(() => s.store.length >= 3, 3000);
  await s.waitFor(() => s.insightsDisabled, 3000);
  assert.equal(s.nextInsightIn(), null);
  const result = await s.stop();
  assert.equal(s.store.lines[0].text, "Ciao Marco, come stai?");
  assert.ok(s.store.length >= 3);
  assert.ok(result.error); // summary failed too (same broken key), but the transcript is kept
  assert.ok(result.transcript.length >= 3);
  assert.ok(events.some(([k, p]) => k === "warning" && Array.isArray(p) && p[0] === "insight_error"));
});

test("Claude chat requests: labels, notes, and only the end of a long call", () => {
  const lines = Array.from({ length: 400 }, (_, i) => ({ t: i * 5, speaker: i % 2 ? "them" : "me", text: `frase numero ${i}` }));
  const ask = chatAskPrompt({ lang: "it", lines, notes: "<file path=\"me.md\">\nMi chiamo Andrea\n</file>" });
  assert.match(ask, /^Sono in una chiamata adesso\./);
  assert.match(ask, /Le mie note personali:\n<file path="me\.md">/);
  assert.match(ask, /\[33:15\] Altri: frase numero 399$/);
  assert.match(ask, /\(inizio della chiamata omesso\)\n\[\d\d:\d\d\] (Io|Altri): /);
  assert.ok(!ask.includes("frase numero 0\n"));
  assert.ok(ask.length < 13500);
  assert.equal(chatTranscript(lines.slice(0, 2), "en"), "[00:00] Me: frase numero 0\n[00:05] Them: frase numero 1");

  const summary = chatSummaryPrompt({ lang: "en", meta: "today, 33:15", lines, liveRemember: ["Party on Saturday"] });
  assert.match(summary, /^I just finished a call \(today, 33:15\)\./);
  assert.match(summary, /Notes taken during the call:\n- Party on Saturday/);
  assert.ok(summary.includes("[00:00] Me: frase numero 0") && !summary.includes("My personal notes"));
});

test("bridge addresses and secret key", () => {
  assert.equal(cleanBridgeUrl(""), "");
  assert.equal(cleanBridgeUrl(" call-assistant-bridge.me.workers.dev/ "), "https://call-assistant-bridge.me.workers.dev");
  assert.equal(cleanBridgeUrl("https://b.me.workers.dev/mcp/abcdefghijklmnopqrstuvwxyz012345"), "https://b.me.workers.dev");
  assert.equal(cleanBridgeUrl("http://localhost:8787/"), "http://localhost:8787");
  assert.equal(cleanBridgeUrl("http://example.com"), null);
  assert.equal(cleanBridgeUrl("ftp://example.com"), null);
  const key = newBridgeKey();
  assert.match(key, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(key, newBridgeKey());
  assert.equal(new Bridge({ url: "https://b.dev", key }).connectorUrl, `https://b.dev/mcp/${key}`);
});

test("bridge requests: simple text/plain POSTs, readable errors", async () => {
  const sent = [];
  const reply = (status, body) => async (url, init) => {
    sent.push({ url, init });
    if (status === 0) throw new TypeError("Failed to fetch");
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  const bridge = (fetchImpl) => new Bridge({ url: "https://b.dev", key: "K".repeat(32), fetchImpl });
  assert.deepEqual(await bridge(reply(200, { ok: true, calls: 2 })).status(), { ok: true, calls: 2 });
  assert.equal(sent[0].url, `https://b.dev/api/${"K".repeat(32)}/status`);
  await bridge(reply(200, { ok: true })).send({ id: "x", lines: [] });
  assert.equal(sent[1].init.headers["content-type"], "text/plain;charset=UTF-8");
  assert.equal(JSON.parse(sent[1].init.body).id, "x");
  const code = async (fetchImpl) => (await bridge(fetchImpl).status().catch((e) => e)).code;
  assert.equal(await code(reply(0)), "unreachable");
  assert.equal(await code(reply(404, "<html>Not found</html>")), "not_found");
  assert.equal(await code(reply(500, { ok: false, error: "no_database" })), "no_database");
  assert.equal(await code(reply(500, { ok: false, error: "server_error" })), "failed");
  assert.ok((await bridge(reply(0)).clear().catch((e) => e)) instanceof BridgeError);
});

test("bridge sync sends the call when it changes, reports trouble, marks the end", async () => {
  const store = new TranscriptStore();
  const session = { startedAt: new Date("2026-10-27T09:00:00Z"), language: "it", store, lastInsight: null };
  const calls = [];
  let down = false;
  const bridge = { send: async (call) => { if (down) throw new BridgeError("unreachable"); calls.push(call); } };
  const states = [];
  const sync = new BridgeSync({ bridge, session, intervalMs: 60000, onState: (s) => states.push(s) });
  await sync.tick();
  await sync.tick(); // nothing new: nothing sent
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { id: "2026-10-27T09:00:00.000Z", startedAt: "2026-10-27T09:00:00.000Z", status: "live", lang: "it", lines: [], remember: [], summary: "" });
  store.add({ t: 3, speaker: "me", text: "Ciao Giulia" });
  down = true;
  await sync.tick();
  down = false;
  await sync.tick(); // the failed update is sent again
  assert.deepEqual(calls[1].lines, [{ t: 3, speaker: "me", text: "Ciao Giulia" }]);
  assert.deepEqual(states, ["ok", "error", "ok"]);
  await sync.finish("Riassunto.");
  assert.equal(calls[2].status, "ended");
  assert.equal(calls[2].summary, "Riassunto.");
});
