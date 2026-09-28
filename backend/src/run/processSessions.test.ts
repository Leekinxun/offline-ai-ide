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
import { startAgentProcessSession, startProjectTaskSession, listProcessSessions, pollProcessSession, inputProcessSession, stopProcessSession, type ProcessSessionOwner } from "./processSessions.js";

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
test("sessions stream incremental output, accept stdin, and preserve exact invocation and exit", async (t) => {
  const owner = fixture(t, { interactive: 'node -e "console.log(\'ready\');process.stdin.once(\'data\',data=>{console.log(\'received:\'+data);process.exit(0)})"' });
  const record = startProjectTaskSession(owner, "npm:interactive");
  assert.equal(record.status, "running");
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
  assert.equal((await waitFor(owner, timeout.id, (value) => value.session.status !== "running")).session.status, "timed_out");
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
  if (!probeFilesystemIsolation().available) { assert.throws(() => startAgentProcessSession(input), /isolation|sandbox/i); return; }
  const session = startAgentProcessSession(input);
  assert.throws(() => pollProcessSession({ ...owner, runId: "other-run" }, session.id), /not found/);
  const finished = await waitFor({ ...owner, runId: "agent-run" }, session.id, (value) => value.session.status !== "running");
  assert.equal(hits, 0);
  assert.match(finished.events.map((event) => event.text).join(""), /network-blocked/);
  assert.equal(finished.session.status, "exited");
});

test("the IPC watchdog stops ordinary descendants when the backend crashes", async (t) => {
  const owner = fixture(t, { watch: 'node -e "require(\'fs\').writeFileSync(\'task.pid\',String(process.pid));setInterval(()=>{},1000)"' });
  const moduleUrl = pathToFileURL(path.resolve("src/run/processSessions.ts")).href;
  const script = `import {startProjectTaskSession} from ${JSON.stringify(moduleUrl)};const record=startProjectTaskSession(${JSON.stringify(owner)},"npm:watch");console.log(record.id);`;
  const backend = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => backend.kill("SIGKILL"));
  let output = ""; backend.stdout.on("data", (chunk) => output += chunk.toString());
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
  assert.equal(alive, false, "The IPC watchdog must kill the task after the backend exits");
  assert.equal(pollProcessSession(owner, output.trim()).session.status, "interrupted");
});
