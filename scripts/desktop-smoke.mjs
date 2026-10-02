#!/usr/bin/env node
// Owned Electron/CDP fixture only. No existing application, browser, or user data is attached.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = path.join(root, "desktop");
const require = createRequire(path.join(root, "backend", "package.json"));
const { WebSocket } = require("ws");
const options = { app: null, artifacts: path.join(root, ".artifacts", "desktop-1.1.1-dev") };
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  if (["--app", "--artifacts"].includes(flag) && process.argv[i + 1]) options[flag.slice(2)] = path.resolve(process.argv[++i]);
  else if (flag === "--help") {
    console.log("node scripts/desktop-smoke.mjs [--app /path/CrownForge.app|CrownForge.exe] [--artifacts /path/screenshots]");
    process.exit(0);
  } else throw new Error(`Unknown or incomplete option: ${flag}`);
}
const mode = options.app ? "packaged" : "dev";
const prefix = `desktop-smoke-${mode}`;
fs.mkdirSync(options.artifacts, { recursive: true });
const reportFile = path.join(options.artifacts, `${prefix}-report.json`);
const report = { mode, startedAt: new Date().toISOString(), status: "running", checks: [], screenshots: [], providerRequests: 0 };
const dataDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-desktop-smoke-")));
const workspace = path.join(dataDir, "workspace");
const originalCode = "export function add(a: number, b: number) {\n  return a - b;\n}\n";
const replacement = originalCode.replace("return a - b;", "return a + b;").trimEnd();
const expectedFont = "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let modelServer;
let owned;

class CDP {
  constructor(socket) {
    this.socket = socket; this.counter = 0; this.pending = new Map(); this.contexts = new Map(); this.errors = [];
    socket.on("message", (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.id) {
        const pending = this.pending.get(event.id);
        if (pending) { clearTimeout(pending.timer); this.pending.delete(event.id); event.error ? pending.reject(new Error(event.error.message)) : pending.resolve(event.result || {}); }
      } else if (event.method === "Runtime.exceptionThrown") {
        this.errors.push(event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text);
      } else if (event.method === "Runtime.consoleAPICalled" && event.params.type === "error") {
        this.errors.push(event.params.args.map((arg) => arg.description || arg.value || arg.type).join(" ").slice(0, 2000));
      } else if (event.method === "Runtime.executionContextCreated") {
        const context = event.params.context; this.contexts.set(`${event.sessionId}:${context.id}`, { ...context, sessionId: event.sessionId });
      } else if (event.method === "Runtime.executionContextDestroyed") this.contexts.delete(`${event.sessionId}:${event.params.executionContextId}`);
      else if (event.method === "Runtime.executionContextsCleared") {
        for (const [key, context] of this.contexts) if (context.sessionId === event.sessionId) this.contexts.delete(key);
      } else if (event.method === "Target.attachedToTarget" && event.params.targetInfo.type === "iframe") {
        void this.send("Runtime.enable", {}, event.params.sessionId).catch(() => {});
      }
    });
    socket.on("close", () => { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Owned CDP disconnected")); } this.pending.clear(); });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

async function until(predicate, label, timeout = 25_000) {
  const deadline = Date.now() + timeout; let lastError;
  while (Date.now() < deadline) {
    if (owned?.cdp?.errors.length) throw new Error(`Owned renderer failed: ${owned.cdp.errors[0]}`);
    try { const value = await predicate(); if (value) return value; } catch (error) { lastError = error; }
    if (owned?.child.exitCode !== null && owned?.child.exitCode !== undefined) throw new Error(`Owned Electron exited before ${label}: ${owned.log.slice(-2000)}`);
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}${lastError ? ` (${lastError.message})` : ""}`);
}

async function evaluate(expression, context) {
  const result = await owned.cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true,
    ...(context ? { contextId: context.id } : {}) }, context?.sessionId || owned.sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
const call = (fn, ...args) => evaluate(`(${fn.toString()})(${args.map((value) => JSON.stringify(value)).join(",")})`);
async function api(route, method = "GET", body) {
  return call(async (route, method, body) => {
    const response = await fetch(route, { method, headers: { Authorization: `Bearer ${localStorage.getItem("ai-ide-token")}`,
      "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); if (!response.ok) throw new Error(value.error || `Fixture API status ${response.status}`); return value;
  }, route, method, body);
}

async function click(selector) {
  const point = await until(() => call(async (selector) => {
    const node = document.querySelector(selector); if (!node || node.disabled) return null;
    node.scrollIntoView({ block: "center", inline: "center" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = node.getBoundingClientRect(); const x = rect.x + rect.width / 2; const y = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return rect.width && rect.height && (hit === node || node.contains(hit)) ? { x, y } : null;
  }, selector), `clickable ${selector}`);
  for (const type of ["mousePressed", "mouseReleased"]) await owned.cdp.send("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...point }, owned.sessionId);
}
async function key(key, code, windowsVirtualKeyCode, modifiers = 0) {
  for (const type of ["keyDown", "keyUp"]) await owned.cdp.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode, modifiers }, owned.sessionId);
}
const primaryModifier = process.platform === "darwin" ? 4 : 2;
async function fill(selector, text) {
  await click(selector);
  await key("a", "KeyA", 65, primaryModifier); await key("Backspace", "Backspace", 8);
  await owned.cdp.send("Input.insertText", { text }, owned.sessionId);
  await until(() => call((selector, text) => document.querySelector(selector)?.value === text, selector, text), "input text");
}
async function chooseOption(trigger, label) {
  await click(trigger);
  await until(() => call((label) => {
    const node = [...document.querySelectorAll('[data-workbench-select-menu] [role="option"]')].find((node) => node.textContent.trim() === label);
    if (!node) return false; node.setAttribute("data-desktop-smoke-option", "true"); return true;
  }, label), `option ${label}`);
  await click('[data-desktop-smoke-option="true"]');
}
async function screenshot(name) {
  const image = await owned.cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, owned.sessionId);
  const file = path.join(options.artifacts, `${prefix}-${name}.png`);
  fs.writeFileSync(file, Buffer.from(image.data, "base64")); report.screenshots.push(file); return file;
}
async function check(name, fn) {
  const started = Date.now();
  try { const evidence = await fn(); report.checks.push({ name, status: "passed", durationMs: Date.now() - started, ...(evidence === undefined ? {} : { evidence }) }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, status: "failed", durationMs: Date.now() - started, error: error.message }); throw error; }
}

function executable() {
  if (!options.app) {
    const binary = process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron";
    return { binary: path.join(desktopDir, "node_modules", "electron", "dist", binary), args: [desktopDir] };
  }
  if (options.app.endsWith(".app")) {
    const directory = path.join(options.app, "Contents", "MacOS");
    const files = fs.readdirSync(directory).filter((name) => fs.statSync(path.join(directory, name)).isFile());
    assert.equal(files.length, 1, "Application bundle must have one executable");
    return { binary: path.join(directory, files[0]), args: [] };
  }
  return { binary: options.app, args: [] };
}
async function launch() {
  const { binary, args } = executable(); assert.ok(fs.existsSync(binary), `Electron executable missing: ${binary}`);
  const env = { ...process.env, CREWFORGE_DESKTOP_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(binary, [...args, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"], {
    cwd: desktopDir, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  const current = { child, log: "", origin: null, endpoint: null, cdp: null, sessionId: null, targetId: null };
  owned = current;
  const capture = (chunk) => {
    current.log = (current.log + chunk.toString()).slice(-32_000);
    current.endpoint ||= current.log.match(/DevTools listening (?:on )?(ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/)?.[1];
    current.origin ||= current.log.match(/CrewForge running at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  };
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  child.on("error", (error) => { current.log += `\n${error.message}`; });
  await until(() => owned.endpoint && owned.origin, "own process CDP and backend readiness", 40_000);
  const socket = new WebSocket(owned.endpoint);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  owned.cdp = new CDP(socket);
  const target = await until(async () => {
    const { targetInfos } = await owned.cdp.send("Target.getTargets");
    const pages = targetInfos.filter((target) => target.type === "page" && target.url === `${owned.origin}/`);
    assert.ok(pages.length <= 1, "Ambiguous own root page"); return pages[0];
  }, "own root page");
  owned.targetId = target.targetId;
  const { sessionId } = await owned.cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  owned.sessionId = sessionId;
  await owned.cdp.send("Runtime.enable", {}, sessionId); await owned.cdp.send("Page.enable", {}, sessionId);
  await owned.cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
  await until(() => call(() => Boolean(window.crownforgeDesktop && document.querySelector(".activity-rail"))), "passwordless desktop workbench", 40_000);
  await until(() => call(() => Boolean(document.querySelector(".statusbar-conn-dot.ready, .statusbar-conn-dot.warning"))), "local service connection", 40_000);
  return owned.origin;
}
async function closeOwned() {
  if (!owned) return;
  const current = owned;
  try { if (current.cdp && current.targetId) await current.cdp.send("Target.closeTarget", { targetId: current.targetId }); } catch { /* app may already have closed */ }
  if (current.child.exitCode === null) await Promise.race([new Promise((resolve) => current.child.once("exit", resolve)), sleep(7000)]);
  current.cdp?.socket.close();
  // The Electron launch is in its own POSIX process group, including its backend.
  if (process.platform === "win32") {
    if (current.child.exitCode === null) spawnSync("taskkill", ["/pid", String(current.child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    try { process.kill(-current.child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    await sleep(200);
    try { process.kill(-current.child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  owned = null;
}
function preferences() { return JSON.parse(fs.readFileSync(path.join(dataDir, "preferences.json"), "utf8")); }

try {
  fs.mkdirSync(workspace); fs.mkdirSync(path.join(dataDir, "plugins"));
  fs.writeFileSync(path.join(dataDir, "users.json"), JSON.stringify({ allowedRoots: [workspace], pendingRegistrations: [],
    users: [{ username: "admin", password: crypto.randomBytes(18).toString("base64url"), defaultWorkspace: workspace, isAdmin: true }] }));
  fs.writeFileSync(path.join(dataDir, "preferences.json"), JSON.stringify({ theme: "light", zoomLevel: 1, locale: "en" }));
  fs.writeFileSync(path.join(workspace, "calculator.ts"), originalCode);
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "desktop-smoke-fixture", private: true, scripts: { wait: "node wait.cjs" } }));
  fs.writeFileSync(path.join(workspace, "wait.cjs"), "console.log('session ready');console.log('payload Node mode: '+String(process.env.ELECTRON_RUN_AS_NODE));process.stdin.setEncoding('utf8');process.stdin.on('data',text=>{console.log('input: '+text.trim());if(text.trim()==='exit')process.exit(0)});setInterval(()=>{},1000);\n");
  fs.writeFileSync(path.join(workspace, "index.html"), '<!doctype html><html><head><title>Desktop preview fixture</title><style>body{font:20px system-ui;padding:28px;background:#eaf2ff;color:#17385e}</style></head><body><h1>Desktop preview fixture</h1><p id="proof">Static preview rendered inside the desktop application.</p><script>document.body.dataset.bridge=String(typeof window.crownforgeDesktop);</script></body></html>');
  modelServer = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ data: [{ id: "desktop-fixture", max_output_tokens: 2048 }] })); return; }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    let request;
    try { request = JSON.parse(Buffer.concat(chunks).toString()); } catch { res.writeHead(400).end(); return; }
    if (request.model !== "desktop-fixture") { res.writeHead(400).end("Only desktop-fixture is available"); return; }
    report.providerRequests++;
    const content = `\`\`\`typescript\n${replacement}\n\`\`\``;
    if (request.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75 } })}\n\ndata: [DONE]\n\n`);
    } else { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ id: "desktop-fixture", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }] })); }
  });
  await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(dataDir, "app-settings.json"), JSON.stringify({ schemaVersion: 1,
    llm: { modelName: "desktop-fixture", vllmApiUrl: `http://127.0.0.1:${modelServer.address().port}/v1`, vllmApiKey: "" },
    mcp: { baseUrls: [], lazyUrls: [], disabledUrls: [], servers: [] }, delivery: { providers: [] } }));
  const initialOrigin = await launch(); report.initialOrigin = initialOrigin;
  await check("passwordless_desktop_and_workspace", async () => {
    const result = await call(async () => {
      const token = localStorage.getItem("ai-ide-token");
      const response = await fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } });
      const session = await response.json();
      return { desktop: session.desktop, workspaceDir: session.workspaceDir, username: session.username, bridge: Boolean(window.crownforgeDesktop),
        bridgePlatform: window.crownforgeDesktop.platform, version: window.crownforgeDesktop.version, node: typeof window.require,
        loginForm: Boolean(document.querySelector("#login-username")), theme: document.documentElement.dataset.theme, locale: document.documentElement.lang };
    });
    assert.equal(result.desktop, true); assert.equal(result.bridge, true); assert.equal(result.workspaceDir, workspace);
    assert.equal(result.node, "undefined"); assert.equal(result.loginForm, false); assert.equal(result.theme, "light"); assert.equal(result.locale, "en");
    await screenshot("initial"); return result;
  });
  await check("single_layout_zoom_keeps_native_pixel_ratio", async () => {
    const before = await call(() => ({ zoom: Number(getComputedStyle(document.documentElement).zoom), ratio: devicePixelRatio }));
    await key("=", "Equal", 187, primaryModifier);
    await until(() => call(() => Number(getComputedStyle(document.documentElement).zoom) === 1.1), "one zoom step");
    await until(() => preferences().zoomLevel === 1.1, "native zoom persisted"); await sleep(250);
    const after = await call(() => ({ zoom: Number(getComputedStyle(document.documentElement).zoom), ratio: devicePixelRatio }));
    assert.equal(before.zoom, 1); assert.equal(after.zoom, 1.1); assert.equal(after.ratio, before.ratio); return { before, after };
  });
  await check("ui_theme_and_font_persist", async () => {
    await click('button[aria-label="Switch to dark theme"]');
    await until(async () => await call(() => document.documentElement.dataset.theme === "dark") && preferences().theme === "dark", "dark theme saved");
    await click('button[aria-label="Settings"]');
    await chooseOption('.settings-modal button[aria-label^="Editor font:"]', "SF Mono");
    await until(() => preferences().editorFont === expectedFont, "font saved");
    await click(".settings-modal-close"); return preferences();
  });
  await check("run_center_long_session_streams_input_and_real_exit", async () => {
    await click('button[aria-label="Run and Test Center"]');
    if (!await call(() => document.querySelector(".process-sessions")?.open)) await click(".process-sessions > summary");
    await until(() => call(() => Boolean(document.querySelector('.process-sessions select[aria-label="Choose a project task"] option[value="npm:wait"]'))), "owned wait task");
    // The native select picker is outside the page's CDP input surface on macOS.
    // Select only the discovered fixture task; start, approval and stdin use real input.
    await call(() => { const select = document.querySelector('.process-sessions select[aria-label="Choose a project task"]');
      select.value = "npm:wait"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await until(() => call(() => document.querySelector('.process-sessions select[aria-label="Choose a project task"]')?.value === "npm:wait"), "wait task selection");
    await click(".process-session-controls button.dialog-btn"); await click('[role="alertdialog"] .dialog-btn.primary');
    const sessionId = await until(() => call(() => document.querySelector('.process-sessions select[aria-label="Choose a session"]')?.value), "owned process session");
    const state = await until(async () => {
      const state = await api(`/api/process-sessions/${sessionId}`);
      const output = state.events.map((event) => event.text).join("");
      if (state.session.status !== "running") throw new Error(`Owned command ended before ready: ${JSON.stringify({ session: state.session, output })}`);
      return output.includes("session ready") ? state : false;
    }, "actual long-running Node task", 12_000);
    assert.match(state.events.map((event) => event.text).join(""), /payload Node mode: undefined/);
    await fill('.process-sessions input[aria-label="Send input to the running command"]', "exit");
    await click('.process-sessions button[type="submit"]');
    const finished = await until(async () => {
      const state = await api(`/api/process-sessions/${sessionId}`); return state.session.status === "running" ? false : state;
    }, "long process real exit");
    assert.equal(finished.session.status, "exited"); assert.equal(finished.session.exitCode, 0);
    assert.match(finished.events.map((event) => event.text).join(""), /input: exit/);
    await until(() => call(() => document.querySelector(".process-sessions .run-output")?.textContent.includes("input: exit")), "command output shown in UI");
    await screenshot("process-session"); return { status: finished.session.status, exitCode: finished.session.exitCode, invocation: finished.session.invocation, cleanPayloadEnvironment: true };
  });
  await check("inline_accept_is_buffer_only_and_undoable", async () => {
    if (!await call(() => Boolean(document.querySelector('[data-tree-path="calculator.ts"]')?.getBoundingClientRect().width))) await click('button[aria-label="Explorer"]');
    await click('[data-tree-path="calculator.ts"]');
    await until(() => call(() => Boolean(document.querySelector(".monaco-editor textarea"))), "Monaco file editor");
    await until(() => call(async () => {
      const url = performance.getEntriesByType("resource").map((entry) => entry.name).find((url) => /\/monaco-core-[^/]+\.js/.test(url));
      if (!url) return false;
      const module = await import(url);
      const api = Object.values(module).find((value) => value && typeof value.getEditors === "function")
        || Object.values(module).map((value) => value?.editor).find((value) => value && typeof value.getEditors === "function");
      const editor = api?.getEditors().find((editor) => editor.getModel()?.uri.path.endsWith("/calculator.ts"));
      if (!editor) return false; globalThis.__desktopSmokeEditor = editor; return true;
    }), "public Monaco model");
    assert.equal(await evaluate("__desktopSmokeEditor.getValue()"), originalCode);
    await click(".monaco-editor .view-lines"); await key("a", "KeyA", 65, primaryModifier); await key("k", "KeyK", 75, primaryModifier);
    await until(() => call(() => Boolean(document.querySelector('[data-testid="inline-assistant"]'))), "Inline shortcut");
    await fill(".inline-assistant textarea", "DESKTOP_SMOKE: replace subtraction with addition; return the complete function in one fenced block.");
    await click(".inline-assistant-footer button:not(.inline-assistant-accept)");
    await until(() => call(() => document.querySelector(".inline-assistant")?.getAttribute("aria-busy") === "false" && document.querySelector(".inline-assistant-accept")?.disabled === false), "applicable completed inline proposal", 40_000);
    assert.equal(fs.readFileSync(path.join(workspace, "calculator.ts"), "utf8"), originalCode);
    await screenshot("inline-proposal"); await click(".inline-assistant-accept");
    await until(() => evaluate("__desktopSmokeEditor.getValue().includes('return a + b;')"), "accepted buffer");
    assert.equal((await evaluate("__desktopSmokeEditor.getValue()")).trimEnd(), replacement);
    assert.equal(fs.readFileSync(path.join(workspace, "calculator.ts"), "utf8"), originalCode);
    await click(".monaco-editor .view-lines"); await key("z", "KeyZ", 90, primaryModifier);
    await until(() => evaluate("__desktopSmokeEditor.getValue()") .then((value) => value === originalCode), "undo restores original buffer");
    assert.equal(fs.readFileSync(path.join(workspace, "calculator.ts"), "utf8"), originalCode);
    return { diskUnchanged: true, undoRestoredBuffer: true, providerRequests: report.providerRequests };
  });
  await check("rendered_static_preview_has_no_native_bridge", async () => {
    await click('button[aria-label="Web preview"]'); await click(".web-preview-target-card");
    await click('[role="alertdialog"] .dialog-btn.primary');
    await until(() => call(() => Boolean(document.querySelector(".web-preview-panel iframe"))), "preview iframe");
    const attributes = await call(() => { const frame = document.querySelector(".web-preview-panel iframe"); return { sandbox: frame.getAttribute("sandbox"), src: frame.src, opaque: frame.contentDocument === null }; });
    assert.equal(attributes.opaque, true); assert.ok(!attributes.sandbox.includes("allow-same-origin"));
    const context = await until(async () => {
      for (const context of owned.cdp.contexts.values()) {
        if (context.auxData?.isDefault !== true) continue;
        try { if (await evaluate('document.title === "Desktop preview fixture" && document.querySelector("h1")?.textContent === "Desktop preview fixture"', context)) return context; } catch { /* context replaced */ }
      }
    }, "actual opaque preview content");
    const frameState = await evaluate('({title:document.title,bridge:typeof window.crownforgeDesktop,require:typeof window.require,proof:document.getElementById("proof").textContent})', context);
    assert.equal(frameState.bridge, "undefined"); assert.equal(frameState.require, "undefined"); await screenshot("preview"); return { ...attributes, ...frameState };
  });
  await check("native_external_url_rejects_file_and_other_loopback_ports", async () => {
    const result = await call(async () => ({ file: await window.crownforgeDesktop.openExternal("file:///tmp/desktop-smoke-blocked"),
      otherLoopback: await window.crownforgeDesktop.openExternal(`http://127.0.0.1:${location.port === "1" ? "2" : "1"}/`),
      httpsLoopback: await window.crownforgeDesktop.openExternal("https://localhost/blocked") }));
    assert.deepEqual(result, { file: false, otherLoopback: false, httpsLoopback: false }); return result;
  });
  await check("ui_locale_persists", async () => {
    await click('button[aria-label="Settings"]'); await chooseOption('.settings-modal button[aria-label^="Language:"]', "简体中文");
    await until(async () => await call(() => Boolean(document.querySelector('button[aria-label="设置"]'))) && preferences().locale === "zh-CN", "locale saved");
    await click(".settings-modal-close"); return preferences();
  });
  const firstRendererErrors = [...owned.cdp.errors];
  const expectedPreferences = preferences(); await closeOwned();
  const restartedOrigin = await launch(); report.restartedOrigin = restartedOrigin;
  await check("restart_restores_preferences_across_random_origin", async () => {
    assert.notEqual(restartedOrigin, initialOrigin, "Backend restart must use a new loopback origin");
    const result = await call(async () => ({ native: await window.crownforgeDesktop.getPreferences(), theme: document.documentElement.dataset.theme,
      zoom: Number(getComputedStyle(document.documentElement).zoom), locale: document.documentElement.lang }));
    assert.deepEqual(result.native, expectedPreferences); assert.equal(result.theme, "dark"); assert.equal(result.zoom, 1.1);
    assert.equal(result.native.locale, "zh-CN");
    assert.equal(result.locale, "zh-CN");
    assert.equal(await call(() => Boolean(document.querySelector('button[aria-label="设置"]'))), true);
    assert.equal(result.native.editorFont, expectedFont); await screenshot("restarted"); return result;
  });
  assert.deepEqual([...firstRendererErrors, ...owned.cdp.errors], [], "Uncaught renderer errors");
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = error.stack || error.message;
  if (owned?.cdp && owned.sessionId) {
    await screenshot("failure").catch(() => {});
    report.diagnostics = await call(() => ({ title: document.title, body: document.body.innerText.slice(0, 3500),
      buttons: [...document.querySelectorAll("button[aria-label]")].map((button) => button.getAttribute("aria-label")) })).catch(() => undefined);
  }
  report.electronLog = owned?.log?.slice(-4000); report.rendererErrors = owned?.cdp?.errors;
  report.fixturePreferences = preferences(); process.exitCode = 1;
} finally {
  await closeOwned().catch((error) => { report.cleanupError = error.message; report.status = "failed"; process.exitCode = 1; });
  if (modelServer) { modelServer.closeAllConnections(); await new Promise((resolve) => modelServer.close(resolve)); }
  fs.rmSync(dataDir, { recursive: true, force: true });
  report.cleanedFixture = true; report.finishedAt = new Date().toISOString();
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, report: reportFile, screenshots: report.screenshots, error: report.error }));
}
