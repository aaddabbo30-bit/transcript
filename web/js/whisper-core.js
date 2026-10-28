// Whisper decoding done by hand on top of Transformers.js, to get what its
// speech-recognition pipeline hides:
// - the language, chosen between Italian and English only (left alone, the
//   pipeline transcribes everything as English);
// - how sure Whisper is that there is no speech at all, and how sure it is of
//   the words (silence and noise come out as "Thank you." otherwise);
// - a prompt with the meeting's names and terms, so they are spelled right.
// Used by the Whisper worker in the browser and by a test on Node with the
// real model (web/tests/whisper-real.mjs).

export const LANGS = ["it", "en"];
const MAX_NEW_TOKENS = 224;
const MAX_PROMPT_TOKENS = 96;

/** The ids of Whisper's special tokens for a loaded pipeline. */
export function specialIds(asr) {
  const gc = asr.model.generation_config || {};
  const id = (token) => {
    try {
      const v = asr.tokenizer._tokenizer.token_to_id(token);
      return Number.isInteger(v) ? v : null;
    } catch {
      return null;
    }
  };
  const notimestamps = gc.no_timestamps_token_id ?? id("<|notimestamps|>");
  const eos = Array.isArray(gc.eos_token_id) ? gc.eos_token_id[0] : gc.eos_token_id;
  return {
    sot: gc.decoder_start_token_id ?? id("<|startoftranscript|>"),
    eot: eos ?? id("<|endoftext|>"),
    prev: gc.prev_sot_token_id ?? id("<|startofprev|>"),
    transcribe: (gc.task_to_id && gc.task_to_id.transcribe) ?? id("<|transcribe|>"),
    notimestamps,
    nospeech: id("<|nospeech|>") ?? id("<|nocaptions|>") ?? notimestamps - 1,
    lang: Object.fromEntries(LANGS.map((l) => [l, (gc.lang_to_id && gc.lang_to_id[`<|${l}|>`]) ?? id(`<|${l}|>`)])),
    // Tokens Whisper never writes (symbols, special tokens), and the ones it may not start the text with.
    suppress: (gc.suppress_tokens || []).map(Number),
    beginSuppress: (gc.begin_suppress_tokens || []).map(Number),
  };
}

function logSumExp(row) {
  let max = -Infinity;
  for (let i = 0; i < row.length; i++) if (row[i] > max) max = row[i];
  let sum = 0;
  for (let i = 0; i < row.length; i++) sum += Math.exp(row[i] - max);
  return max + Math.log(sum);
}

function keepOnly(row, token) {
  const v = row[token];
  row.fill(-Infinity);
  row[token] = v;
}

/**
 * Steers one decoding: the first step picks the language (forced, or the more
 * likely of Italian and English) and reads the "no speech" probability; the
 * next two force "transcribe" and "no timestamps"; then it filters the tokens
 * Whisper never writes and measures its confidence. Transformers.js' own
 * filters are turned off (see transcribeWith): they would hide the "no speech"
 * token before it is read, and expect the text to start right after the prefix.
 * Pure logic on a logits row, so it can be tested without a model.
 */
export class DecodeControl {
  constructor(ids, { language = "auto", prefer = null, margin = 1.5, prefixLength = 1 } = {}) {
    this.ids = ids;
    this.forced = LANGS.includes(language) ? language : null;
    this.prefer = LANGS.includes(prefer) ? prefer : null;
    this.margin = margin; // logits: below this difference, keep the preferred language
    this.prefixLength = prefixLength;
    this.language = this.forced;
    this.noSpeechProb = 0;
    this.sumLogprob = 0;
    this.tokens = 0;
  }

  /** Called before each new token, with the sequence length so far and that step's logits. */
  step(length, row) {
    const pos = length - this.prefixLength;
    if (pos === 0) {
      this.noSpeechProb = Math.exp(row[this.ids.nospeech] - logSumExp(row));
      if (!this.forced) {
        const it = row[this.ids.lang.it];
        const en = row[this.ids.lang.en];
        const best = it >= en ? "it" : "en";
        this.language = this.prefer && Math.abs(it - en) < this.margin ? this.prefer : best;
        this.languageMargin = Math.abs(it - en);
      }
      keepOnly(row, this.ids.lang[this.language]);
    } else if (pos === 1) {
      keepOnly(row, this.ids.transcribe);
    } else if (pos === 2) {
      keepOnly(row, this.ids.notimestamps);
    } else if (pos > 2) {
      for (const t of this.ids.suppress || []) row[t] = -Infinity;
      if (pos === 3) for (const t of this.ids.beginSuppress || []) row[t] = -Infinity;
      // Greedy decoding takes the most likely token: add up its log-probability.
      let max = -Infinity;
      for (let i = 0; i < row.length; i++) if (row[i] > max) max = row[i];
      if (max > -Infinity) {
        this.sumLogprob += max - logSumExp(row);
        this.tokens++;
      }
    }
  }

  get avgLogprob() {
    return this.tokens ? this.sumLogprob / this.tokens : 0;
  }
}

/** The decoder's first tokens: an optional prompt (<|startofprev|> + text), then <|startoftranscript|>. */
export function decoderPrefix(ids, promptIds = []) {
  const prompt = promptIds.slice(-MAX_PROMPT_TOKENS);
  return prompt.length && ids.prev !== null ? [ids.prev, ...prompt, ids.sot] : [ids.sot];
}

/** The text tokens of a decoded sequence: after the prefix and the three control tokens, up to <|endoftext|>. */
export function textTokens(sequence, prefixLength, ids) {
  const out = [];
  for (const t of sequence.slice(prefixLength + 3).map(Number)) {
    if (t === ids.eot) break;
    if (t < ids.eot) out.push(t); // special and timestamp tokens all come after <|endoftext|>
  }
  return out;
}

/** The prompt text for the meeting's names and terms ("Glossary: Jaromir, X-13, MATLAB."). */
export function glossaryPrompt(terms) {
  const list = [...new Set((terms || []).map((t) => String(t).trim()).filter(Boolean))].slice(0, 40);
  return list.length ? `${list.join(", ")}.` : "";
}

/**
 * Whether to keep a decoded segment. Silence and noise give text that Whisper
 * itself doubts (the rule faster-whisper uses: probably no speech, and unsure
 * of the words); the prompt repeated back is not speech either.
 */
export function judgeSegment({ text, noSpeechProb = 0, avgLogprob = 0 }, prompt = "") {
  const clean = String(text || "").trim();
  if (!clean) return "empty";
  if (noSpeechProb > 0.6 && avgLogprob < -1.0) return "no_speech";
  if (avgLogprob < -1.8) return "unsure";
  if (prompt) {
    const words = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(Boolean);
    const terms = new Set(words(prompt));
    const said = words(clean);
    if (said.length && said.every((w) => terms.has(w))) return "prompt_echo";
  }
  return "ok";
}

/**
 * Transcribe one stretch of audio (16 kHz mono, up to 30 s) with a loaded
 * Transformers.js speech-recognition pipeline. `LogitsProcessor` is the class
 * exported by Transformers.js; steps are hooked in through it.
 */
export async function transcribeWith(asr, LogitsProcessor, audio, { language = "auto", prefer = null, promptIds = [] } = {}) {
  const ids = asr.__whisperIds || (asr.__whisperIds = specialIds(asr));
  const prefix = decoderPrefix(ids, promptIds);
  const control = new DecodeControl(ids, { language, prefer, prefixLength: prefix.length });
  class Steer extends LogitsProcessor {
    _call(inputIds, logits) {
      for (let i = 0; i < inputIds.length; i++) control.step(inputIds[i].length, logits[i].data);
      return logits;
    }
  }
  const started = Date.now();
  const { input_features } = await asr.processor(audio);
  const output = await asr.model.generate({
    inputs: input_features,
    decoder_input_ids: prefix,
    logits_processor: [new Steer()],
    max_new_tokens: MAX_NEW_TOKENS,
    // Applied by DecodeControl instead, at the right steps.
    suppress_tokens: null,
    begin_suppress_tokens: null,
  });
  const sequence = (output.sequences || output).tolist()[0];
  const text = asr.tokenizer.decode(textTokens(sequence, prefix.length, ids), { skip_special_tokens: true }).trim();
  return {
    text,
    language: control.language,
    languageMargin: control.languageMargin ?? null,
    noSpeechProb: control.noSpeechProb,
    avgLogprob: control.avgLogprob,
    ms: Date.now() - started,
  };
}

/** Token ids of the glossary prompt (cached by text). */
export function promptTokenIds(asr, prompt) {
  if (!prompt) return [];
  asr.__promptCache = asr.__promptCache || new Map();
  if (!asr.__promptCache.has(prompt)) {
    asr.__promptCache.set(prompt, asr.tokenizer.encode(` ${prompt}`, { add_special_tokens: false }).map(Number));
  }
  return asr.__promptCache.get(prompt);
}
