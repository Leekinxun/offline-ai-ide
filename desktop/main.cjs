const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createPreferencesStore } = require("./preferences.cjs");
const { isTrustedUiUrl, isTrustedSender, externalUrl, createApplicationMenu } = require("./bridge-policy.cjs");

if (process.platform === "win32") {
  app.disableHardwareAcceleration();
}

if (process.env.CREWFORGE_DESKTOP_DATA_DIR) {
  const userData = path.resolve(process.env.CREWFORGE_DESKTOP_DATA_DIR);
  fs.mkdirSync(userData, { recursive: true });
  app.setPath("userData", userData);
}

const isPrimaryInstance = app.requestSingleInstanceLock();
let backend;
let backendUrl;
let mainWindow;
let quitting = false;
let folderPickerOpen = false;
const registeredContents = new Set();

if (!isPrimaryInstance) app.quit();

function bundledPath(name) {
  return path.join(app.isPackaged ? process.resourcesPath : path.resolve(__dirname, ".."), name);
}

function ensureDesktopData() {
  const dataDir = app.getPath("userData");
  const workspaceDir = path.join(dataDir, "workspace");
  const pluginsDir = path.join(dataDir, "plugins");
  const usersPath = path.join(dataDir, "users.json");
  fs.mkdirSync(workspaceDir, { recursive: true });
  if (!fs.existsSync(pluginsDir)) {
    const bundledPlugins = bundledPath("plugins");
    if (fs.existsSync(bundledPlugins)) fs.cpSync(bundledPlugins, pluginsDir, { recursive: true });
    else fs.mkdirSync(pluginsDir, { recursive: true });
  }

  let initialPassword;
  if (!fs.existsSync(usersPath)) {
    initialPassword = crypto.randomBytes(18).toString("base64url");
    const users = {
      allowedRoots: [app.getPath("home"), workspaceDir],
      pendingRegistrations: [],
      users: [{
        username: "admin",
        password: initialPassword,
        defaultWorkspace: workspaceDir,
        isAdmin: true,
      }],
    };
    try {
      fs.writeFileSync(usersPath, `${JSON.stringify(users, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      initialPassword = undefined;
    }
  }
  return { dataDir, workspaceDir, pluginsDir, usersPath, initialPassword };
}

function startBackend(data) {
  return new Promise((resolve, reject) => {
    const bootstrapPath = bundledPath(path.join("backend", "bootstrap.cjs"));
    const staticDir = bundledPath(app.isPackaged ? "frontend" : path.join("frontend", "dist"));
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      CREWFORGE_DESKTOP: "1",
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: "0",
      WORKSPACE_DIR: data.workspaceDir,
      USERS_CONFIG: data.usersPath,
      APP_SETTINGS_CONFIG: path.join(data.dataDir, "app-settings.json"),
      TEAM_STORE_ROOT: data.dataDir,
      PLUGINS_DIR: data.pluginsDir,
      STATIC_DIR: staticDir,
      VLLM_API_URL: process.env.VLLM_API_URL || "http://127.0.0.1:8000/v1",
    };
    const child = spawn(process.execPath, [bootstrapPath], {
      cwd: data.dataDir,
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    backend = child;
    let settled = false;
    let startupFailed = false;
    const timeout = setTimeout(() => fail(new Error("本地服务启动超时")), 30000);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      startupFailed = true;
      clearTimeout(timeout);
      child.kill();
      reject(error);
    };
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", fail);
    child.on("exit", (code) => {
      if (!settled) fail(new Error(`本地服务提前退出（代码 ${code ?? "unknown"}）`));
      else if (!quitting && !startupFailed) {
        dialog.showErrorBox("CrownForge", "本地服务已停止，请重新启动应用。");
        app.quit();
      }
    });
    child.on("message", (message) => {
      if (message && message.type === "ready" && /^http:\/\/127\.0\.0\.1:\d+$/.test(message.url || "")) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(message.url);
      } else if (message && message.type === "error") {
        fail(new Error(`本地服务启动失败（${message.phase || "startup"}: ${message.code || "unknown"}）`));
      } else if (message && message.type === "desktop-pick-folder") {
        void handleFolderPickerRequest(child, message);
      }
    });
  });
}

function sendFolderPickerResult(child, requestId, result) {
  if (!child.connected || !requestId) return;
  child.send({ type: "desktop-pick-folder-result", requestId, ...result });
}

function normalizeDefaultPath(defaultPath) {
  if (typeof defaultPath !== "string" || !defaultPath.trim()) return undefined;
  return path.resolve(defaultPath);
}

async function handleFolderPickerRequest(child, message) {
  const requestId = typeof message.requestId === "string" ? message.requestId : "";
  if (!requestId) return;
  if (child !== backend) {
    sendFolderPickerResult(child, requestId, { path: null, error: "INVALID_BACKEND_PROCESS" });
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    sendFolderPickerResult(child, requestId, { path: null, error: "MAIN_WINDOW_UNAVAILABLE" });
    return;
  }
  if (folderPickerOpen) {
    sendFolderPickerResult(child, requestId, { path: null, error: "FOLDER_PICKER_BUSY" });
    return;
  }

  const properties = ["openDirectory"];
  if (process.platform === "darwin") properties.push("createDirectory");

  folderPickerOpen = true;
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties,
      defaultPath: normalizeDefaultPath(message.defaultPath),
    });
    const selectedPath = result.canceled ? null : result.filePaths[0] || null;
    sendFolderPickerResult(child, requestId, { path: selectedPath });
  } catch (error) {
    sendFolderPickerResult(child, requestId, {
      path: null,
      error: error && error.message ? error.message : String(error),
    });
  } finally {
    folderPickerOpen = false;
  }
}

function desktopWebPreferences() {
  return {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    preload: path.join(__dirname, "preload.cjs"),
    additionalArguments: [`--crownforge-desktop-origin=${backendUrl}`, `--crownforge-desktop-version=${app.getVersion()}`],
  };
}

async function openExternal(url) {
  const checked = externalUrl(url, backendUrl);
  if (!checked) return false;
  try {
    await shell.openExternal(checked);
    return true;
  } catch {
    return false;
  }
}

function registerDesktopBridge(preferences) {
  const authorize = (event) => {
    if (!isTrustedSender(event, backendUrl, registeredContents)) throw new Error("Unauthorized desktop request");
  };
  ipcMain.handle("crownforge:preferences:get", (event) => {
    authorize(event);
    return preferences.get();
  });
  ipcMain.handle("crownforge:preferences:set", (event, patch) => {
    authorize(event);
    return preferences.set(patch);
  });
  ipcMain.handle("crownforge:external:open", (event, url) => {
    authorize(event);
    return openExternal(url);
  });
}

function installApplicationMenu() {
  const template = createApplicationMenu(process.platform, (command, focusedWindow) => {
    const window = focusedWindow || BrowserWindow.getFocusedWindow();
    if (!window || window.isDestroyed()) return;
    const contents = window.webContents;
    if (registeredContents.has(contents) && !contents.isDestroyed() && isTrustedUiUrl(contents.getURL(), backendUrl)) {
      contents.send("crownforge:zoom", command);
    }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function guardWindow(window) {
  const contents = window.webContents;
  registeredContents.add(contents);
  contents.once("destroyed", () => registeredContents.delete(contents));
  contents.setZoomFactor(1);
  void contents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url === "about:blank" || isTrustedUiUrl(url, backendUrl)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          webPreferences: desktopWebPreferences(),
        },
      };
    }
    void openExternal(url);
    return { action: "deny" };
  });
  const guardNavigation = (event, url) => {
    if (url === "about:blank" || isTrustedUiUrl(url, backendUrl)) return;
    event.preventDefault();
    void openExternal(url);
  };
  window.webContents.on("will-navigate", guardNavigation);
  window.webContents.on("will-redirect", guardNavigation);
  window.webContents.on("did-create-window", (childWindow) => guardWindow(childWindow));
}

async function showInitialPassword(password) {
  if (!password) return;
  const choice = dialog.showMessageBoxSync({
    type: "info",
    title: "CrownForge 首次启动",
    message: "已创建本机管理员账号 admin",
    detail: `初始密码：${password}\n\n请保存密码。登录后可以在设置中修改。`,
    buttons: ["复制密码并继续", "继续"],
    defaultId: 0,
    noLink: true,
  });
  if (choice === 0) {
    try {
      await Promise.resolve(clipboard.writeText(password));
    } catch {
      dialog.showMessageBoxSync({
        type: "warning",
        title: "复制失败",
        message: "无法复制初始密码，请手动保存",
        detail: `初始密码：${password}`,
        buttons: ["继续"],
      });
    }
  }
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on("before-quit", () => {
  quitting = true;
  if (!backend || backend.killed) return;
  if (backend.connected) backend.send({ type: "shutdown" });
  const forceStop = setTimeout(() => backend?.kill(), 3000);
  forceStop.unref?.();
});

if (isPrimaryInstance) {
  app.whenReady().then(async () => {
    try {
      const data = ensureDesktopData();
      backendUrl = await startBackend(data);
      registerDesktopBridge(createPreferencesStore(path.join(data.dataDir, "preferences.json")));
      installApplicationMenu();
      mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 900,
        minHeight: 640,
        title: "CrownForge",
        show: true,
        webPreferences: desktopWebPreferences(),
      });
      guardWindow(mainWindow);
      await mainWindow.loadURL(backendUrl);
      mainWindow.show();
      mainWindow.focus();
      mainWindow.on("closed", () => {
        mainWindow = undefined;
        app.quit();
      });
    } catch (error) {
      dialog.showErrorBox("CrownForge 启动失败", error.message || String(error));
      app.quit();
    }
  });
}
