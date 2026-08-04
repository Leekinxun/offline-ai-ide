import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AgentRunRecorder,
  findLatestResumableRun,
  hasActiveRunForConversation,
  listChildRuns,
  listRunSummaries,
  readRunRecord,
} from "../chat/runHistory.js";

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
  assert.equal(children[0].agentName, "subagent:Explore");
  assert.equal(findLatestResumableRun(workspaceDir, "conversation-1")?.runId, "run-parent");

  await fs.rm(workspaceDir, { recursive: true, force: true });
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
  await fs.rm(workspaceDir, { recursive: true, force: true });
});
