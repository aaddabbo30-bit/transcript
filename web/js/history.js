// Past calls, kept in this browser, and their transcript as Markdown for download.

import { fmtTime } from "./transcript.js";

const KEY = "ca.calls.v1";
const MAX_CALLS = 40;

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function loadCalls() {
  try {
    return JSON.parse(storage()?.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

export function saveCall(call) {
  const calls = [call, ...loadCalls().filter((c) => c.id !== call.id)].slice(0, MAX_CALLS);
  const s = storage();
  if (!s) return false;
  // If the browser is full, drop the oldest transcripts first, then the oldest calls.
  for (let attempt = 0; attempt < calls.length + 1; attempt++) {
    try {
      s.setItem(KEY, JSON.stringify(calls));
      return true;
    } catch {
      const victim = [...calls].reverse().find((c) => c.transcript && c.transcript.length);
      if (victim) victim.transcript = [];
      else calls.pop();
    }
  }
  return false;
}

export function deleteCall(id) {
  try {
    storage()?.setItem(KEY, JSON.stringify(loadCalls().filter((c) => c.id !== id)));
  } catch {
    /* ignore */
  }
}

/** "27/10/2026, 09:00:00 · 12:30": when the call started and how long it lasted. */
export function callLabel(call) {
  return `${new Date(call.startedAt).toLocaleString()} · ${fmtTime(call.durationS)}`;
}

export function transcriptMarkdown(call, t) {
  const labels = { me: t("speaker_me"), them: t("speaker_them") };
  const lines = (call.transcript || []).map((l) => `- [${fmtTime(l.t)}] **${labels[l.speaker] || l.speaker}:** ${l.text}`);
  return `# ${t("transcript_title")}\n\n${callLabel(call)}\n\n${lines.join("\n")}\n`;
}

export function fileName(call, what) {
  return `${call.id.slice(0, 16).replace(/[:T]/g, "-")}-${what}.md`;
}

export function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
