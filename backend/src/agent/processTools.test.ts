import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeProcessTool, pendingAgentProcesses, stopAgentProcesses } from "./processTools.js";
import { classifyToolApproval } from "./toolApproval.js";
import { evaluateModeCapability } from "./modeCapabilities.js";
import { subagentAllowsTool } from "./subagentRoles.js";
import { getAllTools, TOOL_DISPATCH } from "./tools.js";
import { buildFileHash, listFileMutations, listMutationEvidenceGaps, recordKnownFileMutation, rollbackFileMutations } from "../files/mutationRegistry.js";
import type { ToolContext } from "./types.js";
import type { ExecutionPlan } from "../chat/executionPlans.js";

function fixture(t: test.TestContext, script: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-process-tools-"));
  fs.writeFileSync(path.join(root, "task.cjs"), script);
  const context = { workspaceDir: root, mode: "code", actorName: "tester", sessionOwner: "tester", sessionToken: "token", runId: "run-process", requestId: "request-process", toolCallId: "process-start", compatibilityShellAuthorized: true } as ToolContext;
  t.after(async () => { await stopAgentProcesses(context); await new Promise((resolve) => setTimeout(resolve, 100)); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, context };
}
async function terminal(context: ToolContext, id: string) {
  const deadline = Date.now() + 5000;
  while (true) {
    const result = await executeProcessTool("process_poll", { session_id: id }, context);
    if (result.process.session.status !== "running") return result;
    if (Date.now() > deadline) throw new Error("process did not finish");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("Agent process polling returns real exit/output and journals delayed writes once under the starting tool", async (t) => {
  const f = fixture(t, 'setTimeout(() => { require("node:fs").writeFileSync("generated.txt", "delayed"); console.log("done"); }, 100);');
  const start = await executeProcessTool("process_start", { command: "node task.cjs" }, f.context);
  assert.equal(start.process.session.status, "running");
  assert.equal(start.process.session.exitCode, null);
  const done = await terminal(f.context, start.process.session.id);
  assert.equal(done.process.session.status, "exited");
  assert.equal(done.process.session.exitCode, 0);
  assert.match(done.process.output, /done/);
  assert.equal(done.process.evidenceError, undefined);
  const records = listFileMutations(f.root, { toolCallId: "process-start" });
  assert.deepEqual(records.map((record) => record.path), ["generated.txt"]);
  await executeProcessTool("process_poll", { session_id: start.process.session.id }, f.context);
  assert.equal(listFileMutations(f.root, { toolCallId: "process-start" }).length, 1);
  assert.equal(pendingAgentProcesses(f.context).length, 0);
});

test("a completed Agent process records a binary artifact without an evidence error", async (t) => {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128]);
  const f = fixture(t, `setTimeout(() => { require('node:fs').writeFileSync('image.png', Buffer.from(${JSON.stringify([...bytes])})); console.log('artifact ready'); }, 50);`);
  const start = await executeProcessTool("process_start", { command: "node task.cjs" }, f.context);
  const done = await terminal(f.context, start.process.session.id);
  assert.equal(done.process.session.exitCode, 0);
  assert.equal(done.process.evidenceError, undefined);
  assert.equal(pendingAgentProcesses(f.context).length, 0);
  const records = listFileMutations(f.root, { toolCallId: "process-start" });
  assert.equal(records.length, 1);
  assert.equal(records[0].path, "image.png");
  assert.equal(records[0].postimageHash, buildFileHash(bytes));
  assert.equal(records[0].rollbackScope, "whole-file");
  assert.equal(records[0].rollbackUnavailableReason, undefined);
  assert.deepEqual(listMutationEvidenceGaps(f.root), []);
  await executeProcessTool("process_poll", { session_id: start.process.session.id }, f.context);
  assert.equal(listFileMutations(f.root, { toolCallId: "process-start" }).length, 1);
  assert.deepEqual(rollbackFileMutations(f.root, { toolCallId: "process-start" }).applied, [records[0].id]);
  assert.equal(fs.existsSync(path.join(f.root, "image.png")), false);
});

test("process tools enforce owner/run, active-write exclusion, input approval and read-only/child boundaries", async (t) => {
  const f = fixture(t, 'process.stdin.on("data", (text) => { console.log(text.toString()); process.exit(0); });');
  const start = await executeProcessTool("process_start", { command: "node task.cjs" }, f.context);
  const id = start.process.session.id;
  const alias = `${f.root}-alias`;
  fs.symlinkSync(f.root, alias);
  t.after(() => fs.rmSync(alias, { force: true }));
  assert.equal(pendingAgentProcesses({ ...f.context, workspaceDir: alias }, true).length, 1);
  await assert.rejects(executeProcessTool("process_poll", { session_id: id }, { ...f.context, runId: "another-run" }), /not found/);
  await assert.rejects(executeProcessTool("process_poll", { session_id: id }, { ...f.context, sessionOwner: "someone-else" }), /not found/);
  assert.match(String(await TOOL_DISPATCH.write_file({ path: "new.ts", content: "blocked" }, f.context as never)), /active Agent process/);
  await assert.rejects(executeProcessTool("process_input", { session_id: id, text: "hello\n" }, { ...f.context, compatibilityShellAuthorized: false }), /approved tool permission/);
  await assert.rejects(executeProcessTool("process_input", { session_id: id, text: "curl https://example.com\n" }, f.context), /blocked by workspace policy/);
  for (const mode of ["ask", "plan", "review"] as const) {
    assert.equal(getAllTools({ mode }).some((tool) => tool.function.name.startsWith("process_")), false);
    assert.equal(evaluateModeCapability({ mode, toolName: "process_start", input: { command: "node task.cjs" } }).allowed, false);
    await assert.rejects(executeProcessTool("process_poll", { session_id: id }, { ...f.context, mode }), /Code mode/);
  }
  assert.equal(subagentAllowsTool("general", "process_start"), false);
  await assert.rejects(executeProcessTool("process_start", { command: "node task.cjs" }, { ...f.context, subagentDepth: 1 }), /primary Agent/);
  await executeProcessTool("process_input", { session_id: id, text: "hello\n", eof: true }, f.context);
  assert.match((await terminal(f.context, id)).process.output, /hello/);
});

test("process start obeys command hard policy and approved plan command scope; stdin is separately high risk", async (t) => {
  const f = fixture(t, "console.log('ok');");
  assert.equal(classifyToolApproval("process_start", { command: "curl https://example.com" }).kind, "blocked");
  await assert.rejects(executeProcessTool("process_start", { command: "curl https://example.com" }, f.context), /blocked/);
  const approval = classifyToolApproval("process_input", { session_id: "owned", text: "yes\n" });
  assert.equal(approval.kind, "approval");
  if (approval.kind === "approval") { assert.equal(approval.risk, "high"); assert.equal(approval.canAllowSession, false); }
  const executionPlan = { verificationCommands: ["npm test"], files: ["."] } as ExecutionPlan;
  assert.equal(evaluateModeCapability({ mode: "code", toolName: "process_start", input: { command: "npm test" }, executionPlan }).allowed, true);
  assert.equal(evaluateModeCapability({ mode: "code", toolName: "process_start", input: { command: "node task.cjs" }, executionPlan }).allowed, false);
  assert.equal(evaluateModeCapability({ mode: "code", toolName: "process_input", input: { text: "yes" }, executionPlan }).allowed, false);
  await assert.rejects(executeProcessTool("process_start", { command: "node task.cjs" }, { ...f.context, executionPlan }), /outside the approved/);
});

test("concurrent user edits produce an attribution conflict instead of being journaled as process changes", async (t) => {
  const f = fixture(t, "setTimeout(() => console.log('finished'), 150);");
  const start = await executeProcessTool("process_start", { command: "node task.cjs" }, f.context);
  fs.writeFileSync(path.join(f.root, "user.txt"), "user change");
  recordKnownFileMutation({ workspaceDir: f.root, path: "user.txt", source: "user", actor: "tester", content: "user change", mtimeMs: fs.statSync(path.join(f.root, "user.txt")).mtimeMs });
  const done = await terminal(f.context, start.process.session.id);
  assert.match(done.process.evidenceError || "", /Concurrent workspace edits/);
  assert.equal(listFileMutations(f.root, { toolCallId: "process-start" }).length, 0);
  assert.equal(pendingAgentProcesses(f.context)[0].evidenceError, done.process.evidenceError);
});

test("process stop is idempotent and timeout remains a terminal failure", async (t) => {
  const f = fixture(t, "setInterval(() => {}, 1000);");
  const timed = await executeProcessTool("process_start", { command: "node task.cjs", timeout_ms: 100 }, f.context);
  assert.equal((await terminal(f.context, timed.process.session.id)).process.session.status, "timed_out");
  const started = await executeProcessTool("process_start", { command: "node task.cjs" }, { ...f.context, toolCallId: "start-2" });
  await executeProcessTool("process_stop", { session_id: started.process.session.id }, f.context);
  await executeProcessTool("process_stop", { session_id: started.process.session.id }, f.context);
  assert.equal((await terminal(f.context, started.process.session.id)).process.session.status, "cancelled");
});
