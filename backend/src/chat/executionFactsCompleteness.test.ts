import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRunRecorder, listChildRuns, readRunRecord } from "./runHistory.js";

test("uninstrumented executor records stay unknown while collected parent and child facts remain complete", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-facts-completeness-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const parent = new AgentRunRecorder(root, "parent", "conversation", "ask");
  await parent.start();
  const legacyChild = new AgentRunRecorder(root, "legacy-child", "conversation", "ask", undefined,
    { parentRunId: parent.runId, agentName: "subagent:fixture" }, undefined, undefined, undefined, { executionFactsCompleteness: "unknown" });
  const collectedChild = new AgentRunRecorder(root, "collected-child", "conversation", "ask", undefined,
    { parentRunId: parent.runId, agentName: "instrumented:fixture" });
  await legacyChild.start(); await collectedChild.start();
  await legacyChild.toolState({ toolCallId: "legacy-read", requestId: "request", name: "read_file", status: "completed", resultSummary: "Read fixture" });
  for (const recorder of [parent, collectedChild]) {
    // This supported ordering must not permanently downgrade a complete collector.
    await recorder.toolState({ toolCallId: "read", requestId: "request", name: "read_file", status: "completed", resultSummary: "Read fixture" });
    await recorder.recordExecutionFact({ kind: "tool_result", requestId: "request", toolCallId: "read", toolName: "read_file", isError: false,
      output: JSON.stringify({ path: "fixture.txt", version: "v1", character_offset: 0, total_characters: 7, complete: true, truncated: false, content: "fixture" }) });
    assert.equal(recorder.getExecutionFacts().completeness, "complete");
    assert.equal(recorder.getExecutionFacts().fileReads, 1);
  }
  assert.equal(legacyChild.getExecutionFacts().completeness, "unknown");
  assert.equal(readRunRecord(root, legacyChild.runId).executionFacts?.completeness, "unknown");
  const children = listChildRuns(root, parent.runId);
  assert.equal(children.find((child) => child.runId === legacyChild.runId)?.executionFacts?.completeness, "unknown");
  assert.equal(children.find((child) => child.runId === collectedChild.runId)?.executionFacts?.completeness, "complete");
  await legacyChild.finish("stopped"); await collectedChild.finish("stopped"); await parent.finish("stopped");
});

test("partial receipts cannot turn explicitly unknown executor records into a complete source", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-facts-partial-executor-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const recorder = new AgentRunRecorder(root, "partial", "conversation", "ask", undefined, undefined, undefined, undefined, undefined,
    { executionFactsCompleteness: "unknown" });
  await recorder.start();
  await recorder.recordExecutionFact({ kind: "tool_result", requestId: "request", toolCallId: "partial", toolName: "find_files", isError: false, output: "fixture" });
  assert.equal(recorder.getExecutionFacts().toolCalls, 1);
  assert.equal(recorder.getExecutionFacts().completeness, "unknown");
  await recorder.finish("stopped");
});
