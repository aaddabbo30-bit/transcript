// Only the local first-run page (pair.html) talks to the app: it hands over the prompter link.
// The bridge's page, in the same window, gets nothing from here.

const { contextBridge, ipcRenderer } = require("electron");

if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("suggeritore", {
    pair: (link) => ipcRenderer.invoke("pair", link),
    clipboardLink: () => ipcRenderer.invoke("clipboard-link"),
  });
}
