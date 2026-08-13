import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AgentRunRecorder,
  CURRENT_RUN_SCHEMA_VERSION,
  findLatestResumableRun,
  hasActiveRunForConversation,
  listChildRuns,
  listDescendantRuns,
  listRunSummaries,
  readRunRecord,
  terminalizeInterruptedRun,
  RunLineageError,
} from "../chat/runHistory.js";
import type { CompletionEvidence } from "../chat/completionEvidence.js";

const completedEvidence: CompletionEvidence = {
  schemaVersion: 1,
  outcome: "completed",
  ledger: { changedFiles: ["src/a.ts"], verification: [], criteria: [], blockers: [] },
};

test("persists agent run metrics and timeline events", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crownforge-run-"));
  const recorder = new AgentRunRecorder(workspaceDir, "run-1", "conversation-1", "code");

  await recorder.start();
  assert.equal(hasActiveRunForConversation(workspaceDir, "conversation-1"), true);
  await recorder.event(
    {
      kind: "model_response",
      label: "Model response received",
      durationMs: 42,
    },
    { modelCalls: 1, totalTokens: 128, estimatedTokensPeak: 200 }
  );
  const finished = await recorder.finish("stopped", { toolCalls: 2, toolErrors: 1 });
  assert.equal(hasActiveRunForConversation(workspaceDir, "conversation-1"), false);

  const record = readRunRecord(workspaceDir, "run-1");
  assert.equal(record.schemaVersion, CURRENT_RUN_SCHEMA_VERSION);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(workspaceDir, ".history", "runs", "run-1.json"), "utf8")).schemaVersion,
    CURRENT_RUN_SCHEMA_VERSION
  );
  assert.equal(record.status, "stopped");
  assert.equal(record.metrics.modelCalls, 1);
  assert.equal(record.metrics.toolCalls, 2);
  assert.equal(record.metrics.toolErrors, 1);
  assert.equal(record.metrics.totalTokens, 128);
  assert.equal(record.events.length, 3);
  assert.equal(finished.events.at(-1)?.kind, "run_finished");
  assert.equal(listRunSummaries(workspaceDir, "conversation-1")[0]?.runId, "run-1");
  assert.equal(findLatestResumableRun(workspaceDir, "conversation-1")?.runId, "run-1");

  await fs.rm(workspaceDir, { recursive: true, force: true });
});

test("rejects self-parent and cyclic run lineage without rewriting persisted records", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-lineage-cycle-"));
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  const self = new AgentRunRecorder(workspaceDir, "self", "conversation", "code", undefined, { parentRunId: "self" });
  await assert.rejects(self.start(), RunLineageError);
  const writeA = new AgentRunRecorder(workspaceDir, "write-a", "conversation", "code", undefined, { parentRunId: "write-b" });
  await writeA.start();
  const writeB = new AgentRunRecorder(workspaceDir, "write-b", "conversation", "code", undefined, { parentRunId: "write-a" });
  await assert.rejects(writeB.start(), RunLineageError);
  assert.equal(await fs.stat(path.join(workspaceDir, ".history", "runs", "write-b.json")).then(() => true).catch(() => false), false);
  await writeA.finish("stopped");
  const runsDir = path.join(workspaceDir, ".history", "runs"); await fs.mkdir(runsDir, { recursive: true });
  const base = { schemaVersion: CURRENT_RUN_SCHEMA_VERSION, conversationId: "conversation", mode: "code", status: "stopped", startedAt: 1, updatedAt: 1, metrics: {}, events: [], toolExecutions: [], contextManifestIds: [] };
  const a = JSON.stringify({ ...base, runId: "a", parentRunId: "b", status: "running" });
  const b = JSON.stringify({ ...base, runId: "b", parentRunId: "a" });
  await fs.writeFile(path.join(runsDir, "a.json"), a); await fs.writeFile(path.join(runsDir, "b.json"), b);
  assert.throws(() => readRunRecord(workspaceDir, "a"), RunLineageError);
  assert.throws(() => listRunSummaries(workspaceDir), RunLineageError);
  assert.equal(await fs.readFile(path.join(runsDir, "a.json"), "utf8"), a);
  assert.equal(await fs.readFile(path.join(runsDir, "b.json"), "utf8"), b);
});

test("normalizes legacy run records and rejects future schemas", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crownforge-run-schema-"));
  const runsDir = path.join(workspaceDir, ".history", "runs");
  await fs.mkdir(runsDir, { recursive: true });
  const record = {
    runId: "run-legacy", conversationId: "conversation-1", mode: "code", status: "completed",
    startedAt: 1, updatedAt: 1, metrics: {}, events: [], toolExecutions: [],
  };
  await fs.writeFile(path.join(runsDir, "run-legacy.json"), JSON.stringify(record));
  await fs.writeFile(path.join(runsDir, "run-future.json"), JSON.stringify({
    ...record, runId: "run-future", schemaVersion: CURRENT_RUN_SCHEMA_VERSION + 1,
  }));

  assert.equal(readRunRecord(workspaceDir, "run-legacy").schemaVersion, CURRENT_RUN_SCHEMA_VERSION);
  assert.throws(() => readRunRecord(workspaceDir, "run-future"), /Run record is invalid/);
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

test("persists the effective model used by a run", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crownforge-run-model-"));
  const recorder = new AgentRunRecorder(
    workspaceDir,
    "run-model",
    "conversation-model",
    "plan",
    undefined,
    undefined,
    undefined,
    "deep-model"
  );

  await recorder.start();
  await recorder.finish("completed");

  assert.equal(readRunRecord(workspaceDir, "run-model").modelName, "deep-model");
  assert.equal(listRunSummaries(workspaceDir, "conversation-model")[0]?.modelName, "deep-model");

  await fs.rm(workspaceDir, { recursive: true, force: true });
});

test("persists bounded context manifest references and normalizes legacy runs", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crownforge-run-context-"));
  const recorder = new AgentRunRecorder(workspaceDir, "run-context", "conversation-context", "code");
  await recorder.start();
  await recorder.attachContextManifest("ctx-11111111-1111-4111-8111-111111111111");
  await recorder.attachContextManifest("ctx-11111111-1111-4111-8111-111111111111");
  await recorder.finish("completed");
  const record = readRunRecord(workspaceDir, "run-context");
  assert.deepEqual(record.contextManifestIds, ["ctx-11111111-1111-4111-8111-111111111111"]);
  assert.equal(listRunSummaries(workspaceDir, "conversation-context")[0]?.contextManifestCount, 1);
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

test("persists active execution contract and completion evidence", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crownforge-run-contract-"));
  const recorder = new AgentRunRecorder(
    workspaceDir, "run-contract", "conversation-contract", "code", undefined, undefined,
    "plan-1", "deep-model", "approved_plan"
  );
  await recorder.start();
  await recorder.finish("completed", {}, {
    changedFiles: ["src/a.ts"], toolCallCount: 0, errorCount: 0, commandCount: 0,
    executionContractKind: "approved_plan",
  }, completedEvidence);

  const record = readRunRecord(workspaceDir, "run-contract");
  assert.equal(record.executionContractKind, "approved_plan");
  assert.equal(record.completionEvidence?.outcome, "completed");
  assert.equal(record.summary?.completionEvidence?.outcome, "completed");
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

test("persists child run lineage and excludes children from root resume selection", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crownforge-lineage-"));
  const parent = new AgentRunRecorder(workspaceDir, "run-parent", "conversation-1", "code");
  await parent.start();
  await parent.finish("stopped");

  const child = new AgentRunRecorder(
    workspaceDir,
    "run-child",
    "conversation-1",
    "code",
    undefined,
    {
      parentRunId: "run-parent",
      parentTaskId: 42,
      parentToolCallId: "call-task",
      parentRequestId: "request-1",
      agentName: "subagent:Explore",
    }
  );
  await child.start();
  await child.finish("failed");

  const children = listChildRuns(workspaceDir, "run-parent");
  assert.equal(children.length, 1);
  assert.equal(children[0].runId, "run-child");
  assert.equal(children[0].parentToolCallId, "call-task");
  assert.equal(children[0].parentTaskId, 42);
  assert.equal(children[0].agentName, "subagent:Explore");
  assert.equal(findLatestResumableRun(workspaceDir, "conversation-1")?.runId, "run-parent");

  await fs.rm(workspaceDir, { recursive: true, force: true });
});

test("active descendants durably block parent completion across restart and terminal children unblock", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-descendant-gate-"));
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  const parent = new AgentRunRecorder(workspaceDir, "parent", "conversation", "code");
  const child = new AgentRunRecorder(workspaceDir, "child", "conversation", "code", undefined, { parentRunId: "parent", parentTaskId: 7 });
  await parent.start();
  await child.start();
  const blocked = await parent.finish("completed", {}, undefined, completedEvidence);
  assert.equal(blocked.status, "failed");
  assert.deepEqual(blocked.completionEvidence?.ledger.blockers, ["childRun"]);
  assert.equal(listDescendantRuns(workspaceDir, "parent")[0]?.status, "running");

  // Simulate a process restart: a persisted running child becomes interrupted,
  // which remains nonterminal and therefore still blocks its isolated parent.
  const runFile = path.join(workspaceDir, ".history", "runs", "child.json");
  const persisted = JSON.parse(await fs.readFile(runFile, "utf8"));
  persisted.status = "interrupted";
  await fs.writeFile(runFile, JSON.stringify(persisted));
  assert.equal(listDescendantRuns(workspaceDir, "parent")[0]?.status, "interrupted");
  assert.equal(terminalizeInterruptedRun(workspaceDir, "child", "stopped").status, "stopped");

  const secondParent = new AgentRunRecorder(workspaceDir, "parent-2", "conversation", "code");
  const terminalChild = new AgentRunRecorder(workspaceDir, "child-2", "conversation", "code", undefined, { parentRunId: "parent-2", parentTaskId: 8 });
  await secondParent.start();
  await terminalChild.start();
  await terminalChild.finish("completed");
  const completed = await secondParent.finish("completed", {}, undefined, completedEvidence);
  assert.equal(completed.status, "completed");
});

test("persists tool lifecycle transitions and interrupts unfinished tools on finish", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crownforge-tools-"));
  const recorder = new AgentRunRecorder(workspaceDir, "run-tools", "conversation-1", "code");
  await recorder.start();
  await recorder.toolState({
    toolCallId: "call-1",
    requestId: "request-1",
    name: "write_file",
    toolInput: { path: "src/a.ts", apiKey: "must-not-persist" },
    status: "pending",
  });
  await recorder.toolState({
    toolCallId: "call-1",
    requestId: "request-1",
    name: "write_file",
    status: "running",
  });
  await recorder.finish("stopped");

  const record = readRunRecord(workspaceDir, "run-tools");
  assert.equal(record.toolExecutions[0]?.status, "interrupted");
  assert.equal(record.toolExecutions[0]?.input.apiKey, "[REDACTED]");
  assert.match(record.toolExecutions[0]?.error || "", /interrupted/i);
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

test("redacts secrets from run events, tool state, summaries, and legacy records", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crownforge-redacted-run-"));
  const canary = "sk-test_RUN_CANARY_123456";
  const recorder = new AgentRunRecorder(workspaceDir, "run-redacted", "conversation-1", "code");
  await recorder.start();
  await recorder.event({ kind: "tool_result", label: `safe code() ${canary}`, detail: `result=Bearer ${canary}` });
  await recorder.toolState({
    toolCallId: "call-1", requestId: "request-1", name: "bash",
    toolInput: { command: `curl 'https://user:${canary}@provider.test/?api_key=${canary}'`, safe: "code()" },
    status: "completed", resultSummary: `output=${canary}; code()`, error: `token=${canary}`,
  });
  await recorder.finish("completed", {}, {
    changedFiles: [`src/${canary}.ts`], toolCallCount: 1, errorCount: 0, commandCount: 1,
    reviewFindings: [{ id: "finding", severity: "info", path: "safe.ts", line: 1, message: `found ${canary}` }],
  }, {
    schemaVersion: 1, outcome: "completed",
    ledger: { changedFiles: [`src/${canary}.ts`], verification: [{ command: `test ${canary}`, status: "passed" }], criteria: [{ criterion: `no ${canary}`, state: "passed", evidenceRefs: [] }], blockers: [] },
  });

  const raw = await fs.readFile(path.join(workspaceDir, ".history", "runs", "run-redacted.json"), "utf8");
  const record = readRunRecord(workspaceDir, "run-redacted");
  const summary = listRunSummaries(workspaceDir, "conversation-1")[0];
  for (const value of [raw, JSON.stringify(record), JSON.stringify(summary)]) {
    assert.doesNotMatch(value, new RegExp(canary));
  }
  assert.match(raw, /code\(\)/);
  assert.match(JSON.stringify(record), /code\(\)/);

  const legacyPath = path.join(workspaceDir, ".history", "runs", "run-legacy-secret.json");
  await fs.writeFile(legacyPath, JSON.stringify({
    runId: "run-legacy-secret", conversationId: "conversation-1", mode: "code", status: "completed",
    startedAt: 1, updatedAt: 1, metrics: {}, events: [{ id: "event", timestamp: 1, kind: "error", label: `failure ${canary}`, detail: canary }],
    toolExecutions: [{ toolCallId: "call", requestId: "request", name: "bash", input: { value: canary }, status: "failed", createdAt: 1, updatedAt: 1, error: canary }],
  }));
  assert.doesNotMatch(JSON.stringify(readRunRecord(workspaceDir, "run-legacy-secret")), new RegExp(canary));
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

test("recovers nonterminal tool states from an orphaned running record", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crownforge-orphan-"));
  const runsDir = path.join(workspaceDir, ".history", "runs");
  await fs.mkdir(runsDir, { recursive: true });
  const now = Date.now();
  await fs.writeFile(
    path.join(runsDir, "run-orphan.json"),
    JSON.stringify({
      runId: "run-orphan",
      conversationId: "conversation-1",
      mode: "code",
      status: "running",
      startedAt: now,
      updatedAt: now,
      metrics: {},
      events: [],
      toolExecutions: [{
        toolCallId: "call-1",
        requestId: "request-1",
        name: "bash",
        input: { command: "npm test" },
        status: "awaiting_permission",
        createdAt: now,
        updatedAt: now,
      }],
    })
  );
  const record = readRunRecord(workspaceDir, "run-orphan");
  assert.equal(record.toolExecutions[0]?.status, "interrupted");
  assert.equal(record.status, "interrupted");
  await fs.rm(workspaceDir, { recursive: true, force: true });
});
