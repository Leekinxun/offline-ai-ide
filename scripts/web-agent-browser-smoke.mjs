#!/usr/bin/env node
// Explicit browser QA only. Creates its own Chrome context; never enumerates user tabs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "backend/package.json"));
const { WebSocket } = require("ws");
const args = process.argv.slice(2);
const options = { url: "http://127.0.0.1:45173", cdp: "http://127.0.0.1:9222", workspace: undefined, artifacts: undefined, launch: false, review: false };
for (let index = 0; index < args.length; index += 1) {
  const key = args[index];
  if (key === "--launch") options.launch = true;
  else if (key === "--review") options.review = true;
  else if (["--url", "--cdp", "--workspace", "--artifacts"].includes(key) && args[index + 1]) options[key.slice(2)] = args[++index];
  else if (key === "--help") {
    console.log("node scripts/web-agent-browser-smoke.mjs [--url http://127.0.0.1:45173] [--cdp http://127.0.0.1:9222] [--workspace /tmp/crownforge-browser-fixture-.../workspace] [--launch] [--review] [--artifacts /tmp/review-screenshots]");
    process.exit(0);
  } else throw new Error("Unknown or incomplete option: " + key);
}
function localUrl(value, protocols = ["http:", "https:"]) {
  const url = new URL(value);
  assert.ok(protocols.includes(url.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Only loopback fixture/CDP endpoints are allowed");
  assert.ok(!url.username && !url.password, "URL credentials are not supported");
  return url;
}
const origin = localUrl(options.url).origin;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(probe, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await probe(); if (value) return value; } catch (error) { lastError = error; }
    await sleep(80);
  }
  throw new Error(label + " timed out" + (lastError ? ": " + lastError.message : ""));
}
function safeError(error) {
  return String(error?.message || error).replace(/Bearer\s+\S+/g, "Bearer [redacted]").replace(/\/preview\/([^/]+)\/[^/]+\//g, "/preview/$1/[ticket]/").slice(0, 2200);
}
const results = [];
async function scenario(name, action, fatal = false) {
  const started = Date.now();
  try { await action(); results.push({ scenario: name, status: "pass", durationMs: Date.now() - started }); }
  catch (error) {
    const diagnostics = name.startsWith("inline_") && cdp && pageSession ? await call(() => ({
      inline: document.querySelector(".inline-assistant")?.textContent?.slice(0, 1500),
      value: document.querySelector(".inline-assistant textarea")?.value,
      buttons: [...document.querySelectorAll(".inline-assistant button")].map((button) => ({ text: button.textContent, disabled: button.disabled })),
      active: document.activeElement?.outerHTML?.slice(0, 350),
    })).catch(() => undefined) : undefined;
    results.push({ scenario: name, status: "fail", reason: safeError(error), ...(diagnostics ? { diagnostics } : {}), durationMs: Date.now() - started }); if (fatal) throw error;
  }
  finally { console.log(JSON.stringify(results[results.length - 1])); }
}
let chrome, profile, cdp, browserContextId, pageSession, targetId, safeWorkspace, diskBefore;
let ownedContextDisposed = false;
const ownSessions = new Set();
const executionContexts = new Map();
const pendingRequests = new Map();
const responses = [];
const ownedPreviews = new Set();
const ownedProcesses = new Set();

class CDP {
  constructor(socket) {
    this.socket = socket; this.nextId = 0; this.pending = new Map(); this.listeners = new Set();
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (pending) { clearTimeout(pending.timer); this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result || {}); }
      } else for (const listener of this.listeners) listener(message);
    });
    socket.on("close", () => { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("CDP disconnected")); } this.pending.clear(); });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("CDP timeout: " + method)); }, 25_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}
async function evaluate(expression, session = pageSession, contextId) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) }, session);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
const call = (fn, ...values) => evaluate("(" + fn.toString() + ")(" + values.map((value) => JSON.stringify(value)).join(",") + ")");
async function click(selector, requireHit = false) {
  const point = await until(() => call(async (query) => {
    const element = document.querySelector(query);
    if (!element || element.disabled) return null;
    element.scrollIntoView({ block: "center", inline: "center" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return rect.width && rect.height ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
      hitTarget: hit === element || element.contains(hit), hit: hit?.outerHTML.slice(0, 350) } : null;
  }, selector), "Clickable " + selector);
  if (requireHit) assert.equal(point.hitTarget, true, 'Button is covered: ' + point.hit);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: point.x, y: point.y }, pageSession);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: point.x, y: point.y }, pageSession);
}
async function key(key, code, windowsVirtualKeyCode, modifiers = 0) {
  const event = { key, code, windowsVirtualKeyCode, modifiers };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...event }, pageSession);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...event }, pageSession);
}
let primaryModifier = 4;
async function fill(selector, text) {
  // Content widgets can relayout on scrollIntoView. Focus the actual input DOM
  // node and use Chromium input events, rather than assigning a React value.
  await until(() => call((query) => {
    const element = document.querySelector(query); if (!element || element.disabled) return false;
    element.focus(); return document.activeElement === element;
  }, selector), "Focused " + selector);
  await key("a", "KeyA", 65, primaryModifier); await key("Backspace", "Backspace", 8);
  if (text) await cdp.send("Input.insertText", { text }, pageSession);
  await until(() => call((query, expected) => document.querySelector(query)?.value === expected, selector, text), "Input text in " + selector);
}
async function uiApi(route, method = "GET", body) {
  return call(async (route, method, body) => {
    const token = localStorage.getItem("ai-ide-token");
    const response = await fetch(route, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...(globalThis.__smokeWorkspace ? { "X-Workspace-Dir": encodeURIComponent(globalThis.__smokeWorkspace) } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); if (!response.ok) throw new Error(value.error || value.detail || "Fixture API failed: " + response.status);
    return value;
  }, route, method, body);
}
async function capturedResponse(route, after = 0) {
  return until(() => responses.find((entry) => entry.route === route && entry.method === "POST" && entry.time >= after), "UI response for " + route, 30_000);
}
async function launchOwnedChrome() {
  const executable = process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : process.env.CHROME_BINARY;
  assert.ok(executable && fs.existsSync(executable), "Chrome is unavailable; supply an existing loopback --cdp endpoint or CHROME_BINARY");
  profile = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-browser-smoke-"));
  chrome = spawn(executable, ["--headless=new", "--remote-debugging-port=0", "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--window-size=1440,1000", "about:blank"], { detached: process.platform !== "win32", stdio: "ignore" });
  let launchError;
  chrome.once("error", (error) => { launchError = error; });
  const file = path.join(profile, "DevToolsActivePort");
  const port = await until(() => { if (launchError) throw launchError; return fs.existsSync(file) && fs.readFileSync(file, "utf8").split("\n")[0]; }, "Owned Chrome debugging port");
  return "http://127.0.0.1:" + port;
}
async function connect() {
  const endpoint = options.launch ? await launchOwnedChrome() : options.cdp;
  const address = localUrl(endpoint, ["http:", "https:", "ws:", "wss:"]);
  let webSocketUrl = endpoint;
  if (address.protocol.startsWith("http")) {
    const response = await fetch(new URL("/json/version", address), { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("CDP /json/version returned HTTP " + response.status + "; use a real Chrome CDP endpoint or --launch for a disposable owned browser");
    webSocketUrl = (await response.json()).webSocketDebuggerUrl;
    assert.ok(webSocketUrl, "CDP version response has no browser WebSocket endpoint");
    localUrl(webSocketUrl, ["ws:", "wss:"]);
  }
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  cdp = new CDP(socket);
  ({ browserContextId } = await cdp.send("Target.createBrowserContext", { disposeOnDetach: true }));
  ({ targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId }));
  ({ sessionId: pageSession } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }));
  ownSessions.add(pageSession);
  cdp.listeners.add((event) => {
    if (!ownSessions.has(event.sessionId)) return;
    if (event.method === "Target.attachedToTarget") {
      ownSessions.add(event.params.sessionId);
      void cdp.send("Runtime.enable", {}, event.params.sessionId).catch(() => {});
    }
    if (event.method === "Runtime.executionContextCreated" && event.params.context.auxData?.isDefault) executionContexts.set(event.sessionId + ":" + event.params.context.id, { sessionId: event.sessionId, ...event.params.context });
    if (event.method === "Runtime.executionContextDestroyed") executionContexts.delete(event.sessionId + ":" + event.params.executionContextId);
    if (event.method === "Network.requestWillBeSent") {
      const request = event.params.request;
      if (request.url.startsWith(origin + "/api/")) pendingRequests.set(event.sessionId + ":" + event.params.requestId, { route: new URL(request.url).pathname, method: request.method });
    }
    if (event.method === "Network.loadingFinished") {
      const request = pendingRequests.get(event.sessionId + ":" + event.params.requestId);
      if (request && (request.method === "POST" || /^\/api\/chat\/runs\/[^/]+\/changes$/.test(request.route))) void cdp.send("Network.getResponseBody", { requestId: event.params.requestId }, event.sessionId).then(({ body, base64Encoded }) => {
        let result; try { result = JSON.parse(base64Encoded ? Buffer.from(body, "base64").toString() : body); } catch { return; }
        responses.push({ ...request, result, time: Date.now() });
        if (request.route === "/api/previews" && result.preview?.id) ownedPreviews.add(result.preview.id);
        if (request.route === "/api/process-sessions" && result.session?.id) ownedProcesses.add(result.session.id);
      }).catch(() => {});
    }
  });
  await cdp.send("Runtime.enable", {}, pageSession);
  await cdp.send("Network.enable", {}, pageSession);
  await cdp.send("Page.enable", {}, pageSession);
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, pageSession);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, pageSession);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `
    localStorage.setItem("app-locale","en");
    globalThis.__smokeAllowed=false;globalThis.__smokeBlocked=[];globalThis.__smokeInlineStates=[];globalThis.__smokeProgress=[];
    const nativeSend=WebSocket.prototype.send;
    WebSocket.prototype.send=function(data){let value;try{value=JSON.parse(data)}catch{}
      const review=globalThis.__smokeReviewAllowed&&value?.mode==="code"&&value?.modelName==="local-fixture"&&value?.message==="FIXTURE_REVIEW: format the interview document";
      if(value?.requestId&&typeof value.message==="string"&&(!globalThis.__smokeAllowed||(!review&&value.mode!=="ask")||(value.modelName&&value.modelName!=="local-fixture")||value.message.includes("FIXTURE_EDIT"))){globalThis.__smokeBlocked.push("Unsafe Agent request");throw new Error("Smoke safety gate blocked Agent request")}
      if(review){globalThis.__smokeReviewRequest=value;globalThis.__smokeReviewSocket=this;}
      return nativeSend.call(this,data)};
    const nativeFetch=window.fetch;
    window.fetch=function(input,init){const url=new URL(typeof input==="string"?input:input.url,location.href);const method=(init?.method||"GET").toUpperCase();
      if(url.pathname.startsWith("/api/files")&&!["GET","HEAD"].includes(method)){globalThis.__smokeBlocked.push("Unexpected file write");return Promise.reject(new Error("Smoke forbids file writes"))}
      return nativeFetch.apply(this,arguments)};
    addEventListener("DOMContentLoaded",()=>new MutationObserver(()=>{const panel=document.querySelector('[data-testid="inline-assistant"]');if(panel)globalThis.__smokeInlineStates.push({busy:panel.getAttribute("aria-busy")==="true",disabled:panel.querySelector(".inline-assistant-accept")?.disabled});
      if(globalThis.__smokeReviewAllowed){const phase=document.querySelector('.editor-assistant-panel .assistant-activity')?.dataset.phase;const reasoningNode=document.querySelector('.editor-assistant-panel [data-assistant-reasoning]');const reasoning=reasoningNode?.textContent;const reasoningVisible=Boolean(reasoningNode?.getBoundingClientRect().height);const tool=document.querySelector('.editor-assistant-panel [data-assistant-tool-call-id]')?.textContent;const previous=globalThis.__smokeProgress.at(-1);if(previous?.phase!==phase||previous?.reasoning!==reasoning||previous?.reasoningVisible!==reasoningVisible||previous?.tool!==tool)globalThis.__smokeProgress.push({phase,reasoning,reasoningVisible,tool});}
    }).observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:["disabled","aria-busy","data-phase","data-status"]}));
  ` }, pageSession);
  await cdp.send("Page.navigate", { url: origin + "/login" }, pageSession);
}
async function modelValue() { return evaluate("globalThis.__smokeEditor.getModel().getValue()"); }
async function selectSecondLine() {
  // Public Monaco API places the caret; actual input events perform selection and shortcuts.
  // The @ picker restores composer focus on the next animation frame. Finish
  // that UI transition before targeting a different input surface.
  await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))");
  await until(() => evaluate("globalThis.__smokeEditor.focus();globalThis.__smokeEditor.setPosition({lineNumber:2,column:1});globalThis.__smokeEditor.hasTextFocus()"), "Editor keyboard focus");
  await key("End", "End", 35, 8);
  return evaluate("globalThis.__smokeEditor.getModel().getValueInRange(globalThis.__smokeEditor.getSelection())");
}

try {
  await scenario("isolated_chrome_context", connect, true);
  await scenario("ui_login_and_offline_fixture_gate", async () => {
    await until(() => call(() => Boolean(document.querySelector("#login-username"))), "Login form");
    primaryModifier = await call(() => /Mac/.test(navigator.platform) ? 4 : 2);
    await fill("#login-username", "fixture"); await fill("#login-password", "local-fixture-only"); await click(".login-btn");
    await until(() => call(() => Boolean(localStorage.getItem("ai-ide-token"))), "Fixture login");
    const auth = await uiApi("/api/auth/me");
    assert.equal(auth.username, "fixture"); assert.equal(auth.desktop, false);
    safeWorkspace = fs.realpathSync(auth.workspaceDir);
    const fixtureParent = path.dirname(safeWorkspace);
    assert.equal(path.basename(safeWorkspace), "workspace");
    assert.match(path.basename(fixtureParent), /^crownforge-browser-fixture-[A-Za-z0-9_-]+$/);
    assert.ok(fixtureParent.startsWith(fs.realpathSync(os.tmpdir()) + path.sep), "Fixture must be inside the operating-system temporary directory");
    if (options.workspace) assert.equal(safeWorkspace, fs.realpathSync(options.workspace), "--workspace does not match the authenticated fixture");
    const [runtime, settings] = await Promise.all([uiApi("/api/chat/runtime-options"), uiApi("/api/admin/settings")]);
    assert.equal(runtime.defaultModelName, "local-fixture"); assert.equal(runtime.modeModels.ask, "local-fixture");
    if (options.review) assert.equal(runtime.modeModels.code, "local-fixture");
    assert.equal(settings.llm.modelName, "local-fixture"); localUrl(settings.llm.vllmApiUrl);
    for (const model of settings.llm.models || []) if (model.modelName === 'local-fixture') localUrl(model.apiUrl);
    for (const fallback of settings.llm.fallbacks || []) localUrl(fallback.apiUrl);
    const fixtureSettings = JSON.parse(fs.readFileSync(path.join(fixtureParent, "settings.json"), "utf8"));
    assert.equal(fixtureSettings.llm.modelName, "local-fixture"); assert.equal(fixtureSettings.llm.vllmApiUrl, settings.llm.vllmApiUrl);
    await call((workspace) => { globalThis.__smokeWorkspace = workspace; globalThis.__smokeAllowed = true; }, safeWorkspace);
    diskBefore = fs.readFileSync(path.join(safeWorkspace, "calculator.ts"), "utf8");
    assert.match(diskBefore, /export function add\(a: number, b: number\)/);
    await click('[data-tree-path="calculator.ts"]');
    await until(() => call(() => Boolean(document.querySelector(".monaco-editor textarea"))), "Monaco editor");
    await until(() => call(async () => {
      const url = performance.getEntriesByType("resource").map((entry) => entry.name).find((name) => /\/monaco-editor\.js(?:\?|$)/.test(name));
      if (!url) return false;
      const monaco = await import(url);
      const instance = monaco.editor.getEditors().find((editor) => editor.getModel()?.uri.path.endsWith("/calculator.ts"));
      if (!instance) return false;
      globalThis.__smokeEditor = instance; return true;
    }), "Loaded calculator Monaco model");
    assert.equal(await modelValue(), diskBefore);
  }, true);
  if (options.review) {
    await scenario("review_fixture_run", async () => {
      assert.equal(fs.readFileSync(path.join(safeWorkspace, "review-doc.md"), "utf8").startsWith("请在当前目录"), true, "Review requires a fresh disposable fixture");
      await click('[data-tree-path="review-doc.md"]');
      await click('.editor-assistant-composer .model-selector button');
      await call(() => {
        const option = [...document.querySelectorAll('.workbench-select-option')].find((node) => node.querySelector('strong')?.textContent === 'local-fixture');
        if (!option) throw new Error('Explicit fixture model option is missing');
        option.setAttribute('data-smoke-local-model', 'true');
      });
      await click('[data-smoke-local-model]');
      await call(() => { globalThis.__smokeReviewAllowed = true; });
      await fill('.editor-assistant-composer textarea', "FIXTURE_REVIEW: format the interview document");
      await click('.editor-assistant-send-btn');
      await until(() => call(() => document.querySelector('.tool-approval-card')?.textContent.includes('edit_file')), "Edit approval", 30_000);
      await click('.tool-approval-card .tool-approval-allow');
      await until(() => call(() => document.querySelector('.editor-assistant-message.assistant')?.textContent.includes('内容已保留。')), "Complete fixture reply", 30_000);
      await until(() => call(() => document.querySelectorAll('.editor-change-review-zone').length >= 2), "Two editor review hunks");
      assert.ok(fs.readFileSync(path.join(safeWorkspace, "review-doc.md"), "utf8").startsWith('# 技术面试'));
    }, true);
    await scenario("live_reasoning_and_activity", async () => {
      const observations = await evaluate('globalThis.__smokeProgress');
      for (const phase of ['waiting', 'reasoning', 'approval']) assert.ok(observations.some((entry) => entry.phase === phase), 'Missing visible phase: ' + phase);
      assert.ok(observations.some((entry) => entry.reasoningVisible && entry.reasoning?.includes('Fixture reasoning: inspect Markdown structure.')), 'Provider reasoning is invisible');
      assert.ok(observations.some((entry) => entry.tool?.includes('read_file')), 'Tool activity is invisible');
    });
    await scenario("kept_changes_leave_editor_and_remain_in_history", async () => {
      const before = fs.readFileSync(path.join(safeWorkspace, 'review-doc.md'), 'utf8');
      await click('.editor-change-review-zone button[aria-label="Open full change review"]', true);
      await until(() => call(() => document.querySelector('.run-review-file-heading')?.textContent.includes('review-doc.md')), 'Full Changes review opened');
      await click('.run-review-hunks > summary');
      const selector = '.editor-change-review-zone .editor-change-review-actions button:first-child';
      await click(selector, true);
      await until(() => call(() => document.querySelectorAll('.editor-change-review-zone').length === 1
        && document.querySelectorAll('.run-review-hunk .run-review-state.kept').length === 1), 'Only the pending block stays; Changes sees first keep', 4000);
      assert.equal(await call(() => document.querySelector('.editor-change-review-deleted')?.textContent.includes('请在当前目录')), false, 'Accepted deletion is still displayed in the editor');
      // Confirm the remaining change from the separate Changes reader; the
      // editor must react without a file edit, tab switch or manual refresh.
      await call(() => {
        const button = [...document.querySelectorAll('.run-review-detail > .run-review-actions button')].find((node) => node.textContent.trim() === 'Keep file');
        if (!button) throw new Error('Keep file action missing');
        button.setAttribute('data-smoke-keep-file', 'true');
      });
      await click('[data-smoke-keep-file]', true);
      await until(() => call(() => document.querySelectorAll('.editor-change-review-zone').length === 0
        && document.querySelectorAll('.editor-change-review-added-line').length === 0
        && document.querySelectorAll('.run-review-hunk .run-review-state.kept').length === 2), 'Editor is clean; both retained blocks remain in Changes', 4000);
      const kept = await until(() => responses.filter((entry) => entry.route.endsWith('/changes/keep')).length >= 2 && responses.filter((entry) => entry.route.endsWith('/changes/keep')).at(-1), 'Two real keep API responses');
      const changes = await uiApi(kept.route.replace(/\/keep$/, '') + '?path=review-doc.md');
      assert.equal(changes.files[0].hunks.length, 2);
      assert.ok(changes.files[0].hunks.every((hunk) => hunk.kept), 'Keep state was not persisted on the server');
      assert.notEqual(changes.files[0].original, changes.files[0].modified, 'Historical diff was removed when keeping changes');
      assert.equal(await call(() => [...document.querySelectorAll('.run-review-detail > .run-review-actions button')].some((button) => button.textContent.trim() === 'Undo file' && !button.disabled)), true, 'Historical undo is unavailable');
      assert.equal(fs.readFileSync(path.join(safeWorkspace, 'review-doc.md'), 'utf8'), before, 'Keep changed file contents');
      assert.equal(await call(() => { const tab = document.querySelector('.tab[title="review-doc.md"][aria-selected="true"]'); return tab ? tab.classList.contains('modified') : null; }), false, 'Keep marked editor dirty or switched its tab');
      await click('.run-details-close-btn');
      await click('[data-tree-path="calculator.ts"]');
      const reopenedAt = Date.now();
      await click('[data-tree-path="review-doc.md"]');
      await until(() => call(() => Boolean(document.querySelector('.tab[title="review-doc.md"][aria-selected="true"]'))), 'Return to reviewed file');
      await until(() => responses.some((entry) => entry.method === 'GET' && entry.time >= reopenedAt
        && entry.result.files?.some((file) => file.path === 'review-doc.md' && typeof file.modified === 'string')), 'Reopened file review reloaded');
      assert.equal(await call(() => document.querySelectorAll('.editor-change-review-zone, .editor-change-review-added-line').length), 0, 'Reviewed decorations returned on reopening');
    });
    await scenario("reply_stays_inside_narrow_panel", async () => {
      for (const width of [1440, 1000]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false }, pageSession);
        if (width === 1000) {
          await call(() => document.querySelector('.assistant-resize-handle').focus());
          await key('Home', 'Home', 36);
          await until(() => call(() => document.querySelector('.editor-assistant-panel').clientWidth <= 282), '280px collaboration panel');
        }
        await sleep(250);
        await call(() => { document.querySelector('.editor-assistant-messages').scrollTop = 0; });
        if (options.artifacts) {
          fs.mkdirSync(path.resolve(options.artifacts), { recursive: true });
          const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, pageSession);
          fs.writeFileSync(path.join(path.resolve(options.artifacts), `review-${width}.png`), Buffer.from(screenshot.data, 'base64'));
        }
        const overflow = await call(() => {
          const panel = document.querySelector('.editor-assistant-panel');
          return [...panel.querySelectorAll('.editor-assistant-messages, .editor-assistant-message, .editor-assistant-message-content, .editor-assistant-composer')]
            .filter((node) => node.scrollWidth > node.clientWidth + 2).map((node) => ({ className: node.className, width: node.clientWidth, scrollWidth: node.scrollWidth }));
        });
        assert.deepEqual(overflow, [], `Reply overflow at viewport ${width}: ${JSON.stringify(overflow)}`);
        const sendVisible = await call(() => {
          const button = document.querySelector('.editor-assistant-send-btn');
          const rect = button.getBoundingClientRect(); const composer = document.querySelector('.editor-assistant-composer').getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return rect.left >= composer.left && rect.right <= composer.right && (hit === button || button.contains(hit));
        });
        assert.equal(sendVisible, true, 'Composer send button is clipped or covered');
      }
    });
  } else {
  await scenario("workspace_file_reference", async () => {
    const composer = '.editor-assistant-panel textarea[aria-label], .chat-panel textarea.chat-input';
    await fill(composer, "@file:calculator");
    await until(() => call(() => [...document.querySelectorAll('.context-reference-menu [role="option"]')].some((node) => node.textContent.trim() === "calculator.ts")), "@file candidate");
    await call(() => [...document.querySelectorAll('.context-reference-menu [role="option"]')].find((node) => node.textContent.trim() === "calculator.ts").click());
    assert.ok(await call(() => [...document.querySelectorAll(".context-reference-picker .context-reference-chip")].some((node) => node.textContent.includes("calculator.ts"))));
  });
  await scenario("inline_complete_accept_buffer_and_undo", async () => {
    let setupEdit = false;
    const selected = await selectSecondLine(); assert.match(selected, /return a [+-] b;/);
    if (!selected.includes("return a - b;")) { await cdp.send("Input.insertText", { text: "  return a - b;" }, pageSession); setupEdit = true; }
    const beforeProposal = await modelValue();
    await selectSecondLine(); await key("k", "KeyK", 75, primaryModifier);
    await until(() => call(() => Boolean(document.querySelector('[data-testid="inline-assistant"]'))), "Inline Cmd/Ctrl+K");
    assert.equal(await call(() => document.querySelector(".inline-assistant-accept").disabled), true);
    await fill(".inline-assistant textarea", "Smoke check: replace subtraction with addition; preserve the function.");
    await click(".inline-assistant-footer button:not(.inline-assistant-accept)");
    await until(() => call(() => { const panel = document.querySelector(".inline-assistant"); return panel?.getAttribute("aria-busy") === "false" && panel.querySelector(".inline-assistant-accept")?.disabled === false; }), "Completed applicable inline proposal", 45_000);
    const states = await evaluate("globalThis.__smokeInlineStates");
    assert.ok(states.some((state) => state.busy), "Generation state was never observed");
    assert.ok(states.filter((state) => state.busy).every((state) => state.disabled), "Accept became enabled during generation");
    assert.equal(fs.readFileSync(path.join(safeWorkspace, "calculator.ts"), "utf8"), diskBefore);
    await click(".inline-assistant-accept");
    assert.equal(await modelValue(), beforeProposal.replace("return a - b;", "return a + b;"));
    assert.equal(fs.readFileSync(path.join(safeWorkspace, "calculator.ts"), "utf8"), diskBefore, "Accept wrote shared fixture disk");
    await evaluate("globalThis.__smokeEditor.focus()"); await key("z", "KeyZ", 90, primaryModifier);
    await until(async () => (await modelValue()) === beforeProposal, "Inline undo restored the buffer");
    if (setupEdit) { await key("z", "KeyZ", 90, primaryModifier); await until(async () => (await modelValue()) === diskBefore, "Setup undo restored initial buffer"); }
    assert.equal(fs.readFileSync(path.join(safeWorkspace, "calculator.ts"), "utf8"), diskBefore);
  });
  await scenario("static_preview_opaque_iframe", async () => {
    await click('button[aria-label="Web preview"]');
    await until(() => call(() => Boolean([...document.querySelectorAll(".web-preview-targets button")].find((node) => node.textContent.includes("Static HTML")))), "Static preview target");
    await call(() => [...document.querySelectorAll(".web-preview-targets button")].find((node) => node.textContent.includes("Static HTML")).click());
    const started = Date.now(); await click('[role="alertdialog"] .dialog-btn.primary');
    const created = await capturedResponse("/api/previews", started); assert.ok(created.result.preview?.id);
    await until(() => call((id) => document.querySelector(".web-preview-panel iframe")?.src.includes("/preview/" + id + "/"), created.result.preview.id), "Owned preview iframe");
    const frame = await call(() => { const frame = document.querySelector(".web-preview-panel iframe"); return { sandbox: frame.getAttribute("sandbox"), src: frame.src, opaque: frame.contentDocument === null }; });
    assert.ok(frame.sandbox.includes("allow-scripts")); assert.ok(!frame.sandbox.includes("allow-same-origin")); assert.equal(frame.opaque, true);
    const context = await until(async () => {
      for (const entry of executionContexts.values()) {
        try { if (await evaluate('location.pathname.startsWith(' + JSON.stringify("/preview/" + created.result.preview.id + "/") + ') && document.title==="Preview fixture" && document.querySelector("h1")?.textContent==="Preview fixture"', entry.sessionId, entry.id)) return entry; } catch { /* frame navigated */ }
      }
      return null;
    }, "Rendered opaque preview document");
    assert.equal(await evaluate('document.getElementById("save").click();document.getElementById("status").textContent', context.sessionId, context.id), "Saved");
    await uiApi("/api/previews/" + created.result.preview.id, "DELETE");
    ownedPreviews.delete(created.result.preview.id);
  });
  await scenario("long_command_session_input_and_exit", async () => {
    await click('button[aria-label="Run and Test Center"]');
    await click(".process-sessions > summary");
    await until(() => call(() => Boolean(document.querySelector('.process-sessions select[aria-label="Choose a project task"] option[value="npm:wait"]'))), "wait task");
    await call(() => { const select = document.querySelector('.process-sessions select[aria-label="Choose a project task"]'); select.value = "npm:wait"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await call(() => [...document.querySelectorAll(".process-sessions button")].find((node) => node.textContent.includes("Start session")).click());
    const started = Date.now(); await click('[role="alertdialog"] .dialog-btn.primary');
    const created = await capturedResponse("/api/process-sessions", started); assert.ok(created.result.session?.id);
    await until(() => call((id) => document.querySelector('.process-sessions select[aria-label="Choose a session"]')?.value === id, created.result.session.id), "Owned process selected");
    await until(() => call(() => document.querySelector(".process-sessions .run-output")?.textContent.includes("session ready")), "Streaming command output");
    await fill('.process-sessions input[aria-label="Send input to the running command"]', "exit");
    await click('.process-sessions button[type="submit"]');
    await until(async () => (await uiApi("/api/process-sessions/" + created.result.session.id)).session.status === "exited", "Process exited after stdin");
    await until(() => call(() => document.querySelector(".process-sessions .run-output")?.textContent.includes("input: exit")), "stdin echo in the UI");
    ownedProcesses.delete(created.result.session.id);
  });
  }
  await scenario("no_shared_disk_write_or_unsafe_request", async () => {
    assert.equal(fs.readFileSync(path.join(safeWorkspace, "calculator.ts"), "utf8"), diskBefore);
    assert.deepEqual(await evaluate("globalThis.__smokeBlocked"), []);
  });
} catch (error) {
  if (!results.length) console.log(JSON.stringify({ scenario: "bootstrap", status: "fail", reason: safeError(error) }));
  process.exitCode = 1;
} finally {
  if (cdp && pageSession && safeWorkspace) {
    await call(() => { const request = globalThis.__smokeReviewRequest; if (request && globalThis.__smokeReviewSocket?.readyState === 1) globalThis.__smokeReviewSocket.send(JSON.stringify({ type: 'stop', requestId: request.requestId, conversationId: request.conversationId })); }).catch(() => {});
    for (const id of ownedPreviews) await uiApi("/api/previews/" + id, "DELETE").catch(() => {});
    for (const id of ownedProcesses) await uiApi("/api/process-sessions/" + id, "DELETE").catch(() => {});
    await uiApi("/api/auth/logout", "POST").catch(() => {});
  }
  if (cdp && browserContextId) {
    try { await cdp.send("Target.disposeBrowserContext", { browserContextId }); ownedContextDisposed = true; }
    catch (error) { const result = { scenario: "owned_context_cleanup", status: "fail", reason: safeError(error) }; results.push(result); console.log(JSON.stringify(result)); }
  }
  cdp?.socket.close();
  if (chrome) {
    try { if (process.platform === "win32") chrome.kill("SIGTERM"); else process.kill(-chrome.pid, "SIGTERM"); } catch {}
    await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), sleep(2000)]);
    if (chrome.exitCode === null && chrome.signalCode === null) { try { if (process.platform === "win32") chrome.kill("SIGKILL"); else process.kill(-chrome.pid, "SIGKILL"); } catch {} }
    if (profile) fs.rmSync(profile, { recursive: true, force: true });
  }
  const failed = results.filter((result) => result.status === "fail").length;
  console.log(JSON.stringify({ summary: { passed: results.length - failed, failed, ownedContextDisposed } }));
  if (failed) process.exitCode = 1;
}
