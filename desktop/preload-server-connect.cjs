const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("crownforgeServer", {
  getConfig: () => ipcRenderer.invoke("crownforge:server:get"),
  testConnection: (url) => ipcRenderer.invoke("crownforge:server:test", url),
  saveAndConnect: (url) => ipcRenderer.invoke("crownforge:server:save", url),
  cancel: () => ipcRenderer.invoke("crownforge:server:cancel"),
});
