const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");
const source = fs.readFileSync(path.join(__dirname, "connection-preload.cjs"), "utf8");
const page = pathToFileURL(path.join(__dirname, "connection.html")).href;

function load(url, isMainFrame = true) {
  let bridge;
  const calls = [];
  const ipcRenderer = new EventEmitter();
  ipcRenderer.invoke = (...args) => { calls.push(args); return Promise.resolve({}); };
  vm.runInNewContext(source, {
    require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld: (_name, api) => { bridge = api; } } }),
    process: { isMainFrame, argv: [`--crownforge-connection-page=${page}`] },
    window: { location: { href: url } },
  });
  return { bridge, calls, ipcRenderer };
}

test("connection configuration bridge exists only on the exact packaged main page", async () => {
  for (const value of ["https://ide.example.com/", "file:///tmp/connection.html", `${page}?other=1`, `${page}#other`]) assert.equal(load(value).bridge, undefined);
  assert.equal(load(page, false).bridge, undefined);
  const { bridge, calls, ipcRenderer } = load(page);
  await bridge.getState(); await bridge.connect("https://ide.example.com"); await bridge.retry();
  assert.deepEqual(calls, [["crownforge:connection:get"], ["crownforge:connection:connect", "https://ide.example.com"], ["crownforge:connection:retry"]]);
  const received = [];
  const unsubscribe = bridge.onState((...args) => received.push(args));
  ipcRenderer.emit("crownforge:connection:state", { privileged: true }, { status: "connecting" });
  assert.deepEqual(received, [[{ status: "connecting" }]]);
  unsubscribe(); assert.equal(ipcRenderer.listenerCount("crownforge:connection:state"), 0);
});
