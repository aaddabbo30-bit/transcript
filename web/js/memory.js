// Personal memory: Markdown "files" kept in this browser (localStorage),
// exportable to and importable from a single Markdown file.

const KEY = "ca.memory.v1";
export const EXPORT_FILE = "claude-memory-export.md";
const MAX_MEMORY_CHARS = 250000; // stays well below Haiku's 100k-token long-prompt rate

const TEMPLATES = {
  it: {
    "about-me.md": `# Chi sono

<!-- Scrivi qui quello che vuoi che l'assistente sappia di te. Il testo nei commenti viene ignorato. -->

## Nome, età, dove vivo

## Lavoro, studio e progetti in corso

## Famiglia e persone vicine

## Come mi piace comunicare
`,
    "interests.md": `# Interessi

<!-- Hobby, passioni, sport, libri, serie, viaggi, cose che stai imparando. -->

## Passioni e hobby

## Cosa sto imparando / leggendo / guardando
`,
    [EXPORT_FILE]: `# Memoria esportata da Claude

<!-- Qui finisce il testo incollato con «Importa memoria Claude». -->
`,
  },
  en: {
    "about-me.md": `# About me

<!-- Write what you want the assistant to know about you. Text inside comments is ignored. -->

## Name, age, where I live

## Work, studies and current projects

## Family and close people

## How I like to communicate
`,
    "interests.md": `# Interests

<!-- Hobbies, passions, sports, books, shows, travel, things you are learning. -->

## Passions and hobbies

## What I'm learning / reading / watching
`,
    [EXPORT_FILE]: `# Memory exported from Claude

<!-- Text pasted with "Import Claude memory" ends up here. -->
`,
  },
};

export class MemoryPathError extends Error {}

function safeStorage() {
  try {
    const s = globalThis.localStorage;
    const probe = "__ca_probe__";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null; // private window or blocked storage: keep memory for this visit only
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function clean(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export class Memory {
  constructor(language = "it", storage = safeStorage()) {
    this.language = language === "en" ? "en" : "it";
    this.storage = storage;
    this.files = {};
    this.load();
  }

  load() {
    let stored = null;
    try {
      stored = this.storage ? JSON.parse(this.storage.getItem(KEY) || "null") : null;
    } catch {
      stored = null;
    }
    this.files = stored && typeof stored.files === "object" ? stored.files : {};
    let changed = false;
    for (const [name, text] of Object.entries(TEMPLATES[this.language])) {
      if (!(name in this.files)) {
        this.files[name] = text;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  save() {
    if (!this.storage) return false;
    try {
      this.storage.setItem(KEY, JSON.stringify({ files: this.files }));
      return true;
    } catch {
      return false; // quota exceeded
    }
  }

  names() {
    // Fixed order keeps the prompt identical between requests (prompt caching).
    return Object.keys(this.files).sort((a, b) => {
      const depth = a.split("/").length - b.split("/").length;
      return depth || a.toLowerCase().localeCompare(b.toLowerCase());
    });
  }

  /** All memory as one text block for the prompt. Returns {text, truncated}. */
  loadText(maxChars = MAX_MEMORY_CHARS) {
    const parts = [];
    for (const name of this.names()) {
      const body = clean(this.files[name] || "");
      // Skip files that hold only headings (untouched templates).
      if (!body.split("\n").some((l) => l.trim() && !l.trim().startsWith("#"))) continue;
      parts.push(`<file path="${name}">\n${body}\n</file>`);
    }
    const text = parts.join("\n\n");
    if (!text) return { text: "(The memory is empty: nothing is known about the user yet.)", truncated: false, empty: true };
    if (text.length > maxChars) return { text: `${text.slice(0, maxChars)}\n[... memory truncated ...]`, truncated: true };
    return { text, truncated: false };
  }

  /** Validate a path proposed by Claude or typed by the user. */
  resolve(relative) {
    const rel = String(relative || "").trim().replace(/\\/g, "/");
    const parts = rel.split("/");
    if (!rel || rel.startsWith("/") || rel.includes(":") || !rel.toLowerCase().endsWith(".md") || parts.includes("..")) {
      throw new MemoryPathError(`Not allowed: ${relative}`);
    }
    const cleaned = parts.map((p) => p.replace(/[^\p{L}\p{N}\s.,'()&_-]/gu, "").trim());
    if (cleaned.some((p) => !p || p.startsWith(".")) || cleaned.length > 3) throw new MemoryPathError(`Not allowed: ${relative}`);
    return cleaned.join("/");
  }

  write(name, text) {
    this.files[this.resolve(name)] = text;
    return this.save();
  }

  remove(name) {
    delete this.files[name];
    this.save();
  }

  /** Append an approved proposal (never deletes existing text). */
  apply({ file, content }, source = "") {
    const name = this.resolve(file);
    const body = String(content || "").trim();
    if (!body) throw new Error("empty content");
    const note = `<!-- added ${today()}${source ? ` from ${source}` : ""} -->\n`;
    const existing = this.files[name];
    if (existing !== undefined) {
      const sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
      this.files[name] = `${existing}${sep}${note}${body}\n`;
    } else {
      const title = name.split("/").pop().replace(/\.md$/i, "");
      this.files[name] = `# ${title}\n\n${note}${body}\n`;
    }
    this.save();
    return name;
  }

  importClaudeExport(text) {
    const body = String(text || "").trim();
    if (!body) throw new Error("empty text");
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const header = `## Import ${stamp}\n\n`;
    const existing = (this.files[EXPORT_FILE] || "# Claude memory export\n").trimEnd();
    this.files[EXPORT_FILE] = `${existing}\n\n${header}${body}\n`;
    this.save();
    return EXPORT_FILE;
  }

  /** One Markdown file with every memory file, for backup or another browser. */
  exportBundle() {
    const parts = this.names().map((n) => `<!-- memory-file: ${n} -->\n${this.files[n].trimEnd()}\n`);
    return `<!-- Call Assistant memory backup ${today()} -->\n\n${parts.join("\n")}`;
  }

  /** Import a backup made by exportBundle, or plain .md files (name -> text). */
  importBundle(text) {
    const re = /<!-- memory-file: (.+?) -->\n/g;
    const marks = [...text.matchAll(re)];
    if (!marks.length) return 0;
    marks.forEach((m, i) => {
      const start = m.index + m[0].length;
      const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
      this.files[this.resolve(m[1])] = `${text.slice(start, end).trimEnd()}\n`;
    });
    this.save();
    return marks.length;
  }
}
