import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This tests the shipped Linux execution helper with real bubblewrap. Docker
// supplies a disposable Linux kernel; it does not prove Windows/WSL/DrvFS paths.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.join(root, ".artifacts", "wsl-execution-linux", "report.json");
const docker = process.env.DOCKER_BIN || (fs.existsSync("/Applications/Docker.app/Contents/Resources/bin/docker")
  ? "/Applications/Docker.app/Contents/Resources/bin/docker" : "docker");
const image = process.env.CROWNFORGE_WSL_HELPER_SMOKE_IMAGE || "crewforge-wsl-helper-test:local";
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-wsl-linux-smoke-"));
const containerName = `crewforge-wsl-smoke-${crypto.randomUUID()}`;
const startedAt = Date.now();
const compiledInputs = {};

async function containerDriver() {
  const assert = require("node:assert/strict");
  const { spawn } = require("node:child_process");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const net = require("node:net");
  const crypto = require("node:crypto");
  const helper = "/fixture/backend/dist/agent/wslHelper.js";
  const preload = "/fixture/kernel-preload.mjs";
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-wsl-payload-"));
  const cases = [];
  const live = new Set();
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let server;
  process.stderr.write(`Linux fixture driver started as uid ${process.getuid()}\n`);

  function writeAtomic(file, value) {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value));
    fs.renameSync(temporary, file);
  }

  async function until(predicate, label, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await delay(50);
    }
    assert.fail(`Timed out waiting for ${label}`);
  }

  function processTable() {
    const records = [];
    for (const name of fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
      try {
        const value = fs.readFileSync(`/proc/${name}/stat`, "utf8");
        const fields = value.slice(value.lastIndexOf(")") + 2).split(" ");
        records.push({ pid: Number(name), parent: Number(fields[1]), start: fields[19], state: fields[0] });
      } catch { /* A process may exit between directory enumeration and stat. */ }
    }
    return records;
  }

  function descendants(pid) {
    const table = processTable();
    const ids = new Set([pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of table) {
        if (ids.has(record.parent) && !ids.has(record.pid)) { ids.add(record.pid); changed = true; }
      }
    }
    return table.filter((record) => ids.has(record.pid));
  }

  async function assertReaped(records) {
    assert.ok(records.length >= 3, `Expected helper and actual Linux descendants, got ${JSON.stringify(records)}`);
    await until(() => {
      const current = processTable();
      return records.every((old) => !current.some((record) => record.pid === old.pid && record.start === old.start));
    }, "owned Linux process tree to disappear", 3000);
  }

  function start(command, overrides = {}) {
    const id = crypto.randomUUID();
    const directory = path.join(fixture, id);
    const workspace = path.join(directory, "workspace");
    const controlDirectory = path.join(directory, "control");
    const outsideDirectory = path.join(directory, "outside");
    for (const item of [workspace, controlDirectory, outsideDirectory, path.join(workspace, "nested"), path.join(workspace, ".git"), path.join(workspace, ".history")]) fs.mkdirSync(item, { recursive: true });
    fs.writeFileSync(path.join(workspace, "alpha.txt"), "allowed-sentinel");
    fs.writeFileSync(path.join(workspace, "nested", "read.txt"), "nested-sentinel");
    fs.writeFileSync(path.join(workspace, ".env"), "fixture-env-sentinel");
    fs.writeFileSync(path.join(workspace, ".git", "config"), "fixture-git-sentinel");
    fs.writeFileSync(path.join(workspace, ".history", "event"), "fixture-history-sentinel");
    fs.writeFileSync(path.join(outsideDirectory, "secret.txt"), "fixture-outside-sentinel");
    const controlPath = path.join(controlDirectory, "control.json");
    const manifestPath = path.join(controlDirectory, "manifest.json");
    let counter = 1;
    writeAtomic(controlPath, { counter, stop: false });
    const args = typeof command === "function" ? command({ workspace, controlPath, outsideDirectory }) : command;
    const manifest = {
      version: 1, op: "execute", controlPath,
      options: {
        executable: "/bin/bash", args: ["-c", args], cwd: workspace,
        env: { CASE_MARKER: id }, networkMode: "deny", resourceLimitMode: "posix-shell",
        limits: { cpuTimeMs: 5000, maxOpenFiles: 64, wallTimeMs: 30000 },
        filesystem: { workspaceDir: workspace, readPaths: ["."], writePaths: ["."] },
        ...overrides,
      },
    };
    if (overrides.readPaths) {
      manifest.options.filesystem = { workspaceDir: workspace, readPaths: overrides.readPaths, writePaths: overrides.writePaths || [] };
      delete manifest.options.readPaths; delete manifest.options.writePaths;
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const child = spawn(process.execPath, ["--import", preload, helper, manifestPath], {
      cwd: workspace, env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.stdin.on("error", () => {});
    const heartbeat = setInterval(() => writeAtomic(controlPath, { counter: ++counter, stop: false }), 250);
    const state = { child, workspace, controlPath, outsideDirectory, closed: false, began: Date.now() };
    const completed = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => {
        clearInterval(heartbeat); state.closed = true; live.delete(state);
        resolve({ code, signal, stdout, stderr, elapsedMs: Date.now() - state.began });
      });
    });
    Object.assign(state, {
      completed,
      stopHeartbeat: () => clearInterval(heartbeat),
      stop: () => { clearInterval(heartbeat); writeAtomic(controlPath, { counter, stop: true }); },
    });
    live.add(state);
    return state;
  }

  async function complete(state, timeoutMs = 8000) {
    let timer;
    try {
      return await Promise.race([state.completed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Helper did not finish within its smoke deadline")), timeoutMs); })]);
    } finally { clearTimeout(timer); }
  }

  async function test(name, action) {
    const begin = Date.now();
    process.stderr.write(`Starting ${name}\n`);
    try { const evidence = await action(); cases.push({ name, passed: true, elapsedMs: Date.now() - begin, evidence }); }
    catch (error) { cases.push({ name, passed: false, elapsedMs: Date.now() - begin, error: error.stack || String(error) }); }
    finally {
      for (const state of [...live]) {
        state.stop();
        try { await complete(state, 2500); } catch { state.child.kill("SIGKILL"); }
      }
    }
    process.stderr.write(`Finished ${name}: ${cases.at(-1).passed ? "passed" : cases.at(-1).error}\n`);
  }

  try {
    assert.notEqual(process.getuid(), 0, "The real helper and payload smoke must run as a non-root Linux user");
    await test("Bash and enforced filesystem boundaries", async () => {
      const state = start(({ controlPath, outsideDirectory }) => `set -eu
test -n "$BASH_VERSION"
test "$(cat alpha.txt)" = allowed-sentinel
printf written > result.txt
for forbidden in .env .git/config .history/event '${controlPath}' '${outsideDirectory}/secret.txt'; do
  if cat "$forbidden" >/dev/null 2>&1; then printf 'unexpected read: %s\\n' "$forbidden"; exit 31; fi
  if (printf overwritten > "$forbidden") 2>/dev/null; then printf 'unexpected write: %s\\n' "$forbidden"; exit 32; fi
done
printf 'BASH=%s\\n' "$BASH_VERSION"`);
      state.child.stdin.end();
      const result = await complete(state);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /^BASH=\d/);
      assert.equal(fs.readFileSync(path.join(state.workspace, "result.txt"), "utf8"), "written");
      for (const [relative, value] of [[".env", "fixture-env-sentinel"], [".git/config", "fixture-git-sentinel"], [".history/event", "fixture-history-sentinel"]]) assert.equal(fs.readFileSync(path.join(state.workspace, relative), "utf8"), value);
      assert.equal(fs.readFileSync(path.join(state.outsideDirectory, "secret.txt"), "utf8"), "fixture-outside-sentinel");
      assert.equal(JSON.parse(fs.readFileSync(state.controlPath, "utf8")).stop, false);
      return { bash: result.stdout.trim(), writableResult: "written", deniedPaths: 5, exitCode: result.code };
    });

    await test("Nested read-only grant rejects mutation", async () => {
      const state = start(`set -eu; test "$(cat nested/read.txt)" = nested-sentinel; if (printf mutation > nested/read.txt) 2>/dev/null; then exit 33; fi; if cat alpha.txt >/dev/null 2>&1; then exit 34; fi; printf readonly-ok`, { readPaths: ["nested"], writePaths: [] });
      state.child.stdin.end();
      const result = await complete(state);
      assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout, "readonly-ok");
      assert.equal(fs.readFileSync(path.join(state.workspace, "nested", "read.txt"), "utf8"), "nested-sentinel");
      return { exitCode: result.code, siblingReadDenied: true, nestedWriteDenied: true };
    });

    await test("Node and npm project build under compatibility resource defaults", async () => {
      const state = start("set -eu; node --version; npm --version; npm run build; test \"$(cat dist/result.txt)\" = node-build-sentinel", {
        limits: { memoryBytes: 4 * 1024 * 1024 * 1024, cpuTimeMs: 60000, maxOpenFiles: 256, wallTimeMs: 15000 },
      });
      fs.writeFileSync(path.join(state.workspace, "package.json"), JSON.stringify({ private: true, scripts: { build: "node build.cjs" } }));
      fs.writeFileSync(path.join(state.workspace, "build.cjs"), "const fs = require('node:fs'); fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/result.txt', 'node-build-sentinel');\n");
      state.child.stdin.end();
      const result = await complete(state, 18000);
      assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /v22\./); assert.match(result.stdout, /> node build\.cjs/);
      assert.equal(fs.readFileSync(path.join(state.workspace, "dist", "result.txt"), "utf8"), "node-build-sentinel");
      return { exitCode: result.code, limits: { memoryBytes: 4 * 1024 * 1024 * 1024, cpuTimeMs: 60000, maxOpenFiles: 256 }, stdout: result.stdout.trim() };
    });

    await test("Network deny blocks a verified localhost listener", async () => {
      let connections = 0;
      server = net.createServer((socket) => { connections += 1; socket.on("error", () => {}); socket.resume(); socket.end("fixture"); });
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const port = server.address().port;
      const allow = start(`printf allowed >/dev/tcp/127.0.0.1/${port}; printf connected`, { networkMode: "inherit" });
      allow.child.stdin.end();
      const positive = await complete(allow);
      process.stderr.write(`Network positive result ${JSON.stringify(positive)} connections=${connections}\n`);
      assert.equal(positive.code, 0, positive.stderr); assert.equal(positive.stdout, "connected"); assert.equal(connections, 1);
      const deny = start(`if (printf leak >/dev/tcp/127.0.0.1/${port}) 2>/dev/null; then exit 35; fi; printf denied`);
      deny.child.stdin.end();
      const result = await complete(deny);
      process.stderr.write(`Network deny result ${JSON.stringify(result)} connections=${connections}\n`);
      assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout, "denied"); assert.equal(connections, 1);
      await new Promise((resolve) => server.close(resolve)); server = undefined;
      return { reachablePositiveControl: true, deniedConnectionReachedListener: false, exitCode: result.code };
    });

    await test("Hard CPU and open-file limits are applied", async () => {
      const state = start(`printf '%s,%s,%s,%s' "$(ulimit -St)" "$(ulimit -Ht)" "$(ulimit -Sn)" "$(ulimit -Hn)"`, { limits: { cpuTimeMs: 1000, maxOpenFiles: 64, wallTimeMs: 5000 } });
      state.child.stdin.end();
      const result = await complete(state);
      assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout, "1,1,64,64");
      const descriptors = start(`opened=0; for ((index=0; index<80; index++)); do if { exec {fd}>/dev/null; } 2>/dev/null; then opened=$((opened+1)); else printf 'exhausted:%s' "$opened"; exit 0; fi; done; exit 37`);
      descriptors.child.stdin.end();
      const exhausted = await complete(descriptors);
      assert.equal(exhausted.code, 0, exhausted.stderr);
      assert.match(exhausted.stdout, /^exhausted:\d+$/);
      const openedDescriptors = Number(exhausted.stdout.split(":")[1]);
      assert.ok(openedDescriptors > 30 && openedDescriptors < 64, exhausted.stdout);
      return { softCpuSeconds: 1, hardCpuSeconds: 1, softOpenFiles: 64, hardOpenFiles: 64, openedDescriptors, descriptorExhaustionObserved: true };
    });

    await test("CPU exhaustion actually terminates a busy Bash payload", async () => {
      const state = start("while :; do :; done", { limits: { cpuTimeMs: 1000, maxOpenFiles: 64, wallTimeMs: 5000 } });
      state.child.stdin.end();
      const result = await complete(state);
      assert.notEqual(result.code, 0); assert.ok(result.elapsedMs >= 500 && result.elapsedMs < 4500, JSON.stringify(result));
      assert.equal(result.stderr.includes("timed out"), false);
      return { exitCode: result.code, elapsedMs: result.elapsedMs, wallTimeoutWasNotCause: true };
    });

    await test("Input EOF preserves a quiet payload until completion", async () => {
      const state = start(`IFS= read -r value; test "$value" = input-sentinel; if IFS= read -r extra; then exit 36; fi; sleep 0.4; printf complete > eof-result.txt`);
      state.child.stdin.end("input-sentinel\n");
      const result = await complete(state);
      assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
      assert.equal(fs.readFileSync(path.join(state.workspace, "eof-result.txt"), "utf8"), "complete");
      return { exitCode: result.code, quietCompletionAfterEof: true };
    });

    async function sleepingTree() {
      const state = start("sleep 60 & printf ready > ready.txt; wait");
      await until(() => fs.existsSync(path.join(state.workspace, "ready.txt")) || state.closed, "sleep tree readiness");
      assert.equal(state.closed, false, "Helper exited before spawning a supervised payload");
      const tree = descendants(state.child.pid);
      assert.ok(tree.length >= 4, `Expected helper, bubblewrap and Bash/sleep, got ${JSON.stringify(tree)}`);
      return { state, tree };
    }

    await test("Stale heartbeat kills a quiet payload and every captured descendant", async () => {
      const { state, tree } = await sleepingTree();
      const begin = Date.now(); state.stopHeartbeat();
      const result = await complete(state, 19000);
      const staleElapsedMs = Date.now() - begin;
      assert.notEqual(result.code, 0); assert.ok(staleElapsedMs >= 14000 && staleElapsedMs <= 18000, JSON.stringify({ staleElapsedMs, result }));
      assert.equal(result.stdout, ""); assert.equal(result.stderr.includes("timed out"), false);
      await assertReaped(tree);
      return { exitCode: result.code, staleElapsedMs, reapedProcesses: tree.length };
    });

    await test("Stop marker promptly cleans the Linux process tree", async () => {
      const { state, tree } = await sleepingTree();
      const begin = Date.now(); state.stop();
      const result = await complete(state, 3500);
      assert.notEqual(result.code, 0); await assertReaped(tree);
      return { exitCode: result.code, stopElapsedMs: Date.now() - begin, reapedProcesses: tree.length };
    });

    await test("Helper wall timeout terminates its process tree", async () => {
      const state = start("sleep 60 & printf ready > ready.txt; wait", { limits: { cpuTimeMs: 5000, maxOpenFiles: 64, wallTimeMs: 900 } });
      await until(() => fs.existsSync(path.join(state.workspace, "ready.txt")) || state.closed, "wall-timeout payload readiness");
      assert.equal(state.closed, false); const tree = descendants(state.child.pid);
      const result = await complete(state, 3500);
      assert.notEqual(result.code, 0); assert.match(result.stderr, /timed out after 900ms/); await assertReaped(tree);
      return { exitCode: result.code, elapsedMs: result.elapsedMs, reapedProcesses: tree.length };
    });

    await test("SIGTERM to the helper cleans its Linux process tree", async () => {
      const { state, tree } = await sleepingTree();
      state.child.kill("SIGTERM");
      const result = await complete(state, 3500);
      assert.notEqual(result.code, 0); await assertReaped(tree);
      return { exitCode: result.code, reapedProcesses: tree.length };
    });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    for (const state of live) { state.stop(); state.child.kill("SIGKILL"); }
    fs.rmSync(fixture, { recursive: true, force: true });
  }
  const report = { passed: cases.every((item) => item.passed), nonRootUid: process.getuid(), cases };
  process.stdout.write(JSON.stringify(report));
  process.exitCode = report.passed ? 0 : 1;
}

let report;
try {
  for (const relative of ["agent/wslHelper.js", "agent/processSandbox.js", "agent/wslExecution.js", "agent/secretRedaction.js", "utils/nodeRuntime.js"]) {
    const source = path.join(root, "backend", "dist", relative);
    if (!fs.existsSync(source)) throw new Error(`Missing compiled module ${source}; run npm run build in backend first`);
    const bytes = fs.readFileSync(source);
    compiledInputs[relative] = crypto.createHash("sha256").update(bytes).digest("hex");
    const target = path.join(stage, "backend", "dist", relative);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
  }
  fs.writeFileSync(path.join(stage, "backend", "dist", "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(path.join(stage, "driver.cjs"), `(${containerDriver.toString()})().catch(error => { process.stdout.write(JSON.stringify({ passed: false, error: error.stack || String(error) })); process.exitCode = 1; });\n`);
  fs.writeFileSync(path.join(stage, "kernel-preload.mjs"), `import fs from 'node:fs';\nconst original = fs.readFileSync;\nfs.readFileSync = function(file, options) {\n  if (String(file) === '/proc/sys/kernel/osrelease' || String(file) === '/proc/version') {\n    const text = 'fixture-microsoft-standard-WSL2\\n';\n    const encoding = typeof options === 'string' ? options : options?.encoding;\n    return encoding ? text : Buffer.from(text);\n  }\n  return Reflect.apply(original, this, arguments);\n};\n`);
  fs.writeFileSync(path.join(stage, "wslpath"), '#!/bin/sh\n[ "$#" = 3 ] && [ "$1" = -a ] && [ "$2" = -u ] || exit 2\ncase "$3" in /fixture/*|/tmp/crewforge-wsl-payload-*) printf "%s\\n" "$3";; *) exit 2;; esac\n');
  const bootstrap = "set -eu\ninstall -o root -g root -m 0755 /fixture/wslpath /usr/bin/wslpath\nexec su -s /bin/sh node -c 'exec /usr/bin/node /fixture/driver.cjs'";
  if (!bootstrap.includes("\n") || !fs.readFileSync(path.join(stage, "wslpath"), "utf8").startsWith("#!/bin/sh\n")) throw new Error("Generated fixture scripts must contain actual newline bytes");
  const args = ["run", "--pull=never", "--rm", "--init", "--privileged", "--name", containerName, "--user", "0", "--mount", `type=bind,source=${stage},target=/fixture,readonly`, "--entrypoint", "/bin/sh", image, "-c", bootstrap];
  const result = await new Promise((resolve, reject) => {
    const child = spawn(docker, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let deadlineReached = false;
    const deadline = setTimeout(() => {
      deadlineReached = true;
      spawnSync(docker, ["rm", "--force", containerName], { stdio: "ignore", timeout: 10000 });
      child.kill("SIGTERM");
    }, 90000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-20000); });
    child.once("error", (error) => { clearTimeout(deadline); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(deadline); resolve({ stdout, stderr, code, signal, deadlineReached }); });
  });
  let container;
  try { container = JSON.parse(result.stdout); } catch { container = { passed: false, error: "Container did not return a JSON report", stdout: result.stdout.slice(-20000) }; }
  report = { ...container, passed: container.passed === true && result.code === 0 && !result.deadlineReached, image, elapsedMs: Date.now() - startedAt, compiledInputs, dockerExitCode: result.code, dockerSignal: result.signal, deadlineReached: result.deadlineReached, ...(result.stderr ? { dockerStderr: result.stderr } : {}), limitations: ["Docker Linux validates the helper, real bubblewrap isolation, limits, and cleanup; it does not validate native Windows WSL2 or DrvFS.", "Only wslpath conversion and the helper's WSL2 kernel-name detection are fixture seams; sandboxing, resource limits, sockets and process trees are real.", "Privileged Docker enables disposable user namespaces; helper and payload execute as the non-root node user.", "Only the five compiled helper modules and generated fixtures are mounted; repository configuration and workspace data are not mounted."] };
} catch (error) {
  report = { passed: false, error: error.stack || String(error), image, elapsedMs: Date.now() - startedAt, compiledInputs };
} finally {
  if (process.env.CROWNFORGE_WSL_SMOKE_KEEP_STAGE === "1") { if (report) report.debugStage = stage; }
  else fs.rmSync(stage, { recursive: true, force: true });
}
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ passed: report.passed, cases: report.cases?.length || 0, failed: report.cases?.filter((item) => !item.passed).map((item) => item.name) || [], reportPath, elapsedMs: report.elapsedMs })}\n`);
process.exitCode = report.passed ? 0 : 1;
