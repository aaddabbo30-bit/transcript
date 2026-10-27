import assert from "node:assert/strict";
import { test } from "node:test";

import worker, { cleanCall, describeCall } from "../src/worker.js";
import { memoryD1 } from "./d1.mjs";

const KEY = "k".repeat(8) + "ABCdef123_-xyz789QRSTuv"; // 31 characters
const OTHER = "Z".repeat(32);
const BASE = "https://bridge.example.workers.dev";

function bridge(env = { DB: memoryD1() }) {
  const call = async (method, path, body) => {
    const res = await worker.fetch(
      new Request(BASE + path, { method, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }),
      env,
    );
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, headers: res.headers, data };
  };
  let nextId = 1;
  const rpc = async (method, params, key = KEY) => (await call("POST", `/mcp/${key}`, { jsonrpc: "2.0", id: nextId++, method, params })).data;
  const tool = async (name, args = {}, key = KEY) => {
    const reply = await rpc("tools/call", { name, arguments: args }, key);
    return { text: reply.result.content[0].text, isError: Boolean(reply.result.isError) };
  };
  return { env, call, rpc, tool };
}

const lines = (n, start = 0) =>
  Array.from({ length: n }, (_, i) => ({ t: (start + i) * 15, speaker: i % 2 ? "them" : "me", text: `frase ${start + i}` }));

test("the page saves the call and Claude reads it through MCP", async () => {
  const b = bridge();
  assert.deepEqual((await b.call("GET", `/api/${KEY}/status`)).data, { ok: true, calls: 0 });
  assert.match((await b.tool("get_current_call")).text, /^No calls yet/);

  const id = "2026-10-27T09:00:00.000Z";
  const saved = await b.call("POST", `/api/${KEY}/call`, { id, startedAt: id, status: "live", lang: "it", lines: lines(80) });
  assert.deepEqual(saved.data, { ok: true });
  assert.equal(saved.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual((await b.call("GET", `/api/${KEY}/status`)).data, { ok: true, calls: 1 });

  const recent = await b.tool("get_current_call");
  assert.match(recent.text, /^Call 2026-10-27T09:00:00\.000Z, started .*, 19:45 of transcript so far\./);
  assert.match(recent.text, /Status: in progress\. The page last sent an update \d+ seconds ago\./);
  assert.match(recent.text, /Transcript, the last 10 minutes \(41 of 80 lines\)/);
  assert.match(recent.text, /\n\[19:45\] Them: frase 79$/);
  assert.ok(!recent.text.includes("frase 38\n"));
  const whole = await b.tool("get_current_call", { minutes: 0 });
  assert.match(whole.text, /the whole call \(80 of 80 lines\)/);
  assert.match(whole.text, /\n\[00:00\] Me: frase 0\n/);

  // Later updates replace the call; the end of the call is marked.
  await b.call("POST", `/api/${KEY}/call`, { id, status: "ended", lang: "it", lines: lines(81), summary: "Giulia va a Milano." });
  const ended = await b.tool("get_current_call", { minutes: 1 });
  assert.match(ended.text, /Status: ended\./);
  assert.match(ended.text, /\[20:00\] Me: frase 80/);
  assert.match(ended.text, /Summary written by the page:\nGiulia va a Milano\./);
});

test("calls are listed newest first, read by id, and kept apart per key", async () => {
  const b = bridge();
  await b.call("POST", `/api/${KEY}/call`, { id: "a", startedAt: "2026-10-27T08:00:00Z", status: "ended", lines: lines(3) });
  await b.call("POST", `/api/${KEY}/call`, { id: "b", startedAt: "2026-10-27T09:00:00Z", status: "live", lines: lines(2, 10) });
  await b.call("POST", `/api/${OTHER}/call`, { id: "c", startedAt: "2026-10-27T10:00:00Z", lines: lines(1) });

  const list = (await b.tool("list_calls")).text.split("\n");
  assert.equal(list.length, 2);
  assert.match(list[0], /^- id b: .* in progress, updated \d+ s ago, 2 lines\. Begins: "frase 10"$/);
  assert.match(list[1], /^- id a: .* ended, 3 lines/);
  assert.match((await b.tool("get_call", { id: "a" })).text, /\[00:30\] Me: frase 2$/);
  const missing = await b.tool("get_call", { id: "c" });
  assert.ok(missing.isError);
  assert.match((await b.tool("get_current_call", {}, OTHER)).text, /Call c,/);

  await b.call("POST", `/api/${KEY}/delete`, "");
  assert.match((await b.tool("list_calls")).text, /^No calls yet/);
  assert.match((await b.tool("list_calls", {}, OTHER)).text, /id c/);
});

test("only the last 10 calls and the last 48 hours are kept", async (t) => {
  const b = bridge();
  let now = Date.parse("2026-10-27T09:00:00Z");
  t.mock.method(Date, "now", () => now);
  for (let i = 0; i < 12; i++) {
    const id = `2026-10-27T09:${String(i).padStart(2, "0")}:00Z`;
    await b.call("POST", `/api/${KEY}/call`, { id, startedAt: id, status: "ended", lines: lines(1) });
  }
  const ids = (await b.tool("list_calls")).text.split("\n").map((l) => l.match(/id (\S+):/)[1]);
  assert.equal(ids.length, 10);
  assert.equal(ids.at(-1), "2026-10-27T09:02:00Z");

  now += 49 * 3600 * 1000;
  assert.match((await b.tool("list_calls")).text, /^No calls yet/);
  await b.call("POST", `/api/${KEY}/call`, { id: "new", lines: [] });
  assert.match((await b.tool("get_current_call")).text, /Nothing has been transcribed yet\./);
});

test("a page that stops sending is reported", async (t) => {
  const b = bridge();
  let now = Date.parse("2026-10-27T09:00:00Z");
  t.mock.method(Date, "now", () => now);
  await b.call("POST", `/api/${KEY}/call`, { id: "x", status: "live", lines: lines(2) });
  now += 5 * 60 * 1000;
  assert.match((await b.tool("get_current_call")).text, /last sent an update 300 seconds ago\.\nThe page hasn't sent anything for a while/);
});

test("MCP handshake, notifications, errors", async () => {
  const b = bridge();
  const init = await b.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false }, prompts: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, "call-assistant-bridge");
  const unknownVersion = await b.rpc("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(unknownVersion.result.protocolVersion, "2025-11-25");

  const note = await b.call("POST", `/mcp/${KEY}`, { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(note.status, 202);
  assert.deepEqual((await b.rpc("ping")).result, {});
  const tools = (await b.rpc("tools/list")).result.tools;
  assert.deepEqual(tools.map((x) => x.name), ["get_current_call", "list_calls", "get_call"]);
  assert.ok(tools.every((x) => x.inputSchema.type === "object" && x.annotations.readOnlyHint));
  assert.equal((await b.rpc("resources/list")).error.code, -32601);
  assert.equal((await b.rpc("tools/call", { name: "nope" })).error.code, -32602);

  const batch = await b.call("POST", `/mcp/${KEY}`, [
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
  ]);
  assert.deepEqual(batch.data, [{ jsonrpc: "2.0", id: 1, result: {} }]);
  assert.equal((await b.call("POST", `/mcp/${KEY}`, "{not json")).data.error.code, -32700);
  assert.equal((await b.call("GET", `/mcp/${KEY}`)).status, 405);
  assert.equal((await b.call("OPTIONS", `/mcp/${KEY}`)).status, 204);
});

test("bad keys, bad calls, missing database", async () => {
  const b = bridge();
  assert.equal((await b.call("POST", "/mcp/short", { jsonrpc: "2.0", id: 1, method: "ping" })).status, 404);
  assert.equal((await b.call("GET", "/api/short/status")).status, 404);
  assert.equal((await b.call("POST", `/api/${KEY}/call`, { lines: [] })).status, 400);
  assert.equal((await b.call("POST", `/api/${KEY}/call`, "x".repeat(2_000_001))).status, 400);
  assert.equal((await b.call("GET", `/api/${KEY}/call`)).status, 405);
  assert.match((await b.call("GET", "/")).data, /running/);

  const none = bridge({});
  assert.deepEqual((await none.call("GET", `/api/${KEY}/status`)).data, { ok: false, error: "no_database" });
  assert.match((await none.call("GET", "/")).data, /no database/);
  assert.equal((await none.call("POST", `/mcp/${KEY}`, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 500);
});

test("what the page sends is cleaned", () => {
  const call = cleanCall({ id: "x", lines: [{ t: 1.234, speaker: "boss", text: "a".repeat(3000) }, { t: "x", text: "no" }], remember: ["r"] });
  assert.deepEqual(call.lines, [{ t: 1.2, speaker: "them", text: "a".repeat(2000) }]);
  assert.equal(call.status, "live");
  assert.equal(cleanCall({ id: "x" }), null);
  assert.equal(cleanCall(null), null);
  const text = describeCall({ ...call, updatedAt: 0, startedAt: "s", remember: ["Festa sabato"] }, 10, 1000);
  assert.match(text, /Points the live assistant noted:\n- Festa sabato$/);
});

test("ready-made prompts carry the transcript, so Claude answers at once", async () => {
  const b = bridge();
  const list = (await b.rpc("prompts/list")).result.prompts;
  assert.deepEqual(list.map((p) => p.name), ["cosa_dico_adesso", "cosa_mi_hanno_chiesto", "riassunto_chiamata"]);
  assert.deepEqual(list.map((p) => p.title), ["Cosa dico adesso?", "Cosa mi hanno chiesto?", "Riassumi la chiamata"]);
  assert.ok(list.every((p) => p.description && Array.isArray(p.arguments) && !p.arguments.length));

  const empty = (await b.rpc("prompts/get", { name: "cosa_dico_adesso" })).result;
  assert.match(empty.messages[0].content.text, /<call>\nNo calls yet\./);

  await b.call("POST", `/api/${KEY}/call`, { id: "x", status: "live", lines: lines(60) });
  const now = (await b.rpc("prompts/get", { name: "cosa_dico_adesso" })).result;
  assert.equal(now.messages.length, 1);
  assert.equal(now.messages[0].role, "user");
  const text = now.messages[0].content.text;
  assert.match(text, /^Sono in una chiamata adesso\./);
  assert.match(text, /get_current_call/);
  assert.match(text, /Transcript, the last 10 minutes \(41 of 60 lines\)/);
  assert.match(text, /\[14:45\] Them: frase 59\n<\/call>$/);
  const summary = (await b.rpc("prompts/get", { name: "riassunto_chiamata" })).result.messages[0].content.text;
  assert.match(summary, /the whole call \(60 of 60 lines\)/);
  assert.match((await b.rpc("prompts/get", { name: "cosa_mi_hanno_chiesto" })).result.messages[0].content.text, /the last 5 minutes/);
  assert.equal((await b.rpc("prompts/get", { name: "nope" })).error.code, -32602);
});

test("deployed with the web app: the page, a link to it for Claude, old /web/ links", async () => {
  const assets = [];
  const ASSETS = { fetch: async (req) => (assets.push(new URL(req.url).pathname), new Response("<!doctype html>app", { headers: { "content-type": "text/html" } })) };
  const b = bridge({ DB: memoryD1(), ASSETS });
  const page = await b.call("GET", "/");
  assert.equal(page.data, "<!doctype html>app");
  await b.call("GET", "/js/app.js?v=1");
  assert.deepEqual(assets, ["/", "/js/app.js"]);
  const old = await b.call("GET", "/web/js/app.js?v=1");
  assert.equal(old.status, 301);
  assert.equal(old.headers.get("location"), `${BASE}/js/app.js?v=1`);
  assert.match((await b.call("GET", "/health")).data, /^Call Assistant bridge: running\. The app is at \/\.$/);

  // No call yet: Claude gets the link to give the user.
  assert.match((await b.tool("get_current_call")).text, new RegExp(`opens the Call Assistant at ${BASE}/ and presses Start`));
  const init = await b.rpc("initialize", { protocolVersion: "2025-06-18" });
  assert.match(init.result.instructions, new RegExp(`page is at ${BASE}/`));
  await b.call("POST", `/api/${KEY}/call`, { id: "x", status: "ended", lines: lines(2) });
  assert.match((await b.tool("get_current_call")).text, new RegExp(`Status: ended\\. To follow a new call, the user opens the Call Assistant at ${BASE}/`));
  // The API and MCP still answer before the static files.
  assert.deepEqual((await b.call("GET", `/api/${KEY}/status`)).data, { ok: true, calls: 1 });
  assert.equal(assets.length, 2);

  // The bridge alone (Deploy button): no page, no link.
  const alone = bridge();
  assert.doesNotMatch((await alone.tool("get_current_call")).text, /https?:/);
  assert.equal((await alone.call("GET", "/web/x")).status, 404);
});
