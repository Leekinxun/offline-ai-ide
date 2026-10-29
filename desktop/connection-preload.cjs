const { contextBridge, ipcRenderer } = require("electron");
const prefix = "--crownforge-connection-page=";
const page = process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);

// The configuration bridge belongs exclusively to the packaged, top-level page.
if (process.isMainFrame && page && window.location.href === page && page.startsWith("file:")) {
  contextBridge.exposeInMainWorld("crownforgeConnection", {
    getState: () => ipcRenderer.invoke("crownforge:connection:get"),
    connect: (url) => ipcRenderer.invoke("crownforge:connection:connect", url),
    retry: () => ipcRenderer.invoke("crownforge:connection:retry"),
    onState(callback) {
      if (typeof callback !== "function") throw new TypeError("State callback must be a function");
      const listener = (_event, state) => callback(state);
      ipcRenderer.on("crownforge:connection:state", listener);
      return () => ipcRenderer.removeListener("crownforge:connection:state", listener);
    },
  });
}
