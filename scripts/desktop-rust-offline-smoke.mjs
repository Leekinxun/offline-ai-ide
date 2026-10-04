// macOS package-backend acceptance only: this does not certify model weights,
// GUI behavior, Windows installation, or the Agent command sandbox.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const option = (name) => process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const controlsOnly = process.argv.includes("--controls-only");
const app = path.resolve(option("--app") || path.join(project, "desktop/rust/target/release/bundle/macos/CrownForge.app"));
const runtime = path.join(app, "Contents/Resources/runtime");
const node = controlsOnly ? option("--node") : path.join(runtime, "node/node");
const reportPath = path.resolve(option("--report") || path.join(project, ".artifacts/app-rust/offline-report.json"));
assert.equal(process.platform, "darwin", "This acceptance requires macOS Seatbelt");
assert.ok(node && path.isAbsolute(node) && fs.statSync(node).isFile(), "A verified standalone or packaged Node executable is required");
assert.ok(fs.existsSync("/usr/bin/sandbox-exec"), "macOS sandbox-exec is required");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-package-offline-"));
const profile = path.join(directory, "loopback-only.sb");
function writeProfile(ports) {
  fs.writeFileSync(profile, `(version 1)
(allow default)
(deny network*)
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
${ports.map((port) => `(allow network-outbound (remote ip "localhost:${port}"))`).join("\n")}
`);
}
const report = {
  schemaVersion: 1, status: "failed", platform: process.platform, arch: process.arch,
  scope: "packaged backend cold start, private bootstrap, local protocol-fixture inference and shutdown",
  networkBoundary: "macOS Seatbelt denies networking by default; outbound is allowed only to declared host-local fixture ports, inherited by child processes",
  publicEndpointDirectlyTested: false, completeOfflineAppAccepted: false,
  realModelWeightsVerified: false, guiVerified: false, windowsInstallerVerified: false,
  checks: [],
};
let child;
let socket;
let lines;
let stage = "network controls";
let backendLog = "";
let bearer = "";
const bootstrapToken = crypto.randomBytes(32).toString("hex");
const servers = [];
const ownedChildren = new Set();

async function bounded(promise, milliseconds = 15_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${stage} timed out`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

async function serve(host, handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, host, resolve); });
  return { server, url: `http://${host}:${server.address().port}` };
}

async function execute(executable, args, env = {}) {
  const processChild = spawn(executable, args, { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  ownedChildren.add(processChild);
  let stdout = "", stderr = "";
  processChild.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-8192); });
  processChild.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8192); });
  try {
    const [code] = await bounded(once(processChild, "close"), 10_000);
    assert.equal(code, 0, `Owned control failed: ${stderr}`);
    return JSON.parse(stdout);
  } finally {
    if (processChild.exitCode === null) processChild.kill("SIGKILL");
    ownedChildren.delete(processChild);
  }
}

try {
  let loopHits = 0, undeclaredHits = 0;
  const loop = await serve("127.0.0.1", (_req, res) => { loopHits++; res.end("owned-loopback"); });
  const undeclared = await serve("127.0.0.1", (_req, res) => { undeclaredHits++; res.end("owned-undeclared-port"); });
  writeProfile([loop.server.address().port]);
  const probe = `import http from 'node:http';
async function get(url) { return new Promise(resolve => {
  const req = http.get(url, res => { res.resume(); res.on('end', () => resolve({status:res.statusCode})); });
  req.on('error', error => resolve({error:error.code||error.message}));
  req.setTimeout(2500, () => req.destroy(new Error('owned control timeout')));
}); }
console.log(JSON.stringify({nodeVersion:process.versions.node, declaredLocal:await get(${JSON.stringify(loop.url)}), undeclaredLocal:await get(${JSON.stringify(undeclared.url)})}));`;
  const open = await execute(node, ["--input-type=module", "-e", probe]);
  assert.equal(open.declaredLocal.status, 200);
  assert.equal(open.undeclaredLocal.status, 200);
  const beforeLoop = loopHits, beforeUndeclared = undeclaredHits;
  const isolated = await execute("/usr/bin/sandbox-exec", ["-f", profile, node, "--input-type=module", "-e", probe]);
  assert.equal(isolated.declaredLocal.status, 200);
  assert.match(isolated.undeclaredLocal.error || "", /^(?:EPERM|EACCES)$/, "Seatbelt must reject the reachable undeclared receiver with a permission error");
  assert.equal(loopHits, beforeLoop + 1);
  assert.equal(undeclaredHits, beforeUndeclared);
  assert.equal(isolated.nodeVersion, "22.23.3");
  report.nodeVersion = isolated.nodeVersion;
  report.controls = { unsandboxedDeclaredLocalPort: 200, unsandboxedUndeclaredLocalPort: 200, sandboxedDeclaredLocalPort: 200, sandboxedUndeclaredLocalPort: isolated.undeclaredLocal.error, blockedReceiverRequests: 0 };
  report.checks.push("Owned reachable receiver controls prove declared local-port access and kernel rejection of an undeclared port");
  if (controlsOnly) {
    report.status = "controls_passed";
  } else {
    stage = "packaged resources";
    const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const manifest = JSON.parse(fs.readFileSync(path.join(runtime, "runtime-manifest.json"), "utf8"));
    const core = path.join(runtime, "binaries/crownforge-ide-core");
    assert.equal(manifest.nodeVersion, "22.23.3");
    assert.equal(sha256(node), manifest.nodeSha256);
    assert.equal(sha256(core), manifest.ideCoreSha256);
    assert.ok(fs.existsSync(path.join(runtime, "backend/dist/auth/desktopBootstrapCredential.js")));
    assert.ok(fs.existsSync(path.join(runtime, "frontend/index.html")));
    report.packagedResources = { app, nodeSha256: manifest.nodeSha256, ideCoreSha256: manifest.ideCoreSha256, backendIndexSha256: sha256(path.join(runtime, "backend/dist/index.js")) };
    const require = createRequire(path.join(runtime, "backend/package.json"));
    const { WebSocket } = require("ws");
    const answer = `OFFLINE_LOCAL_MODEL_${crypto.randomUUID()}`;
    let completions = 0;
    const model = await serve("127.0.0.1", async (req, res) => {
      try {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ object: "list", data: [{ id: "offline-fixture-model", object: "model", owned_by: "disposable-fixture" }] }));
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(404); res.end(); return; }
      let bytes = "";
      for await (const chunk of req) { bytes += chunk; if (bytes.length > 2 * 1024 * 1024) { res.writeHead(413); res.end(); return; } }
      const input = JSON.parse(bytes);
      assert.equal(input.model, "offline-fixture-model");
      assert.ok(Array.isArray(input.messages));
      assert.equal(req.headers.authorization, undefined, "Fixture must not receive user API credentials");
      completions++;
      if (!input.stream) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "offline-fixture", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      } else {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ id: "offline-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "offline-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.end("data: [DONE]\n\n");
      }
      } catch {
        // Keep fixture failures on the ordinary HTTP/Agent error path so the
        // outer finally can still stop every owned child and receiver.
        if (!res.headersSent) res.writeHead(500);
        res.end("Disposable model fixture rejected the request");
      }
    });
    writeProfile([loop.server.address().port, model.server.address().port]);
    report.declaredFixturePorts = [loop.server.address().port, model.server.address().port];
    const finalControl = await execute("/usr/bin/sandbox-exec", ["-f", profile, node, "--input-type=module", "-e", probe]);
    assert.equal(finalControl.declaredLocal.status, 200);
    assert.match(finalControl.undeclaredLocal.error || "", /^(?:EPERM|EACCES)$/);
    assert.equal(undeclaredHits, beforeUndeclared);
    report.controls.finalBackendProfileConfirmed = true;
    report.profileSha256 = sha256(profile);
    const workspace = path.join(directory, "workspace");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "offline.txt"), "Own disposable package fixture\n");
    const users = path.join(directory, "users.json");
    fs.writeFileSync(users, JSON.stringify({ allowedRoots: [directory], pendingRegistrations: [], users: [{ username: "offline-fixture", password: crypto.randomBytes(24).toString("hex"), defaultWorkspace: workspace, isAdmin: true }] }), { mode: 0o600 });
    stage = "packaged backend cold start";
    child = spawn("/usr/bin/sandbox-exec", ["-f", profile, node, path.join(runtime, "bootstrap.cjs")], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, LANG: "en_US.UTF-8",
        CREWFORGE_DESKTOP: "1", CROWNFORGE_DESKTOP_RUNTIME: "tauri", CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN: bootstrapToken,
        CROWNFORGE_IDE_CORE_EXECUTABLE: core, CROWNFORGE_BACKEND_BOOTSTRAP: path.join(runtime, "backend/bootstrap.cjs"),
        HOST: "127.0.0.1", PORT: "0", USERS_CONFIG: users, WORKSPACE_DIR: workspace,
        APP_SETTINGS_CONFIG: path.join(directory, "settings.json"), TEAM_STORE_ROOT: directory,
        PLUGINS_DIR: path.join(directory, "plugins"), STATIC_DIR: path.join(runtime, "frontend"),
        VLLM_API_URL: `${model.url}/v1`, VLLM_API_KEY: "", MODEL_NAME: "offline-fixture-model", MCP_BASE_URLS: "",
      }, detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    ownedChildren.add(child);
    const stopped = once(child, "close");
    void stopped.catch(() => {});
    child.stderr.on("data", (chunk) => { backendLog = (backendLog + chunk).slice(-8192); });
    lines = readline.createInterface({ input: child.stdout });
    const base = await bounded(new Promise((resolve, reject) => {
      lines.on("line", (line) => { try { const frame = JSON.parse(line); if (frame.type === "ready") resolve(frame.url); else if (frame.type === "error") reject(new Error(`Packaged backend ${frame.phase || "startup"} failed`)); } catch { reject(new Error("Non-JSON host protocol output")); } });
      child.once("error", reject);
      child.once("close", () => reject(new Error("Packaged backend exited before readiness")));
    }));
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await fetch(`${base}/api/auth/me`, { signal: AbortSignal.timeout(5000) })).status, 401);
    const meResponse = await fetch(`${base}/api/auth/me`, { headers: { "X-CrownForge-Desktop-Bootstrap": bootstrapToken }, signal: AbortSignal.timeout(5000) });
    assert.equal(meResponse.status, 200);
    const me = await meResponse.json();
    assert.equal(me.desktop, true);
    assert.equal(typeof me.token, "string");
    bearer = me.token;
    const headers = { Authorization: `Bearer ${bearer}` };
    const tree = await fetch(`${base}/api/files/tree`, { headers, signal: AbortSignal.timeout(5000) });
    assert.equal(tree.status, 200);
    assert.ok((await tree.json()).some((entry) => entry.name === "offline.txt"));
    const nativeChildren = () => execFileSync("/bin/ps", ["-ww", "-axo", "pid=,ppid=,comm="], { encoding: "utf8" })
      .split("\n").flatMap((line) => {
        const entry = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
        return entry && Number(entry[2]) === child.pid && entry[3] === core ? [Number(entry[1])] : [];
      });
    const corePids = nativeChildren();
    assert.equal(corePids.length, 1, "Packaged tree access must start exactly one owned Rust service");
    const page = await fetch(base, { signal: AbortSignal.timeout(5000) });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="root"/);
    report.checks.push("Fresh disposable profile cold-starts bundled backend and Rust core, serves bundled frontend and requires private bootstrap");
    stage = "packaged local model request";
    const health = await fetch(`${base}/api/chat/model-health`, { headers, signal: AbortSignal.timeout(5000) });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ready");
    socket = new WebSocket(`${base.replace(/^http/, "ws")}/ws/chat?token=${encodeURIComponent(bearer)}`);
    const frames = [];
    let frameFailure;
    socket.on("message", (bytes) => {
      try {
        const frame = JSON.parse(bytes.toString());
        assert.ok(frame && typeof frame.type === "string", "Invalid packaged WebSocket frame");
        frames.push(frame);
      } catch { frameFailure = new Error("Malformed packaged WebSocket frame"); }
    });
    socket.on("error", () => { frameFailure = new Error("Packaged WebSocket transport failed"); });
    await bounded(once(socket, "open"));
    const requestId = crypto.randomUUID();
    socket.send(JSON.stringify({ type: "message", requestId, mode: "ask", modelName: "offline-fixture-model", message: "Reply with the disposable model fixture response; do not run tools." }));
    let modelTimer;
    try {
      await bounded(new Promise((resolve, reject) => {
        modelTimer = setInterval(() => {
          if (frameFailure) { reject(frameFailure); return; }
          const error = frames.find((frame) => frame.type === "error");
          if (error) reject(new Error(`Packaged model request failed: ${String(error.content).slice(0, 200)}`));
          else if (frames.some((frame) => frame.type === "done" && frame.requestId === requestId)) resolve();
        }, 20);
        modelTimer.unref();
      }), 30_000);
    } finally { clearInterval(modelTimer); }
    assert.ok(frames.filter((frame) => frame.type === "token").map((frame) => frame.content || "").join("").includes(answer));
    assert.ok(completions >= 1);
    assert.equal(undeclaredHits, beforeUndeclared, "No isolated child may contact the undeclared local-port receiver");
    report.model = { fixtureKind: "owned loopback OpenAI-compatible protocol fixture", completedRequests: completions, assistantStreamConfirmed: true };
    report.checks.push("Packaged Agent completes an authenticated chat turn against the owned loopback model fixture under Seatbelt");
    socket.close();
    await bounded(once(socket, "close"), 5000);
    socket = undefined;
    stage = "packaged backend shutdown";
    child.stdin.end(`${JSON.stringify({ type: "shutdown" })}\n`);
    const [code] = await bounded(stopped, 20_000);
    assert.equal(code, 0);
    for (const pid of corePids) {
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "Owned Rust service must be gone after daemon close");
    }
    report.shutdown = { backendExitCode: code, ownedRustServicesObserved: corePids.length, ownedRustServicesRemaining: 0 };
    ownedChildren.delete(child);
    report.checks.push("Private host shutdown closes the packaged Node daemon and owned Rust service with exit 0");
    report.status = "passed";
  }
} catch (error) {
  report.failure = { stage, message: error instanceof Error ? error.message : String(error) };
  process.exitCode = 1;
} finally {
  socket?.terminate();
  lines?.close();
  for (const processChild of ownedChildren) {
    if (processChild.stdin && !processChild.stdin.destroyed) processChild.stdin.end(`${JSON.stringify({ type: "shutdown" })}\n`);
    if (processChild.exitCode === null) {
      try { await bounded(once(processChild, "close"), 20_000); }
      catch { processChild.kill("SIGKILL"); await bounded(once(processChild, "close"), 5000).catch(() => {}); }
    }
  }
  if (child?.pid) {
    // Only this fixture's detached process group is eligible for forced cleanup.
    // A killed parent can leave its Rust service alive even after `close` fires.
    const groupAlive = () => {
      try { process.kill(-child.pid, 0); return true; }
      catch (error) { if (error.code === "ESRCH") return false; throw error; }
    };
    try {
      if (groupAlive()) process.kill(-child.pid, "SIGKILL");
      const deadline = Date.now() + 5_000;
      while (groupAlive()) {
        if (Date.now() >= deadline) throw new Error("Owned packaged process group did not exit");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      report.ownedProcessGroupRemaining = false;
    } catch {
      report.status = "failed";
      report.failure = { stage: "failure cleanup", message: "Could not confirm the owned packaged process group exited" };
      process.exitCode = 1;
    }
  }
  for (const server of servers) { server.closeAllConnections(); await new Promise((resolve) => server.close(() => resolve())); }
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  if (fs.existsSync(profile)) {
    fs.copyFileSync(profile, `${reportPath}.sb`);
    report.profileArtifact = `${reportPath}.sb`;
  }
  if (report.failure && backendLog) fs.writeFileSync(`${reportPath}.failure.log`, backendLog.replaceAll(bootstrapToken, "[bootstrap-redacted]").replaceAll(bearer || "unused-bearer", "[bearer-redacted]"));
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.rmSync(directory, { recursive: true, force: true });
  console.log(JSON.stringify({ status: report.status, reportPath, checks: report.checks, ...(report.failure ? { failure: report.failure } : {}) }));
}
