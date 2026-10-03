import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getDiagnostics, startDiagnosticsSession, stopDiagnosticsSession } from "../diagnostics/service.js";
import { getDesktopNativeIde, shutdownDesktopNativeIde } from "./nativeIdeClient.js";

const unixOnly = { skip: process.platform === "win32" ? "Executable fixture scripts require a Unix host; these are protocol regressions, not Windows acceptance" : false };
const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function until(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(20);
  }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

async function fixture(t: test.TestContext, failFirstWatch = false) {
  await shutdownDesktopNativeIde();
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-native-diagnostics-")));
  const workspace = path.join(root, "workspace"); const bin = path.join(root, "bin"); const state = path.join(root, "state");
  for (const directory of [workspace, bin, state]) fs.mkdirSync(directory);
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  fs.writeFileSync(path.join(workspace, "sample.py"), "initial_value = 1\n");
  fs.writeFileSync(path.join(state, "app-settings.json"), "{}\n");
  fs.writeFileSync(path.join(state, "users.json"), JSON.stringify({ users: [], allowedRoots: [workspace] }));

  const core = path.join(bin, "fixture-ide-core");
  fs.writeFileSync(core, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const state = ${JSON.stringify(state)};
const failFirstWatch = ${failFirstWatch};
let attempts = 0;
let watchId;
fs.writeFileSync(path.join(state, "core.pid"), String(process.pid));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "ping") send({ id: request.id, result: { protocolVersion: 1 } });
  else if (request.method === "watch.start") {
    attempts += 1;
    fs.writeFileSync(path.join(state, "watch-attempts"), String(attempts));
    if (failFirstWatch && attempts === 1) send({ id: request.id, error: { code: "FAILED", message: "fixture watcher startup failure" } });
    else { watchId = request.params.watchId; send({ id: request.id, result: { watchId } }); }
  } else if (request.method === "fixture.change") {
    send({ event: "fs.changed", params: { watchId, paths: ["sample.py"], overflow: false } });
    send({ id: request.id, result: null });
  } else if (request.method === "fixture.disconnect") {
    process.stdout.write(JSON.stringify({ id: request.id, result: null }) + "\\n", () => process.exit(0));
  } else if (request.method === "watch.stop" || request.method === "rpc.cancel") send({ id: request.id, result: null });
  else send({ id: request.id, error: { code: "INVALID_REQUEST", message: "Unknown fixture method" } });
});
input.on("close", () => process.exit(0));
`, { mode: 0o755 });

  fs.writeFileSync(path.join(bin, "ruff"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const state = ${JSON.stringify(state)};
const counter = path.join(state, "ruff-count");
const run = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;
fs.writeFileSync(counter, String(run));
const source = fs.readFileSync("sample.py", "utf8").trim();
fs.writeFileSync(path.join(state, "ruff-" + run + ".started"), String(process.pid));
const finish = () => {
  process.stdout.write(JSON.stringify([{ filename: path.join(process.cwd(), "sample.py"), location: { row: 1, column: 1 }, code: "FIXTURE", message: "observed:" + source }]));
  process.exitCode = 1;
};
if (run !== 1) finish();
else {
  const deadline = Date.now() + 8000;
  const timer = setInterval(() => {
    if (fs.existsSync(path.join(state, "release-first")) || fs.existsSync(path.join(state, "release-all")) || Date.now() >= deadline) {
      clearInterval(timer); finish();
    }
  }, 10);
}
`, { mode: 0o755 });

  const keys = ["CREWFORGE_DESKTOP", "CROWNFORGE_IDE_CORE_EXECUTABLE", "PATH", "APP_SETTINGS_CONFIG", "USERS_CONFIG", "WORKSPACE_DIR"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.CREWFORGE_DESKTOP = "1"; process.env.CROWNFORGE_IDE_CORE_EXECUTABLE = core;
  process.env.PATH = bin;
  process.env.APP_SETTINGS_CONFIG = path.join(state, "app-settings.json");
  process.env.USERS_CONFIG = path.join(state, "users.json"); process.env.WORKSPACE_DIR = workspace;
  const tracked = new Set<Promise<unknown>>();

  t.after(async () => {
    try {
      stopDiagnosticsSession(workspace); const stopped = shutdownDesktopNativeIde();
      fs.writeFileSync(path.join(state, "release-all"), "release");
      await Promise.allSettled([...tracked]);
      await stopped;
      await until(() => fs.readdirSync(state).filter((name) => name === "core.pid" || /^ruff-\d+\.started$/.test(name))
        .every((name) => !pidAlive(Number(fs.readFileSync(path.join(state, name), "utf8")))), "fixture processes to exit");
    } finally {
      for (const key of keys) { const value = previous[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  return {
    workspace,
    firstRunning: () => fs.existsSync(path.join(state, "ruff-1.started")),
    releaseFirst: () => fs.writeFileSync(path.join(state, "release-first"), "release"),
    runs: () => fs.existsSync(path.join(state, "ruff-count")) ? Number(fs.readFileSync(path.join(state, "ruff-count"), "utf8")) : 0,
    attempts: () => fs.existsSync(path.join(state, "watch-attempts")) ? Number(fs.readFileSync(path.join(state, "watch-attempts"), "utf8")) : 0,
    track<T>(promise: Promise<T>): Promise<T> { tracked.add(promise); void promise.catch(() => {}); return promise; },
  };
}

test("native watcher changes during a running check trigger a second check of the changed file", unixOnly, async (t) => {
  const f = await fixture(t);
  const first = f.track(startDiagnosticsSession(f.workspace));
  await until(f.firstRunning, "the first Ruff check to start");
  assert.equal(getDiagnostics(f.workspace).session.status, "running");
  fs.writeFileSync(path.join(f.workspace, "sample.py"), "changed_value = 2\n");
  await getDesktopNativeIde().request("fixture.change", {});
  // Hold the real check past the watch debounce, so the notification arrives in-flight.
  await delay(400);
  assert.equal(f.runs(), 1); assert.equal(getDiagnostics(f.workspace).session.status, "running");
  f.releaseFirst();
  assert.equal((await first).diagnostics[0].message, "observed:initial_value = 1");
  await until(() => getDiagnostics(f.workspace).session.generation >= 2, "a new check after the in-flight change");
  const refreshed = getDiagnostics(f.workspace);
  assert.equal(f.runs(), 2); assert.equal(refreshed.session.status, "watching");
  assert.equal(refreshed.diagnostics[0].message, "observed:changed_value = 2");
});

test("native watcher disconnect remains an error after the running check finishes", unixOnly, async (t) => {
  const f = await fixture(t);
  const first = f.track(startDiagnosticsSession(f.workspace));
  await until(f.firstRunning, "the first Ruff check to start");
  await getDesktopNativeIde().request("fixture.disconnect", {});
  await until(() => getDiagnostics(f.workspace).session.status === "error", "the watcher disconnect to be reported");
  f.releaseFirst();
  const completed = await first;
  assert.equal(completed.session.status, "error"); assert.match(completed.session.error!, /watcher disconnected/);
  const current = getDiagnostics(f.workspace);
  assert.equal(current.session.status, "error"); assert.equal(current.session.generation, 1);
  assert.match(current.session.error!, /watcher disconnected/); assert.equal(f.runs(), 1);
});

test("a failed native watcher startup can be retried without a stuck diagnostic session", unixOnly, async (t) => {
  const f = await fixture(t, true);
  await assert.rejects(startDiagnosticsSession(f.workspace), /fixture watcher startup failure/);
  assert.equal(getDiagnostics(f.workspace).session.status, "error"); assert.equal(f.attempts(), 1); assert.equal(f.runs(), 0);
  const retry = f.track(startDiagnosticsSession(f.workspace));
  await until(f.firstRunning, "Ruff to run after a fresh watcher startup");
  f.releaseFirst();
  const result = await retry;
  assert.equal(f.attempts(), 2); assert.equal(f.runs(), 1);
  assert.equal(result.session.status, "watching"); assert.equal(result.session.generation, 1);
  assert.equal(getDiagnostics(f.workspace).session.error, undefined);
});
