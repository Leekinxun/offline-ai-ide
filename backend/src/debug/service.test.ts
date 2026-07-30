import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../config.js";
import {
  debugCommand,
  evaluateDebugExpression,
  getDebugScopes,
  getDebugSession,
  getDebugVariables,
  startDebugSession,
  stopDebugSession,
} from "./service.js";

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

test("Node debugger exposes locals and nested objects, evaluates expressions, and steps", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-debug-"));
  fs.writeFileSync(path.join(workspace, "target.js"), [
    "function add(left, right) {",
    "  const nested = { profile: { name: 'Ada' }, scores: [left, right] };",
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

  const started = startDebugSession(workspace, "target.js", [3]);
  assert.equal(started.status, "starting");
  assert.equal(started.runtime, "node");
  const paused = await waitForStatus(workspace, "paused");
  assert.equal(paused.breakpoints[0]?.verified, true);
  assert.equal(paused.frames[0]?.path, "target.js");
  assert.equal(paused.frames[0]?.line, 3);

  const frameId = paused.frames[0]!.id;
  const scopes = await getDebugScopes(workspace, frameId);
  const localScope = scopes.find((scope) => /local/i.test(scope.name));
  assert.ok(localScope?.variablesReference);
  const locals = await getDebugVariables(workspace, localScope.variablesReference);
  assert.equal(locals.find((variable) => variable.name === "left")?.value, "2");
  const nested = locals.find((variable) => variable.name === "nested");
  assert.ok(nested?.variablesReference);
  const nestedVariables = await getDebugVariables(workspace, nested.variablesReference);
  const profile = nestedVariables.find((variable) => variable.name === "profile");
  assert.ok(profile?.variablesReference);
  const profileVariables = await getDebugVariables(workspace, profile.variablesReference);
  assert.equal(profileVariables.find((variable) => variable.name === "name")?.value, '"Ada"');

  const evaluated = await evaluateDebugExpression(workspace, frameId, "nested.profile.name");
  assert.equal(evaluated.result, '"Ada"');

  const stepped = await debugCommand(workspace, "step_over");
  assert.equal(stepped.status, "paused");
  assert.equal(stepped.frames[0]?.line, 4);
  await assert.rejects(() => getDebugVariables(workspace, nested.variablesReference), /no longer available/i);

  await debugCommand(workspace, "continue");
  const stopped = await waitForStatus(workspace, "stopped");
  assert.match(stopped.stdout, /5/);
});

test("Python debugger exposes locals and nested objects, evaluates expressions, steps, and stops", {
  skip: debugpyAvailable ? false : `debugpy is not installed for ${config.debugpyPythonExecutable}`,
}, async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-python-debug-"));
  fs.writeFileSync(path.join(workspace, "target.py"), [
    "def add(left, right):",
    "    nested = {'profile': {'name': 'Ada'}, 'scores': [left, right]}",
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

  const started = startDebugSession(workspace, "target.py", [3]);
  assert.equal(started.status, "starting");
  assert.equal(started.runtime, "python");

  const paused = await waitForStatus(workspace, "paused");
  assert.equal(paused.breakpoints[0]?.verified, true);
  assert.equal(paused.frames[0]?.path, "target.py");
  assert.equal(paused.frames[0]?.line, 3);

  const frameId = paused.frames[0]!.id;
  const scopes = await getDebugScopes(workspace, frameId);
  const localScope = scopes.find((scope) => /local/i.test(scope.name));
  assert.ok(localScope?.variablesReference);
  const locals = await getDebugVariables(workspace, localScope.variablesReference);
  assert.equal(locals.find((variable) => variable.name === "left")?.value, "2");
  const nested = locals.find((variable) => variable.name === "nested");
  assert.ok(nested?.variablesReference);
  const nestedVariables = await getDebugVariables(workspace, nested.variablesReference);
  const profile = nestedVariables.find((variable) => variable.name.includes("profile"));
  assert.ok(profile?.variablesReference);
  const profileVariables = await getDebugVariables(workspace, profile.variablesReference);
  assert.ok(profileVariables.some((variable) => variable.value.includes("Ada")));

  const evaluated = await evaluateDebugExpression(workspace, frameId, "nested['profile']['name']");
  assert.match(evaluated.result, /Ada/);

  const stepped = await debugCommand(workspace, "step_over");
  assert.equal(stepped.status, "paused");
  assert.equal(stepped.frames[0]?.path, "target.py");
  assert.equal(stepped.frames[0]?.line, 4);
  await assert.rejects(() => getDebugVariables(workspace, nested.variablesReference));

  const steppedOut = await debugCommand(workspace, "step_out");
  assert.equal(steppedOut.status, "paused");
  assert.equal(steppedOut.frames[0]?.path, "target.py");
  assert.equal(steppedOut.frames[0]?.line, 6);

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
