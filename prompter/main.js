// The Suggeritore: Call Assistant's prompter in a window of its own, always on
// top, that screen sharing doesn't show. Windows leaves it out of every capture
// (Teams, recordings, screenshots: SetWindowDisplayAffinity with
// WDA_EXCLUDEFROMCAPTURE, which Electron sets with setContentProtection), so
// the user sees it and the people watching their screen don't.
//
// The window shows the web app's prompter view (?view=prompter) from the
// user's bridge: Claude's suggestions, the briefing and the transcript of the
// call in progress. The first time, the user pastes the prompter link from the
// web app's Settings: it gives the bridge's address (kept here) and its key
// (kept by the page).

const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeImage, nativeTheme, screen, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const ICON = nativeImage.createFromBuffer(Buffer.from(require("./icon.js"), "base64"));
const LINK = /^(https:\/\/[^/?#\s]+|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?)\/?(?:\?view=prompter)?#k=([A-Za-z0-9_-]{24,128})$/;

const file = (name) => path.join(app.getPath("userData"), name);
function readJson(name) {
  try {
    return JSON.parse(fs.readFileSync(file(name), "utf8"));
  } catch {
    return {};
  }
}
function writeJson(name, data) {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(file(name), JSON.stringify(data, null, 2));
  } catch {
    /* not saved: asked again next time */
  }
}

/** The prompter link, parsed: the bridge's address and its key; null when it isn't one. */
function parseLink(text) {
  const m = LINK.exec(String(text || "").trim());
  return m ? { origin: m[1], key: m[2] } : null;
}

let win = null;

/** The bridge's address, saved the first time (CALL_ASSISTANT_URL overrides it). */
function bridgeOrigin() {
  const value = process.env.CALL_ASSISTANT_URL || readJson("config.json").url || "";
  try {
    return value ? new URL(value).origin : "";
  } catch {
    return "";
  }
}

function showPrompter(hash = "") {
  win.loadURL(`${bridgeOrigin()}/?view=prompter${hash}`);
}

function showPairing() {
  win.loadFile(path.join(__dirname, "pair.html"));
}

function createWindow() {
  const saved = readJson("window.json");
  // Back where it was, if that place is still on a screen.
  const onScreen = saved.bounds && screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    const b = saved.bounds;
    return b.x < a.x + a.width - 40 && b.x + b.width > a.x + 40 && b.y >= a.y - 8 && b.y < a.y + a.height - 40;
  });
  win = new BrowserWindow({
    ...(onScreen ? saved.bounds : { width: 420, height: 640 }),
    minWidth: 300,
    minHeight: 220,
    title: "Suggeritore",
    icon: ICON,
    backgroundColor: "#1f1f1f",
    alwaysOnTop: true,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  // The point of it all: Windows leaves this window out of screen sharing, recordings and screenshots.
  win.setContentProtection(true);
  // Above the call's window, also when that one is full screen.
  win.setAlwaysOnTop(true, "screen-saver");
  win.once("ready-to-show", () => win.show());
  win.on("close", () => writeJson("window.json", { bounds: win.getBounds() }));

  // Links open in the browser; the window itself stays on the bridge's page.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const origin = bridgeOrigin();
    if (url.startsWith("file:") || (origin && url.startsWith(`${origin}/`))) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
  // A few keys of a browser: reload, zoom.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const ctrl = input.control || input.meta;
    const zoom = win.webContents.getZoomLevel();
    if (input.key === "F5" || (ctrl && input.key.toLowerCase() === "r")) win.webContents.reload();
    else if (ctrl && (input.key === "+" || input.key === "=")) win.webContents.setZoomLevel(Math.min(zoom + 0.5, 4));
    else if (ctrl && input.key === "-") win.webContents.setZoomLevel(Math.max(zoom - 0.5, -3));
    else if (ctrl && input.key === "0") win.webContents.setZoomLevel(0);
    else return;
    event.preventDefault();
  });
  // Right click: the same, and connecting again.
  win.webContents.on("context-menu", (_event, params) => {
    const items = [];
    if (params.selectionText) items.push({ label: "Copia", role: "copy" }, { type: "separator" });
    if (params.isEditable) items.push({ label: "Incolla", role: "paste" }, { type: "separator" });
    items.push(
      { label: "Ricarica", click: () => win.webContents.reload() },
      { label: "Ingrandisci il testo", click: () => win.webContents.setZoomLevel(Math.min(win.webContents.getZoomLevel() + 0.5, 4)) },
      { label: "Riduci il testo", click: () => win.webContents.setZoomLevel(Math.max(win.webContents.getZoomLevel() - 0.5, -3)) },
      { type: "separator" },
      { label: "Collega di nuovo…", click: showPairing },
      { label: "Esci", role: "quit" },
    );
    Menu.buildFromTemplate(items).popup({ window: win });
  });

  if (bridgeOrigin()) showPrompter();
  else showPairing();
}

/** A desktop icon, once (deleted by the user, it stays deleted). Started from it, Electron needs no terminal. */
function desktopShortcut() {
  if (process.platform !== "win32" || readJson("state.json").shortcut) return;
  try {
    const ico = file("Suggeritore.ico");
    fs.writeFileSync(ico, icoFromPng(ICON.toPNG()));
    shell.writeShortcutLink(path.join(app.getPath("desktop"), "Suggeritore.lnk"), "create", {
      target: process.execPath,
      args: `"${app.getAppPath()}"`,
      cwd: app.getAppPath(),
      icon: ico,
      iconIndex: 0,
      description: "Call Assistant: i suggerimenti di Claude, invisibili nella condivisione dello schermo",
    });
  } catch {
    /* no icon: npm start still works */
  }
  writeJson("state.json", { ...readJson("state.json"), shortcut: true });
}

/** An .ico holding one PNG (Windows Vista and later read it). */
function icoFromPng(png) {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0); // reserved
  head.writeUInt16LE(1, 2); // an icon
  head.writeUInt16LE(1, 4); // one image
  head.writeUInt8(0, 6); // width 256
  head.writeUInt8(0, 7); // height 256
  head.writeUInt16LE(1, 10); // planes
  head.writeUInt16LE(32, 12); // bits per pixel
  head.writeUInt32LE(png.length, 14);
  head.writeUInt32LE(22, 18); // where the PNG starts
  return Buffer.concat([head, png]);
}

// The first time: the prompter link from the web app's Settings.
ipcMain.handle("pair", (_event, text) => {
  const link = parseLink(text);
  if (!link) return { ok: false };
  writeJson("config.json", { url: `${link.origin}/` });
  // The page keeps the key (it reads it from the address, then takes it out).
  showPrompter(`#k=${link.key}`);
  return { ok: true };
});
ipcMain.handle("clipboard-link", () => (parseLink(clipboard.readText()) ? clipboard.readText().trim() : ""));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.whenReady().then(() => {
    nativeTheme.themeSource = "dark"; // a dark title bar, as the page
    Menu.setApplicationMenu(null);
    // The page needs only to copy a suggestion to the clipboard.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === "clipboard-sanitized-write"));
    if (process.platform === "win32") app.setAppUserModelId("CallAssistant.Suggeritore");
    createWindow();
    desktopShortcut();
  });
  app.on("window-all-closed", () => app.quit());
  process.on("uncaughtException", (err) => {
    dialog.showErrorBox("Suggeritore", String((err && err.stack) || err));
  });
}
