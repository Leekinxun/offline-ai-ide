const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const origin = "http://127.0.0.1:43210";
const preview = `${origin}/preview/12345678-abcd-1234-abcd-123456789abc/${"a".repeat(64)}/`;

function fixture() {
  const handlers = new Map();
  const externalCalls = [];
  const headerListeners = [];
  const contentsById = new Map();
  const backendSpawns = [];
  let menu;
  const app = new EventEmitter();
  app.requestSingleInstanceLock = () => false;
  app.quit = () => {};
  app.getVersion = () => "1.2.0";
  const electron = {
    app,
    BrowserWindow: { getFocusedWindow: () => null },
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    Menu: { buildFromTemplate: (value) => value, setApplicationMenu: (value) => { menu = value; } },
    shell: { openExternal: async (url) => { externalCalls.push(url); } },
    session: { defaultSession: { webRequest: { onBeforeSendHeaders: (filter, listener) => headerListeners.push({ filter, listener }) } } },
    webContents: { fromId: (id) => contentsById.get(id) },
  };
  const sandbox = {
    require: (name) => name === "electron" ? electron : name === "node:child_process" ? { spawn: (executable, args, options) => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
      backendSpawns.push({ executable, args, options }); queueMicrotask(() => child.emit("message", { type: "ready", url: origin })); return child;
    } } : name.startsWith("./") ? require(path.join(__dirname, name)) : require(name),
    module: { exports: {} },
    __dirname,
    process: { platform: "linux", env: {}, execPath: "/fixture/electron", stdout: { write() {} }, stderr: { write() {} } },
    URL, setTimeout, clearTimeout,
  };
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  vm.runInNewContext(`${source}\nbackendUrl = ${JSON.stringify(origin)}; desktopBootstrapToken = "${"x".repeat(64)}"; module.exports = { guardWindow, registerDesktopBridge, installApplicationMenu, installBootstrapRequestHeaders, desktopWebPreferences, startBackend };`, sandbox);
  return { ...sandbox.module.exports, handlers, externalCalls, headerListeners, contentsById, backendSpawns, getMenu: () => menu };
}

function windowAt(url) {
  const contents = new EventEmitter();
  contents.mainFrame = { url };
  contents.getURL = () => contents.mainFrame.url;
  contents.isDestroyed = () => false;
  contents.setWindowOpenHandler = (handler) => { contents.windowOpenHandler = handler; };
  contents.setZoomFactor = (factor) => { contents.zoomFactor = factor; };
  contents.setVisualZoomLevelLimits = async (minimum, maximum) => { contents.visualZoom = [minimum, maximum]; };
  contents.messages = [];
  contents.send = (...args) => contents.messages.push(args);
  return { webContents: contents, isDestroyed: () => false };
}

test("main IPC validates the real sender before preferences or external actions", async () => {
  const runtime = fixture();
  const preferences = { theme: "light" };
  runtime.registerDesktopBridge({ get: () => ({ ...preferences }), set: (patch) => Object.assign(preferences, patch) });
  const window = windowAt(`${origin}/`);
  runtime.guardWindow(window);
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  assert.deepEqual(runtime.handlers.get("crownforge:preferences:get")(event), { theme: "light" });
  runtime.handlers.get("crownforge:preferences:set")(event, { theme: "dark" });
  assert.equal(preferences.theme, "dark");
  assert.equal(await runtime.handlers.get("crownforge:external:open")(event, preview), true);
  assert.deepEqual(runtime.externalCalls, [preview]);
  for (const badEvent of [{ ...event, senderFrame: { url: `${origin}/` } }, { ...event, senderFrame: null }]) {
    for (const callback of runtime.handlers.values()) assert.throws(() => callback(badEvent, { theme: "light" }), /Unauthorized/);
  }
  window.webContents.mainFrame.url = preview;
  assert.throws(() => runtime.handlers.get("crownforge:preferences:set")(event, { theme: "light" }), /Unauthorized/);
  assert.equal(preferences.theme, "dark");
  assert.deepEqual(runtime.externalCalls, [preview]);
  window.webContents.mainFrame.url = `${origin}/`;
  window.webContents.emit("destroyed");
  assert.throws(() => runtime.handlers.get("crownforge:preferences:get")(event), /Unauthorized/);
});

test("popup policy preserves Vibe windows while opening ticketed previews outside Electron", async () => {
  const runtime = fixture();
  const parent = windowAt(`${origin}/`);
  runtime.guardWindow(parent);
  assert.equal(parent.webContents.zoomFactor, 1);
  assert.deepEqual(parent.webContents.visualZoom, [1, 1]);
  for (const url of ["about:blank", `${origin}/?vibe=1`, `${origin}/login`]) {
    const result = parent.webContents.windowOpenHandler({ url });
    assert.equal(result.action, "allow");
    const prefs = result.overrideBrowserWindowOptions.webPreferences;
    assert.equal(prefs.sandbox, true);
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.nodeIntegrationInSubFrames, false);
    assert.equal(prefs.preload, path.join(__dirname, "preload.cjs"));
    assert.ok(prefs.additionalArguments.includes(`--crownforge-desktop-origin=${origin}`));
  }
  assert.equal(parent.webContents.windowOpenHandler({ url: preview }).action, "deny");
  assert.deepEqual(runtime.externalCalls, [preview]);
  assert.equal(parent.webContents.windowOpenHandler({ url: "http://localhost:8000/" }).action, "deny");
  assert.deepEqual(runtime.externalCalls, [preview]);
  const child = windowAt(`${origin}/?vibe=1`);
  parent.webContents.emit("did-create-window", child);
  runtime.registerDesktopBridge({ get: () => ({ theme: "dark" }) });
  const event = { sender: child.webContents, senderFrame: child.webContents.mainFrame };
  assert.deepEqual(runtime.handlers.get("crownforge:preferences:get")(event), { theme: "dark" });
  let prevented = false;
  child.webContents.emit("will-navigate", { preventDefault: () => { prevented = true; } }, preview);
  assert.equal(prevented, true);
  assert.deepEqual(runtime.externalCalls, [preview, preview]);
});

test("menu commands go only to a trusted focused IDE window", () => {
  const runtime = fixture();
  runtime.installApplicationMenu();
  const window = windowAt(`${origin}/?vibe=1`);
  runtime.guardWindow(window);
  const zoomIn = runtime.getMenu().find((item) => item.label === "View").submenu.find((item) => item.label === "Zoom In");
  zoomIn.click({}, window);
  assert.deepEqual(window.webContents.messages, [["crownforge:zoom", "in"]]);
  window.webContents.mainFrame.url = preview;
  zoomIn.click({}, window);
  assert.equal(window.webContents.messages.length, 1);
});

test("private bootstrap headers reach only the registered IDE main-frame auth endpoint", () => {
  const runtime = fixture(); const window = windowAt(`${origin}/`); runtime.guardWindow(window);
  runtime.contentsById.set(7, window.webContents); runtime.installBootstrapRequestHeaders();
  const listener = runtime.headerListeners[0].listener;
  const details = { url: `${origin}/api/auth/me`, method: "GET", webContentsId: 7, frame: window.webContents.mainFrame, initiatorOrigin: origin,
    requestHeaders: { "x-crownforge-desktop-bootstrap": "spoofed", "Content-Type": "application/json" } };
  const request = (patch = {}) => { let response; listener({ ...details, ...patch }, (value) => { response = value; }); return response.requestHeaders; };
  assert.equal(request()["X-CrownForge-Desktop-Bootstrap"], "x".repeat(64));
  assert.equal(request()["x-crownforge-desktop-bootstrap"], undefined);
  for (const patch of [
    { method: "POST" }, { url: `${origin}/api/admin/settings` }, { url: `${origin}/api/auth/me?extra=1` },
    { url: "https://outside.example/api/auth/me" }, { url: "http://127.0.0.1:1/api/auth/me" },
    { url: `${origin}/preview/project/api/auth/me` }, { webContentsId: 99 }, { frame: null },
    { frame: { url: `${origin}/` } }, { initiatorOrigin: "https://outside.example" }, { initiatorOrigin: "null" },
  ]) assert.equal(Object.keys(request(patch)).some((key) => key.toLowerCase() === "x-crownforge-desktop-bootstrap"), false, JSON.stringify(patch));
  window.webContents.mainFrame.url = preview;
  assert.equal(Object.keys(request()).some((key) => key.toLowerCase() === "x-crownforge-desktop-bootstrap"), false);
  window.webContents.mainFrame.url = `${origin}/`; window.webContents.emit("destroyed");
  assert.equal(Object.keys(request()).some((key) => key.toLowerCase() === "x-crownforge-desktop-bootstrap"), false);
  const argumentsList = runtime.desktopWebPreferences().additionalArguments.join(" ");
  assert.equal(argumentsList.includes("x".repeat(64)), false, "Renderer process arguments must not contain host bootstrap authority");
});

test("Electron host gives each backend a fresh private bootstrap secret without exposing it to renderer arguments", async () => {
  const runtime = fixture(); const data = { dataDir: "/fixture/data", workspaceDir: "/fixture/project", usersPath: "/fixture/data/users.json", pluginsDir: "/fixture/plugins" };
  assert.equal(await runtime.startBackend(data), origin); assert.equal(await runtime.startBackend(data), origin);
  const secrets = runtime.backendSpawns.map((entry) => entry.options.env.CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN);
  for (const secret of secrets) assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(secrets[0], secrets[1]);
  for (const entry of runtime.backendSpawns) {
    assert.equal(entry.options.env.CREWFORGE_DESKTOP, "1"); assert.equal(entry.options.env.CROWNFORGE_DESKTOP_RUNTIME, "electron");
    assert.equal(entry.args.join(" ").includes(entry.options.env.CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN), false);
  }
  for (const secret of secrets) assert.equal(runtime.desktopWebPreferences().additionalArguments.join(" ").includes(secret), false);
});
