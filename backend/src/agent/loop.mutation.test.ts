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
import { listFileMutations, listMutationEvidenceGaps, rollbackFileMutations } from "../files/mutationRegistry.js";
import { collectAuthoritativeChangeEvidence, deriveCompletionEvidence } from "../chat/completionEvidence.js";
import type { ExecutionPlan } from "../chat/executionPlans.js";

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

test("primary shell changes are captured from the step checkpoint as create, modify, and delete", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-shell-mutations-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspaceDir, "changed.txt"), "before");
  fs.writeFileSync(path.join(workspaceDir, "deleted.txt"), "remove-me");
  await runSingleTool(workspaceDir, {
    id: "bash-call", name: "bash",
    arguments: { command: "sed -i '' s/before/after/ changed.txt; touch created.txt; mv deleted.txt moved.txt" },
  });
  const records = listFileMutations(workspaceDir, { runId: "run-primary", toolCallId: "bash-call" });
  assert.deepEqual(records.map((record) => [record.path, record.operation, record.preimageContent]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))), [
    ["changed.txt", "modify", "before"],
    ["created.txt", "create", undefined],
    ["deleted.txt", "delete", "remove-me"],
    ["moved.txt", "create", undefined],
  ]);
  assert.ok(records.every((record) => record.actor === "primary-user"));
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
  assert.deepEqual(authoritative.changedFiles, ["issues.sqlite"]);
  assert.deepEqual(authoritative.mutationEvidenceGaps, []);
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

test("a failing SQLite command still reports its real exit failure and journals its artifact", async (t) => {
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
  assert.deepEqual(records.map((record) => [record.path, record.operation]), [["partial.sqlite", "create"]]);
  const rollback = rollbackFileMutations(workspaceDir, { toolCallId: "sqlite-fail" });
  assert.deepEqual(rollback.applied, [records[0].id], JSON.stringify(rollback));
  assert.equal(fs.existsSync(path.join(workspaceDir, "partial.sqlite")), false);
});

test("a failed primary shell tool journals partial side effects and supports rollback", async (t) => {
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
  assert.deepEqual(records.map((record) => ({
    path: record.path,
    operation: record.operation,
    preimageContent: record.preimageContent,
  })), [{ path: "partial.txt", operation: "modify", preimageContent: "before" }]);
  assert.deepEqual(
    rollbackFileMutations(workspaceDir, { runId: "run-primary", toolCallId: "failed-bash-call" }).applied,
    [records[0].id]
  );
  assert.equal(fs.readFileSync(path.join(workspaceDir, "partial.txt"), "utf8"), "before");
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

test("a mutating primary tool fails before execution when its checkpoint cannot be created", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-checkpoint-required-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspaceDir, ".checkpoints"), "blocks checkpoint directory");
  const persisted = await runSingleTool(workspaceDir, { id: "write-without-baseline", name: "write_file", arguments: { path: "should-not-exist.txt", content: "unsafe" } });
  assert.equal(fs.existsSync(path.join(workspaceDir, "should-not-exist.txt")), false);
  assert.equal(persisted[0]?.toolCalls?.[0]?.isError, true);
  assert.match(persisted[0]?.toolCalls?.[0]?.result || "", /required mutation checkpoint unavailable/i);
});
