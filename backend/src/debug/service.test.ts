import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../config.js";
import { debugCommand, getDebugSession, startDebugSession, stopDebugSession } from "./service.js";

const debugpyAvailable = spawnSync(
  config.debugpyPythonExecutable,
  ["-c", "import debugpy"],
  { stdio: "ignore", timeout: 5_000 }
).status === 0;

async function waitForStatus(workspace: string, status: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = getDebugSession(workspace);
    if (current?.status === status) return current;
    if (current?.status === "failed") throw new Error(current.error || "Debug session failed");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for debug status ${status}`);
}

test("Node debugger pauses at a configured breakpoint and exposes workspace frames", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-debug-"));
  fs.writeFileSync(path.join(workspace, "target.js"), [
    "function add(left, right) {",
    "  const total = left + right;",
    "  return total;",
    "}",
    "console.log(add(2, 3));",
  ].join("\n"));
  t.after(async () => {
    const current = getDebugSession(workspace);
    if (current && current.status !== "stopped") {
      try { await stopDebugSession(workspace); } catch { /* already exited */ }
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const started = startDebugSession(workspace, "target.js", [2]);
  assert.equal(started.status, "starting");
  assert.equal(started.runtime, "node");
  const paused = await waitForStatus(workspace, "paused");
  assert.equal(paused.breakpoints[0]?.verified, true);
  assert.equal(paused.frames[0]?.path, "target.js");
  assert.equal(paused.frames[0]?.line, 2);

  await debugCommand(workspace, "continue");
  const stopped = await waitForStatus(workspace, "stopped");
  assert.match(stopped.stdout, /5/);
});

test("Python debugger pauses, steps, exposes frames and stops after completion", {
  skip: debugpyAvailable ? false : `debugpy is not installed for ${config.debugpyPythonExecutable}`,
}, async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-python-debug-"));
  fs.writeFileSync(path.join(workspace, "target.py"), [
    "def add(left, right):",
    "    total = left + right",
    "    return total",
    "",
    "print(add(2, 3))",
  ].join("\n"));
  t.after(async () => {
    const current = getDebugSession(workspace);
    if (current && current.status !== "stopped") {
      try { await stopDebugSession(workspace); } catch { /* already exited */ }
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const started = startDebugSession(workspace, "target.py", [2]);
  assert.equal(started.status, "starting");
  assert.equal(started.runtime, "python");

  const paused = await waitForStatus(workspace, "paused");
  assert.equal(paused.breakpoints[0]?.verified, true);
  assert.equal(paused.frames[0]?.path, "target.py");
  assert.equal(paused.frames[0]?.line, 2);

  await debugCommand(workspace, "step_over");
  const stepped = await waitForStatus(workspace, "paused");
  assert.equal(stepped.frames[0]?.path, "target.py");
  assert.equal(stepped.frames[0]?.line, 3);

  await debugCommand(workspace, "step_out");
  const steppedOut = await waitForStatus(workspace, "paused");
  assert.equal(steppedOut.frames[0]?.path, "target.py");
  assert.equal(steppedOut.frames[0]?.line, 5);

  await debugCommand(workspace, "continue");
  const stopped = await waitForStatus(workspace, "stopped");
  assert.match(stopped.stdout, /5/);

  const entryStarted = startDebugSession(workspace, "target.py", [1]);
  assert.equal(entryStarted.status, "starting");
  const entryPaused = await waitForStatus(workspace, "paused");
  assert.equal(entryPaused.breakpoints[0]?.verified, true);
  assert.equal(entryPaused.frames[0]?.path, "target.py");
  assert.equal(entryPaused.frames[0]?.line, 1);

  await debugCommand(workspace, "continue");
  await waitForStatus(workspace, "stopped");
});
