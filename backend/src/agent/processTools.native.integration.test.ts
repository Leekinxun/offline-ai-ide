import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { agentProcessOwner, executeProcessTool, pendingAgentProcesses, stopAgentProcesses } from "./processTools.js";
import { listFileMutations, listMutationEvidenceGaps, recordKnownFileMutation, buildFileVersion } from "../files/mutationRegistry.js";
import { pollProcessSession } from "../run/processSessions.js";
import { mutateDesktopWorkspace, withDesktopWorkspaceWriter } from "../desktop/nativeWorkspaceMutation.js";
import { shutdownDesktopNativeIde } from "../desktop/nativeIdeClient.js";
import type { ToolContext } from "./types.js";

const executable = process.env.CROWNFORGE_TEST_NATIVE_IDE || fileURLToPath(new URL(`../../../desktop/rust/target/debug/crownforge-ide-core${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
const nativeOptions = { skip: !fs.existsSync(executable), timeout: 30_000 };
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function fixture(t: test.TestContext, script: string) {
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-native-process-audit-")));
  fs.writeFileSync(path.join(workspace, "task.cjs"), script);
  const context = { workspaceDir: workspace, mode: "code", actorName: "tester", sessionOwner: "tester", sessionToken: "native-token", runId: "run-native-process", requestId: "turn", toolCallId: "process-start", compatibilityShellAuthorized: true } as ToolContext;
  const originalDesktop = process.env.CREWFORGE_DESKTOP; const originalCore = process.env.CROWNFORGE_IDE_CORE_EXECUTABLE;
  process.env.CREWFORGE_DESKTOP = "1"; process.env.CROWNFORGE_IDE_CORE_EXECUTABLE = executable;
  t.after(async () => {
    await stopAgentProcesses(context); await shutdownDesktopNativeIde();
    if (originalDesktop === undefined) delete process.env.CREWFORGE_DESKTOP; else process.env.CREWFORGE_DESKTOP = originalDesktop;
    if (originalCore === undefined) delete process.env.CROWNFORGE_IDE_CORE_EXECUTABLE; else process.env.CROWNFORGE_IDE_CORE_EXECUTABLE = originalCore;
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  return { workspace, context };
}

async function waitForExit(context: ToolContext, id: string) {
  const deadline = Date.now() + 5000;
  while (pollProcessSession(agentProcessOwner(context), id).session.status === "running") {
    if (Date.now() > deadline) throw new Error("Process did not exit");
    await pause(20);
  }
}

async function withoutNodeEvidence<T>(workspace: string, work: () => Promise<T>): Promise<T> {
  const methods = ["writeFileSync", "renameSync", "unlinkSync", "mkdirSync", "rmSync", "copyFileSync", "appendFileSync"] as const;
  const originals = methods.map((method) => [method, fs[method]] as const); const attempted: string[] = [];
  for (const [method, original] of originals) Reflect.set(fs, method, (...args: unknown[]) => {
    const affected = args.slice(0, method === "renameSync" || method === "copyFileSync" ? 2 : 1);
    if (affected.some((entry) => typeof entry === "string" && (entry === path.join(workspace, ".checkpoints/mutations.json") || entry.startsWith(path.join(workspace, ".checkpoints/mutations.json.")) || entry.startsWith(path.join(workspace, ".checkpoints/blobs"))))) { attempted.push(method); throw new Error("Node cannot publish process mutation evidence"); }
    return Reflect.apply(original, fs, args);
  });
  try { return await work(); }
  finally { for (const [method, original] of originals) Reflect.set(fs, method, original); assert.deepEqual(attempted, []); }
}

test("a terminal process remains pending and polling awaits its native mutation audit", nativeOptions, async (t) => {
  const f = fixture(t, 'setTimeout(() => require("node:fs").writeFileSync("generated.txt", "native output"), 150);');
  const started = await executeProcessTool("process_start", { command: "node task.cjs" }, f.context);
  await assert.rejects(withDesktopWorkspaceWriter(f.workspace, "rollback", async () => undefined), /audit is pending/);
  let entered!: () => void; const admitted = new Promise<void>((resolve) => { entered = resolve; }); let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  const blocking = withDesktopWorkspaceWriter(f.workspace, "editor", async () => { entered(); await held; });
  await admitted;
  try {
    await withoutNodeEvidence(f.workspace, async () => {
      await waitForExit(f.context, started.process.session.id);
      const pending = pendingAgentProcesses(f.context);
      assert.equal(pending.length, 1); assert.equal(pending[0].session.status, "running"); assert.equal(pending[0].session.exitCode, null); assert.equal(pending[0].auditing, true);
      let resolved = false;
      const terminal = executeProcessTool("process_poll", { session_id: started.process.session.id }, f.context).then((result) => { resolved = true; return result; });
      await pause(20); assert.equal(resolved, false); assert.deepEqual(listFileMutations(f.workspace, { toolCallId: "process-start" }), []);
      release(); await blocking;
      const result = await terminal;
      assert.equal(result.process.session.status, "exited"); assert.equal(result.process.session.exitCode, 0); assert.equal(result.process.evidenceError, undefined);
      assert.deepEqual(listFileMutations(f.workspace, { toolCallId: "process-start" }).map((record) => record.path), ["generated.txt"]);
      assert.deepEqual(pendingAgentProcesses(f.context), []);
    });
  } finally { release(); await blocking; }
});

test("human saves remain possible during a process and prevent attributing their edits to it", nativeOptions, async (t) => {
  const f = fixture(t, "setTimeout(() => console.log('finished'), 500);");
  const started = await executeProcessTool("process_start", { command: "node task.cjs" }, f.context);
  const saved = await mutateDesktopWorkspace(f.workspace, [{ type: "writeFile", path: "human.txt", content: "human save", expected: { exists: false } }]);
  recordKnownFileMutation({ workspaceDir: f.workspace, path: "human.txt", content: "human save", source: "user", actor: "human", mtimeMs: saved.entries[0].mtimeMs, version: buildFileVersion("human save") });
  await waitForExit(f.context, started.process.session.id);
  const result = await executeProcessTool("process_poll", { session_id: started.process.session.id }, f.context);
  assert.equal(result.process.session.exitCode, 0); assert.match(result.process.evidenceError || "", /Concurrent workspace edits/);
  assert.equal(fs.readFileSync(path.join(f.workspace, "human.txt"), "utf8"), "human save");
  assert.deepEqual(listFileMutations(f.workspace, { toolCallId: "process-start" }), []);
  assert.equal(listFileMutations(f.workspace).filter((record) => record.source === "user").length, 0);
});

test("process stop awaits descendant cleanup and the terminal native audit", nativeOptions, async (t) => {
  const f = fixture(t, "setInterval(() => {}, 1000);");
  const started = await executeProcessTool("process_start", { command: "node task.cjs" }, f.context);
  const before = Date.now();
  const stopped = await withoutNodeEvidence(f.workspace, () => executeProcessTool("process_stop", { session_id: started.process.session.id }, f.context));
  assert.equal(stopped.process.session.status, "cancelled"); assert.equal(stopped.process.evidenceError, undefined);
  assert.ok(Date.now() - before >= 1400); assert.deepEqual(pendingAgentProcesses(f.context), []);
});


test("native process audits persist skipped evidence and return an explicit terminal evidence error", nativeOptions, async (t) => {
  const f = fixture(t, 'setTimeout(() => require("node:fs").writeFileSync("large.txt", "x".repeat(2 * 1024 * 1024 + 1)), 100);');
  const started = await executeProcessTool("process_start", { command: "node task.cjs" }, f.context);
  await withoutNodeEvidence(f.workspace, async () => {
    await waitForExit(f.context, started.process.session.id);
    const result = await executeProcessTool("process_poll", { session_id: started.process.session.id }, f.context);
    assert.equal(result.process.session.exitCode, 0);
    assert.match(result.process.evidenceError || "", /Process mutation evidence is incomplete: large.txt:oversized/);
    assert.deepEqual(listMutationEvidenceGaps(f.workspace, { toolCallId: "process-start" }).map((gap) => [gap.path, gap.reason]), [["large.txt", "oversized"]]);
    assert.equal(pendingAgentProcesses(f.context)[0].evidenceError, result.process.evidenceError);
  });
});
