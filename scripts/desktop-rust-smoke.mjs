import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import crypto from "node:crypto";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.resolve(process.env.CROWNFORGE_TEST_NATIVE_IDE || path.join(project, "desktop/rust/target/debug", `crownforge-ide-core${process.platform === "win32" ? ".exe" : ""}`));
assert.ok(fs.existsSync(executable), "Build crownforge-ide-core before running the smoke test");
assert.ok(fs.existsSync(path.join(project, "backend/dist/index.js")), "Build the retained backend before running the smoke test");
const require = createRequire(path.join(project, "backend/package.json"));
const { WebSocket } = require("ws");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-rust-smoke-"));
const workspace = path.join(directory, "workspace");
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, "sample.ts"), "export const message = 'Rust 中文';\n");
fs.writeFileSync(path.join(workspace, ".env"), "SECRET=Rust_PRIVATE\n");
execFileSync("git", ["init", "--quiet"], { cwd: workspace });
const users = path.join(directory, "users.json");
const bootstrapToken = crypto.randomBytes(32).toString("hex");
fs.writeFileSync(users, JSON.stringify({ allowedRoots: [directory], pendingRegistrations: [], users: [{ username: "fixture", password: crypto.randomBytes(24).toString("hex"), defaultWorkspace: workspace, isAdmin: true }] }), { mode: 0o600 });
const child = spawn(process.execPath, [path.join(project, "desktop/rust/runtime/bootstrap.cjs")], {
  cwd: directory,
  env: { ...process.env, CREWFORGE_DESKTOP: "1", CROWNFORGE_IDE_CORE_EXECUTABLE: executable,
    CROWNFORGE_DESKTOP_RUNTIME: "tauri", CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN: bootstrapToken,
    CROWNFORGE_BACKEND_BOOTSTRAP: path.join(project, "backend/bootstrap.cjs"),
    HOST: "127.0.0.1", PORT: "0", USERS_CONFIG: users, WORKSPACE_DIR: workspace,
    APP_SETTINGS_CONFIG: path.join(directory, "settings.json"), TEAM_STORE_ROOT: directory,
    PLUGINS_DIR: path.join(directory, "plugins"), STATIC_DIR: path.join(project, "frontend/dist"),
  }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
});
// Only disposable fixture diagnostics are retained. Never publish auth tokens or raw logs.
let diagnostics = "";
child.stderr.on("data", (data) => { diagnostics = (diagnostics + data.toString()).slice(-8192); });
const exited = once(child, "exit");
const lines = readline.createInterface({ input: child.stdout });
const checks = [];
const frames = [];
let socket;
let stage = "desktop backend readiness";
let cursorRequests = "";
let cursorReplies = 0;

async function bounded(promise, milliseconds = 15_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Smoke operation timed out")), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

try {
  const base = await bounded(new Promise((resolve, reject) => {
    lines.on("line", (line) => {
      try { const value = JSON.parse(line); if (value.type === "ready") resolve(value.url); else if (value.type === "error") reject(new Error("Desktop backend failed to start")); }
      catch { reject(new Error("Desktop host protocol contains non-JSON output")); }
    });
    child.once("error", reject); child.once("exit", () => reject(new Error("Desktop backend exited before ready")));
  }));
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  stage = "authenticated desktop HTTP contracts";
  const unauthorizedBootstrap = await fetch(`${base}/api/auth/me`, { signal: AbortSignal.timeout(5000) });
  assert.equal(unauthorizedBootstrap.status, 401);
  checks.push("unauthenticated loopback cannot bootstrap the Tauri desktop session");
  const meResponse = await fetch(`${base}/api/auth/me`, { headers: { "X-CrownForge-Desktop-Bootstrap": bootstrapToken }, signal: AbortSignal.timeout(5000) });
  assert.equal(meResponse.status, 200);
  const me = await meResponse.json(); assert.ok(me.token); assert.equal(me.desktop, true);
  const headers = { Authorization: `Bearer ${me.token}`, "Content-Type": "application/json" };
  async function api(route, options = {}) {
    const response = await fetch(`${base}${route}`, { ...options, headers, signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200, `${route} failed with HTTP ${response.status}`);
    return response.json();
  }
  assert.equal((await api("/api/health")).status, "ok"); checks.push("private sidecar readiness and local desktop session");
  const tree = await api("/api/files/tree"); assert.ok(tree.some((entry) => entry.name === "sample.ts")); checks.push("Rust file tree");
  const read = await api("/api/files/read?path=sample.ts"); assert.match(read.content, /Rust 中文/); checks.push("Rust UTF-8 file read");
  const search = await api("/api/files/search?query=Rust&useIgnoreFiles=false");
  assert.ok(search.results.some((entry) => entry.path === "sample.ts"));
  assert.ok(search.results.every((entry) => entry.path !== ".env")); checks.push("embedded search and protected paths");
  const status = await api("/api/files/git-status"); assert.equal(status.isRepo, true); checks.push("Rust-managed Git status");
  await api("/api/files/write", { method: "POST", body: JSON.stringify({ path: "sample.ts", content: "export const message = 'Saved through existing mutation protocol';\n", expectedVersion: read.version }) });
  const saved = await api("/api/files/read?path=sample.ts"); assert.match(saved.content, /Saved through/); assert.equal(saved.source, "user"); checks.push("existing save, version and mutation contract");

  socket = new WebSocket(`${base.replace(/^http/, "ws")}/ws/terminal?protocol=2&token=${encodeURIComponent(me.token)}`);
  const clientKey = crypto.randomUUID(); const documentId = crypto.randomUUID();
  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString()); frames.push(frame);
    if (process.platform !== "win32" || frame.type !== "output") return;
    // portable-pty starts ConPTY with INHERIT_CURSOR. A real xterm answers its
    // DSR request; this raw WebSocket fixture must provide the same handshake.
    cursorRequests += frame.data;
    const request = /\x1b\[6n/g;
    for (const _match of cursorRequests.matchAll(request)) {
      socket.send(JSON.stringify({ type: "input", data: "\x1b[1;1R" })); cursorReplies++;
    }
    cursorRequests = cursorRequests.replace(request, "").slice(-8);
  });
  await bounded(once(socket, "open"));
  socket.send(JSON.stringify({ type: "attach", clientKey, documentId }));
  const waitForFrame = async (predicate) => {
    let timer; let failed; let closed;
    try {
      return await bounded(new Promise((resolve, reject) => {
        const find = () => { const value = frames.find(predicate); if (value) resolve(value); };
        timer = setInterval(find, 10);
        failed = reject;
        closed = () => { find(); if (!frames.some(predicate)) reject(new Error("Terminal closed before expected frame")); };
        socket.once("error", failed); socket.once("close", closed); find();
      }));
    } finally { clearInterval(timer); socket.off("error", failed); socket.off("close", closed); }
  };
  stage = "terminal attach readiness";
  const ready = await waitForFrame((frame) => frame.type === "ready");
  socket.send(JSON.stringify({ type: "ready_ack", ticket: ready.ticket }));
  const outputText = () => frames.filter((frame) => frame.type === "output").map((frame) => frame.data).join("");
  const displayText = () => outputText().replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  if (process.platform === "win32") {
    stage = "PowerShell interactive prompt after ConPTY handshake";
    await waitForFrame(() => /PS [\s\S]*>\s*$/.test(displayText()));
    socket.send(JSON.stringify({ type: "input", data: "[Console]::WriteLine('RUST_SMOKE_' + 'ASCII_READY')" }));
    socket.send(JSON.stringify({ type: "input", data: "\r" }));
    stage = "PowerShell ASCII execution after prompt readiness";
    await waitForFrame(() => outputText().includes("RUST_SMOKE_ASCII_READY"));
    checks.push("PowerShell prompt readiness and actual ASCII execution");
  }
  socket.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
  // Split the marker in the command so an echoed input line cannot satisfy the output assertion.
  socket.send(JSON.stringify({ type: "input", data: process.platform === "win32" ? "Write-Output ('RUST_SMOKE_' + 'UTF8_中文')\r" : "printf 'RUST_SMOKE_%s\\n' 'UTF8_中文'\n" }));
  stage = "terminal UTF-8 command output";
  await waitForFrame(() => outputText().includes("RUST_SMOKE_UTF8_中文"));
  checks.push("framed WebSocket to Rust PTY, resize and UTF-8 output");
  socket.send(JSON.stringify({ type: "stop" }));
  stage = "terminal stop cleanup";
  await waitForFrame((frame) => frame.type === "exit");
  socket.close(); socket = undefined; checks.push("terminal stop and process cleanup");
  child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
  stage = "private sidecar shutdown";
  const [code] = await bounded(exited, 8000); assert.equal(code, 0); checks.push("sidecar shutdown through private host protocol");
  const report = { status: "passed", platform: process.platform, architecture: process.arch, checks, cursorReplies, windowsSandboxVerified: false };
  const reportPath = path.join(project, ".artifacts/app-rust/smoke-report.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(`${stage}: ${error instanceof Error ? error.message : "Rust desktop smoke failed"}`);
  // Paths and fixture-only diagnostics remain local, separate from the concise test report.
  const failurePath = path.join(project, ".artifacts/app-rust/smoke-failure.log");
  const terminalOutput = frames.filter(frame => frame.type === "output").map(frame => frame.data).join("").slice(-8192);
  fs.mkdirSync(path.dirname(failurePath), { recursive: true }); fs.writeFileSync(failurePath, JSON.stringify({
    stage, checks, cursorReplies, frameTypes: frames.map(frame => frame.type), terminalOutput, fixtureDiagnostics: diagnostics,
  }, null, 2));
  process.exitCode = 1;
} finally {
  socket?.terminate(); lines.close();
  if (!child.stdin.destroyed) child.stdin.end(`${JSON.stringify({ type: "shutdown" })}\n`);
  if (child.exitCode === null) {
    try { await bounded(exited, 8000); } catch {
      if (process.platform === "win32" && child.pid) {
        try { execFileSync(path.join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10_000, stdio: "ignore" }); } catch { /* The owned child may already have exited. */ }
      } else child.kill();
      await bounded(exited, 5000).catch(() => {});
    }
  }
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
