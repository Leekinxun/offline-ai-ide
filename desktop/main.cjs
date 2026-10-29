const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { createPreferencesStore } = require("./preferences.cjs");
const { normalizeServerUrl, serverId, serverPartition, createConnectionStore, RETRY_DELAYS } = require("./connection.cjs");
const { isTrustedUiUrl, isTrustedSender, externalUrl, createApplicationMenu } = require("./bridge-policy.cjs");

// This remote-client profile differs from a local Codex-style host: only the
// server owns workspaces, model credentials, processes and Agent run lifetime.
function createDesktopRuntime(electron, options = {}) {
  const { app, BrowserWindow, ipcMain, Menu, session, shell } = electron;
  const timers = options.timers || { setTimeout, clearTimeout };
  const connectionPage = pathToFileURL(path.join(__dirname, "connection.html")).href;
  const connectionStore = options.connectionStore || createConnectionStore(path.join(app.getPath("userData"), "connection.json"));
  const preferenceStores = new Map();
  const configuredSessions = new Set();
  const registeredContents = new Set();
  const windows = new Set();
  let connectionWindow;
  let mainWindow;
  let serverUrl = connectionStore.get().serverUrl;
  let state = { serverUrl, status: "disconnected", message: "", retryAt: null, attempt: 0 };
  let retryTimer;
  let generation = 0;
  let quitting = false;

  const snapshot = () => ({ ...state });
  function publish(patch) {
    state = { ...state, ...patch };
    if (connectionWindow && !connectionWindow.isDestroyed()) connectionWindow.webContents.send("crownforge:connection:state", snapshot());
  }
  function cancelRetry() {
    if (retryTimer !== undefined) timers.clearTimeout(retryTimer);
    retryTimer = undefined;
  }
  function authorizeConnection(event) {
    const contents = connectionWindow?.webContents;
    if (!contents || contents.isDestroyed() || event?.sender !== contents || event.senderFrame !== contents.mainFrame ||
        event.senderFrame?.url !== connectionPage || contents.getURL() !== connectionPage) throw new Error("Unauthorized connection request");
  }
  function preferencesFor(origin) {
    if (!preferenceStores.has(origin)) {
      preferenceStores.set(origin, (options.createPreferencesStore || createPreferencesStore)(path.join(app.getPath("userData"), "servers", serverId(origin), "preferences.json")));
    }
    return preferenceStores.get(origin);
  }
  function authorizeRemote(event) {
    if (!isTrustedSender(event, serverUrl, registeredContents)) throw new Error("Unauthorized desktop request");
  }
  function webPreferences(origin) {
    return {
      sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
      webviewTag: false, partition: serverPartition(origin), preload: path.join(__dirname, "preload.cjs"),
      additionalArguments: [`--crownforge-desktop-origin=${origin}`, `--crownforge-desktop-version=${app.getVersion()}`],
    };
  }
  async function openExternal(url, origin = serverUrl) {
    const checked = externalUrl(url, origin);
    if (!checked) return false;
    try { await shell.openExternal(checked); return true; } catch { return false; }
  }
  function configureSession(origin) {
    const partition = serverPartition(origin);
    if (configuredSessions.has(partition)) return;
    const target = session.fromPartition(partition);
    target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    target.setPermissionCheckHandler(() => false);
    configuredSessions.add(partition);
  }
  function guardWindow(window, origin) {
    const contents = window.webContents;
    windows.add(window);
    registeredContents.add(contents);
    contents.once("destroyed", () => { registeredContents.delete(contents); windows.delete(window); });
    contents.setZoomFactor(1);
    void contents.setVisualZoomLevelLimits(1, 1).catch(() => {});
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (url === "about:blank" || isTrustedUiUrl(url, origin)) {
        return { action: "allow", overrideBrowserWindowOptions: { webPreferences: webPreferences(origin) } };
      }
      void openExternal(url, origin);
      return { action: "deny" };
    });
    const guardNavigation = (event, url) => {
      if (url === "about:blank" || isTrustedUiUrl(url, origin)) return;
      event.preventDefault(); void openExternal(url, origin);
    };
    contents.on("will-navigate", guardNavigation);
    contents.on("will-redirect", (event, url) => {
      if (isTrustedUiUrl(url, origin)) return;
      event.preventDefault();
      if (window === mainWindow && state.status === "connecting") {
        cancelRetry();
        openConnectionSettings();
        publish({ status: "error", retryAt: null, message: "服务器跳转到了其他地址。请填写最终的服务器根地址后重新连接。" });
      } else { void openExternal(url, origin); }
    });
    contents.on("did-create-window", (child) => guardWindow(child, origin));
  }
  function openConnectionSettings() {
    if (quitting) return;
    if (connectionWindow && !connectionWindow.isDestroyed()) {
      connectionWindow.show(); connectionWindow.focus(); return;
    }
    const window = new BrowserWindow({
      width: 660, height: 630, minWidth: 480, minHeight: 550, title: "CrownForge · 连接服务器",
      autoHideMenuBar: false, backgroundColor: "#10161f", show: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
        webviewTag: false, partition: "crownforge-connection", preload: path.join(__dirname, "connection-preload.cjs"),
        additionalArguments: [`--crownforge-connection-page=${connectionPage}`] },
    });
    connectionWindow = window;
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const guard = (event, url) => { if (url !== connectionPage) event.preventDefault(); };
    window.webContents.on("will-navigate", guard);
    window.webContents.on("will-redirect", guard);
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    window.on("closed", () => {
      if (connectionWindow === window) connectionWindow = undefined;
      if (!mainWindow || mainWindow.isDestroyed() || state.status !== "connected") app.quit();
    });
    void window.loadURL(connectionPage).catch(() => app.quit());
  }
  function loaded(window, origin) {
    if (quitting || window !== mainWindow || origin !== serverUrl || !isTrustedUiUrl(window.webContents.getURL(), origin)) return;
    cancelRetry();
    publish({ status: "connected", message: "已连接服务器", retryAt: null, attempt: 0 });
    window.show(); window.focus(); connectionWindow?.hide();
  }
  function loadFailed(window, origin, error) {
    if (quitting || window !== mainWindow || origin !== serverUrl || retryTimer !== undefined || state.status === "error") return;
    const delay = RETRY_DELAYS[state.attempt];
    const description = String(error?.code || error?.message || "无法连接服务器").slice(0, 180);
    openConnectionSettings();
    if (delay === undefined) {
      publish({ status: "error", message: `无法连接服务器，请检查地址、网络或证书后重试。${description}`, retryAt: null });
      return;
    }
    const retryGeneration = generation;
    publish({ status: "retrying", message: `连接中断，正在等待重试。${description}`, retryAt: Date.now() + delay, attempt: state.attempt + 1 });
    retryTimer = timers.setTimeout(() => {
      retryTimer = undefined;
      if (!quitting && retryGeneration === generation && window === mainWindow) void loadRemote(window, origin);
    }, delay);
    retryTimer?.unref?.();
  }
  async function loadRemote(window, origin) {
    const loadGeneration = generation;
    publish({ status: "connecting", retryAt: null, message: "正在连接服务器…" });
    try {
      await window.loadURL(`${origin}/`);
      if (loadGeneration === generation && state.status !== "error") loaded(window, origin);
    } catch (error) {
      if (loadGeneration === generation && error?.code !== "ERR_ABORTED") loadFailed(window, origin, error);
    }
  }
  async function connect(value) {
    const origin = normalizeServerUrl(value);
    connectionStore.set(origin);
    cancelRetry(); generation += 1;
    if (origin !== serverUrl || !mainWindow || mainWindow.isDestroyed()) {
      mainWindow = undefined;
      for (const window of [...windows]) if (!window.isDestroyed()) window.destroy();
      serverUrl = origin;
      configureSession(origin);
      const window = new BrowserWindow({
        width: 1440, height: 900, minWidth: 900, minHeight: 640, title: "CrownForge", show: false,
        webPreferences: webPreferences(origin),
      });
      mainWindow = window; guardWindow(window, origin);
      window.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
        if (isMainFrame && code !== -3) loadFailed(window, origin, { message: description });
      });
      window.on("closed", () => { if (mainWindow === window) { mainWindow = undefined; app.quit(); } });
    }
    publish({ serverUrl: origin, attempt: 0, status: "connecting", message: "正在连接服务器…", retryAt: null });
    void loadRemote(mainWindow, origin);
    return snapshot();
  }
  function registerBridge() {
    ipcMain.handle("crownforge:connection:get", (event) => { authorizeConnection(event); return snapshot(); });
    ipcMain.handle("crownforge:connection:connect", (event, value) => { authorizeConnection(event); return connect(value); });
    ipcMain.handle("crownforge:connection:retry", (event) => {
      authorizeConnection(event);
      if (!serverUrl) throw new Error("请先填写服务器地址。");
      return connect(serverUrl);
    });
    ipcMain.handle("crownforge:connection:settings", (event) => { authorizeRemote(event); openConnectionSettings(); });
    ipcMain.handle("crownforge:preferences:get", (event) => { authorizeRemote(event); return preferencesFor(serverUrl).get(); });
    ipcMain.handle("crownforge:preferences:set", (event, patch) => { authorizeRemote(event); return preferencesFor(serverUrl).set(patch); });
    ipcMain.handle("crownforge:external:open", (event, value) => { authorizeRemote(event); return openExternal(value); });
  }
  function installMenu() {
    const template = createApplicationMenu(process.platform, (command, focused) => {
      const window = focused || BrowserWindow.getFocusedWindow();
      const contents = window?.webContents;
      if (contents && registeredContents.has(contents) && !contents.isDestroyed() && isTrustedUiUrl(contents.getURL(), serverUrl)) contents.send("crownforge:zoom", command);
    });
    template.splice(process.platform === "darwin" ? 1 : 0, 0, {
      label: "服务器", submenu: [{ label: "连接服务器…", accelerator: "CmdOrCtrl+Shift+S", click: openConnectionSettings }],
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }
  function start() {
    registerBridge(); installMenu(); openConnectionSettings();
    if (serverUrl) void connect(serverUrl).catch(() => {
      publish({ status: "error", message: "无法读取或保存服务器连接，请检查客户端数据目录权限后重试。", retryAt: null });
    });
  }
  function shutdown() { quitting = true; generation += 1; cancelRetry(); }
  return { start, shutdown, snapshot, connect, openConnectionSettings, webPreferences, guardWindow, registerBridge, installMenu,
    getMainWindow: () => mainWindow, getConnectionWindow: () => connectionWindow };
}

function startDesktop(electron) {
  const { app, dialog } = electron;
  if (process.platform === "win32") app.disableHardwareAcceleration();
  if (process.env.CREWFORGE_DESKTOP_DATA_DIR) {
    const directory = path.resolve(process.env.CREWFORGE_DESKTOP_DATA_DIR);
    fs.mkdirSync(directory, { recursive: true }); app.setPath("userData", directory);
  }
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  let runtime;
  app.on("second-instance", () => runtime?.openConnectionSettings());
  app.on("before-quit", () => runtime?.shutdown());
  app.on("window-all-closed", () => app.quit());
  app.whenReady().then(() => {
    runtime = createDesktopRuntime(electron); runtime.start();
  }).catch((error) => { dialog.showErrorBox("CrownForge 启动失败", error.message || String(error)); app.quit(); });
}

module.exports = { createDesktopRuntime, startDesktop };
// Electron loads the application entry through its own bootstrap. In newer
// releases it need not be Node's require.main; process.type is its public role.
if (process.type === "browser") startDesktop(require("electron"));
