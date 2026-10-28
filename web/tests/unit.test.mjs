// Run with: node --test web/tests/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Bridge, BridgeError, BridgeSync, cleanBridgeUrl, newBridgeKey, sameOriginBridge } from "../js/bridge.js";
import { chatAskPrompt, chatConnectorPrompt, chatSummaryPrompt, chatTranscript, projectInstructions } from "../js/prompts.js";
import { followRequest } from "../../bridge/src/worker.js";
import { EchoDetector } from "../js/echo.js";
import { SuggestionScript } from "../js/script.js";
import { AudioRouter, Segmenter, TARGET_RATE, resample } from "../js/segmenter.js";
import { CallSession, TranscriptReplay } from "../js/session.js";
import { ScriptedTranscriber } from "../js/transcriber.js";
import { TranscriptStore, cleanTranscription, collapseRepetitions, fmtTime, parseTranscript } from "../js/transcript.js";
import { DecodeControl, decoderPrefix, glossaryPrompt, judgeSegment, textTokens } from "../js/whisper-core.js";

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
  // By default at most 8 s, so the text of long speech doesn't wait too long.
  const quick = feed(new Segmenter("them"), speechLike(30));
  assert.ok(quick.length >= 4 && quick.every((c) => c.end - c.start <= 8.1), quick.map((c) => (c.end - c.start).toFixed(1)).join(" "));
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

const SETTINGS = { callLanguage: "auto" };

test("demo session: the transcript plays back, Stop ends the call with it", async () => {
  const events = [];
  const lines = parseTranscript(readFileSync(new URL("web/samples/demo_call_it.txt", ROOT), "utf8"));
  const replay = new TranscriptReplay(lines, 200);
  const s = new CallSession({ settings: SETTINGS, replay, onEvent: (k, p) => events.push([k, p]) });
  await s.start();
  await replay.finished;
  const result = await s.stop();
  const kinds = events.map(([k]) => k);
  assert.ok(kinds.includes("transcript") && kinds.includes("ended"));
  assert.equal(kinds.at(-1), "status");
  assert.equal(s.store.length, lines.length);
  assert.equal(result.transcript.length, lines.length);
  assert.deepEqual(Object.keys(result).sort(), ["durationS", "id", "startedAt", "transcript"]);
  assert.equal(await s.stop(), result); // a second Stop changes nothing
});

test("audio session: segmenter + (scripted) Whisper, and a warning when the call audio is silent", async () => {
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
  const transcriber = new ScriptedTranscriber(["Ciao Marco, come stai?", "Ti chiamo per la cena di sabato.", "Did you finish it?", "A presto!"], 5);
  const s = new CallSession({ settings: SETTINGS, transcriber, capture, onEvent: (k, p) => events.push([k, p]), clock: () => now });
  await s.start();
  const result = await s.stop();
  assert.equal(s.store.lines[0].text, "Ciao Marco, come stai?");
  // The whole recording arrives at once: while Whisper works on the first sentence the others
  // pile up, and are transcribed together in one window instead of one window each.
  assert.equal(result.transcript.length, 2);
  assert.equal(transcriber.calls.length, 2);
  assert.ok(transcriber.calls[1].seconds > 8, `${transcriber.calls[1].seconds}`);
  assert.ok(s.stats.joined >= 2);
  assert.ok(events.some(([k, p]) => k === "model_ready" && p === "scripted"));
  // How long after the end of each sentence its text appeared.
  const latencies = events.filter(([k]) => k === "latency").map(([, p]) => p);
  assert.ok(latencies.length === 2 && latencies.every((s) => s >= 0), latencies.join(" ")); // (the test clock jumps: no real delays here)
  assert.ok(events.some(([k, p]) => k === "audio" && p === "fake capture"));

  // Only the microphone heard for a while: the shared tab/screen audio is probably missing.
  const quiet = new CallSession({ settings: SETTINGS, transcriber: new ScriptedTranscriber([], 1), capture: { wantShared: true, start: async () => [], stop() {} }, onEvent: (k, p) => events.push([k, p]), clock: () => now });
  await quiet.start();
  for (let i = 0; i < 3; i++) quiet.addLine({ t: i, speaker: "me", text: `frase ${i}` });
  now = 1000;
  quiet.tick();
  assert.ok(events.some(([k, p]) => k === "warning" && p === "no_system_audio"));
  await quiet.stop();
});

test("Claude chat requests: labels, only the end of a long call, short requests with the connector", () => {
  const lines = Array.from({ length: 400 }, (_, i) => ({ t: i * 5, speaker: i % 2 ? "them" : "me", text: `frase numero ${i}` }));
  const ask = chatAskPrompt({ lang: "it", lines });
  assert.match(ask, /^Sono in una chiamata adesso\./);
  assert.match(ask, /\[33:15\] Altri: frase numero 399$/);
  assert.match(ask, /\(inizio della chiamata omesso\)\n\[\d\d:\d\d\] (Io|Altri): /);
  assert.ok(!ask.includes("frase numero 0\n"));
  assert.ok(ask.length < 13500);
  assert.equal(chatTranscript(lines.slice(0, 2), "en"), "[00:00] Me: frase numero 0\n[00:05] Them: frase numero 1");

  const summary = chatSummaryPrompt({ lang: "en", meta: "today, 33:15", lines });
  assert.match(summary, /^I just finished a call \(today, 33:15\)\./);
  assert.ok(summary.includes("[00:00] Me: frase numero 0"));

  assert.match(chatConnectorPrompt("it", "ask"), /strumento get_current_call\)/);
  assert.match(chatConnectorPrompt("en", "summary"), /minutes = 0/);
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
  const session = { startedAt: new Date("2026-10-27T09:00:00Z"), language: "it", store, settings: { uiLanguage: "it" } };
  const calls = [];
  let down = false;
  const bridge = {
    send: async (call) => {
      if (down) throw new BridgeError("unreachable");
      calls.push(call);
    },
    suggestions: async () => ({ suggestions: null, meeting: null, follow: null }),
  };
  const states = [];
  const sync = new BridgeSync({ bridge, session, intervalMs: 60000, onState: (s) => states.push(s) });
  await sync.tick();
  await sync.tick(); // nothing new: nothing sent
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { id: "2026-10-27T09:00:00.000Z", startedAt: "2026-10-27T09:00:00.000Z", status: "live", lang: "it", ui: "it", lines: [] });
  store.add({ t: 3, speaker: "me", text: "Ciao Giulia", lang: "it" });
  down = true;
  await sync.tick();
  down = false;
  await sync.tick(); // the failed update is sent again
  // n: the order the line was heard in; lang: what Whisper heard.
  assert.deepEqual(calls[1].lines, [{ t: 3, speaker: "me", text: "Ciao Giulia", n: 1, lang: "it" }]);
  assert.deepEqual(states, ["ok", "error", "ok"]);
  await sync.finish();
  assert.equal(calls[2].status, "ended");
  assert.equal(calls[2].lines.length, 1);
});

test("a page served by its bridge finds it at its own address", async () => {
  const key = "K".repeat(32);
  const seen = [];
  const reply = (status, body) => async (url) => {
    seen.push(url);
    return new Response(JSON.stringify(body), { status });
  };
  const here = await sameOriginBridge(key, { origin: "https://x.me.workers.dev", fetchImpl: reply(200, { ok: true, calls: 0 }) });
  assert.equal(here.url, "https://x.me.workers.dev");
  assert.equal(here.connectorUrl, `https://x.me.workers.dev/mcp/${key}`);
  assert.equal(seen[0], `https://x.me.workers.dev/api/${key}/status`);
  // GitHub Pages or any other host: no bridge there, quietly.
  assert.equal(await sameOriginBridge(key, { origin: "https://me.github.io", fetchImpl: reply(404, { message: "Not Found" }) }), null);
  assert.equal(await sameOriginBridge(key, { origin: "file://", fetchImpl: reply(200, { ok: true }) }), null);
  // A bridge without its database is worth saying.
  const err = await sameOriginBridge(key, { origin: "https://x.me.workers.dev", fetchImpl: reply(500, { ok: false, error: "no_database" }) }).catch((e) => e);
  assert.equal(err.code, "no_database");
});

test("bridge sync brings back Claude's suggestions for this call, once each", async () => {
  const store = new TranscriptStore();
  const session = { startedAt: new Date("2026-10-27T09:00:00Z"), language: "it", store };
  const id = "2026-10-27T09:00:00.000Z";
  let latest = { callId: id, updatedAt: 1, topic: "Milano", suggestions: [{ kind: "question", text: "Quando inizi?" }], remember: [] };
  let meeting = null;
  let gets = 0;
  const bridge = {
    send: async () => ({ ok: true, suggestions: latest, meeting }),
    suggestions: async () => (gets++, { suggestions: latest, meeting }),
  };
  const shown = [];
  const meetings = [];
  const sync = new BridgeSync({
    bridge,
    session,
    intervalMs: 60000,
    onSuggestions: (s) => shown.push(s.topic),
    onMeeting: (m) => meetings.push(m && m.title),
  });
  await sync.tick(); // sends the call; the answer carries the suggestions
  await sync.tick(); // nothing new to send: asks for suggestions, same as before
  assert.deepEqual(shown, ["Milano"]);
  assert.equal(gets, 1);
  latest = { ...latest, updatedAt: 2, topic: "Il trasloco" };
  meeting = { title: "Offerta Milano", goal: "Chiudere la data", updatedAt: 5 };
  await sync.tick();
  meeting = { ...meeting, updatedAt: 6 }; // same title and goal: not passed on again
  latest = { ...latest, updatedAt: 3, callId: "another call", topic: "Altro" };
  await sync.tick();
  assert.deepEqual(shown, ["Milano", "Il trasloco"]);
  assert.deepEqual(meetings, [null, "Offerta Milano"]);
});

test("bridge sync sends a new line at once, not at the next tick", async () => {
  const store = new TranscriptStore();
  const session = { startedAt: new Date("2026-10-27T09:00:00Z"), language: "it", store };
  const sent = [];
  const bridge = { send: async (call) => sent.push(call.lines.length), suggestions: async () => ({ suggestions: null, meeting: null }) };
  const sync = new BridgeSync({ bridge, session, intervalMs: 60000 });
  sync.start();
  await sync.busy;
  store.add({ t: 1, speaker: "me", text: "Ciao" });
  sync.nudge(20);
  sync.nudge(20); // lines arriving together go in one send
  await new Promise((r) => setTimeout(r, 80));
  await sync.busy;
  assert.deepEqual(sent, [0, 1]);
  sync.stop();
  sync.nudge(1); // after Stop, nothing more is sent
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(sent, [0, 1]);
});

// --------------------------------------------------------- echo and Whisper
const delayed = (x, seconds, gain) => {
  const d = Math.round(seconds * TARGET_RATE);
  const y = new Float32Array(x.length);
  for (let i = d; i < x.length; i++) y[i] = gain * x[i - d];
  return y;
};
const mix = (...xs) => {
  const y = new Float32Array(Math.max(...xs.map((x) => x.length)));
  for (const x of xs) for (let i = 0; i < x.length; i++) y[i] += x[i];
  return y;
};
let seed = 1;
const noise = (n, a) =>
  Float32Array.from({ length: n }, () => {
    seed = (seed * 16807) % 2147483647;
    return (seed / 2147483647 - 0.5) * 2 * a;
  });

/** Both sources through the router, as the live capture feeds them; what reaches Whisper and what is dropped as echo. */
function routeBoth(them, me) {
  const kept = [];
  const echoes = [];
  let now = 0;
  const router = new AudioRouter((c) => c.source === "me" && kept.push(c), () => now, { onEcho: (c) => echoes.push(c) });
  for (let i = 0; i < Math.max(them.length, me.length); i += 1600) {
    now = (i + 1600) / TARGET_RATE;
    router.feed("them", them.subarray(i, i + 1600), now);
    router.feed("me", me.subarray(i, i + 1600), now);
  }
  router.flushAll();
  return { kept, echoes };
}

test("echo: the microphone hearing the call from the speakers is dropped, the user's own voice is kept", () => {
  const speech = readWav16k(new URL("tests/fixtures/speech_it_en.wav", ROOT));
  const n = speech.length;
  // Speakers: the call reaches the microphone 150 ms later, quieter.
  const echo = routeBoth(speech, mix(delayed(speech, 0.15, 0.2), noise(n, 0.002)));
  assert.equal(echo.kept.length, 0);
  assert.ok(echo.echoes.length >= 3);
  assert.ok(echo.echoes.every((c) => c.echo.corr > 0.85 && c.echo.lagS > 0.1 && c.echo.lagS < 0.2), echo.echoes.map((c) => c.echo.corr.toFixed(2)).join(" "));
  // The user alone (the others silent): nothing to compare with, all kept.
  const alone = routeBoth(new Float32Array(n), mix(speech, noise(n, 0.002)));
  assert.ok(alone.kept.length >= 3 && alone.echoes.length === 0);
  // The user talking while the others talk (and are heard from the speakers): kept.
  const other = Float32Array.from(speech).reverse();
  const both = routeBoth(other, mix(speech, delayed(other, 0.15, 0.25), noise(n, 0.002)));
  assert.ok(both.kept.length >= 2 && both.echoes.length === 0, `${both.kept.length} kept, ${both.echoes.length} echoes`);
  // A gap in the shared audio doesn't shift its timeline.
  const d = new EchoDetector();
  d.addReference(new Float32Array(3200), 0);
  d.addReference(new Float32Array(3200), 1.2);
  assert.equal(d.ref.length, Math.round(1.4 / 0.02));
});

test("Whisper decoding: language between Italian and English, no-speech probability, confidence", () => {
  const ids = { sot: 10, eot: 5, prev: 11, transcribe: 12, notimestamps: 13, nospeech: 14, lang: { it: 20, en: 21 }, suppress: [14, 7], beginSuppress: [5] };
  const row = (values) => {
    const r = new Float32Array(30).fill(-5);
    for (const [i, v] of Object.entries(values)) r[i] = v;
    return r;
  };
  // Auto: the more likely of the two; the others (e.g. Spanish at 22) never win.
  const auto = new DecodeControl(ids, { prefixLength: 1 });
  const first = row({ 20: 3, 21: 1, 22: 9, 14: 2 });
  auto.step(1, first);
  assert.equal(auto.language, "it");
  assert.deepEqual([...first].map((v, i) => (v > -Infinity ? i : null)).filter((i) => i !== null), [20]);
  assert.ok(auto.noSpeechProb > 0 && auto.noSpeechProb < 0.01);
  // Then "transcribe" and "no timestamps" are forced; text steps add up the confidence.
  const second = row({ 12: 0, 3: 5 });
  auto.step(2, second);
  assert.equal(second.indexOf(Math.max(...second)), 12);
  auto.step(3, row({ 13: 0 }));
  // Text: the first token can't be the end of the text; tokens Whisper never writes are filtered out.
  const text1 = row({ 5: 20, 7: 20, 3: 10 });
  auto.step(4, text1);
  assert.equal(text1.indexOf(Math.max(...text1)), 3);
  const text2 = row({ 5: 20 });
  auto.step(5, text2);
  assert.equal(text2.indexOf(Math.max(...text2)), 5);
  assert.ok(auto.avgLogprob > -0.01 && auto.avgLogprob <= 0);
  // A close call keeps the language this speaker has been speaking.
  const close = new DecodeControl(ids, { prefer: "en", prefixLength: 1 });
  close.step(1, row({ 20: 2, 21: 1.5 }));
  assert.equal(close.language, "en");
  // Forced language; a prompt shifts where the steps start; silence shows as a high no-speech probability.
  const forced = new DecodeControl(ids, { language: "en", prefixLength: 4 });
  const quiet = row({ 20: 9, 14: 12 });
  forced.step(4, quiet);
  assert.equal(forced.language, "en");
  assert.ok(forced.noSpeechProb > 0.9);
  assert.equal(quiet.indexOf(Math.max(...quiet)), 21);

  assert.deepEqual(decoderPrefix(ids, []), [10]);
  assert.deepEqual(decoderPrefix(ids, [1, 2]), [11, 1, 2, 10]);
  assert.deepEqual(textTokens([11n, 1n, 2n, 10n, 21n, 12n, 13n, 3n, 4n, 30n, 5n, 3n], 4, ids), [3, 4]);
  assert.equal(glossaryPrompt([" Jaromir", "X-13", "Jaromir", ""]), "Jaromir, X-13.");
  assert.equal(glossaryPrompt([]), "");
});

test("what Whisper invents on silence is dropped, real speech is kept", () => {
  assert.equal(judgeSegment({ text: "Thank you.", noSpeechProb: 0.8, avgLogprob: -1.2 }), "no_speech");
  assert.equal(judgeSegment({ text: "We compile everything.", noSpeechProb: 0.02, avgLogprob: -0.3 }), "ok");
  // What the real whisper-base gives on 3 s of silence (see whisper-real.mjs).
  assert.equal(judgeSegment({ text: "you", noSpeechProb: 0.95, avgLogprob: -0.54 }), "no_speech");
  assert.equal(judgeSegment({ text: "A presto!", noSpeechProb: 0.11, avgLogprob: -0.55 }), "ok");
  assert.equal(judgeSegment({ text: "blah", noSpeechProb: 0.1, avgLogprob: -2.1 }), "unsure");
  assert.equal(judgeSegment({ text: "Jaromir, X-13.", noSpeechProb: 0.3, avgLogprob: -0.4 }, "Jaromir, X-13, MATLAB."), "prompt_echo");
  assert.equal(judgeSegment({ text: "" }), "empty");
  // Short polite words: kept when Whisper is sure, dropped when it isn't; sounds always dropped.
  assert.equal(cleanTranscription("Thank you.", { noSpeechProb: 0.4, avgLogprob: -0.3 }), "");
  assert.equal(cleanTranscription("Thank you.", { noSpeechProb: 0.01, avgLogprob: -0.2 }), "Thank you.");
  assert.equal(cleanTranscription("Okay.", { noSpeechProb: 0.02, avgLogprob: -0.9 }), "");
  assert.equal(cleanTranscription("Thank you."), "Thank you."); // confidence unknown: kept
  assert.equal(cleanTranscription("Uh..."), "");
  assert.equal(cleanTranscription("Shhh."), "");
});

test("Whisper's queue: joins one speaker's waiting sentences, never across the other speaker; language and glossary passed on", async () => {
  const events = [];
  const transcriber = new ScriptedTranscriber([{ text: "Uno.", language: "en" }, { text: "Due.", language: "en" }, "Tre.", "Quattro."], 30);
  let now = 0;
  const s = new CallSession({ settings: SETTINGS, transcriber, onEvent: (k, p) => events.push([k, p]), clock: () => now });
  await s.start();
  now = 100;
  s.setGlossary(["Jaromir", "X-13"]);
  const chunk = (source, start) => ({ source, start, end: start + 1, audio: new Float32Array(16000) });
  // Whisper busy with the first; meanwhile: them, them, me, them.
  s.transcribe(chunk("them", 0));
  s.transcribe(chunk("them", 2));
  s.transcribe(chunk("them", 4));
  s.transcribe(chunk("me", 6));
  s.transcribe(chunk("them", 8));
  s.tick();
  await s.stop();
  // While Whisper worked on the first, four waited; the oldest ended 97 s before "now".
  const health = events.filter(([k]) => k === "health")[0][1];
  assert.equal(health.waiting, 4);
  assert.equal(health.lag, 97);
  // 1: them@0 alone; 2: them@2+4 joined; 3: me@6; 4: them@8 (the user spoke in between: not joined).
  assert.deepEqual(transcriber.calls.map((c) => Math.round(c.seconds * 100) / 100), [1, 2.25, 1, 1]);
  assert.deepEqual(s.store.lines.map((l) => [l.t, l.speaker, l.text]), [[0, "them", "Uno."], [2, "them", "Due."], [6, "me", "Tre."], [8, "them", "Quattro."]]);
  assert.equal(transcriber.calls[0].prompt, "Jaromir, X-13.");
  // After two English sentences, a hesitation between Italian and English leans to English.
  assert.equal(transcriber.calls[3].prefer, "en");
  assert.equal(s.store.lines[0].lang, "en");
});

test("microphone echoes: counted, and the user is told once", async () => {
  const events = [];
  const s = new CallSession({ settings: SETTINGS, transcriber: new ScriptedTranscriber([], 1), onEvent: (k, p) => events.push([k, p]), clock: () => 0 });
  await s.start();
  for (let i = 0; i < 5; i++) s.echoDropped();
  assert.equal(events.filter(([k, p]) => k === "warning" && p === "echo").length, 1);
  assert.equal(s.stats.echoes, 5);
  await s.stop();
});

test("bridge sync: whether Claude follows this call, and the briefing with its questions", async () => {
  const store = new TranscriptStore();
  const session = { startedAt: new Date("2026-10-27T09:00:00Z"), language: "it", store, settings: {} };
  const id = "2026-10-27T09:00:00.000Z";
  let follow = { callId: id, rounds: 3, readAt: 1, cursor: 4 };
  const meeting = { title: "Budget", goal: "", questions: [{ text: "Chi paga?", done: false }], objectives: [], glossary: ["MPED"] };
  const bridge = { send: async () => ({ ok: true }), suggestions: async () => ({ suggestions: null, meeting, follow }) };
  const follows = [];
  const meetings = [];
  const sync = new BridgeSync({ bridge, session, onFollow: (f) => follows.push(f && f.rounds), onMeeting: (m) => meetings.push(m) });
  await sync.tick(); // sends the call (no follow state in the answer)
  await sync.tick(); // asks: Claude follows this call
  await sync.tick(); // same: not passed on again
  follow = { ...follow, rounds: 4 };
  await sync.tick();
  follow = { ...follow, callId: "another call" };
  await sync.tick();
  assert.deepEqual(follows, [null, 3, 4, null]);
  assert.deepEqual(meetings.at(-1).questions, [{ text: "Chi paga?", done: false }]);
});

test("the request to follow the call is the connector's own, and a Project's instructions come in both languages", () => {
  assert.equal(chatConnectorPrompt("it", "follow"), followRequest());
  assert.match(chatConnectorPrompt("en", "follow"), /follow_call without a cursor[\s\S]*set_meeting_context[\s\S]*merged[\s\S]*show_suggestions[\s\S]*cursor it gave you/);
  assert.match(projectInstructions("it"), /follow_call senza cursor[\s\S]*set_meeting_context[\s\S]*show_suggestions/);
  assert.match(projectInstructions("en"), /^You are my prompter/);
});

test("the script of a call keeps every suggestion: newest first, by arrival, filtered, pinned, said-again ones once", () => {
  const sc = new SuggestionScript();
  assert.equal(sc.add({ updatedAt: 1000, topic: "Budget", suggestions: [{ kind: "question", say: "Chi paga?" }, { kind: "answer", say: "Sì, entro venerdì.", why: "ti hanno chiesto la data" }] }), true);
  assert.equal(sc.add({ updatedAt: 1000, topic: "Budget", suggestions: [{ kind: "question", say: "Chi paga?" }] }), false); // the same set again
  sc.add({ updatedAt: 2000, topic: "Licenze", suggestions: [{ kind: "warning", say: "Non promettere lo sconto." }, { kind: "question", say: "chi paga?" }, { kind: "boh", text: "Riassumi i punti." }] });
  // "Now" shows the latest set; the script lists the others ("Chi paga?", said again, is in "now" for the moment).
  assert.deepEqual(sc.groups().map((g) => [g.at, g.topic, g.items.map((x) => x.say)]), [[1000, "Budget", ["Sì, entro venerdì."]]]);
  // A filter shows all of that kind, the latest set included.
  assert.deepEqual(sc.groups("warning").map((g) => g.items.map((x) => x.say)), [["Non promettere lo sconto."]]);
  assert.deepEqual(sc.counts(), { all: 4, answer: 1, question: 1, point: 1, warning: 1 });
  sc.add({ updatedAt: 3000, topic: "Chiusura", suggestions: [{ kind: "point", say: "Fissiamo la prossima call." }] });
  // Once a newer set arrives, it is back in the script, where it first came (a suggestion said again is listed once).
  assert.deepEqual(sc.groups().map((g) => [g.at, g.items.map((x) => x.say)]), [[2000, ["Non promettere lo sconto.", "Riassumi i punti."]], [1000, ["Chi paga?", "Sì, entro venerdì."]]]);
  const key = sc.items.find((x) => x.say === "Chi paga?").key;
  sc.togglePin(key);
  assert.deepEqual(sc.pinnedItems().map((x) => x.say), ["Chi paga?"]);
  sc.togglePin(key);
  assert.equal(sc.pinnedItems().length, 0);
  // What the history keeps, and read back after the call.
  const saved = JSON.parse(JSON.stringify(sc));
  assert.equal(saved.length, 5);
  assert.deepEqual(new SuggestionScript(saved).groups().map((g) => g.at), [3000, 2000, 1000]);
  // A page opened mid-call: the bridge's earlier suggestions come first, as older.
  const late = new SuggestionScript();
  late.add({ updatedAt: 5000, suggestions: [{ kind: "answer", say: "Ok." }], previous: [{ kind: "question", say: "Prima?" }] });
  assert.deepEqual(late.groups().map((g) => [g.at, g.items.map((x) => x.say)]), [[4999, ["Prima?"]]]);
});
