import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { WebSocket } from "ws";
import { MessageBus } from "./messageBus.js";
import { runAgentLoop } from "./loop.js";
import { TaskManager } from "./taskManager.js";
import { TeammateManager } from "./teammateManager.js";
import type { UserSession } from "../auth/sessionManager.js";
import { AgentRunRecorder } from "../chat/runHistory.js";
import { buildFileVersion, listFileMutations, listMutationEvidenceGaps, rollbackFileMutations } from "../files/mutationRegistry.js";
import { listCheckpoints } from "../chat/checkpoints.js";
import { executeProcessTool, stopAgentProcesses } from "./processTools.js";
import type { ToolContext } from "./types.js";
import { collectAuthoritativeChangeEvidence, deriveCompletionEvidence } from "../chat/completionEvidence.js";
import type { ExecutionPlan } from "../chat/executionPlans.js";
import { listExternalToolEffects } from "../chat/externalToolEffects.js";

function sessionFor(workspaceDir: string): UserSession {
  const taskManager = new TaskManager(workspaceDir);
  const messageBus = new MessageBus(workspaceDir);
  return {
    token: "mutation-token", username: "primary-user", workspaceDir, workspaceRoot: workspaceDir,
    isAdmin: false, isolated: false, taskManager, messageBus,
    teammateManager: new TeammateManager(workspaceDir, messageBus, taskManager),
  };
}

async function runSingleTool(
  workspaceDir: string,
  toolCall: { id: string; name: string; arguments: Record<string, unknown> },
  approve: () => Promise<"allow_once" | "deny"> = async () => "allow_once",
  executionPlan?: ExecutionPlan,
) {
  const recorder = new AgentRunRecorder(workspaceDir, "run-primary", "conversation-primary", "code", undefined, undefined, undefined, "test-model");
  await recorder.start();
  const ws = { readyState: WebSocket.OPEN, send() {} } as unknown as WebSocket;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json(calls === 1 ? {
      choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: toolCall.id, type: "function", function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) } }] } }],
    } : { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }] });
  };
  try {
    return await runAgentLoop(ws, "make a change", "request-primary", sessionFor(workspaceDir), undefined, undefined, undefined, undefined, undefined, undefined, {
      isStopped: () => false, createAbortSignal: () => undefined, mode: "code", modelName: "test-model",
      conversationId: "conversation-primary", runRecorder: recorder, requestToolApproval: approve, executionPlan,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("primary shell changes execute without snapshots and declare untracked effects", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-shell-mutations-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspaceDir, "changed.txt"), "before");
  fs.writeFileSync(path.join(workspaceDir, "deleted.txt"), "remove-me");
  await runSingleTool(workspaceDir, {
    id: "bash-call", name: "bash",
    arguments: { command: "sed -i '' s/before/after/ changed.txt; touch created.txt; mv deleted.txt moved.txt" },
  });
  const records = listFileMutations(workspaceDir, { runId: "run-primary", toolCallId: "bash-call" });
  assert.deepEqual(records, []);
  assert.equal(fs.readFileSync(path.join(workspaceDir, "changed.txt"), "utf8"), "after");
  assert.ok(fs.existsSync(path.join(workspaceDir, "created.txt")));
  assert.equal(fs.existsSync(path.join(workspaceDir, "deleted.txt")), false);
  assert.equal(fs.readFileSync(path.join(workspaceDir, "moved.txt"), "utf8"), "remove-me");
  const effects = listExternalToolEffects(workspaceDir, { runId: "run-primary", expectedExecutions: [{ toolCallId: "bash-call", requestId: "request-primary" }] });
  assert.equal(effects.length, 1);
  assert.equal(effects[0].rollbackCoverage, "untracked");
  assert.ok(effects[0].finishedAt);
  assert.deepEqual(listCheckpoints(workspaceDir), []);
});

test("approved SQLite creation preserves successful execution and completion evidence", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-sqlite-completion-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const verification = `python3 -B -c "import sqlite3; c=sqlite3.connect('issues.sqlite'); c.execute('create table issues (id integer primary key, title text)'); c.execute('insert into issues values (1, ?)',['generated']); c.commit(); assert c.execute('select count(*) from issues').fetchone()[0] == 1; c.close(); print('SQLite verified')"`;
  fs.writeFileSync(path.join(workspaceDir, "package.json"), JSON.stringify({ name: "sqlite-fixture", scripts: { test: verification } }));
  const command = "npm test";
  const executionPlan: ExecutionPlan = {
    id: "sqlite-plan", conversationId: "conversation-primary", planRunId: "plan-run",
    status: "approved", createdAt: 1, updatedAt: 1, executionRunIds: [],
    goal: "Generate and verify SQLite", files: ["issues.sqlite"], steps: ["Create and check the database"],
    risks: [], verificationCommands: [command], acceptanceCriteria: [],
  };
  const persisted = await runSingleTool(workspaceDir, {
    id: "sqlite-create", name: "bash", arguments: { command },
  }, async () => { throw new Error("The approved plan already authorizes this exact command"); }, executionPlan);
  const tool = persisted.flatMap((message) => message.toolCalls || []).find((call) => call.toolCallId === "sqlite-create");
  assert.equal(tool?.isError, false);
  assert.match(tool?.result || "", /SQLite verified/);
  assert.doesNotMatch(tool?.result || "", /Mutation evidence incomplete/);
  const database = path.join(workspaceDir, "issues.sqlite");
  assert.equal(fs.readFileSync(database).subarray(0, 16).toString(), "SQLite format 3\0");
  const independentlyRead = spawnSync("python3", ["-B", "-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute('select title from issues where id=1').fetchone()[0]); c.close()", database], { encoding: "utf8" });
  assert.equal(independentlyRead.status, 0, independentlyRead.stderr);
  assert.equal(independentlyRead.stdout.trim(), "generated");
  const authoritative = collectAuthoritativeChangeEvidence(workspaceDir, "run-primary");
  assert.deepEqual(authoritative.changedFiles, []);
  assert.deepEqual(authoritative.mutationEvidenceGaps, []);
  assert.equal(persisted.at(-1)?.runtimeValidation?.changeCoverage, "tracked_edits_only");
  assert.equal(listExternalToolEffects(workspaceDir, { runId: "run-primary" })[0]?.rollbackCoverage, "untracked");
  const completion = deriveCompletionEvidence({
    plan: executionPlan, messages: persisted, changedFiles: authoritative.changedFiles,
    blockers: { changeEvidence: authoritative.mutationEvidenceGaps.length > 0 },
  });
  assert.equal(completion.outcome, "completed", JSON.stringify({ completion, validation: persisted.map((message) => message.runtimeValidation) }));
  assert.equal(completion.ledger.verification[0]?.status, "passed");
});

test("an inline Python read reaches ordinary approval and executes quoted method calls", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-python-inline-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspaceDir, "input.txt"), "local check");
  let approvals = 0;
  const persisted = await runSingleTool(workspaceDir, {
    id: "python-check", name: "bash",
    arguments: { command: `python3 -c "from pathlib import Path; print(Path('input.txt').read_text())"` },
  }, async () => { approvals += 1; return "allow_once"; });
  const tool = persisted.flatMap((message) => message.toolCalls || []).find((call) => call.toolCallId === "python-check");
  assert.equal(approvals, 1);
  assert.equal(tool?.isError, false);
  assert.match(tool?.result || "", /local check/);
  assert.deepEqual(listMutationEvidenceGaps(workspaceDir), []);
});

test("a failing SQLite command retains its real exit failure and marks its artifact untracked", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-sqlite-failure-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const persisted = await runSingleTool(workspaceDir, {
    id: "sqlite-fail", name: "bash",
    arguments: { command: `python3 -B -c "import sqlite3; c=sqlite3.connect('partial.sqlite'); c.execute('create table items (id integer)'); c.commit(); c.close(); raise SystemExit(7)"` },
  });
  const tool = persisted.flatMap((message) => message.toolCalls || []).find((call) => call.toolCallId === "sqlite-fail");
  assert.equal(tool?.isError, true);
  assert.match(tool?.result || "", /Process exited with code 7/);
  assert.doesNotMatch(tool?.result || "", /Mutation evidence incomplete/);
  const records = listFileMutations(workspaceDir, { toolCallId: "sqlite-fail" });
  assert.deepEqual(records, []);
  assert.ok(fs.existsSync(path.join(workspaceDir, "partial.sqlite")));
  assert.equal(listExternalToolEffects(workspaceDir, { runId: "run-primary" })[0]?.rollbackCoverage, "untracked");
  const rollback = rollbackFileMutations(workspaceDir, { toolCallId: "sqlite-fail" });
  assert.deepEqual(rollback.applied, [], JSON.stringify(rollback));
  assert.ok(fs.existsSync(path.join(workspaceDir, "partial.sqlite")));
});

test("a failed primary shell tool preserves partial effects without claiming automatic rollback", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-failed-shell-mutations-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspaceDir, "partial.txt"), "before");
  const persisted = await runSingleTool(workspaceDir, {
    id: "failed-bash-call", name: "bash",
    arguments: { command: "sed -i '' s/before/partial/ partial.txt; false" },
  });

  assert.equal(persisted[0]?.toolCalls?.[0]?.isError, true);
  assert.match(persisted[0]?.toolCalls?.[0]?.result || "", /Process exited with code 1/);
  const records = listFileMutations(workspaceDir, {
    runId: "run-primary",
    toolCallId: "failed-bash-call",
  });
  assert.deepEqual(records, []);
  assert.deepEqual(
    rollbackFileMutations(workspaceDir, { runId: "run-primary", toolCallId: "failed-bash-call" }).applied,
    []
  );
  assert.equal(fs.readFileSync(path.join(workspaceDir, "partial.txt"), "utf8"), "partial");
  assert.ok(listExternalToolEffects(workspaceDir, { runId: "run-primary" })[0]?.finishedAt);
});

test("a denied primary tool never creates a mutation journal entry", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-denied-mutations-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  await runSingleTool(workspaceDir, {
    id: "denied-write", name: "write_file", arguments: { path: "denied.txt", content: "no" },
  }, async () => "deny");
  assert.equal(fs.existsSync(path.join(workspaceDir, "denied.txt")), false);
  assert.equal(listFileMutations(workspaceDir, { runId: "run-primary", toolCallId: "denied-write" }).length, 0);
});

test("a journaled file tool fails before execution when its mutation storage is invalid", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-checkpoint-required-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspaceDir, ".checkpoints"), "blocks checkpoint directory");
  const persisted = await runSingleTool(workspaceDir, { id: "write-without-baseline", name: "write_file", arguments: { path: "should-not-exist.txt", content: "unsafe" } });
  assert.equal(fs.existsSync(path.join(workspaceDir, "should-not-exist.txt")), false);
  assert.equal(persisted[0]?.toolCalls?.[0]?.isError, true);
  assert.match(persisted[0]?.toolCalls?.[0]?.result || "", /mutation journal|not a directory|ENOTDIR/i);
});

test("an external command is refused before execution when its intent receipt cannot be persisted", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-required-tool-receipt-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspaceDir, ".history"));
  fs.writeFileSync(path.join(workspaceDir, ".history", "external-tools"), "blocks receipt directory");
  const messages = await runSingleTool(workspaceDir, {
    id: "blocked-receipt", name: "bash", arguments: { command: "printf unsafe > should-not-exist.txt" },
  });
  const tool = messages.flatMap((message) => message.toolCalls || []).find((entry) => entry.toolCallId === "blocked-receipt");
  assert.equal(tool?.isError, true);
  assert.match(tool?.result || "", /execution evidence unavailable/);
  assert.equal(fs.existsSync(path.join(workspaceDir, "should-not-exist.txt")), false);
});

for (const limit of ["file-count", "total-bytes"] as const) {
  test(`file edits roll back and commands execute beyond the old workspace checkpoint ${limit} limit`, async (t) => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), `crewforge-large-file-tools-${limit}-`));
    t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
    const count = limit === "file-count" ? 20_001 : 65;
    const content = limit === "file-count" ? "" : Buffer.alloc(1024 * 1024, "x");
    const filler = path.join(workspaceDir, "fixtures");
    fs.mkdirSync(filler);
    for (let i = 0; i < count; i++) fs.writeFileSync(path.join(filler, `${i}.txt`), content);
    fs.writeFileSync(path.join(workspaceDir, "editable.txt"), "before\n");
    const calls = [
      { id: "large-write", name: "write_file", arguments: { path: "created.txt", content: "created\n" } },
      { id: "large-edit", name: "edit_file", arguments: { path: "editable.txt", old_text: "before", new_text: "after", expected_version: buildFileVersion("before\n") } },
      { id: "large-rename", name: "rename_file", arguments: { source_path: "editable.txt", target_path: "renamed.txt", expected_version: buildFileVersion("after\n") } },
    ];
    for (const call of calls) {
      const messages = await runSingleTool(workspaceDir, call);
      const tool = messages.flatMap((message) => message.toolCalls || []).find((entry) => entry.toolCallId === call.id);
      assert.equal(tool?.isError, false, tool?.result);
      assert.ok(listFileMutations(workspaceDir, { toolCallId: call.id }).length > 0);
    }
    assert.equal(fs.readFileSync(path.join(workspaceDir, "renamed.txt"), "utf8"), "after\n");
    assert.deepEqual(listCheckpoints(workspaceDir), []);
    const rollback = rollbackFileMutations(workspaceDir, { runId: "run-primary" });
    assert.equal(rollback.conflicts.length, 0, JSON.stringify(rollback));
    assert.equal(rollback.applied.length, 4, JSON.stringify(rollback));
    assert.equal(fs.readFileSync(path.join(workspaceDir, "editable.txt"), "utf8"), "before\n");
    assert.equal(fs.existsSync(path.join(workspaceDir, "created.txt")), false);
    assert.equal(fs.existsSync(path.join(workspaceDir, "renamed.txt")), false);
    assert.equal(fs.readdirSync(filler).length, count);
    const commandMessages = await runSingleTool(workspaceDir, {
      id: "large-shell", name: "bash", arguments: { command: "printf command > external.txt" },
    });
    const commandTool = commandMessages.flatMap((message) => message.toolCalls || []).find((entry) => entry.toolCallId === "large-shell");
    assert.equal(commandTool?.isError, false, commandTool?.result);
    assert.equal(fs.readFileSync(path.join(workspaceDir, "external.txt"), "utf8"), "command");
    assert.equal(commandMessages.at(-1)?.runtimeValidation?.changeCoverage, "tracked_edits_only");
    assert.equal(listExternalToolEffects(workspaceDir, { runId: "run-primary" })[0]?.rollbackCoverage, "untracked");
    assert.deepEqual(listCheckpoints(workspaceDir), []);
  });
}

test("journaled rename remains blocked while a workspace Agent process is running", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-rename-process-guard-"));
  fs.writeFileSync(path.join(workspaceDir, "task.cjs"), "setInterval(() => {}, 1000);");
  fs.writeFileSync(path.join(workspaceDir, "original.txt"), "before");
  const context = {
    workspaceDir, mode: "code", actorName: "primary-user", sessionOwner: "primary-user",
    sessionToken: "mutation-token", runId: "run-primary", requestId: "request-primary",
    toolCallId: "process-start", compatibilityShellAuthorized: true,
  } as ToolContext;
  t.after(async () => {
    await stopAgentProcesses(context);
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });
  await executeProcessTool("process_start", { command: "node task.cjs" }, context);
  const messages = await runSingleTool(workspaceDir, {
    id: "rename-during-process", name: "rename_file",
    arguments: { source_path: "original.txt", target_path: "moved.txt", expected_version: buildFileVersion("before") },
  });
  const tool = messages.flatMap((message) => message.toolCalls || []).find((entry) => entry.toolCallId === "rename-during-process");
  assert.equal(tool?.isError, true);
  assert.match(tool?.result || "", /workspace Agent process is still running/);
  assert.equal(fs.readFileSync(path.join(workspaceDir, "original.txt"), "utf8"), "before");
  assert.equal(fs.existsSync(path.join(workspaceDir, "moved.txt")), false);
  assert.deepEqual(listFileMutations(workspaceDir, { toolCallId: "rename-during-process" }), []);
});
