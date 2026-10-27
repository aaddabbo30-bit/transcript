// The bridge as an MCP server, checked with the official MCP TypeScript SDK
// client (what MCP clients such as Claude speak).
//   node bridge/test/mcp-client.mjs                         the Worker code in-process, on Node's SQLite
//   node bridge/test/mcp-client.mjs http://127.0.0.1:8787   a running bridge (e.g. `wrangler dev`)
// Needs @modelcontextprotocol/sdk (npm install --no-save @modelcontextprotocol/sdk).

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

async function inProcessBridge() {
  const { default: worker } = await import("../src/worker.js");
  const { memoryD1 } = await import("./d1.mjs");
  const env = { DB: memoryD1() };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const response = await worker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const bridge = process.argv[2] ? { base: process.argv[2].replace(/\/$/, ""), close() {} } : await inProcessBridge();
const key = `test${Date.now()}${Math.random().toString(36).slice(2)}`.padEnd(32, "x");
const id = new Date().toISOString();

const saved = await fetch(`${bridge.base}/api/${key}/call`, {
  method: "POST",
  headers: { "content-type": "text/plain" },
  body: JSON.stringify({
    id,
    startedAt: id,
    status: "live",
    lang: "it",
    lines: [
      { t: 2, speaker: "them", text: "Ciao, hai visto la mia offerta di lavoro a Milano?" },
      { t: 7, speaker: "me", text: "Sì, quando dovresti iniziare?" },
    ],
  }),
});
assert.deepEqual(await saved.json(), { ok: true });

const client = new Client({ name: "bridge-test", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.base}/mcp/${key}`)));
assert.equal(client.getServerVersion().name, "call-assistant-bridge");
const { tools } = await client.listTools();
assert.deepEqual(tools.map((t) => t.name), ["get_current_call", "list_calls", "get_call"]);
const current = await client.callTool({ name: "get_current_call", arguments: { minutes: 5 } });
const text = current.content[0].text;
assert.match(text, /Status: in progress/);
assert.match(text, /\[00:02\] Them: Ciao, hai visto la mia offerta di lavoro a Milano\?\n\[00:07\] Me: Sì, quando dovresti iniziare\?/);
const list = await client.callTool({ name: "list_calls", arguments: {} });
assert.match(list.content[0].text, new RegExp(`id ${id.replace(/[.]/g, "\\.")}: .*2 lines`));
const { prompts } = await client.listPrompts();
assert.deepEqual(prompts.map((p) => p.title), ["Cosa dico adesso?", "Cosa mi hanno chiesto?", "Riassumi la chiamata"]);
const prompt = await client.getPrompt({ name: "cosa_dico_adesso", arguments: {} });
assert.match(prompt.messages[0].content.text, /^Sono in una chiamata adesso\.[\s\S]*Me: Sì, quando dovresti iniziare\?\n<\/call>$/);
await client.close();

await fetch(`${bridge.base}/api/${key}/delete`, { method: "POST" });
bridge.close();
console.log(`ok - official MCP client: handshake, tools/list, tools/call, prompts/list, prompts/get against ${process.argv[2] || "the Worker code in-process"}`);
