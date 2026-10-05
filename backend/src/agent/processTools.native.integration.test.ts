import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { listFileMutations } from "../files/mutationRegistry.js";
import { shutdownDesktopNativeIde } from "../desktop/nativeIdeClient.js";
import { mutateDesktopWorkspace, withDesktopWorkspaceWriter } from "../desktop/nativeWorkspaceMutation.js";
import { listDesktopExternalToolEffects } from "../desktop/nativeExternalEffects.js";
import { pollProcessSession } from "../run/processSessions.js";
import type { ToolContext } from "./types.js";
import { agentProcessOwner, executeProcessTool, pendingAgentProcesses, stopAgentProcesses, type AgentProcessResult } from "./processTools.js";

const releaseCore = fileURLToPath(new URL(`../../../desktop/rust/target/release/crownforge-ide-core${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
const debugCore = fileURLToPath(new URL(`../../../desktop/rust/target/debug/crownforge-ide-core${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
const executable = process.env.CROWNFORGE_TEST_NATIVE_IDE || (fs.existsSync(debugCore) ? debugCore : releaseCore);
const nativeSkipReason = process.platform === "win32"
  ? "Native executable-command fixtures require the Windows SDK sandbox account setup; this lane verifies non-command native desktop paths on Windows"
  : !fs.existsSync(executable)
    ? `Native IDE core executable not found: ${executable}`
    : false;
const nativeOptions = { skip: nativeSkipReason, timeout: 45_000 };
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function fixture(t: test.TestContext, script: string, options: { huge?: boolean } = {}) {
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-native-process-effects-")));
  if (options.huge) for (let index = 0; index <= 20_000; index += 1) fs.closeSync(fs.openSync(path.join(workspace, `eligible-${index}.txt`), "w"));
  fs.writeFileSync(path.join(workspace, "task.cjs"), script);
  const context = {
    workspaceDir: workspace,
    mode: "code",
    actorName: "tester",
    sessionOwner: "tester",
    sessionToken: "native-token",
    runId: "run-native-process",
    requestId: "turn",
    toolCallId: "process-start",
    compatibilityShellAuthorized: true,
  } as ToolContext;
  const originalDesktop = process.env.CREWFORGE_DESKTOP;
  const originalCore = process.env.CROWNFORGE_IDE_CORE_EXECUTABLE;
  process.env.CREWFORGE_DESKTOP = "1";
  process.env.CROWNFORGE_IDE_CORE_EXECUTABLE = executable;
  t.after(async () => {
    await stopAgentProcesses(context);
    await shutdownDesktopNativeIde();
    if (originalDesktop === undefined) delete process.env.CREWFORGE_DESKTOP; else process.env.CREWFORGE_DESKTOP = originalDesktop;
    if (originalCore === undefined) delete process.env.CROWNFORGE_IDE_CORE_EXECUTABLE; else process.env.CROWNFORGE_IDE_CORE_EXECUTABLE = originalCore;
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  return { workspace, context };
}

async function waitForExit(context: ToolContext, id: string) {
  const deadline = Date.now() + 10_000;
  while (pollProcessSession(agentProcessOwner(context), id).session.status === "running") {
    if (Date.now() > deadline) throw new Error("Process did not exit");
    await pause(20);
  }
}

async function pollTerminal(context: ToolContext, id: string): Promise<AgentProcessResult> {
  await waitForExit(context, id);
  return (await executeProcessTool("process_poll", { session_id: id }, context)).process;
}

function effectsReceipt(workspace: string) {
  const receipts = listDesktopExternalToolEffects(workspace, { runId: "run-native-process", requestId: "turn", expectedToolCallIds: ["process-start"] });
  assert.equal(receipts.length, 1);
  return receipts[0];
}

test("native process writes are reported as untracked effects without checkpoint mutation attribution", nativeOptions, async (t) => {
  const f = fixture(t, 'setTimeout(() => require("node:fs").writeFileSync("generated.txt", "native output"), 100);');
  const started = await executeProcessTool("process_start", { command: "node task.cjs" }, f.context);
  assert.equal(started.process.checkpointId, undefined);
  assert.equal(started.process.workspaceEffects, undefined);
  await assert.rejects(withDesktopWorkspaceWriter(f.workspace, "rollback", async () => undefined), /audit is pending/);

  const result = await pollTerminal(f.context, started.process.session.id);

  assert.equal(result.session.status, "exited");
  assert.equal(result.session.exitCode, 0);
  assert.equal(result.evidenceError, undefined);
  assert.equal(result.workspaceEffects?.rollbackCoverage, "untracked");
  assert.equal(result.workspaceEffects?.observationComplete, false);
  assert.deepEqual(result.workspaceEffects?.observedPaths, []);
  assert.equal(fs.readFileSync(path.join(f.workspace, "generated.txt"), "utf8"), "native output");
  assert.deepEqual(listFileMutations(f.workspace, { toolCallId: "process-start" }), []);
  assert.deepEqual(pendingAgentProcesses(f.context), []);
  const receipt = effectsReceipt(f.workspace);
  assert.equal(receipt.rollbackCoverage, "untracked");
  assert.equal(receipt.observationComplete, false);
  assert.ok(receipt.startedAt > 0);
  assert.ok((receipt.finishedAt || 0) >= receipt.startedAt);
});

test("human native saves during a process do not turn the command into an attribution error", nativeOptions, async (t) => {
  const f = fixture(t, "setTimeout(() => console.log('finished'), 250);");
  const started = await executeProcessTool("process_start", { command: "node task.cjs" }, f.context);
  await mutateDesktopWorkspace(f.workspace, [{ type: "writeFile", path: "human.txt", content: "human save", expected: { exists: false } }]);

  const result = await pollTerminal(f.context, started.process.session.id);

  assert.equal(result.session.exitCode, 0);
  assert.equal(result.evidenceError, undefined);
  assert.equal(result.workspaceEffects?.rollbackCoverage, "untracked");
  assert.equal(fs.readFileSync(path.join(f.workspace, "human.txt"), "utf8"), "human save");
  assert.deepEqual(listFileMutations(f.workspace), []);
});

test("native process stop waits for process-tree cleanup before releasing the writer guard", nativeOptions, async (t) => {
  const f = fixture(t, "setInterval(() => {}, 1000);");
  const started = await executeProcessTool("process_start", { command: "node task.cjs" }, f.context);
  await assert.rejects(withDesktopWorkspaceWriter(f.workspace, "rollback", async () => undefined), /audit is pending/);

  const before = Date.now();
  const stopped = await executeProcessTool("process_stop", { session_id: started.process.session.id }, f.context);

  assert.equal(stopped.process.session.status, "cancelled");
  assert.equal(stopped.process.evidenceError, undefined);
  assert.equal(stopped.process.workspaceEffects?.rollbackCoverage, "untracked");
  assert.ok(Date.now() - before >= 1000);
  await withDesktopWorkspaceWriter(f.workspace, "rollback", async () => undefined);
  assert.deepEqual(pendingAgentProcesses(f.context), []);
});

test("native process succeeds on huge workspaces with >64MB untracked command output", nativeOptions, async (t) => {
  const f = fixture(t, 'setTimeout(() => require("node:fs").writeFileSync("large.txt", Buffer.alloc(65 * 1024 * 1024, 7)), 100);', { huge: true });
  const started = await executeProcessTool("process_start", { command: "node task.cjs" }, f.context);

  const result = await pollTerminal(f.context, started.process.session.id);

  assert.equal(result.session.exitCode, 0);
  assert.equal(result.evidenceError, undefined);
  assert.equal(result.workspaceEffects?.rollbackCoverage, "untracked");
  assert.deepEqual(listFileMutations(f.workspace, { toolCallId: "process-start" }), []);
  assert.equal(fs.statSync(path.join(f.workspace, "large.txt")).size, 65 * 1024 * 1024);
});
