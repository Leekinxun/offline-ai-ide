import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import http from "node:http";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { probeFilesystemIsolation } from "../agent/processSandbox.js";
import { startAgentProcessSession, startProjectTaskSession, startPreviewProcessSession, listProcessSessions, pollProcessSession, inputProcessSession, stopProcessSession, windowsProcessTreeKillInvocation, type ProcessSessionOwner } from "./processSessions.js";

function fixture(t: test.TestContext, scripts: Record<string, string>): ProcessSessionOwner {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-process-"));
  fs.writeFileSync(path.join(workspaceDir, "package.json"), JSON.stringify({ scripts }));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  return { workspaceDir, owner: "alice", sessionToken: "session-alice" };
}
async function waitFor(owner: ProcessSessionOwner, id: string, predicate: (value: ReturnType<typeof pollProcessSession>) => boolean) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const value = pollProcessSession(owner, id); if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Process session did not reach the expected state");
}

test("Windows process tree cleanup invokes taskkill for the owned supervisor pid only", () => {
  assert.deepEqual(windowsProcessTreeKillInvocation(4321), { executable: "taskkill", args: ["/pid", "4321", "/T", "/F"] });
  for (const pid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => windowsProcessTreeKillInvocation(pid), /Invalid process tree pid/);
});

test("sessions stream incremental output, accept stdin, and preserve exact invocation and exit", async (t) => {
  const owner = fixture(t, { interactive: 'node -e "console.log(\'ready\');process.stdin.once(\'data\',data=>{console.log(\'received:\'+data);process.exit(0)})"' });
  const record = startProjectTaskSession(owner, "npm:interactive");
  assert.equal(record.status, "running");
  assert.equal(record.timeoutMs, 600_000);
  assert.equal(record.deadlineAt, record.startedAt + record.timeoutMs);
  assert.deepEqual(record.invocation?.args, ["run", "interactive"]);
  const first = await waitFor(owner, record.id, (value) => value.events.some((event) => event.text.includes("ready")));
  await inputProcessSession(owner, record.id, "hello\n");
  const finished = await waitFor(owner, record.id, (value) => value.session.status !== "running");
  assert.equal(finished.session.status, "exited"); assert.equal(finished.session.exitCode, 0);
  const delta = pollProcessSession(owner, record.id, first.nextCursor);
  assert.ok(delta.events.every((event) => event.seq > first.nextCursor));
  assert.match(delta.events.map((event) => event.text).join(""), /received:hello/);
  assert.deepEqual(pollProcessSession(owner, record.id, delta.nextCursor).events, []);
  await assert.rejects(inputProcessSession(owner, record.id, "late"), /not accepting/);
});

test("writes racing a real supervisor exit reject closed stdin without an uncaught stream error", async (t) => {
  const owner = fixture(t, {});
  const script = "require('fs').writeFileSync('supervisor.pid',String(process.ppid));require('fs').writeFileSync('payload.pid',String(process.pid));console.log('ready');setTimeout(()=>process.exit(23),1500);";
  const record = startPreviewProcessSession({ ...owner, executable: process.execPath, args: ["-e", script], targetId: "stdin-exit-race", onOutput: () => {}, onExit: () => {} });
  await waitFor(owner, record.id, (state) => state.events.some((event) => event.text.includes("ready")));
  const supervisorPid = Number(fs.readFileSync(path.join(owner.workspaceDir, "supervisor.pid"), "utf8"));
  const payloadPid = Number(fs.readFileSync(path.join(owner.workspaceDir, "payload.pid"), "utf8"));
  assert.ok(Number.isSafeInteger(supervisorPid) && supervisorPid > 0 && supervisorPid !== process.pid);
  assert.ok(Number.isSafeInteger(payloadPid) && payloadPid > 0 && payloadPid !== process.pid);
  t.after(() => { try { process.kill(payloadPid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } });
  // The test payload is the supervisor's direct child; its open stdout retains
  // the session until close while the supervisor's stdin disappears.
  process.kill(supervisorPid, "SIGKILL");
  const writes = await Promise.allSettled(Array.from({ length: 32 }, () => inputProcessSession(owner, record.id, "x".repeat(16_384))));
  const rejected = writes.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.ok(rejected.length > 0, "The closed pipe must reject at least one racing write");
  for (const result of rejected) assert.match(result.reason.message, /Process session is not accepting input/);
  await assert.rejects(inputProcessSession(owner, record.id, "late"), /Process session is not accepting input/);
  const final = await waitFor(owner, record.id, (state) => state.session.status !== "running");
  assert.equal(final.session.status, "failed");
  if (process.platform === "win32") assert.equal(final.session.exitCode, 1);
  else assert.equal(final.session.exitCode, null);
});

test("ending process stdin rejects later input while retaining its actual successful exit", async (t) => {
  const owner = fixture(t, {});
  const record = startPreviewProcessSession({ ...owner, executable: process.execPath,
    args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>{console.log('eof received');setTimeout(()=>process.exit(0),100)});console.log('ready');"],
    targetId: "stdin-eof", onOutput: () => {}, onExit: () => {} });
  await waitFor(owner, record.id, (state) => state.events.some((event) => event.text.includes("ready")));
  await inputProcessSession(owner, record.id, "", true);
  await assert.rejects(inputProcessSession(owner, record.id, "after EOF"), /Process session is not accepting input/);
  const final = await waitFor(owner, record.id, (state) => state.session.status !== "running");
  assert.equal(final.session.status, "exited"); assert.equal(final.session.exitCode, 0);
  assert.match(final.events.map((event) => event.text).join(""), /eof received/);
});

test("Electron supervisors keep Node mode internal and do not pass it to discovered project tasks", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, "electron");
  Object.defineProperty(process.versions, "electron", { value: "44.4.4", configurable: true });
  t.after(() => { if (descriptor) Object.defineProperty(process.versions, "electron", descriptor); else delete process.versions.electron; });
  const owner = fixture(t, { env: 'node -e "console.log(\'payload-mode:\'+String(process.env.ELECTRON_RUN_AS_NODE))"' });
  const project = startProjectTaskSession({ ...owner, nodeRuntime: true } as ProcessSessionOwner, "npm:env");
  const projectResult = await waitFor(owner, project.id, (state) => state.session.status !== "running");
  assert.equal(projectResult.session.status, "exited");
  assert.match(projectResult.events.map((event) => event.text).join(""), /payload-mode:undefined/);
  const preview = startPreviewProcessSession({ ...owner, executable: process.execPath,
    args: ["-e", "console.log('internal-mode:'+process.env.ELECTRON_RUN_AS_NODE)"], targetId: "internal-node",
    onOutput: () => {}, onExit: () => {} });
  const previewResult = await waitFor(owner, preview.id, (state) => state.session.status !== "running");
  assert.equal(previewResult.session.status, "exited");
  assert.match(previewResult.events.map((event) => event.text).join(""), /internal-mode:1/);
  assert.throws(() => startPreviewProcessSession({ ...owner, executable: "arbitrary-electron", args: [], targetId: "forged-node",
    onOutput: () => {}, onExit: () => {} }), /Internal Node sessions must use the backend executable/);
});
test("sessions enforce owner, workspace, run selection and bounded output", async (t) => {
  const owner = fixture(t, { flood: 'node -e "for(let i=0;i<60;i++)console.log(\'x\'.repeat(10000))"' });
  const record = startProjectTaskSession(owner, "npm:flood");
  assert.throws(() => pollProcessSession({ ...owner, owner: "bob" }, record.id), /not found/);
  assert.throws(() => stopProcessSession({ ...owner, runId: "unrelated-run" }, record.id), /not found/);
  const outside = fixture(t, {});
  assert.throws(() => pollProcessSession(outside, record.id), /not found/);
  const result = await waitFor(owner, record.id, (value) => value.session.status !== "running");
  assert.ok(result.events.reduce((count, event) => count + event.text.length, 0) <= 128_000);
  assert.equal(result.truncated, true);
  assert.throws(() => startProjectTaskSession(owner, "node -e arbitrary"), /Unknown/);
});
test("cancel and timeout terminate sessions and retain partial output", async (t) => {
  const owner = fixture(t, { watch: 'node -e "console.log(\'watching\');setInterval(()=>{},1000)"' });
  const running = startProjectTaskSession(owner, "npm:watch");
  await waitFor(owner, running.id, (value) => value.events.some((event) => event.text.includes("watching")));
  stopProcessSession(owner, running.id);
  const cancelled = await waitFor(owner, running.id, (value) => value.session.status !== "running");
  assert.equal(cancelled.session.status, "cancelled");
  assert.match(cancelled.events.map((event) => event.text).join(""), /watching/);
  const timeout = startProjectTaskSession(owner, "npm:watch", 200);
  assert.equal(timeout.timeoutMs, 200);
  assert.equal(timeout.deadlineAt, timeout.startedAt + 200);
  const expired = (await waitFor(owner, timeout.id, (value) => value.session.status !== "running")).session;
  assert.equal(expired.status, "timed_out");
  assert.equal(expired.deadlineAt, timeout.deadlineAt);
  assert.ok(expired.endedAt! >= expired.deadlineAt!);
});
test("restart metadata is interrupted and process environments exclude IDE secrets", async (t) => {
  process.env.CREWFORGE_TEST_SECRET = "must-not-inherit";
  t.after(() => delete process.env.CREWFORGE_TEST_SECRET);
  const owner = fixture(t, { env: 'node -e "console.log(process.env.CREWFORGE_TEST_SECRET||\'clean\')"' });
  const record = startProjectTaskSession(owner, "npm:env");
  const finished = await waitFor(owner, record.id, (value) => value.session.status !== "running");
  assert.match(finished.events.map((event) => event.text).join(""), /clean/);
  assert.doesNotMatch(finished.events.map((event) => event.text).join(""), /must-not-inherit/);
  const file = path.join(owner.workspaceDir, ".history/process-sessions", record.id + ".json");
  const stored = JSON.parse(fs.readFileSync(file, "utf8")); stored.status = "running"; delete stored.endedAt; fs.writeFileSync(file, JSON.stringify(stored));
  assert.equal(listProcessSessions(owner)[0].status, "interrupted");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).status, "interrupted");
  assert.equal(stored.ownerHash, crypto.createHash("sha256").update(owner.owner).digest("hex"));
});

test("Agent long sessions keep mandatory filesystem and network isolation", async (t) => {
  const owner = fixture(t, {});
  let hits = 0;
  const listener = http.createServer((_req, res) => { hits += 1; res.end("private-service"); });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => listener.close(() => resolve())));
  const address = listener.address(); assert.ok(address && typeof address !== "string");
  const input = { ...owner, runId: "agent-run", executable: process.execPath, args: ["-e", `require('http').get('http://127.0.0.1:${address.port}',()=>{console.log('ESCAPED');process.exit(1)}).on('error',()=>console.log('network-blocked'))`], timeoutMs: 2000 };
  if (!probeFilesystemIsolation().available) {
    const unsupported = process.platform === "win32" ? /POSIX hard resource limits are unavailable on win32|isolation|sandbox/i : /isolation|sandbox/i;
    assert.throws(() => startAgentProcessSession(input), unsupported);
    return;
  }
  const session = startAgentProcessSession(input);
  assert.throws(() => pollProcessSession({ ...owner, runId: "other-run" }, session.id), /not found/);
  const finished = await waitFor({ ...owner, runId: "agent-run" }, session.id, (value) => value.session.status !== "running");
  assert.equal(hits, 0);
  assert.match(finished.events.map((event) => event.text).join(""), /network-blocked/);
  assert.equal(finished.session.status, "exited");
});

test("Agent sessions fail closed on Windows where mandatory process isolation is unavailable", (t) => {
  const owner = fixture(t, {});
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", descriptor));
  assert.equal(probeFilesystemIsolation().available, false);
  assert.equal(probeFilesystemIsolation().reasonCode, "unsupported_platform");
  assert.throws(() => startAgentProcessSession({ ...owner, executable: process.execPath, args: ["-e", "console.log('must-not-run')"] }), /POSIX hard resource limits are unavailable on win32|isolation|sandbox/i);
});

test("the IPC watchdog stops ordinary descendants when the backend crashes", async (t) => {
  const owner = fixture(t, { watch: 'node -e "require(\'fs\').writeFileSync(\'task.pid\',String(process.pid));setInterval(()=>{},1000)"' });
  const moduleUrl = pathToFileURL(path.resolve("src/run/processSessions.ts")).href;
  const script = `import {startProjectTaskSession} from ${JSON.stringify(moduleUrl)};const record=startProjectTaskSession(${JSON.stringify(owner)},"npm:watch");console.log(record.id);`;
  const backend = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CROWNFORGE_WATCHDOG_DIAGNOSTICS: "1" } });
  t.after(() => backend.kill("SIGKILL"));
  let output = ""; let backendStderr = ""; let backendExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  backend.stdout.on("data", (chunk) => output += chunk.toString());
  backend.stderr.on("data", (chunk) => backendStderr += chunk.toString());
  backend.once("exit", (code, signal) => { backendExit = { code, signal }; });
  const pidFile = path.join(owner.workspaceDir, "task.pid");
  for (let attempt = 0; attempt < 160 && !fs.existsSync(pidFile); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(fs.existsSync(pidFile), "The supervised project task must start before the crash");
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  const exited = new Promise<void>((resolve) => backend.once("exit", () => resolve()));
  backend.kill("SIGKILL"); await exited;
  let alive = true;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { alive = false; break; } }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (alive) {
    const diagnosticDir = path.join(owner.workspaceDir, ".history", "process-sessions");
    console.error(`backend stdout: ${JSON.stringify(output.slice(-4096))}`);
    console.error(`backend stderr: ${JSON.stringify(backendStderr.slice(-4096))}`);
    console.error(`backend exit: ${JSON.stringify(backendExit)}`);
    try {
      console.error(`watchdog diagnostic dir exists: ${fs.existsSync(diagnosticDir)}`);
      for (const name of fs.readdirSync(diagnosticDir).filter((entry) => entry.startsWith("watchdog-"))) {
        console.error(`${name}: ${fs.readFileSync(path.join(diagnosticDir, name), "utf8")}`);
      }
    } catch (error) { console.error(`watchdog diagnostic read failed: ${(error as Error).message}`); }
  }
  assert.equal(alive, false, "The IPC watchdog must kill the task after the backend exits");
  assert.equal(pollProcessSession(owner, output.trim()).session.status, "interrupted");
});
