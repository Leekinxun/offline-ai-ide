import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { debugCommand, getDebugSession, startDebugSession, stopDebugSession } from "./service.js";

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
  t.after(() => {
    const current = getDebugSession(workspace);
    if (current && current.status !== "stopped") {
      try { stopDebugSession(workspace); } catch { /* already exited */ }
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const started = startDebugSession(workspace, "target.js", [2]);
  assert.equal(started.status, "starting");
  const paused = await waitForStatus(workspace, "paused");
  assert.equal(paused.breakpoints[0]?.verified, true);
  assert.equal(paused.frames[0]?.path, "target.js");
  assert.equal(paused.frames[0]?.line, 2);

  await debugCommand(workspace, "continue");
  const stopped = await waitForStatus(workspace, "stopped");
  assert.match(stopped.stdout, /5/);
});
