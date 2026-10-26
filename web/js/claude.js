// Claude API from the browser with the official SDK (bundled in /vendor).
// The API key stays in this browser; requests go straight to api.anthropic.com.

import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from "../vendor/anthropic-sdk.mjs";

// USD per million tokens, used only for the cost shown on screen (check https://claude.com/pricing).
export const PRICING = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
};
// Models that support server-side refusal fallbacks (fallbacks: "default").
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class LLMError extends Error {
  constructor(message, { fatal = false } = {}) {
    super(message);
    this.fatal = fatal; // retrying will not help (bad key, no credit)
  }
}

export function usageFrom(u = {}) {
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
  };
}

export function estimateCost(model, usage) {
  const family = Object.keys(PRICING).find((k) => model.startsWith(k) || model.includes(k.split("-")[1]));
  const p = PRICING[model] || PRICING[family];
  if (!p) return 0;
  const promptTokens = usage.input + usage.cacheWrite + usage.cacheRead;
  const factor = model.startsWith("claude-haiku-5") && promptTokens > 100000 ? 5 : 1; // long-prompt rate
  return (
    (factor *
      (usage.input * p.input + usage.output * p.output + usage.cacheWrite * p.cacheWrite + usage.cacheRead * p.cacheRead)) /
    1e6
  );
}

export class CostTracker {
  constructor() {
    this.byPurpose = {};
  }
  add(purpose, model, usage) {
    const cost = estimateCost(model, usage);
    this.byPurpose[purpose] = (this.byPurpose[purpose] || 0) + cost;
    return cost;
  }
  get total() {
    return Object.values(this.byPurpose).reduce((a, b) => a + b, 0);
  }
}

export class ClaudeClient {
  constructor(apiKey, options = {}) {
    this.client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2, ...options });
  }

  /**
   * One request with a JSON-schema answer. The system prompt (instructions +
   * memory) is identical for every live update, so it is cached; one-off
   * requests (the summary) skip caching, which would only add the write premium.
   */
  async completeJson({ model, system, user, schema, maxTokens, effort, timeoutMs, cacheSystem = true }) {
    const systemBlock = { type: "text", text: system };
    if (cacheSystem) systemBlock.cache_control = { type: "ephemeral" };
    const params = {
      model,
      max_tokens: maxTokens,
      system: [systemBlock],
      messages: [{ role: "user", content: user }],
      output_config: { effort, format: { type: "json_schema", schema } },
    };
    let response;
    try {
      response = FALLBACK_MODELS.has(model)
        ? await this.client.beta.messages.create(
            { ...params, betas: [FALLBACK_BETA], fallbacks: "default" },
            { timeout: timeoutMs },
          )
        : await this.client.messages.create(params, { timeout: timeoutMs });
    } catch (err) {
      throw toLLMError(err, model);
    }
    if (response.stop_reason === "refusal") throw new LLMError("Claude declined this request");
    if (response.stop_reason === "max_tokens") throw new LLMError("reply too long (max_tokens reached)");
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new LLMError("unreadable reply from Claude");
    }
    return { data, usage: usageFrom(response.usage), model: response.model || model };
  }
}

function toLLMError(err, model) {
  if (err instanceof AuthenticationError) return new LLMError("API key not valid (401)", { fatal: true });
  if (err instanceof PermissionDeniedError) return new LLMError("API key without access to this model (403)", { fatal: true });
  if (err instanceof NotFoundError) return new LLMError(`model ${model} not found (404)`, { fatal: true });
  if (err instanceof RateLimitError) return new LLMError("rate limit reached, retrying at the next update");
  if (err instanceof BadRequestError) {
    const msg = String(err.message || "");
    if (/credit balance/i.test(msg)) return new LLMError("API credit too low (console.anthropic.com → Billing)", { fatal: true });
    return new LLMError(`request rejected: ${msg.slice(0, 200)}`);
  }
  if (err instanceof APIConnectionTimeoutError) return new LLMError("Claude did not answer in time");
  if (err instanceof APIConnectionError) return new LLMError("no connection to the Claude API");
  if (err instanceof APIError) return new LLMError(`Claude API error ${err.status ?? ""}`.trim());
  return new LLMError(String(err && err.message ? err.message : err));
}

/** Offline stand-in for the demo without a key and for the tests. */
export class FakeClaude {
  constructor() {
    this.requests = [];
  }
  async completeJson({ model, system, user, schema }) {
    this.requests.push({ model, system, user, schema });
    const lines = user.split("\n").filter((l) => /^\*?\[/.test(l));
    const said = (l) => l.split(": ").slice(1).join(": ");
    const usage = { input: user.split(/\s+/).length * 2, output: 180, cacheWrite: 0, cacheRead: system.split(/\s+/).length * 2 };
    if (schema.properties.topic) {
      const last = lines.length ? said(lines[lines.length - 1]) : "";
      return {
        model,
        usage,
        data: {
          topic: last ? `(demo) Si parla di: ${last.slice(0, 90)}` : "(demo) In attesa di conversazione.",
          suggestions: [
            { kind: "question", text: "Come ti sei trovato con questa cosa?" },
            { kind: "comment", text: "Interessante, raccontami di più." },
          ],
          remember: lines.slice(-3).map((l) => said(l).slice(0, 80)),
          running_summary: `(demo) Conversazione di ${lines.length} battute.`,
        },
      };
    }
    return {
      model,
      usage,
      data: {
        title: "Chiamata demo",
        summary: `(demo) Riassunto finto di ${lines.length} battute. Inserisci una chiave API per un vero riassunto.`,
        key_points: lines.slice(0, 3).map((l) => said(l).slice(0, 100)),
        action_items: [{ owner: "Me", task: "Richiamare la settimana prossima", due: "" }],
        memory_updates: [
          { file: "people/Giulia.md", action: "create", content: "- Amica, sentita nella chiamata demo.", reason: "Persona nuova emersa nella chiamata" },
        ],
      },
    };
  }
}
