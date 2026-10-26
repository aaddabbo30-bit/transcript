// Past calls, kept in this browser, and the Markdown renderings for download.

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

export function summaryMarkdown(call, t) {
  const d = call.data || {};
  const started = new Date(call.startedAt);
  const title = d.title || `${t("summary_title")} ${started.toLocaleString()}`;
  const out = [`# ${title}`, "", `${started.toLocaleString()} · ${fmtTime(call.durationS)} · $${(call.cost || 0).toFixed(4)}`, ""];
  if (call.error) out.push(`> ${t("summary_failed", { error: call.error })}`, "");
  if (d.summary) out.push(String(d.summary).trim(), "");
  if (d.key_points && d.key_points.length) out.push(`## ${t("key_points")}`, "", ...d.key_points.map((p) => `- ${p}`), "");
  if (d.action_items && d.action_items.length) {
    out.push(`## ${t("actions")}`, "");
    for (const a of d.action_items) out.push(`- [ ] **${a.owner}:** ${a.task}${a.due ? ` (${t("due")} ${a.due})` : ""}`);
    out.push("");
  }
  if (call.liveRemember && call.liveRemember.length) out.push(`## ${t("notes_live")}`, "", ...call.liveRemember.map((r) => `- ${r}`), "");
  return out.join("\n");
}

export function transcriptMarkdown(call, t) {
  const labels = { me: t("speaker_me"), them: t("speaker_them") };
  const lines = (call.transcript || []).map((l) => `- [${fmtTime(l.t)}] **${labels[l.speaker] || l.speaker}:** ${l.text}`);
  return `# ${t("sec_transcript")}\n\n${lines.join("\n")}\n`;
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
