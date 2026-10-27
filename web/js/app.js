// The page: the call (setup, live panel, end of the call), history and settings.
// Claude reads the call from the user's bridge (bridge.js) as a connector on
// claude.ai; without a bridge, «Ask Claude» copies the transcript for the chat.

import { BrowserAudioCapture, CaptureError, captureSupported } from "./audio.js";
import { Bridge, BridgeError, BridgeSync, cleanBridgeUrl, newBridgeKey, sameOriginBridge } from "./bridge.js";
import { callLabel, deleteCall, download, fileName, loadCalls, saveCall, transcriptMarkdown } from "./history.js";
import { translator } from "./i18n.js";
import { ModelFileError, importModelFiles, manualDownloadLinks, missingManualFiles } from "./model-files.js";
import { chatAskPrompt, chatConnectorPrompt, chatSummaryPrompt } from "./prompts.js";
import { CallSession, TranscriptReplay } from "./session.js";
import { ScriptedTranscriber, WhisperTranscriber } from "./transcriber.js";
import { fmtTime, parseTranscript } from "./transcript.js";

// The live panel can be in the always-on-top window (see openPip), outside this document.
const $ = (id) => document.getElementById(id) || (pipWindow && pipWindow.document.getElementById(id));
const params = new URLSearchParams(location.search);
// Test hooks: ?engine=scripted (no Whisper download), ?speed=N (demo speed).
const TEST_ENGINE = params.get("engine");

const SETTINGS_KEY = "ca.settings.v1";
const DEFAULTS = {
  uiLanguage: (navigator.language || "it").toLowerCase().startsWith("it") ? "it" : "en",
  callLanguage: "auto",
  whisperModel: "base",
  claudeUrl: "", // chat that «Ask Claude» opens; "" = a new chat
  bridgeUrl: "", // the user's bridge to Claude (bridge/): the page's own address when it serves the page
  bridgeKey: "", // secret part of the bridge addresses, made on first use
  bridgeOn: false,
  connectorAdded: false, // the user added the connector on claude.ai: the Call tab stops showing that step
};
const CLAUDE_NEW_CHAT = "https://claude.ai/new";

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
// Earlier versions called the Claude API with a key saved here: it isn't used any more.
try {
  store()?.removeItem("ca.apiKey");
} catch {
  /* nothing saved */
}

let settings = loadSettings();
let t = translator(settings.uiLanguage);
let session = null;
let lastResult = null;
let pipWindow = null;
let claudeOpened = false; // the Claude chat was opened from this page
let bridgeSync = null; // sends the running call to the bridge
let bridgeHere = false; // the page is served by its bridge, so it is connected by itself
let bridgeProblem = ""; // why the bridge at this address can't be used

// ------------------------------------------------------------------ helpers
function applyTranslations() {
  document.documentElement.lang = settings.uiLanguage;
  document.title = t("app_title");
  document.querySelectorAll("[data-t]").forEach((el) => {
    el.textContent = t(el.dataset.t);
  });
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
  if (name === "history") renderHistory();
  if (name === "settings") renderSettings();
}

// ------------------------------------------------------------- Claude box
/** At the top of the Call tab: is Claude reading the calls, and what is left to do. */
function renderClaudeBox(checking = false) {
  let dot = "";
  let title;
  let text = "";
  let connectorStep = false;
  if (checking) {
    dot = "busy";
    title = t("claude_checking");
  } else if (bridgeProblem) {
    dot = "error";
    title = t("claude_off_title");
    text = bridgeProblem;
  } else if (bridgeActive() && !settings.connectorAdded) {
    dot = "warn";
    title = t("claude_last_step");
    text = t("claude_last_step_text");
    connectorStep = true;
  } else if (bridgeActive()) {
    dot = "ok";
    title = t("claude_on_title");
    text = t("claude_on_text");
  } else {
    title = t("claude_off_title");
    text = t("claude_off_text");
  }
  $("claude-dot").className = `dot ${dot}`;
  $("claude-title").textContent = title;
  $("claude-text").textContent = text;
  $("setup-connector").value = connectorStep ? makeBridge().connectorUrl : "";
  show($("claude-connector-row"), connectorStep);
  show($("claude-settings-row"), !checking && !bridgeActive() && !bridgeHere);
}

// --------------------------------------------------------------- the call
function renderSetup() {
  $("call-language").value = settings.callLanguage;
  setNotice($("setup-notice"), captureSupported() ? "" : t("unsupported"), "error");
  renderClaudeBox();
}

function resetLive() {
  $("transcript").innerHTML = "";
  $("live-hint").textContent = bridgeActive() ? t("live_hint_connector") : t("live_hint_copy");
  setBridgeState(null);
  $("timer").textContent = "00:00";
  setNotice($("notice"), "");
  $("live-language").value = settings.callLanguage;
  $("stop").disabled = false;
}

function setStatus(state) {
  const map = {
    loading: ["status_loading", "warn"],
    listening: ["status_listening", "ok"],
    stopping: ["status_stopping", "busy"],
    done: ["status_done", ""],
    error: ["status_error", "error"],
  };
  const [key, cls] = map[state] || ["status_ready", ""];
  $("status").textContent = t(key);
  $("status-dot").className = `dot ${cls}`;
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
  session = new CallSession({ settings, transcriber, capture, replay, onEvent: handleEvent });
  show($("setup"), false);
  show($("ended"), false);
  show($("live"), true);
  resetLive();
  if (bridgeSync) bridgeSync.stop();
  bridgeSync = null;
  try {
    await session.start();
    if (bridgeActive()) {
      bridgeSync = new BridgeSync({ bridge: makeBridge(), session, onState: setBridgeState });
      bridgeSync.start();
    }
  } catch (err) {
    const text = err instanceof CaptureError && t(err.code) !== err.code ? t(err.code) : t("capture_failed", { error: err.message });
    session.abort();
    session = null;
    show($("live"), false);
    show($("setup"), true);
    setNotice($("setup-notice"), text, "error");
  }
}

function handleEvent(kind, payload) {
  switch (kind) {
    case "status":
      setStatus(payload);
      break;
    case "transcript":
      addTranscriptLine(payload);
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
    case "ended":
      if (bridgeSync) bridgeSync.finish();
      bridgeSync = null;
      saveCall(payload);
      showEnded(payload);
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

function tick() {
  if (!session || !session.running || session.stopping) return;
  $("timer").textContent = fmtTime(session.elapsed());
}

async function stopCall() {
  if (!session || session.stopping) return;
  $("stop").disabled = true;
  await session.stop();
}

/** The end of a call (or a call opened from the history): what Claude can do with it now. */
function showEnded(call) {
  lastResult = call;
  $("ended-meta").textContent = callLabel(call);
  $("ended-hint").textContent = bridgeActive() ? t("ended_hint_connector") : t("ended_hint_copy");
  setNotice($("summary-claude-status"), "");
  if (pipWindow) pipWindow.close();
  show($("live"), false);
  show($("setup"), false);
  show($("ended"), true);
}

async function openPip() {
  if (!("documentPictureInPicture" in window)) {
    setNotice($("notice"), t("pip_unsupported"), "warn");
    return;
  }
  if (pipWindow) return;
  const live = $("live");
  pipWindow = await window.documentPictureInPicture.requestWindow({ width: 400, height: 560 });
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

// ------------------------------------------------------------ Claude chat
// «Ask Claude» copies a request and opens Claude: the user pastes it in the
// chat. With the bridge the request is short, since Claude reads the call
// itself; without it, the request carries the transcript.

function claudeUrl() {
  return settings.claudeUrl || CLAUDE_NEW_CHAT;
}

/** The link as typed if it is on claude.ai, "" for the default, null otherwise. */
function cleanClaudeUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    return url.protocol === "https:" && url.hostname === "claude.ai" ? url.href : null;
  } catch {
    return null;
  }
}

/** Copy first (a page that lost focus can't copy), then open Claude in a new tab. */
async function sendToClaude(text, view, openTab) {
  if (!(await copyText(text, view))) return false;
  if (openTab) {
    let win = null;
    try {
      win = view.open(claudeUrl(), "_blank");
    } catch {
      /* blocked: the user opens Claude */
    }
    if (win) claudeOpened = true;
  }
  return true;
}

async function askClaude(e) {
  const view = e.view || window;
  if (!session || !session.store.length) {
    setNotice($("notice"), t("ask_empty"), "warn");
    return;
  }
  const text = bridgeActive()
    ? chatConnectorPrompt(settings.uiLanguage, "ask")
    : chatAskPrompt({ lang: settings.uiLanguage, lines: session.store.lines });
  if (await sendToClaude(text, view, !claudeOpened)) setNotice($("notice"), t("ask_copied"), "ok");
  else setNotice($("notice"), t("ask_copy_failed"), "error");
}

async function summaryWithClaude(e) {
  if (!lastResult) return;
  const text = bridgeActive()
    ? chatConnectorPrompt(settings.uiLanguage, "summary")
    : chatSummaryPrompt({ lang: settings.uiLanguage, meta: callLabel(lastResult), lines: lastResult.transcript });
  const ok = await sendToClaude(text, e.view || window, true);
  setNotice($("summary-claude-status"), t(ok ? "ask_copied" : "ask_copy_failed"), ok ? "ok" : "error");
}

// ------------------------------------------------------------------ bridge
// The user's bridge (bridge/ in the repository) keeps the call for Claude,
// which reads it as a custom connector on claude.ai.

function bridgeActive() {
  return Boolean(settings.bridgeOn && settings.bridgeUrl && settings.bridgeKey);
}

function makeBridge(url = settings.bridgeUrl) {
  if (!settings.bridgeKey) {
    settings.bridgeKey = newBridgeKey();
    saveSettings();
  }
  return new Bridge({ url, key: settings.bridgeKey });
}

function bridgeMessage(err) {
  const code = err instanceof BridgeError ? err.code : "failed";
  return t({ unreachable: "bridge_unreachable", not_found: "bridge_not_found", no_database: "bridge_no_db" }[code] || "bridge_failed");
}

/** Served by its own bridge (the repository deployed to Cloudflare): connect without asking. */
async function connectHere() {
  if (!settings.bridgeKey) {
    settings.bridgeKey = newBridgeKey();
    saveSettings();
  }
  try {
    const bridge = await sameOriginBridge(settings.bridgeKey);
    if (bridge) {
      bridgeHere = true;
      settings = { ...settings, bridgeUrl: bridge.url, bridgeOn: true };
      saveSettings();
    }
  } catch (err) {
    bridgeHere = true;
    bridgeProblem = bridgeMessage(err);
  }
  renderClaudeBox();
  if ($("tab-settings").classList.contains("active")) renderBridge();
}

function renderBridge(note = "") {
  show($("bridge-manual"), !bridgeHere);
  show($("bridge-here"), bridgeHere);
  $("bridge-url").value = settings.bridgeUrl;
  $("bridge-connector").value = bridgeActive() ? makeBridge().connectorUrl : "";
  show($("bridge-connector-box"), bridgeActive());
  show($("bridge-off"), bridgeActive());
  $("bridge-status").textContent = note || (bridgeHere ? bridgeProblem : "");
}

/** The small "Claude connected" note in the live panel. */
function setBridgeState(state) {
  const el = $("bridge-state");
  el.className = `bridge-state small ${state || ""}`;
  el.textContent = state === "ok" ? t("bridge_live_ok") : state === "error" ? t("bridge_live_error") : "";
  show(el, Boolean(state));
  if (state === "error") setNotice($("notice"), t("bridge_down"), "warn");
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
    const first = (call.transcript || []).find((l) => l.text);
    title.textContent = `${callLabel(call)}${first ? ` · ${first.text.slice(0, 60)}` : ""}`;
    title.addEventListener("click", () => {
      showEnded(call);
      showTab("call");
    });
    const md = document.createElement("button");
    md.textContent = ".md";
    md.title = t("download_transcript");
    md.addEventListener("click", () => download(fileName(call, "transcript"), transcriptMarkdown(call, t)));
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
let manualRender = 0; // the latest status wins: an older check finishing late doesn't overwrite it

async function renderManualModel(note = "") {
  const ticket = ++manualRender;
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
  // Nothing loaded by hand yet: no status. Some files: what is still missing. All of them: ready.
  const missing = await missingManualFiles(model);
  if (ticket !== manualRender) return;
  const started = missing.length < manualDownloadLinks(model).length;
  const state = !started ? "" : missing.length ? t("manual_missing", { files: missing.join(", ") }) : t("manual_ready");
  $("manual-status").textContent = [note, state].filter(Boolean).join(" ");
}

function renderSettings() {
  $("whisper-model").value = settings.whisperModel;
  renderManualModel();
  $("ui-language").value = settings.uiLanguage;
  $("claude-url").value = settings.claudeUrl;
  $("claude-url-status").textContent = "";
  renderBridge();
  $("settings-status").textContent = "";
}

// ------------------------------------------------------------------ wiring
function wire() {
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("start").addEventListener("click", () => startCall());
  $("demo").addEventListener("click", () => startCall({ demo: true }));
  $("stop").addEventListener("click", stopCall);
  $("pip").addEventListener("click", openPip);
  $("ask-claude").addEventListener("click", askClaude);
  $("summary-claude").addEventListener("click", summaryWithClaude);
  $("dl-transcript").addEventListener("click", () => lastResult && download(fileName(lastResult, "transcript"), transcriptMarkdown(lastResult, t)));
  $("new-call").addEventListener("click", () => {
    show($("ended"), false);
    show($("live"), false);
    show($("setup"), true);
    renderSetup();
  });
  $("live-language").addEventListener("change", (e) => {
    settings.callLanguage = e.target.value;
    saveSettings();
    if (session) session.setLanguage(e.target.value);
  });

  // The last step of the setup, in the Call tab: the connector on claude.ai.
  $("setup-copy").addEventListener("click", async (e) => {
    if (await copyText($("setup-connector").value, e.view || window)) $("claude-text").textContent = t("claude_copied");
  });
  $("setup-done").addEventListener("click", () => {
    settings = { ...settings, connectorAdded: true };
    saveSettings();
    renderClaudeBox();
  });
  $("go-settings").addEventListener("click", () => showTab("settings"));

  $("bridge-connect").addEventListener("click", async () => {
    const url = cleanBridgeUrl($("bridge-url").value);
    if (!url) {
      $("bridge-status").textContent = t("bridge_bad_url");
      return;
    }
    $("bridge-status").textContent = "…";
    try {
      await makeBridge(url).status();
      settings = { ...settings, bridgeUrl: url, bridgeOn: true };
      saveSettings();
      renderBridge(t("bridge_ok"));
      renderClaudeBox();
    } catch (err) {
      $("bridge-status").textContent = bridgeMessage(err);
    }
  });
  $("bridge-off").addEventListener("click", () => {
    settings = { ...settings, bridgeOn: false };
    saveSettings();
    if (bridgeSync) bridgeSync.stop();
    bridgeSync = null;
    setBridgeState(null);
    renderBridge(t("bridge_off_done"));
    renderClaudeBox();
  });
  $("bridge-copy").addEventListener("click", async (e) => {
    if (await copyText($("bridge-connector").value, e.view || window)) $("bridge-status").textContent = t("copied");
  });
  $("bridge-clear").addEventListener("click", async () => {
    try {
      await makeBridge().clear();
      $("bridge-status").textContent = t("bridge_cleared");
    } catch (err) {
      $("bridge-status").textContent = bridgeMessage(err);
    }
  });
  $("bridge-new-key").addEventListener("click", async () => {
    try {
      await makeBridge().clear(); // the old address stops working: don't leave its calls behind
    } catch {
      /* they expire within 48 hours anyway */
    }
    settings = { ...settings, bridgeKey: newBridgeKey(), connectorAdded: false };
    saveSettings();
    renderBridge(t("bridge_new_key_done"));
    renderClaudeBox();
  });

  $("claude-url").addEventListener("change", () => {
    const chatUrl = cleanClaudeUrl($("claude-url").value);
    if (chatUrl === null) {
      $("claude-url-status").textContent = t("settings_claude_url_bad");
      return;
    }
    settings = { ...settings, claudeUrl: chatUrl };
    saveSettings();
    $("claude-url-status").textContent = t("settings_saved");
  });
  $("whisper-model").addEventListener("change", () => renderManualModel());
  $("manual-files").addEventListener("change", async (e) => {
    const model = $("whisper-model").value || settings.whisperModel;
    try {
      const { stored, skipped } = await importModelFiles(model, [...e.target.files]);
      const parts = [];
      if (stored.length) parts.push(t("manual_done", { files: stored.join(", ") }));
      if (skipped.length) parts.push(t("manual_skipped", { files: skipped.join(", ") }));
      await renderManualModel(parts.join(" "));
    } catch (err) {
      manualRender++;
      $("manual-status").textContent = err instanceof ModelFileError ? t("manual_invalid", { file: err.message }) : String(err.message || err);
    }
    e.target.value = "";
  });
  $("settings-save").addEventListener("click", () => {
    const uiChanged = $("ui-language").value !== settings.uiLanguage;
    const chatUrl = cleanClaudeUrl($("claude-url").value);
    if (chatUrl === null) {
      $("settings-status").textContent = t("settings_claude_url_bad");
      return;
    }
    settings = { ...settings, whisperModel: $("whisper-model").value, uiLanguage: $("ui-language").value, claudeUrl: chatUrl };
    saveSettings();
    if (uiChanged) {
      t = translator(settings.uiLanguage);
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
renderClaudeBox(!bridgeActive());
connectHere();
window.__callAssistant = { get session() { return session; } };
