// The page: tabs, the live call panel, summary, memory, history and settings.

import { BrowserAudioCapture, CaptureError, captureSupported } from "./audio.js";
import { ClaudeClient, FakeClaude } from "./claude.js";
import { download, deleteCall, loadCalls, saveCall, summaryMarkdown, transcriptMarkdown } from "./history.js";
import { translator } from "./i18n.js";
import { Memory, MemoryPathError } from "./memory.js";
import { BIG_FILES, ModelFileError, hasManualModel, importModelFiles, manualDownloadLinks } from "./model-files.js";
import { CallSession, TranscriptReplay } from "./session.js";
import { ScriptedTranscriber, WhisperTranscriber } from "./transcriber.js";
import { fmtTime, parseTranscript } from "./transcript.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
// Test hooks: ?engine=scripted (no Whisper download), ?llm=fake (no API key), ?speed=N (demo speed).
const TEST_ENGINE = params.get("engine");
const TEST_LLM = params.get("llm");

const SETTINGS_KEY = "ca.settings.v1";
const API_KEY = "ca.apiKey";
const DEFAULTS = {
  uiLanguage: (navigator.language || "it").toLowerCase().startsWith("it") ? "it" : "en",
  callLanguage: "auto",
  whisperModel: "base",
  insightInterval: 25,
  insightModel: "claude-haiku-5-5",
  summaryModel: "claude-opus-5-5",
  transcriptWindow: 240,
};

function store() {
  try {
    return localStorage;
  } catch {
    return null;
  }
}
function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(store()?.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveSettings() {
  try {
    store()?.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage blocked: settings last for this visit */
  }
}
function getApiKey() {
  try {
    return store()?.getItem(API_KEY) || "";
  } catch {
    return "";
  }
}

let settings = loadSettings();
let t = translator(settings.uiLanguage);
let memory = new Memory(settings.uiLanguage);
let session = null;
let lastResult = null;
let copiedUntil = 0;
let pipWindow = null;

// ------------------------------------------------------------------ helpers
function applyTranslations() {
  document.documentElement.lang = settings.uiLanguage;
  document.title = t("app_title");
  document.querySelectorAll("[data-t]").forEach((el) => {
    el.textContent = t(el.dataset.t);
  });
  $("refresh").title = t("tip_refresh");
  $("import-prompt").textContent = t("import_prompt");
}

function show(el, visible = true) {
  el.classList.toggle("hidden", !visible);
}

function setNotice(el, text, kind = "") {
  el.textContent = text || "";
  el.className = `notice ${kind}`;
  show(el, Boolean(text));
}

function message(payload) {
  if (Array.isArray(payload)) return t(payload[0], payload[1]);
  return t(payload);
}

async function copyText(text, view = window) {
  try {
    await view.navigator.clipboard.writeText(text);
    return true;
  } catch {
    const doc = view.document;
    const area = doc.createElement("textarea");
    area.value = text;
    doc.body.append(area);
    area.select();
    const ok = doc.execCommand("copy");
    area.remove();
    return ok;
  }
}

function showTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((s) => s.classList.toggle("active", s.id === `tab-${name}`));
  if (name === "memory") renderMemory();
  if (name === "history") renderHistory();
  if (name === "settings") renderSettings();
}

// --------------------------------------------------------------- the call
function renderSetup() {
  const missing = !getApiKey() && TEST_LLM !== "fake";
  setNotice($("key-missing"), missing ? t("no_api_key") : "", "warn");
  $("call-language").value = settings.callLanguage;
  if (!captureSupported()) setNotice($("key-missing"), t("unsupported"), "error");
}

function resetLive() {
  $("transcript").innerHTML = "";
  $("suggestions").innerHTML = "";
  $("remember").innerHTML = "";
  $("topic").textContent = t("waiting_more");
  $("topic").className = "topic waiting";
  $("cost").textContent = "$0.0000";
  $("timer").textContent = "00:00";
  $("countdown").textContent = "";
  setNotice($("notice"), "");
  $("live-language").value = settings.callLanguage;
  $("stop").disabled = false;
}

function setStatus(state) {
  const map = {
    loading: ["status_loading", "warn"],
    listening: ["status_listening", "ok"],
    stopping: ["status_stopping", "busy"],
    summarizing: ["status_summarizing", "busy"],
    done: ["status_done", ""],
    error: ["status_error", "error"],
  };
  const [key, cls] = map[state] || ["status_ready", ""];
  $("status").textContent = t(key);
  $("status-dot").className = `dot ${cls}`;
}

function makeLLM(demo) {
  const key = getApiKey();
  if (TEST_LLM === "fake") return new FakeClaude();
  if (key) return new ClaudeClient(key);
  return demo ? new FakeClaude() : null;
}

async function startCall({ demo = false } = {}) {
  if (session && !session.done) return;
  settings.callLanguage = $("call-language").value;
  saveSettings();
  let capture = null;
  let transcriber = null;
  let replay = null;
  if (demo) {
    const file = `samples/demo_call_${settings.callLanguage === "en" ? "en" : settings.uiLanguage === "en" ? "en" : "it"}.txt`;
    const text = await (await fetch(file)).text();
    replay = new TranscriptReplay(parseTranscript(text), Number(params.get("speed")) || 1.5);
  } else {
    capture = new BrowserAudioCapture({
      mic: $("src-mic").checked,
      shared: $("src-shared").checked,
      onWarning: (code) => setNotice($("notice"), t(code), "warn"),
      onSharedEnded: () => setNotice($("notice"), t("shared_ended"), "warn"),
    });
    transcriber =
      TEST_ENGINE === "scripted"
        ? new ScriptedTranscriber([], 30)
        : new WhisperTranscriber({
            model: settings.whisperModel,
            onProgress: (p) => setNotice($("notice"), t("model_progress", { p }), ""),
          });
  }
  session = new CallSession({ settings, memory, llm: makeLLM(demo), transcriber, capture, replay, onEvent: handleEvent });
  show($("setup"), false);
  show($("summary"), false);
  show($("live"), true);
  resetLive();
  try {
    await session.start();
  } catch (err) {
    const text = err instanceof CaptureError && t(err.code) !== err.code ? t(err.code) : t("capture_failed", { error: err.message });
    session.abort();
    session = null;
    show($("live"), false);
    show($("setup"), true);
    setNotice($("key-missing"), text, "error");
  }
}

function handleEvent(kind, payload) {
  switch (kind) {
    case "status":
      setStatus(payload);
      if (payload === "stopping") $("countdown").textContent = "";
      break;
    case "transcript":
      addTranscriptLine(payload);
      break;
    case "insight":
      showInsight(payload);
      break;
    case "insight_pending":
      $("countdown").textContent = t("updating");
      break;
    case "warning":
      setNotice($("notice"), message(payload), "warn");
      break;
    case "error_text":
      setStatus("error");
      setNotice($("notice"), message(payload), "error");
      break;
    case "model_ready":
      setNotice($("notice"), t("model_ready", { device: payload }), "ok");
      break;
    case "audio":
      $("audio-info").textContent = payload;
      break;
    case "cost":
      $("cost").textContent = `$${payload.total.toFixed(4)}`;
      $("cost").title = t("cost_tip", {
        live: `$${(payload.byPurpose.live || 0).toFixed(4)}`,
        summary: `$${(payload.byPurpose.summary || 0).toFixed(4)}`,
      });
      break;
    case "summary":
      showSummary(payload);
      break;
    default:
      break;
  }
}

function addTranscriptLine(line) {
  const box = $("transcript");
  const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
  const div = document.createElement("div");
  div.className = "line";
  const time = document.createElement("span");
  time.className = "time";
  time.textContent = fmtTime(line.t);
  const who = document.createElement("span");
  who.className = line.speaker;
  who.textContent = `${line.speaker === "me" ? t("speaker_me") : t("speaker_them")}: `;
  div.append(time, who, document.createTextNode(line.text));
  box.append(div);
  while (box.childElementCount > 300) box.firstElementChild.remove();
  if (atEnd) box.scrollTop = box.scrollHeight;
}

function showInsight(insight) {
  $("topic").textContent = insight.topic || "—";
  $("topic").className = "topic";
  const list = $("suggestions");
  list.innerHTML = "";
  for (const s of insight.suggestions) {
    const card = document.createElement("div");
    card.className = "suggestion";
    const kind = document.createElement("div");
    kind.className = `kind ${s.kind}`;
    kind.textContent = t(`kind_${s.kind}`);
    const text = document.createElement("div");
    text.className = "text";
    text.textContent = s.text;
    card.append(kind, text);
    card.addEventListener("click", async (e) => {
      if (await copyText(s.text, e.view || window)) {
        copiedUntil = Date.now() + 2500;
        $("countdown").textContent = t("copied");
        card.dataset.copied = "1";
      }
    });
    list.append(card);
  }
  const rem = $("remember");
  rem.innerHTML = "";
  for (const item of insight.remember) {
    const li = document.createElement("li");
    li.textContent = item;
    rem.append(li);
  }
}

function tick() {
  if (!session || !session.running || session.stopping) return;
  $("timer").textContent = fmtTime(session.elapsed());
  if (Date.now() < copiedUntil) return;
  const next = session.nextInsightIn();
  if (next === null) $("countdown").textContent = "";
  else if (next > 0) $("countdown").textContent = t("next_update", { s: Math.ceil(next) });
}

async function stopCall() {
  if (!session || session.stopping) return;
  $("stop").disabled = true;
  await session.stop();
}

function showSummary(result) {
  const call = { ...result };
  saveCall(call);
  lastResult = call;
  const d = call.data || {};
  $("summary-title").textContent = d.title || t("summary_title");
  $("summary-meta").textContent = `${new Date(call.startedAt).toLocaleString()} · ${fmtTime(call.durationS)} · $${call.cost.toFixed(4)}`;
  setNotice($("summary-error"), call.error ? t("summary_failed", { error: call.error }) : "", "warn");
  $("summary-body").textContent = d.summary || "";
  const lists = $("summary-lists");
  lists.innerHTML = "";
  const addList = (title, items) => {
    if (!items || !items.length) return;
    const h = document.createElement("h3");
    h.textContent = title;
    const ul = document.createElement("ul");
    for (const it of items) {
      const li = document.createElement("li");
      li.textContent = it;
      ul.append(li);
    }
    lists.append(h, ul);
  };
  addList(t("key_points"), d.key_points);
  addList(
    t("actions"),
    (d.action_items || []).map((a) => `${a.owner}: ${a.task}${a.due ? ` (${t("due")} ${a.due})` : ""}`),
  );
  addList(t("notes_live"), call.liveRemember);
  renderProposals(call.proposals || []);
  if (pipWindow) pipWindow.close();
  show($("live"), false);
  show($("summary"), true);
  show($("setup"), false);
}

function renderProposals(proposals) {
  const box = $("proposals");
  box.innerHTML = "";
  show($("review"), proposals.length > 0);
  setNotice($("review-status"), "");
  const existing = new Set(memory.names().map((n) => n.toLowerCase()));
  for (const p of proposals) {
    const card = document.createElement("div");
    card.className = "proposal";
    const head = document.createElement("header");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = true;
    const name = document.createElement("span");
    const isNew = !existing.has(String(p.file).toLowerCase());
    name.textContent = `${p.file}${isNew ? ` (${t("review_new_file")})` : ""}`;
    head.append(check, name);
    const reason = document.createElement("div");
    reason.className = "reason";
    reason.textContent = p.reason || "";
    const area = document.createElement("textarea");
    area.rows = Math.min(8, Math.max(2, String(p.content).split("\n").length + 1));
    area.value = String(p.content).trim();
    card.append(head, reason, area);
    card.proposal = { p, check, area };
    box.append(card);
  }
}

function applyProposals() {
  let n = 0;
  const errors = [];
  for (const card of $("proposals").children) {
    const { p, check, area } = card.proposal;
    if (!check.checked) continue;
    try {
      memory.apply({ file: p.file, content: area.value }, lastResult ? lastResult.id.slice(0, 16) : "");
      n++;
      card.remove();
    } catch (err) {
      errors.push(`${p.file}: ${err instanceof MemoryPathError ? err.message : err.message}`);
    }
  }
  $("review-status").textContent = errors.length ? errors.join("; ") : t("review_done", { n });
}

async function openPip() {
  if (!("documentPictureInPicture" in window)) {
    setNotice($("notice"), t("pip_unsupported"), "warn");
    return;
  }
  if (pipWindow) return;
  const live = $("live");
  pipWindow = await window.documentPictureInPicture.requestWindow({ width: 400, height: 640 });
  for (const sheet of document.styleSheets) {
    try {
      const style = pipWindow.document.createElement("style");
      style.textContent = [...sheet.cssRules].map((r) => r.cssText).join("\n");
      pipWindow.document.head.append(style);
    } catch {
      const link = pipWindow.document.createElement("link");
      link.rel = "stylesheet";
      link.href = sheet.href;
      pipWindow.document.head.append(link);
    }
  }
  pipWindow.document.title = t("app_title");
  pipWindow.document.body.classList.add("pip");
  const placeholder = document.createComment("live panel is in the always-on-top window");
  live.before(placeholder);
  pipWindow.document.body.append(live);
  show($("pip"), false);
  pipWindow.addEventListener("pagehide", () => {
    placeholder.replaceWith(live);
    show($("pip"), true);
    pipWindow = null;
  });
}

// ---------------------------------------------------------------- memory
function renderMemory(selected) {
  const sel = $("mem-file");
  const names = memory.names();
  sel.innerHTML = "";
  for (const n of names) {
    const o = document.createElement("option");
    o.value = n;
    o.textContent = n;
    sel.append(o);
  }
  sel.value = selected && names.includes(selected) ? selected : names[0] || "";
  $("mem-text").value = memory.files[sel.value] || "";
  $("mem-status").textContent = "";
}

// --------------------------------------------------------------- history
function renderHistory() {
  const box = $("history");
  box.innerHTML = "";
  const calls = loadCalls();
  if (!calls.length) {
    box.textContent = t("history_empty");
    return;
  }
  for (const call of calls) {
    const row = document.createElement("div");
    row.className = "call-item";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = `${new Date(call.startedAt).toLocaleString()} · ${fmtTime(call.durationS)} · ${(call.data && call.data.title) || t("summary_title")}`;
    title.addEventListener("click", () => {
      showSummary(call);
      showTab("call");
    });
    const md = document.createElement("button");
    md.textContent = ".md";
    md.title = t("download_summary");
    md.addEventListener("click", () => download(`${call.id.slice(0, 16).replace(/[:T]/g, "-")}-summary.md`, summaryMarkdown(call, t)));
    const del = document.createElement("button");
    del.className = "ghost";
    del.textContent = t("history_delete");
    del.addEventListener("click", () => {
      deleteCall(call.id);
      renderHistory();
    });
    row.append(title, md, del);
    box.append(row);
  }
}

// -------------------------------------------------------------- settings
async function renderManualModel(message = "") {
  const model = $("whisper-model").value || settings.whisperModel;
  const list = $("manual-links");
  list.innerHTML = "";
  for (const { name, url } of manualDownloadLinks(model)) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = `${name} (whisper-${model})`;
    li.append(a);
    list.append(li);
  }
  const ready = await hasManualModel(model);
  $("manual-status").textContent = [message, ready ? t("manual_ready") : ""].filter(Boolean).join(" ");
}

function renderSettings() {
  $("api-key").value = getApiKey();
  $("whisper-model").value = settings.whisperModel;
  renderManualModel();
  $("interval").value = settings.insightInterval;
  $("summary-model").value = settings.summaryModel;
  $("ui-language").value = settings.uiLanguage;
  $("key-status").textContent = "";
  $("settings-status").textContent = "";
}

// ------------------------------------------------------------------ wiring
function wire() {
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("start").addEventListener("click", () => startCall());
  $("new-call").addEventListener("click", () => {
    show($("summary"), false);
    show($("live"), false);
    show($("setup"), true);
    renderSetup();
  });
  $("demo").addEventListener("click", () => startCall({ demo: true }));
  $("stop").addEventListener("click", stopCall);
  $("refresh").addEventListener("click", () => session && session.requestInsight());
  $("pip").addEventListener("click", openPip);
  $("live-language").addEventListener("change", (e) => {
    settings.callLanguage = e.target.value;
    saveSettings();
    if (session) session.setLanguage(e.target.value);
  });
  $("dl-summary").addEventListener("click", () => lastResult && download(`${lastResult.id.slice(0, 16).replace(/[:T]/g, "-")}-summary.md`, summaryMarkdown(lastResult, t)));
  $("dl-transcript").addEventListener("click", () => lastResult && download(`${lastResult.id.slice(0, 16).replace(/[:T]/g, "-")}-transcript.md`, transcriptMarkdown(lastResult, t)));
  $("apply-proposals").addEventListener("click", applyProposals);

  $("mem-file").addEventListener("change", (e) => {
    $("mem-text").value = memory.files[e.target.value] || "";
  });
  $("mem-save").addEventListener("click", () => {
    const ok = memory.write($("mem-file").value, $("mem-text").value);
    $("mem-status").textContent = ok ? t("mem_saved") : "!";
  });
  $("mem-new").addEventListener("click", () => {
    const name = prompt(t("mem_new_prompt"), "people/");
    if (!name) return;
    try {
      const path = memory.resolve(name.endsWith(".md") ? name : `${name}.md`);
      if (!(path in memory.files)) memory.write(path, `# ${path.split("/").pop().replace(/\.md$/, "")}\n\n`);
      renderMemory(path);
    } catch (err) {
      $("mem-status").textContent = err.message;
    }
  });
  $("mem-delete").addEventListener("click", () => {
    const name = $("mem-file").value;
    if (name && confirm(t("mem_delete_confirm", { name }))) {
      memory.remove(name);
      renderMemory();
    }
  });
  $("copy-prompt").addEventListener("click", async () => {
    if (await copyText(t("import_prompt"))) $("import-status").textContent = t("copied");
  });
  $("import-save").addEventListener("click", () => {
    const text = $("import-text").value;
    if (!text.trim()) {
      $("import-status").textContent = t("import_empty");
      return;
    }
    const path = memory.importClaudeExport(text);
    $("import-text").value = "";
    $("import-status").textContent = t("import_done", { path });
  });
  $("mem-export").addEventListener("click", () => download(`memoria-call-assistant-${new Date().toISOString().slice(0, 10)}.md`, memory.exportBundle()));
  $("mem-import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    let n = memory.importBundle(text);
    if (!n) {
      // A plain Markdown file (e.g. from the desktop app's memory folder).
      memory.write(file.name.endsWith(".md") ? file.name : `${file.name}.md`, text);
      n = 1;
    }
    $("backup-status").textContent = t("mem_import_backup_done", { n });
    renderMemory();
    e.target.value = "";
  });

  $("key-save").addEventListener("click", () => {
    const key = $("api-key").value.trim();
    if (!key.startsWith("sk-ant-")) {
      $("key-status").textContent = t("settings_key_invalid");
      return;
    }
    try {
      store()?.setItem(API_KEY, key);
    } catch {
      /* ignore */
    }
    $("key-status").textContent = t("settings_key_saved");
    renderSetup();
  });
  $("key-forget").addEventListener("click", () => {
    try {
      store()?.removeItem(API_KEY);
    } catch {
      /* ignore */
    }
    $("api-key").value = "";
    renderSetup();
  });
  $("whisper-model").addEventListener("change", () => renderManualModel());
  $("manual-files").addEventListener("change", async (e) => {
    const model = $("whisper-model").value || settings.whisperModel;
    try {
      const { stored, skipped } = await importModelFiles(model, [...e.target.files]);
      const parts = [];
      if (stored.length) parts.push(t("manual_done", { files: stored.join(", ") }));
      if (skipped.length) parts.push(t("manual_skipped", { files: skipped.join(", ") }));
      if (!(await hasManualModel(model))) {
        const missing = [];
        for (const { name } of manualDownloadLinks(model)) if (!stored.includes(name)) missing.push(name);
        if (missing.length && missing.length < BIG_FILES.length + 1) parts.push(t("manual_missing", { files: missing.join(", ") }));
      }
      await renderManualModel(parts.join(" "));
    } catch (err) {
      $("manual-status").textContent = err instanceof ModelFileError ? t("manual_invalid", { file: err.message }) : String(err.message || err);
    }
    e.target.value = "";
  });
  $("settings-save").addEventListener("click", () => {
    const interval = Math.max(10, Math.min(120, Number($("interval").value) || 25));
    const uiChanged = $("ui-language").value !== settings.uiLanguage;
    settings = {
      ...settings,
      whisperModel: $("whisper-model").value,
      insightInterval: interval,
      summaryModel: $("summary-model").value,
      uiLanguage: $("ui-language").value,
    };
    saveSettings();
    if (uiChanged) {
      t = translator(settings.uiLanguage);
      memory = new Memory(settings.uiLanguage);
      applyTranslations();
      renderSetup();
    }
    $("settings-status").textContent = t("settings_saved");
  });
  window.addEventListener("beforeunload", (e) => {
    if (session && session.running && !session.done) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  setInterval(tick, 1000);
}

applyTranslations();
wire();
renderSetup();
$("topic").textContent = t("waiting_first", { s: settings.insightInterval });
window.__callAssistant = { get session() { return session; }, memory: () => memory };
