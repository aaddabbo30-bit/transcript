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
 * Pages; a bridge there without its database throws BridgeError("no_database"),
 * and no answer at all (the network, for a moment) BridgeError("unreachable"):
 * worth asking again.
 */
export async function sameOriginBridge(key, { origin = location.origin, fetchImpl, timeoutMs = 5000 } = {}) {
  if (!/^https:|^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(`${origin}/`)) return null;
  const bridge = new Bridge({ url: origin, key, fetchImpl, timeoutMs });
  try {
    await bridge.status();
    return bridge;
  } catch (err) {
    if (err instanceof BridgeError && (err.code === "no_database" || err.code === "unreachable")) throw err;
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

  /**
   * What Claude last asked to show in the page (its show_suggestions tool), the meeting's briefing and
   * whether Claude follows the call: for this call only (a new call doesn't get the last one's briefing).
   */
  async suggestions(callId = "") {
    const data = await this.request("GET", callId ? `suggestions?call=${encodeURIComponent(callId)}` : "suggestions");
    return { suggestions: data.suggestions || null, meeting: data.meeting || null, follow: data.follow || null };
  }

  clear() {
    return this.request("POST", "delete", "");
  }
}

/**
 * Keeps the bridge up to date with one call session, and brings back what
 * Claude asks to show for it (onSuggestions, each time it changes).
 */
export class BridgeSync {
  constructor({ bridge, session, intervalMs = 2000, onState = () => {}, onSuggestions = () => {}, onMeeting = () => {}, onFollow = () => {} }) {
    this.bridge = bridge;
    this.session = session;
    this.intervalMs = intervalMs;
    this.onState = onState;
    this.onSuggestions = onSuggestions;
    this.onMeeting = onMeeting;
    this.onFollow = onFollow;
    this.meeting = undefined; // the briefing last passed on (JSON)
    this.follow = undefined; // Claude following the call, last passed on (JSON)
    this.state = null; // "ok" | "error"
    this.sent = null;
    this.busy = null;
    this.timer = null;
    this.shownAt = null; // updatedAt of the suggestions last passed on
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
      ui: s.settings && s.settings.uiLanguage,
      // n: the order lines were heard in (a late line can land before others); lang: what Whisper heard.
      lines: s.store.lines.map(({ t, speaker, text, seq, lang }) => ({ t, speaker, text, n: seq, ...(lang ? { lang } : {}) })),
    };
  }

  setState(state) {
    if (state === this.state) return;
    this.state = state;
    this.onState(state);
  }

  receive(suggestions, meeting = null, follow = null) {
    const m = JSON.stringify(meeting ? { ...meeting, updatedAt: undefined } : null);
    if (m !== this.meeting) {
      this.meeting = m;
      this.onMeeting(meeting);
    }
    const thisCall = follow && follow.callId === this.session.startedAt.toISOString() ? follow : null;
    const f = JSON.stringify(thisCall);
    if (f !== this.follow) {
      this.follow = f;
      this.onFollow(thisCall);
    }
    if (!suggestions || suggestions.callId !== this.session.startedAt.toISOString() || suggestions.updatedAt === this.shownAt) return;
    this.shownAt = suggestions.updatedAt;
    this.onSuggestions(suggestions);
  }

  async push(call, signature) {
    try {
      const reply = await this.bridge.send(call);
      this.sent = signature;
      this.setState("ok");
      this.receive(reply && reply.suggestions, reply && reply.meeting, reply && reply.follow);
    } catch {
      this.setState("error");
    }
  }

  async poll() {
    try {
      const { suggestions, meeting, follow } = await this.bridge.suggestions(this.session.startedAt.toISOString());
      this.receive(suggestions, meeting, follow);
      this.setState("ok");
    } catch {
      this.setState("error");
    }
  }

  /** Send the transcript if it changed since the last successful send; otherwise look for new suggestions. */
  tick() {
    if (this.busy) return this.busy;
    const s = this.session;
    const signature = `live:${s.store.seq}:${s.store.length}:${s.language}`;
    const job = signature === this.sent ? this.poll() : this.push(this.snapshot("live"), signature);
    this.busy = job.finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  /** The call is over: one last send, marked as ended (tried again a few times: it tells Claude to stop following). */
  async finish(retryMs = [1000, 3000, 8000]) {
    this.stop();
    if (this.busy) await this.busy;
    await this.push(this.snapshot("ended"), "ended");
    for (const ms of retryMs) {
      if (this.sent === "ended") return;
      await new Promise((resolve) => setTimeout(resolve, ms));
      await this.push(this.snapshot("ended"), "ended");
    }
  }

  /** A new line: send it now (a moment later, to group lines that arrive together) instead of at the next tick. */
  nudge(delayMs = 300) {
    if (this.nudged || !this.timer) return;
    this.nudged = setTimeout(() => {
      this.nudged = null;
      this.tick();
    }, delayMs);
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.nudged);
    this.timer = null;
  }
}
