#!/usr/bin/env node
// Production UI under a real insecure HTTP origin, with disposable API fixtures.
// Requires a local Chrome binary; no credentials or production service is used.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { WebSocket } = createRequire(path.join(root, "backend/package.json"))("ws");
const dist = path.resolve(process.env.OFFLINE_FRONTEND_DIST || path.join(root, "frontend/dist"));
const executable = process.env.CHROME_BINARY || (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "");
assert.ok(executable && fs.existsSync(executable), "Set CHROME_BINARY to a local Chrome executable");
assert.ok(fs.existsSync(path.join(dist, "index.html")), "Build the production frontend first");

const user = { username: "offline-fixture", workspaceDir: "/workspace", isAdmin: false, isolated: false, desktop: false };
const contentTypes = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const apiRequests = [];
const server = http.createServer((req, res) => {
  const route = new URL(req.url, "http://fixture.test").pathname;
  res.setHeader("Cache-Control", "no-store");
  if (route.startsWith("/api/")) {
    apiRequests.push({ method: req.method, route });
    res.setHeader("Content-Type", "application/json");
    if (route === "/api/auth/login" && req.method === "POST") res.end(JSON.stringify({ ...user, token: "fixture-parent" }));
    else if (route === "/api/auth/session/window" && req.method === "POST") res.end(JSON.stringify({ ...user, token: "fixture-child" }));
    else if (route === "/api/auth/me" && req.headers.authorization) res.end(JSON.stringify({ ...user, token: "fixture-parent" }));
    else if (route === "/api/auth/me") { res.writeHead(401); res.end('{"error":"Unauthorized"}'); }
    else if (route === "/api/plugins") res.end('{"plugins":[],"overrides":{}}');
    else { res.writeHead(503); res.end('{"error":"Unavailable in the offline browser fixture"}'); }
    return;
  }
  const target = route === "/login" || route === "/" ? path.join(dist, "index.html") : path.resolve(dist, "." + route);
  if (!target.startsWith(dist + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { res.writeHead(404).end(); return; }
  res.setHeader("Content-Type", contentTypes[path.extname(target)] || "application/octet-stream");
  fs.createReadStream(target).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://crownforge-offline.test:${server.address().port}`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-offline-http-"));
const chrome = spawn(executable, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions",
  "--no-proxy-server", "--host-resolver-rules=MAP crownforge-offline.test 127.0.0.1", "--window-size=1440,1000", "about:blank"], { stdio: "ignore" });
let launchError;
chrome.once("error", (error) => { launchError = error; });
let socket, nextId = 0, sessionId;
const pending = new Map();
const errors = [], externalRequests = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(probe, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await Promise.resolve().then(probe).catch(() => false);
    if (result) return result;
    await pause(80);
  }
  throw new Error(`${label} timed out${errors.length ? ": " + errors[0] : ""}`);
}
function send(method, params = {}, session = sessionId) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
async function assertWorkbench() {
  await until(() => evaluate("Boolean(document.querySelector('.app .titlebar'))"), "Workbench render");
  const tabs = await until(async () => {
    const stored = await evaluate("JSON.parse(sessionStorage.getItem('crewforge-terminal-tabs:/workspace') || '[]')");
    return stored.length > 0 ? stored : false;
  }, "Terminal initialization");
  assert.match(tabs[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  await until(() => evaluate(`Boolean(document.getElementById(${JSON.stringify("terminal-tab-" + tabs[0].id)}))`), "Terminal tab render");
  return tabs[0].id;
}

try {
  const activePort = path.join(profile, "DevToolsActivePort");
  const port = await until(() => {
    if (launchError) throw launchError;
    return fs.existsSync(activePort) && fs.readFileSync(activePort, "utf8").split("\n")[0];
  }, "Chrome startup");
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result || {});
    } else if (message.sessionId === sessionId) {
      if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      if (message.method === "Fetch.requestPaused") {
        const { requestId, request } = message.params;
        if (request.url.startsWith(origin + "/") || request.url.startsWith("data:") || request.url.startsWith("blob:")) {
          void send("Fetch.continueRequest", { requestId }).catch((error) => {
            // Reload may cancel a paused request before Chrome processes its continuation.
            if (error.message !== "Invalid InterceptionId.") errors.push(error.message);
          });
        } else {
          externalRequests.push(request.url);
          void send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch((error) => errors.push(error.message));
        }
      }
    }
  });
  const { browserContextId } = await send("Target.createBrowserContext");
  const { targetId } = await send("Target.createTarget", { url: "about:blank", browserContextId });
  ({ sessionId } = await send("Target.attachToTarget", { targetId, flatten: true }));
  await send("Runtime.enable"); await send("Page.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `
    // Transport behavior is outside this UI regression; never open a terminal or Agent session.
    window.WebSocket = class { static OPEN = 1; static CONNECTING = 0; static CLOSED = 3;
      readyState = 3; close() {} send() {} addEventListener() {} removeEventListener() {} };
  ` });
  await send("Page.navigate", { url: origin + "/login" });
  await until(() => evaluate("Boolean(document.querySelector('#login-username'))"), "Login form");
  const capabilities = await evaluate("({ secure: isSecureContext, randomUUID: typeof crypto.randomUUID, subtle: typeof crypto.subtle, getRandomValues: typeof crypto.getRandomValues })");
  assert.deepEqual(capabilities, { secure: false, randomUUID: "undefined", subtle: "undefined", getRandomValues: "function" });
  await evaluate(`
    for (const [id, value] of [['login-username', 'offline-fixture'], ['login-password', 'fixture-only']]) {
      const input = document.getElementById(id);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  `);
  await until(() => evaluate("!document.querySelector('.login-btn').disabled"), "Login enabled");
  await evaluate("document.querySelector('.login-btn').click()");
  const terminalId = await assertWorkbench();
  const firstDocument = await evaluate("performance.timeOrigin");
  await send("Page.reload", { ignoreCache: true });
  await until(async () => (await evaluate("performance.timeOrigin")) !== firstDocument, "Reloaded document");
  assert.equal(await assertWorkbench(), terminalId, "Reload must preserve the terminal tab");
  await pause(500);
  assert.deepEqual(errors, [], "No uncaught browser exceptions");
  assert.deepEqual(externalRequests, [], "No external assets may be requested");
  assert.ok(apiRequests.some(({ method, route }) => method === "POST" && route === "/api/auth/login"), "Login transition was exercised");
  if (process.env.OFFLINE_SCREENSHOT) {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(process.env.OFFLINE_SCREENSHOT, Buffer.from(data, "base64"));
  }
  console.log(JSON.stringify({ passed: true, capabilities, checks: ["production_build", "insecure_http_origin", "login_to_workbench", "terminal_uuid", "authenticated_reload", "no_external_assets", "no_uncaught_exceptions"], limitations: ["Authentication and transport are local fixtures; production login and terminal connectivity are not exercised."] }));
} catch (error) {
  console.error(JSON.stringify({ passed: false, error: error.message, errors, externalRequests }));
  process.exitCode = 1;
} finally {
  socket?.close();
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Browser fixture closed")); }
  chrome.kill("SIGTERM");
  if (chrome.exitCode === null && chrome.signalCode === null && !launchError) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => { chrome.kill("SIGKILL"); resolve(); }, 5000);
      chrome.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  fs.rmSync(profile, { recursive: true, force: true });
}
