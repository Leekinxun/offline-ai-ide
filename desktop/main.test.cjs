const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { createDesktopRuntime } = require("./main.cjs");
const { serverPartition } = require("./connection.cjs");

const origin = "https://ide.example.com";
const preview = `${origin}/preview/12345678-abcd-1234-abcd-123456789abc/${"a".repeat(64)}/`;
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("Electron bootstrap runs the entry even when it is not Node require.main", () => {
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  let checks = 0;
  let quits = 0;
  const moduleObject = { exports: {} };
  const mockRequire = (name) => name === "electron" ? { app: {
    requestSingleInstanceLock: () => { checks += 1; return false; }, quit: () => { quits += 1; },
  } } : name.startsWith("./") ? require(path.join(__dirname, name)) : require(name);
  mockRequire.main = { differentModule: true };
  vm.runInNewContext(source, { require: mockRequire, module: moduleObject, __dirname,
    process: { type: "browser", platform: "linux", env: {} }, setTimeout, clearTimeout, URL });
  assert.equal(checks, 1); assert.equal(quits, 1);
  assert.equal(typeof moduleObject.exports.createDesktopRuntime, "function");
});

function fixture(savedUrl = null) {
  const handlers = new Map();
  const windows = [];
  const sessions = new Map();
  const externalCalls = [];
  const pendingTimers = new Map();
  const preferenceFiles = new Map();
  const loadOutcomes = [];
  let quitCount = 0;
  let menu;
  const app = new EventEmitter();
  app.getPath = () => "/fixture/user-data";
  app.getVersion = () => "1.2.0";
  app.quit = () => { quitCount += 1; };
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.visible = options.show; this.destroyed = false;
      const contents = new EventEmitter();
      contents.mainFrame = { url: "about:blank" };
      contents.getURL = () => contents.mainFrame.url;
      contents.isDestroyed = () => this.destroyed;
      contents.setWindowOpenHandler = (handler) => { contents.windowOpenHandler = handler; };
      contents.setZoomFactor = (factor) => { contents.zoomFactor = factor; };
      contents.setVisualZoomLevelLimits = async () => {};
      contents.messages = [];
      contents.send = (...args) => contents.messages.push(args);
      this.webContents = contents; this.loads = [];
      windows.push(this);
    }
    loadURL(url) {
      this.loads.push(url); this.webContents.mainFrame.url = url;
      if (url.startsWith("file:")) return Promise.resolve();
      const outcome = loadOutcomes.shift();
      if (outcome instanceof Error) {
        this.webContents.emit("did-fail-load", {}, -102, outcome.message, url, true);
        return Promise.reject(outcome);
      }
      return outcome || Promise.resolve();
    }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() { this.focused = true; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.webContents.emit("destroyed"); this.emit("closed"); }
  }
  Window.getFocusedWindow = () => null;
  const connectionStore = { get: () => ({ serverUrl: savedUrl }), set: (value) => { savedUrl = value; } };
  const electron = {
    app, BrowserWindow: Window,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    Menu: { buildFromTemplate: (value) => value, setApplicationMenu: (value) => { menu = value; } },
    shell: { openExternal: async (url) => { externalCalls.push(url); } },
    session: { fromPartition: (name) => {
      if (!sessions.has(name)) sessions.set(name, {
        setPermissionRequestHandler(handler) { this.requestPermission = handler; },
        setPermissionCheckHandler(handler) { this.checkPermission = handler; },
      });
      return sessions.get(name);
    } },
  };
  const runtime = createDesktopRuntime(electron, {
    connectionStore,
    timers: { setTimeout: (callback, delay) => { const key = {}; pendingTimers.set(key, { callback, delay }); return key; }, clearTimeout: (key) => pendingTimers.delete(key) },
    createPreferencesStore: (file) => {
      const values = {};
      preferenceFiles.set(file, values);
      return { get: () => ({ ...values }), set: (patch) => Object.assign(values, patch) };
    },
  });
  return { runtime, handlers, windows, sessions, preferenceFiles, externalCalls, pendingTimers, loadOutcomes,
    quitCount: () => quitCount, getMenu: () => menu, savedUrl: () => savedUrl,
    runTimer: () => { const [key, value] = pendingTimers.entries().next().value; pendingTimers.delete(key); value.callback(); return value.delay; } };
}
const eventFor = (window) => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });

test("first launch stays on packaged configuration; remote startup loads shared server UI with no backend", async () => {
  const f = fixture(); f.runtime.start();
  assert.equal(f.windows.length, 1); assert.match(f.windows[0].loads[0], /\/connection\.html$/);
  assert.equal(f.runtime.snapshot().status, "disconnected");
  await f.handlers.get("crownforge:connection:connect")(eventFor(f.windows[0]), `${origin}/`); await tick();
  const remote = f.runtime.getMainWindow();
  assert.deepEqual(remote.loads, [`${origin}/`]); assert.equal(remote.visible, true);
  assert.equal(f.windows[0].visible, false); assert.equal(f.savedUrl(), origin);
  assert.equal(f.runtime.snapshot().status, "connected");
  const prefs = remote.options.webPreferences;
  assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.nodeIntegrationInSubFrames, false);
  assert.equal(prefs.webviewTag, false); assert.equal(prefs.partition, serverPartition(origin));
  assert.equal(prefs.additionalArguments.some((arg) => /token|password|bootstrap/i.test(arg)), false);
  assert.equal(f.handlers.has("crownforge:backend:shutdown"), false);
  const sess = f.sessions.get(serverPartition(origin));
  assert.equal(sess.checkPermission(), false);
  let permission; sess.requestPermission({}, "media", (value) => { permission = value; }); assert.equal(permission, false);
});

test("remote and packaged connection IPC have separate top-frame authorities", async () => {
  const f = fixture(origin); f.runtime.start(); await tick();
  const remote = f.runtime.getMainWindow(); const local = f.runtime.getConnectionWindow();
  const remoteEvent = eventFor(remote); const localEvent = eventFor(local);
  assert.deepEqual(f.handlers.get("crownforge:preferences:get")(remoteEvent), {});
  assert.throws(() => f.handlers.get("crownforge:connection:connect")(remoteEvent, "https://other.example.com"), /Unauthorized/);
  assert.throws(() => f.handlers.get("crownforge:preferences:set")(localEvent, { theme: "dark" }), /Unauthorized/);
  for (const event of [{ ...remoteEvent, senderFrame: { url: `${origin}/` } }, { ...remoteEvent, senderFrame: null }]) {
    assert.throws(() => f.handlers.get("crownforge:preferences:get")(event), /Unauthorized/);
  }
  remote.webContents.mainFrame.url = preview;
  assert.throws(() => f.handlers.get("crownforge:connection:settings")(remoteEvent), /Unauthorized/);
  remote.webContents.mainFrame.url = `${origin}/login`;
  f.handlers.get("crownforge:connection:settings")(remoteEvent); assert.equal(local.visible, true);
  remote.destroy(); assert.equal(f.quitCount(), 1);
  assert.throws(() => f.handlers.get("crownforge:preferences:get")(remoteEvent), /Unauthorized/);
});

test("server switch isolates browser partitions and native preferences, retaining them when returning", async () => {
  const f = fixture(origin); f.runtime.start(); await tick();
  const first = f.runtime.getMainWindow(); const firstEvent = eventFor(first);
  f.handlers.get("crownforge:preferences:set")(firstEvent, { theme: "dark" });
  await f.runtime.connect("http://192.168.1.5:3000"); await tick();
  const second = f.runtime.getMainWindow();
  assert.equal(first.destroyed, true); assert.equal(f.quitCount(), 0);
  assert.notEqual(first.options.webPreferences.partition, second.options.webPreferences.partition);
  assert.deepEqual(f.handlers.get("crownforge:preferences:get")(eventFor(second)), {});
  assert.throws(() => f.handlers.get("crownforge:preferences:get")(firstEvent), /Unauthorized/);
  await f.runtime.connect(origin); await tick();
  assert.equal(f.runtime.getMainWindow().options.webPreferences.partition, first.options.webPreferences.partition);
  assert.deepEqual(f.handlers.get("crownforge:preferences:get")(eventFor(f.runtime.getMainWindow())), { theme: "dark" });
});

test("network or certificate failures keep an actionable page and bounded backoff; retry can recover", async () => {
  const f = fixture(origin);
  for (let i = 0; i < 6; i += 1) f.loadOutcomes.push(Object.assign(new Error("ERR_CERT_AUTHORITY_INVALID"), { code: "ERR_CERT_AUTHORITY_INVALID" }));
  f.runtime.start(); await tick();
  assert.equal(f.runtime.getConnectionWindow().visible, true); assert.equal(f.runtime.getMainWindow().visible, false);
  assert.equal(f.runtime.snapshot().status, "retrying");
  const delays = [];
  while (f.pendingTimers.size) { delays.push(f.runTimer()); await tick(); }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 15000]);
  assert.equal(f.runtime.snapshot().status, "error"); assert.match(f.runtime.snapshot().message, /ERR_CERT_AUTHORITY_INVALID/);
  assert.equal(f.runtime.getMainWindow().loads.length, 6);
  await f.handlers.get("crownforge:connection:retry")(eventFor(f.runtime.getConnectionWindow())); await tick();
  assert.equal(f.runtime.snapshot().status, "connected"); assert.equal(f.runtime.getMainWindow().visible, true);
});

test("shutdown cancels pending retries and never communicates cancellation to the server", async () => {
  const f = fixture(origin); f.loadOutcomes.push(new Error("offline")); f.runtime.start(); await tick();
  const remote = f.runtime.getMainWindow(); assert.equal(f.pendingTimers.size, 1);
  const messages = remote.webContents.messages.length;
  f.runtime.shutdown(); assert.equal(f.pendingTimers.size, 0);
  remote.webContents.emit("did-fail-load", {}, -102, "offline", `${origin}/`, true); await tick();
  assert.equal(f.pendingTimers.size, 0); assert.equal(remote.loads.length, 1);
  assert.equal(remote.webContents.messages.length, messages);
});

test("stale loads after changing servers cannot hide settings or steal focus", async () => {
  const f = fixture(origin); let resolveFirst;
  f.loadOutcomes.push(new Promise((resolve) => { resolveFirst = resolve; }));
  f.runtime.start(); const first = f.runtime.getMainWindow();
  await f.runtime.connect("https://second.example.com"); await tick();
  resolveFirst(); await tick();
  assert.equal(first.destroyed, true); assert.equal(first.visible, false);
  assert.equal(f.runtime.snapshot().serverUrl, "https://second.example.com");
  assert.equal(f.runtime.snapshot().status, "connected");
});

test("a cross-origin startup redirect gives an actionable error instead of a stuck loading page", async () => {
  const f = fixture(origin); let rejectLoad;
  f.loadOutcomes.push(new Promise((_resolve, reject) => { rejectLoad = reject; }));
  f.runtime.start(); const remote = f.runtime.getMainWindow(); let prevented = false;
  remote.webContents.emit("will-redirect", { preventDefault: () => { prevented = true; } }, "https://another.example.com/login");
  rejectLoad(Object.assign(new Error("cancelled"), { code: "ERR_ABORTED" })); await tick();
  assert.equal(prevented, true); assert.equal(f.runtime.snapshot().status, "error");
  assert.match(f.runtime.snapshot().message, /最终的服务器根地址/);
  assert.equal(f.runtime.getConnectionWindow().visible, true); assert.equal(f.pendingTimers.size, 0);
});

test("popup policy keeps isolated UI windows sandboxed and routes validated previews externally", async () => {
  const f = fixture(origin); f.runtime.start(); await tick(); const remote = f.runtime.getMainWindow();
  for (const url of ["about:blank", `${origin}/?vibe=1`, `${origin}/login`]) {
    const result = remote.webContents.windowOpenHandler({ url });
    assert.equal(result.action, "allow"); assert.equal(result.overrideBrowserWindowOptions.webPreferences.partition, serverPartition(origin));
  }
  assert.equal(remote.webContents.windowOpenHandler({ url: preview }).action, "deny");
  assert.deepEqual(f.externalCalls, [preview]);
  let prevented = false;
  remote.webContents.emit("will-navigate", { preventDefault: () => { prevented = true; } }, "file:///etc/passwd");
  assert.equal(prevented, true); assert.deepEqual(f.externalCalls, [preview]);
  const zoom = f.getMenu().find((item) => item.label === "View").submenu.find((item) => item.label === "Zoom In");
  zoom.click({}, remote); assert.deepEqual(remote.webContents.messages, [["crownforge:zoom", "in"]]);
  assert.equal(f.getMenu().some((item) => item.label === "服务器"), true);
});
