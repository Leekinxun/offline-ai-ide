import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AgentRunRecorder,
  findLatestResumableRun,
  listRunSummaries,
  readRunRecord,
} from "../chat/runHistory.js";

test("persists agent run metrics and timeline events", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crownforge-run-"));
  const recorder = new AgentRunRecorder(workspaceDir, "run-1", "conversation-1", "code");

  await recorder.start();
  await recorder.event(
    {
      kind: "model_response",
      label: "Model response received",
      durationMs: 42,
    },
    { modelCalls: 1, totalTokens: 128, estimatedTokensPeak: 200 }
  );
  const finished = await recorder.finish("stopped", { toolCalls: 2, toolErrors: 1 });

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
