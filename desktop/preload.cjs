const { contextBridge, ipcRenderer } = require("electron");

function argument(name) {
  const prefix = `--crownforge-desktop-${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function trustedPage() {
  try {
    const url = new URL(window.location.href);
    return process.isMainFrame && !url.username && !url.password && url.origin === argument("origin") &&
      ["/", "/login"].includes(url.pathname);
  } catch {
    return false;
  }
}

// Sandboxed preload cannot import local modules. Keep this gate independent of the main-process sender check.
if (trustedPage()) {
  contextBridge.exposeInMainWorld("crownforgeDesktop", {
    getPreferences: () => ipcRenderer.invoke("crownforge:preferences:get"),
    setPreferences: (patch) => ipcRenderer.invoke("crownforge:preferences:set", patch),
    openExternal: (url) => ipcRenderer.invoke("crownforge:external:open", url),
    switchServer: () => ipcRenderer.invoke("crownforge:server:open-dialog"),
    getServerUrl: () => ipcRenderer.invoke("crownforge:server:get-current"),
    onZoomCommand(callback) {
      if (typeof callback !== "function") throw new TypeError("Zoom callback must be a function");
      const listener = (_event, command) => {
        if (["in", "out", "reset"].includes(command)) callback(command);
      };
      ipcRenderer.on("crownforge:zoom", listener);
      return () => ipcRenderer.removeListener("crownforge:zoom", listener);
    },
    platform: process.platform,
    version: argument("version") || "",
  });
}

function isServerConnectPage() {
  try {
    const url = new URL(window.location.href);
    return process.isMainFrame && url.protocol === "file:" && url.pathname.endsWith("server-connect.html");
  } catch {
    return false;
  }
}

if (isServerConnectPage()) {
  contextBridge.exposeInMainWorld("crownforgeServer", {
    getConfig: () => ipcRenderer.invoke("crownforge:server:get"),
    testConnection: (url) => ipcRenderer.invoke("crownforge:server:test", url),
    saveAndConnect: (url) => ipcRenderer.invoke("crownforge:server:save", url),
    cancel: () => ipcRenderer.invoke("crownforge:server:cancel"),
  });
}

