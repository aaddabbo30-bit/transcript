// The bridge to Claude: the user's own small server (bridge/ in the repository,
// a Cloudflare Worker) that keeps the transcript of the call and serves it to
// Claude as a custom connector. While a call runs the page sends the whole
// transcript every few seconds, when it changed.

export class BridgeError extends Error {
  constructor(code) {
    super(code);
    this.code = code; // unreachable | not_found | no_database | failed
  }
}

/** A random secret for the bridge addresses: 24 bytes as base64url (32 characters). */
export function newBridgeKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The bridge at the page's own address, when the page is served by it (the
 * repository deployed to Cloudflare as it is). null elsewhere, e.g. GitHub
 * Pages; a bridge there without its database throws BridgeError("no_database").
 */
export async function sameOriginBridge(key, { origin = location.origin, fetchImpl, timeoutMs = 5000 } = {}) {
  if (!/^https:|^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(`${origin}/`)) return null;
  const bridge = new Bridge({ url: origin, key, fetchImpl, timeoutMs });
  try {
    await bridge.status();
    return bridge;
  } catch (err) {
    if (err instanceof BridgeError && err.code === "no_database") throw err;
    return null;
  }
}

/** The bridge address as typed ("" when empty, null when it isn't a web address). */
export function cleanBridgeUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
    const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    if (url.protocol !== "https:" && !local) return null;
    // The connector address pasted by mistake also works: keep what comes before /mcp/ or /api/.
    const base = url.pathname.replace(/\/(mcp|api)\/.*$/, "").replace(/\/+$/, "");
    return url.origin + base;
  } catch {
    return null;
  }
}

export class Bridge {
  constructor({ url, key, fetchImpl = (...args) => fetch(...args), timeoutMs = 15000 }) {
    this.url = url;
    this.key = key;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  /** What to paste in claude.ai as the custom connector's address. */
  get connectorUrl() {
    return `${this.url}/mcp/${this.key}`;
  }

  async request(method, action, body) {
    let res;
    try {
      res = await this.fetch(`${this.url}/api/${this.key}/${action}`, {
        method,
        // text/plain keeps it a simple request: no CORS preflight.
        headers: body === undefined ? undefined : { "content-type": "text/plain;charset=UTF-8" },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new BridgeError("unreachable");
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* not the bridge */
    }
    if (res.ok && data && data.ok) return data;
    if (data && data.error === "no_database") throw new BridgeError("no_database");
    throw new BridgeError(res.status === 404 || !data ? "not_found" : "failed");
  }

  status() {
    return this.request("GET", "status");
  }

  send(call) {
    return this.request("POST", "call", JSON.stringify(call));
  }

  clear() {
    return this.request("POST", "delete", "");
  }
}

/** Keeps the bridge up to date with one call session. */
export class BridgeSync {
  constructor({ bridge, session, intervalMs = 6000, onState = () => {} }) {
    this.bridge = bridge;
    this.session = session;
    this.intervalMs = intervalMs;
    this.onState = onState;
    this.state = null; // "ok" | "error"
    this.sent = null;
    this.busy = null;
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.tick();
  }

  snapshot(status) {
    const s = this.session;
    return {
      id: s.startedAt.toISOString(),
      startedAt: s.startedAt.toISOString(),
      status,
      lang: s.language,
      lines: s.store.lines.map(({ t, speaker, text }) => ({ t, speaker, text })),
    };
  }

  setState(state) {
    if (state === this.state) return;
    this.state = state;
    this.onState(state);
  }

  async push(call, signature) {
    try {
      await this.bridge.send(call);
      this.sent = signature;
      this.setState("ok");
    } catch {
      this.setState("error");
    }
  }

  /** Send the transcript if it changed since the last successful send. */
  tick() {
    if (this.busy) return this.busy;
    const s = this.session;
    const signature = `live:${s.store.seq}:${s.store.length}:${s.language}`;
    if (signature === this.sent) return Promise.resolve();
    this.busy = this.push(this.snapshot("live"), signature).finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  /** The call is over: one last send, marked as ended. */
  async finish() {
    clearInterval(this.timer);
    if (this.busy) await this.busy;
    await this.push(this.snapshot("ended"), "ended");
  }

  stop() {
    clearInterval(this.timer);
  }
}
