// Transcript text helpers: Whisper hallucination filters, repetition loops,
// ordered lines with echo removal. Same rules as the desktop app.

import { ME, THEM } from "./segmenter.js";

export const PROMPT_LABELS = { [ME]: "Me", [THEM]: "Them" };

// Subtitle credits Whisper invents on silence or music: never real speech.
const ALWAYS_DROP = /amara\.?org|qtss|sottotitoli (creati|e revisione|a cura)/i;
// Phrases from subtitled videos that are almost always invented in a call.
const LIKELY_INVENTED = new Set([
  "grazie per la visione",
  "grazie a tutti per la visione",
  "iscriviti al canale",
  "thank you for watching",
  "thanks for watching",
  "thank you so much for watching",
  "please subscribe",
  "you",
  "music",
  "musica",
  "applause",
]);

// Sounds that say nothing to whoever reads the transcript.
const FILLERS = new Set(["uh", "um", "uhm", "ehm", "eh", "hmm", "mm", "mmhm", "mhm", "oh", "ah", "shh", "shhh", "beep"]);
// Short replies that are often real and often invented on silence or noise:
// dropped when Whisper itself is unsure (same idea as the desktop app's SUSPICIOUS).
const SUSPICIOUS = new Set([
  "thank you",
  "thank you very much",
  "thank you so much",
  "thanks",
  "grazie",
  "grazie mille",
  "okay",
  "ok",
  "bye",
  "bye bye",
  "yeah",
  "yes",
  "so",
  "and",
  "i",
  "e",
  "si",
]);

export function normalize(text) {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "ok ok ok ok" -> "ok ok"; also catches repeated phrases (a Whisper failure mode). */
export function collapseRepetitions(text, maxRepeats = 2) {
  let words = text.split(/\s+/).filter(Boolean);
  for (let n = 1; n <= 6; n++) {
    const out = [];
    let i = 0;
    while (i < words.length) {
      const gram = words.slice(i, i + n);
      let repeats = 1;
      while (
        gram.length === n &&
        words.slice(i + repeats * n, i + (repeats + 1) * n).join(" ") === gram.join(" ")
      ) {
        repeats++;
      }
      if (repeats > maxRepeats) {
        for (let r = 0; r < maxRepeats; r++) out.push(...gram);
        i += repeats * n;
      } else {
        out.push(words[i]);
        i++;
      }
    }
    words = out;
  }
  return words.join(" ");
}

/**
 * Clean one Whisper result; returns "" when it should be dropped. noSpeechProb
 * and avgLogprob (see whisper-core.js) say how sure Whisper was, when known.
 */
export function cleanTranscription(text, { noSpeechProb = null, avgLogprob = null } = {}) {
  const t = collapseRepetitions((text || "").replace(/\s+/g, " ").trim());
  const norm = normalize(t);
  if (!norm || ALWAYS_DROP.test(t) || LIKELY_INVENTED.has(norm) || FILLERS.has(norm)) return "";
  if (/^\[.*\]$|^\(.*\)$/.test(t)) return ""; // "[Musica]", "(applausi)"
  if (SUSPICIOUS.has(norm) && ((noSpeechProb ?? 0) > 0.15 || (avgLogprob ?? 0) < -0.5)) return "";
  return t;
}

export function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${String(m).padStart(2, "0")}:${ss}`;
}

function similar(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return Math.min(na.length, nb.length) >= 12;
  return diceSimilarity(na, nb) >= 0.72;
}

// Character-bigram similarity (0..1): cheap and robust for near-identical sentences.
function diceSimilarity(a, b) {
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) || 0);
  const total = Math.max(1, a.length - 1 + b.length - 1);
  return (2 * inter) / total;
}

/**
 * Ordered transcript lines. Without headphones the microphone also hears the
 * other people through the speakers, so the same sentence would appear twice;
 * such echoes are dropped, keeping the shared-audio version.
 */
export class TranscriptStore {
  constructor() {
    this.lines = [];
    this.seq = 0;
    this.echoesDropped = 0;
  }

  add({ t, speaker, text, lang = null }) {
    const nearby = this.lines.slice(-30).filter((o) => Math.abs(o.t - t) <= 10);
    if (speaker === ME && nearby.some((o) => o.speaker === THEM && similar(o.text, text))) {
      this.echoesDropped++;
      return null;
    }
    if (speaker === THEM) {
      for (const o of nearby) {
        if (o.speaker === ME && similar(o.text, text)) {
          this.lines.splice(this.lines.indexOf(o), 1);
          this.echoesDropped++;
        }
      }
    }
    const line = { t, speaker, text, seq: ++this.seq };
    if (lang) line.lang = lang;
    this.lines.push(line);
    this.lines.sort((a, b) => a.t - b.t);
    return line;
  }

  get length() {
    return this.lines.length;
  }

  window(seconds, now) {
    if (!this.lines.length) return [];
    const end = now ?? this.lines[this.lines.length - 1].t;
    return this.lines.filter((l) => l.t >= end - seconds);
  }

  text(lines = this.lines, newAfterSeq = null) {
    return lines
      .map((l) => {
        const mark = newAfterSeq !== null && l.seq > newAfterSeq ? "*" : "";
        return `${mark}[${fmtTime(l.t)}] ${PROMPT_LABELS[l.speaker] || l.speaker}: ${l.text}`;
      })
      .join("\n");
  }

  markdown(labels, title = "Transcript") {
    const body = this.lines.map((l) => `- [${fmtTime(l.t)}] **${labels[l.speaker] || l.speaker}:** ${l.text}`);
    return `# ${title}\n\n${body.join("\n")}\n`;
  }

  wordCount() {
    return this.lines.reduce((n, l) => n + l.text.split(/\s+/).filter(Boolean).length, 0);
  }
}

/** Parse a written transcript ("[00:05] Giulia: Ciao!") for the demo mode. */
export function parseTranscript(text, gap = 5) {
  const re = /^\s*(?:\[(?:(\d+):)?(\d+):(\d+)\]\s*)?([^:[\]]{1,40}):\s*(.+?)\s*$/;
  const meNames = new Set(["me", "io", "i", "user", "utente"]);
  const out = [];
  let t = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const m = re.exec(raw);
    if (!m) continue;
    const [, h, mm, ss, speaker, body] = m;
    if (mm !== undefined) t = Number(h || 0) * 3600 + Number(mm) * 60 + Number(ss);
    else if (out.length) t = out[out.length - 1].t + gap;
    out.push({ t, speaker: meNames.has(speaker.trim().toLowerCase()) ? ME : THEM, text: body });
  }
  return out;
}
