const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
const origin = "http://127.0.0.1:43210";

function load(url, isMainFrame = true, trustedOrigin = origin) {
  let bridge;
  const calls = [];
  const ipcRenderer = new EventEmitter();
  ipcRenderer.invoke = (...args) => { calls.push(args); return Promise.resolve({ theme: "dark" }); };
  vm.runInNewContext(source, {
    require: (name) => {
      assert.equal(name, "electron");
      return { ipcRenderer, contextBridge: { exposeInMainWorld: (name, api) => { assert.equal(name, "crownforgeDesktop"); bridge = api; } } };
    },
    process: { platform: "darwin", isMainFrame, argv: [`--crownforge-desktop-origin=${trustedOrigin}`, "--crownforge-desktop-version=1.2.0"] },
    window: { location: { href: url } },
    URL,
  });
  return { bridge, calls, ipcRenderer };
}

test("sandboxed preload exposes a bounded API only in IDE and Vibe main pages", async () => {
  for (const url of [`${origin}/`, `${origin}/?vibe=1`, `${origin}/login`]) {
    const { bridge, calls } = load(url);
    assert.deepEqual(Object.keys(bridge).sort(), ["connectionMode", "getPreferences", "onZoomCommand", "openConnectionSettings", "openExternal", "platform", "serverUrl", "setPreferences", "version"]);
    assert.equal(bridge.platform, "darwin");
    assert.equal(bridge.version, "1.2.0");
    assert.equal(bridge.connectionMode, "remote");
    assert.equal(bridge.serverUrl, origin);
    await bridge.getPreferences();
    await bridge.setPreferences({ theme: "dark" });
    await bridge.openExternal("https://example.com/");
    await bridge.openConnectionSettings();
    assert.deepEqual(calls, [["crownforge:preferences:get"], ["crownforge:preferences:set", { theme: "dark" }], ["crownforge:external:open", "https://example.com/"], ["crownforge:connection:settings"]]);
  }
  for (const url of ["about:blank", `${origin}/preview/id/ticket/`, `${origin}/mobile`, `${origin}/api/config`, "https://example.com/", "http://127.0.0.1:43211/", "http://user@127.0.0.1:43210/"]) {
    assert.equal(load(url).bridge, undefined, url);
  }
  assert.equal(load(`${origin}/`, false).bridge, undefined);
});

test("remote origin bridge works for configured HTTPS and intranet servers without trusting other origins", () => {
  for (const trusted of ["https://ide.example.com", "http://192.168.1.5:3000"]) {
    assert.equal(load(`${trusted}/login`, true, trusted).bridge.serverUrl, trusted);
    assert.equal(load("https://other.example.com/", true, trusted).bridge, undefined);
    assert.equal(load(`${trusted}/preview/id/ticket/`, true, trusted).bridge, undefined);
    assert.equal(load(`${trusted}/`, false, trusted).bridge, undefined);
  }
});

test("zoom listener hides IPC events, validates commands and is removed on unsubscribe", () => {
  const { bridge, ipcRenderer } = load(`${origin}/`);
  const commands = [];
  const unsubscribe = bridge.onZoomCommand((...args) => commands.push(args));
  assert.equal(ipcRenderer.listenerCount("crownforge:zoom"), 1);
  const privilegedEvent = { sender: { nativeAccess: true } };
  ipcRenderer.emit("crownforge:zoom", privilegedEvent, "in");
  ipcRenderer.emit("crownforge:zoom", privilegedEvent, "invalid");
  assert.deepEqual(commands, [["in"]]);
  unsubscribe();
  ipcRenderer.emit("crownforge:zoom", privilegedEvent, "out");
  assert.equal(ipcRenderer.listenerCount("crownforge:zoom"), 0);
  assert.deepEqual(commands, [["in"]]);
  assert.throws(() => bridge.onZoomCommand(null), /Zoom callback/);
});
