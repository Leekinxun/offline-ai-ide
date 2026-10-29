#!/usr/bin/env node
// Owns every Electron, server, socket and data directory it touches. No real model or user profile is used.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(root, "desktop");
const require = createRequire(path.join(root, "backend/package.json"));
const { WebSocket } = require("ws");
const options = { app: null, artifacts: path.join(root, ".artifacts/remote-desktop-smoke") };
for (let i = 2; i < process.argv.length; i++) {
  const option = process.argv[i];
  if (["--app", "--artifacts"].includes(option) && process.argv[i + 1]) options[option.slice(2)] = path.resolve(process.argv[++i]);
  else if (option === "--help") {
    console.log("node scripts/remote-desktop-smoke.mjs [--app /path/CrownForge.app|CrownForge.exe] [--artifacts /path/results]");
    process.exit(0);
  } else throw new Error(`Unknown or incomplete option: ${option}`);
}
const mode = options.app ? "packaged" : "dev";
const fixture = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-remote-smoke-")));
const serverData = path.join(fixture, "server");
const clientData = path.join(fixture, "client");
const workspace = path.join(serverData, "workspace");
const username = "remote-fixture";
const password = crypto.randomBytes(18).toString("base64url");
const marker = "REMOTE_DESKTOP_BACKGROUND_RESULT_82639";
const report = { mode, startedAt: new Date().toISOString(), status: "running", checks: [], screenshots: [], providerRequests: 0, blockedExternalRequests: [] };
fs.mkdirSync(options.artifacts, { recursive: true });
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let app, backend, proxy, model, backendOrigin, origin, releaseModel;
let backendLog = "";
let allowWebSockets = true;
let authUnavailable = false;
let chatUpgrades = 0;
const proxySockets = new Set();
const modelResponses = new Set();

function safeMessage(value) {
  return String(value?.message || value).replace(/([?&]token=)[^&\s"']+/g, "$1[redacted]").replace(/Bearer\s+\S+/g, "Bearer [redacted]").slice(-4000);
}
async function until(probe, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    if (app?.exceptions.length) throw new Error(`Renderer exception: ${app.exceptions[0]}`);
    if (app && app.child.exitCode !== null) throw new Error(`Owned Electron exited: ${safeMessage(app.log)}`);
    if (backend && backend.exitCode !== null) throw new Error(`Fixture server exited: ${safeMessage(backendLog)}`);
    try { const result = await probe(); if (result) return result; } catch (error) { lastError = error; }
    await sleep(80);
  }
  throw new Error(`Timed out: ${label}${lastError ? ` (${safeMessage(lastError)})` : ""}`);
}
async function check(name, run) {
  const started = Date.now();
  try {
    const evidence = await run();
    report.checks.push({ name, status: "passed", durationMs: Date.now() - started, ...(evidence === undefined ? {} : { evidence }) });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, status: "failed", durationMs: Date.now() - started, error: safeMessage(error) });
    throw error;
  }
}

class CDP {
  constructor(socket, owner) {
    this.socket = socket; this.owner = owner; this.counter = 0; this.pending = new Map();
    socket.on("message", (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.id) {
        const pending = this.pending.get(event.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(event.id);
        if (event.error) pending.reject(new Error(event.error.message)); else pending.resolve(event.result || {});
      } else if (event.method === "Runtime.exceptionThrown") {
        owner.exceptions.push(safeMessage(event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text));
      } else if (event.method === "Fetch.requestPaused") {
        const url = new URL(event.params.request.url);
        const allowed = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
        if (!allowed) report.blockedExternalRequests.push(`${url.origin}${url.pathname}`);
        void this.send(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", {
          requestId: event.params.requestId, ...(!allowed ? { errorReason: "BlockedByClient" } : {}),
        }, event.sessionId).catch((error) => {
          // A document navigation can cancel a paused request before CDP resumes
          // it. That is a discarded fixture interception, not a page exception.
          if (!/Invalid InterceptionId|Invalid interceptionId/i.test(error.message)) owner.exceptions.push(safeMessage(error));
        });
      }
    });
    socket.on("close", () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Owned Electron CDP closed")); }
      this.pending.clear();
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15_000);
      this.pending.set(id, { timer, resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}
async function attachPage(predicate, label) {
  const target = await until(async () => {
    const { targetInfos } = await app.cdp.send("Target.getTargets");
    app.targets = targetInfos.map(({ type, url }) => ({ type, url: url.split("?")[0] }));
    const matches = targetInfos.filter((target) => target.type === "page" && predicate(target.url));
    assert.ok(matches.length <= 1, `Ambiguous owned ${label}`);
    return matches[0];
  }, label);
  const attached = await app.cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  app.sessionId = attached.sessionId; app.targetId = target.targetId;
  await app.cdp.send("Runtime.enable", {}, app.sessionId);
  await app.cdp.send("Page.enable", {}, app.sessionId);
  await app.cdp.send("Fetch.enable", { patterns: [{ urlPattern: "http://*" }, { urlPattern: "https://*" }] }, app.sessionId);
}
async function evaluate(expression) {
  const result = await app.cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, app.sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
const call = (fn, ...args) => evaluate(`(${fn.toString()})(${args.map((value) => JSON.stringify(value)).join(",")})`);
async function click(selector) {
  const point = await until(() => call(async (query) => {
    const element = document.querySelector(query);
    if (!element || element.disabled) return null;
    element.scrollIntoView({ block: "center", inline: "center" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = element.getBoundingClientRect(); const x = rect.x + rect.width / 2; const y = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return rect.width && rect.height && (hit === element || element.contains(hit)) ? { x, y } : null;
  }, selector), `clickable ${selector}`);
  for (const type of ["mousePressed", "mouseReleased"]) await app.cdp.send("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...point }, app.sessionId);
}
async function fill(selector, text) {
  await click(selector);
  for (const type of ["keyDown", "keyUp"]) await app.cdp.send("Input.dispatchKeyEvent", {
    type, key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: process.platform === "darwin" ? 4 : 2,
  }, app.sessionId);
  await app.cdp.send("Input.insertText", { text }, app.sessionId);
  await until(() => call((query, value) => document.querySelector(query)?.value === value, selector, text), `filled ${selector}`);
}
async function screenshot(name) {
  const image = await app.cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, app.sessionId);
  const file = path.join(options.artifacts, `${mode}-${name}.png`);
  fs.writeFileSync(file, Buffer.from(image.data, "base64")); report.screenshots.push(file);
}

function executable() {
  if (!options.app) {
    const executable = process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron";
    return { executable: path.join(desktop, "node_modules/electron/dist", executable), arguments: [desktop] };
  }
  if (options.app.endsWith(".app")) {
    const directory = path.join(options.app, "Contents/MacOS");
    const entries = fs.readdirSync(directory).filter((entry) => fs.statSync(path.join(directory, entry)).isFile());
    assert.equal(entries.length, 1, "The supplied application must have exactly one executable");
    return { executable: path.join(directory, entries[0]), arguments: [] };
  }
  return { executable: options.app, arguments: [] };
}
async function launch() {
  const command = executable();
  assert.ok(fs.existsSync(command.executable), `Missing Electron executable: ${command.executable}`);
  const env = { ...process.env, CREWFORGE_DESKTOP_DATA_DIR: clientData };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(command.executable, [...command.arguments, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"], {
    cwd: desktop, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  const current = { child, log: "", endpoint: null, cdp: null, sessionId: null, targetId: null, exceptions: [] };
  app = current;
  const capture = (chunk) => {
    current.log = (current.log + chunk.toString()).slice(-32_000);
    current.endpoint ||= current.log.match(/DevTools listening (?:on )?(ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/)?.[1];
  };
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  child.on("error", (error) => { current.log += `\n${safeMessage(error)}`; });
  await until(() => {
    if (child.exitCode !== null) throw new Error(`Electron exited: ${safeMessage(current.log)}`);
    return current.endpoint;
  }, "owned Electron debugging endpoint", 40_000);
  const socket = new WebSocket(current.endpoint);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  current.cdp = new CDP(socket, current);
}
async function closeApp() {
  if (!app) return;
  const current = app;
  try {
    if (current.cdp && current.targetId) await current.cdp.send("Target.closeTarget", { targetId: current.targetId });
    else if (current.cdp) await current.cdp.send("Browser.close");
  } catch { /* Quit may close CDP before its reply. */ }
  if (current.child.exitCode === null) await Promise.race([new Promise((resolve) => current.child.once("exit", resolve)), sleep(7000)]);
  const graceful = current.child.exitCode !== null;
  current.cdp?.socket.close();
  if (process.platform === "win32") {
    if (current.child.exitCode === null) spawnSync("taskkill", ["/pid", String(current.child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    try { process.kill(-current.child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    await sleep(150);
    try { process.kill(-current.child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  app = undefined;
  return { graceful };
}

function respond(res, body, message) {
  if (res.destroyed || res.writableEnded) return;
  const finish = message.tool_calls ? "tool_calls" : "stop";
  if (body.stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const delta = message.tool_calls ? { role: "assistant", tool_calls: message.tool_calls.map((entry, index) => ({ ...entry, index })) } : message;
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } })}\n\ndata: [DONE]\n\n`);
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: finish, message }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }));
  }
}
async function startFixture() {
  for (const directory of [workspace, clientData, path.join(serverData, "plugins")]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(workspace, "source.txt"), `${marker}\n`);
  fs.writeFileSync(path.join(workspace, "README.md"), "# Remote desktop fixture\nDisposable server-owned workspace.\n");
  fs.writeFileSync(path.join(serverData, "users.json"), JSON.stringify({ allowedRoots: [workspace], pendingRegistrations: [], users: [{ username, password, defaultWorkspace: workspace, isAdmin: true }] }));
  model = http.createServer(async (req, res) => {
    modelResponses.add(res); res.once("close", () => modelResponses.delete(res));
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "remote-fixture", context_window: 32768, max_output_tokens: 2048 }] })); return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.model, "remote-fixture");
      const messages = body.messages || [];
      const title = messages.some((message) => message.role === "system" && String(message.content).includes("Generate a concise title"));
      if (title) { respond(res, body, { role: "assistant", content: "Remote background smoke" }); return; }
      report.providerRequests++;
      const toolResult = messages.find((message) => message.role === "tool" && message.tool_call_id === "remote-read");
      if (toolResult) {
        assert.ok(String(toolResult.content).includes(marker), "Agent must read the server fixture after its client closes");
        respond(res, body, { role: "assistant", content: marker });
      } else {
        assert.ok(messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes(marker)));
        assert.equal(releaseModel, undefined, "Only one background task may start");
        releaseModel = () => respond(res, body, { role: "assistant", content: null, tool_calls: [{ id: "remote-read", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "source.txt" }) } }] });
      }
    } catch (error) { report.fixtureError = safeMessage(error); if (!res.headersSent) res.writeHead(400); res.end("Invalid scripted model request"); }
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(serverData, "settings.json"), JSON.stringify({ schemaVersion: 1,
    llm: { modelName: "remote-fixture", vllmApiUrl: `http://127.0.0.1:${model.address().port}/v1`, vllmApiKey: "" },
    mcp: { baseUrls: [], lazyUrls: [], disabledUrls: [], servers: [] }, delivery: { providers: [] } }));
  assert.ok(fs.existsSync(path.join(root, "frontend/dist/index.html")), "Build the shared frontend before running this smoke test");
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const backendPort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const env = { ...process.env, HOST: "127.0.0.1", PORT: String(backendPort), USERS_CONFIG: path.join(serverData, "users.json"),
    APP_SETTINGS_CONFIG: path.join(serverData, "settings.json"), WORKSPACE_DIR: workspace, TEAM_STORE_ROOT: serverData,
    PLUGINS_DIR: path.join(serverData, "plugins"), STATIC_DIR: path.join(root, "frontend/dist"), CREWFORGE_DESKTOP: "0", CREWFORGE_FIXTURE_LOOPBACK: "1" };
  for (const key of ["ELECTRON_RUN_AS_NODE", "CROWNFORGE_DESKTOP_RUNTIME", "CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN"]) delete env[key];
  backend = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: path.join(root, "backend"), env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  backend.stdout.on("data", (chunk) => { backendLog = (backendLog + chunk).slice(-32_000); });
  backend.stderr.on("data", (chunk) => { backendLog = (backendLog + chunk).slice(-32_000); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fixture server startup timeout: ${safeMessage(backendLog)}`)), 40_000);
    backend.on("message", (message) => {
      if (message?.type === "ready") { backendOrigin = message.url; clearTimeout(timer); resolve(); }
      else if (message?.type === "error") { clearTimeout(timer); reject(new Error(`Fixture server startup ${message.code}`)); }
    });
    backend.once("error", (error) => { clearTimeout(timer); reject(error); });
    backend.once("exit", () => { clearTimeout(timer); reject(new Error(`Fixture server stopped: ${safeMessage(backendLog)}`)); });
  });
  proxy = http.createServer((req, res) => {
    if (authUnavailable && req.url.split("?")[0] === "/api/auth/me") {
      res.writeHead(503, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Disposable fixture connection interruption" })); return;
    }
    const upstream = http.request(new URL(req.url, backendOrigin), { method: req.method, headers: req.headers }, (response) => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  proxy.on("upgrade", (req, client, head) => {
    if (!allowWebSockets) { client.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); return; }
    if (req.url.startsWith("/ws/chat")) chatUpgrades++;
    const upstream = net.connect(Number(new URL(backendOrigin).port), "127.0.0.1", () => {
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${req.rawHeaders.map((value, index) => index % 2 ? `${value}\r\n` : `${value}: `).join("")}\r\n`);
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    for (const socket of [client, upstream]) {
      proxySockets.add(socket); socket.once("close", () => proxySockets.delete(socket));
      socket.on("error", () => { client.destroy(); upstream.destroy(); });
    }
    client.once("close", () => upstream.destroy()); upstream.once("close", () => client.destroy());
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${proxy.address().port}`;
  const preferenceDir = path.join(clientData, "servers", crypto.createHash("sha256").update(origin).digest("hex"));
  fs.mkdirSync(preferenceDir, { recursive: true });
  fs.writeFileSync(path.join(preferenceDir, "preferences.json"), JSON.stringify({ locale: "en", theme: "dark", zoomLevel: 1 }));
}
async function serverApi(route, token) {
  const response = await fetch(`${origin}${route}`, { headers: { Authorization: `Bearer ${token}` } });
  const result = await response.json(); assert.ok(response.ok, result.error || `API ${response.status}`); return result;
}

try {
  await startFixture();
  await launch();
  await check("connection_page_saves_server_and_loads_shared_login", async () => {
    await attachPage((url) => url.startsWith("file:") && url.endsWith("/connection.html"), "owned connection page");
    await until(() => call(() => Boolean(window.crownforgeConnection && document.querySelector("#server-url"))), "connection form ready");
    await screenshot("connection");
    await fill("#server-url", origin);
    await click("#connect-button");
    await until(() => fs.existsSync(path.join(clientData, "connection.json")), "server choice persisted");
    assert.equal(JSON.parse(fs.readFileSync(path.join(clientData, "connection.json"))).serverUrl, origin);
    await attachPage((url) => url === `${origin}/`, "remote workbench page");
    await until(() => call(() => Boolean(document.querySelector("#login-username, .landing-enter-button"))), "shared public frontend");
    if (await call(() => Boolean(document.querySelector(".landing-enter-button")))) await click(".landing-enter-button");
    await until(() => call(() => Boolean(document.querySelector("#login-username"))), "React server login");
    const page = await call(() => ({ origin: location.origin, bridge: window.crownforgeDesktop?.connectionMode, server: window.crownforgeDesktop?.serverUrl,
      node: typeof window.require, bootstrap: Boolean(window.crownforgeDesktop?.getBootstrapToken) }));
    assert.equal(page.origin, origin); assert.equal(page.bridge, "remote"); assert.equal(page.server, origin);
    assert.equal(page.node, "undefined"); assert.equal(page.bootstrap, false);
    assert.equal(await (await fetch(`${origin}/`)).text(), fs.readFileSync(path.join(root, "frontend/dist/index.html"), "utf8"));
    await screenshot("login");
    return { sameServerFrontend: true, remoteBridge: true, nodeIntegration: false };
  });
  let loginToken;
  await check("ordinary_server_login_opens_remote_workspace", async () => {
    await fill("#login-username", username); await fill("#login-password", password); await click(".login-btn");
    await until(() => call(() => Boolean(document.querySelector(".activity-rail") && !document.querySelector("#login-username"))), "authenticated workbench");
    await until(() => call(() => Boolean(document.querySelector(".statusbar-conn-dot.ready, .statusbar-conn-dot.warning"))), "server WS connected");
    loginToken = await call(() => localStorage.getItem("ai-ide-token")); assert.ok(loginToken);
    const current = await serverApi("/api/auth/me", loginToken);
    assert.equal(current.username, username); assert.equal(current.workspaceDir, workspace); assert.equal(current.desktop, false);
    await screenshot("workbench"); return { serverAccount: true, serverWorkspace: true, localBootstrap: false };
  });
  await check("websocket_disconnect_is_visible_and_recovers", async () => {
    const previous = chatUpgrades;
    allowWebSockets = false; for (const socket of [...proxySockets]) socket.destroy();
    await until(() => call(() => Boolean(document.querySelector(".statusbar-conn-dot.danger"))), "visible disconnected state");
    await screenshot("disconnected");
    allowWebSockets = true;
    await until(async () => chatUpgrades > previous && await call(() => Boolean(document.querySelector(".statusbar-conn-dot.ready, .statusbar-conn-dot.warning"))), "automatic WS reconnect", 15_000);
    await screenshot("reconnected"); return { reconnectWithoutReload: true };
  });
  let runId, conversationId;
  await check("closing_electron_leaves_server_and_task_running", async () => {
    await click('button[aria-label="AI tasks"]');
    await until(() => call(() => Boolean(document.querySelector(".main-layout.workbench-view-chat .chat-panel"))), "chat workbench");
    await click(".chat-composer-mode-select button");
    await call(() => {
      const option = [...document.querySelectorAll(".workbench-select-option")].find((node) => node.querySelector("strong")?.textContent === "Ask");
      if (!option) throw new Error("Ask mode option is missing"); option.setAttribute("data-remote-smoke-ask", "true");
    });
    await click("[data-remote-smoke-ask]");
    await fill(".chat-panel textarea.chat-input", `Read source.txt and return its contents. ${marker}`);
    await click(".chat-composer-send-btn");
    await until(() => Boolean(releaseModel), "scripted model request in progress");
    const runs = await serverApi("/api/chat/runs", loginToken);
    const active = runs.runs.find((run) => run.status === "running"); assert.ok(active);
    runId = active.runId; conversationId = active.conversationId;
    await screenshot("running-task");
    const closed = await closeApp();
    assert.equal(closed.graceful, true, "Closing the owned main window must quit normally");
    assert.equal(backend.exitCode, null, "Closing the desktop must not terminate its independent server");
    assert.equal((await (await fetch(`${origin}/api/health`)).json()).status, "ok");
    const pending = await serverApi(`/api/chat/runs/${runId}`, loginToken); assert.equal(pending.status, "running");
    releaseModel();
    const completed = await until(async () => {
      const run = await serverApi(`/api/chat/runs/${runId}`, loginToken); return run.status === "running" ? false : run;
    }, "server task finishes after app exits");
    assert.equal(completed.status, "completed", JSON.stringify(completed.summary));
    assert.equal(completed.metrics.toolCalls, 1); assert.equal(completed.metrics.toolErrors, 0);
    const history = await serverApi(`/api/chat/conversations/${conversationId}`, loginToken);
    assert.equal(history.messages.at(-1).content.trim(), marker);
    assert.equal(report.providerRequests, 2); assert.equal(report.fixtureError, undefined);
    return { independentServerSurvived: true, backgroundRunCompleted: true, toolCalls: 1, providerTurns: 2 };
  });
  authUnavailable = true;
  await launch();
  await check("temporary_auth_failure_keeps_login_and_offers_retry", async () => {
    await attachPage((url) => url === `${origin}/`, "remote authentication recovery");
    await until(() => call(() => Boolean(document.querySelector(".login-card p[role=status]") && !document.querySelector("#login-username"))), "auth recovery state");
    assert.equal(await call(() => localStorage.getItem("ai-ide-token")), loginToken);
    await screenshot("auth-unavailable");
    authUnavailable = false;
    await click(".login-card > button.dialog-btn");
    await until(() => call(() => Boolean(document.querySelector(".activity-rail"))), "auth reconnect without sign-in");
    return { loginTokenPreserved: true, retryRestoresSession: true };
  });
  await check("restart_restores_server_login_and_completed_history", async () => {
    await until(() => call(() => Boolean(document.querySelector(".activity-rail") && !document.querySelector("#login-username"))), "persistent server login");
    assert.equal(await call(() => localStorage.getItem("ai-ide-token")), loginToken);
    assert.equal(JSON.parse(fs.readFileSync(path.join(clientData, "connection.json"))).serverUrl, origin);
    const history = await serverApi(`/api/chat/conversations/${conversationId}`, loginToken);
    assert.equal(history.lastRunId, runId); assert.equal(history.status, "completed");
    assert.equal(history.messages.at(-1).content.trim(), marker);
    assert.equal(report.providerRequests, 2, "Restart and hydration must not replay the model request");
    await click('button[aria-label="AI tasks"]');
    await click(".task-list-item-main");
    await until(() => call((text) => [...document.querySelectorAll(".chat-message.assistant .chat-message-content")].some((node) => node.textContent.includes(text)), marker), "persisted assistant result rendered from task history");
    await screenshot("restored-workbench");
    return { serverSelectionPersisted: true, loginStoragePersisted: true, sameCompletedRun: true, renderedHistoryResult: true, noReplay: true };
  });
  assert.deepEqual(report.blockedExternalRequests, [], "The fixture must not attempt public network requests");
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = safeMessage(error);
  if (app?.targets) report.targets = app.targets;
  if (app?.cdp && app.sessionId) await screenshot("failure").catch(() => {});
  console.error(`FAIL ${report.error}`); process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  if (app?.log) fs.writeFileSync(path.join(options.artifacts, `${mode}-electron.log`), safeMessage(app.log));
  await closeApp();
  for (const socket of proxySockets) socket.destroy();
  if (proxy) { proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve)); }
  if (backend && backend.exitCode === null) {
    backend.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => backend.once("exit", resolve)), sleep(5000)]);
    if (backend.exitCode === null) backend.kill("SIGKILL");
  }
  for (const response of modelResponses) response.destroy();
  if (model) { model.closeAllConnections(); await new Promise((resolve) => model.close(resolve)); }
  fs.writeFileSync(path.join(options.artifacts, `${mode}-server.log`), safeMessage(backendLog));
  fs.writeFileSync(path.join(options.artifacts, `${mode}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
  fs.rmSync(fixture, { recursive: true, force: true });
  console.log(`Report: ${path.join(options.artifacts, `${mode}-report.json`)}`);
}
