import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createExecutionFacts, normalizeExecutionFacts, recordExecutionFact, summarizeExecutionFacts, type ExecutionFactInput } from "./executionFacts.js";
import { AgentRunRecorder, listRunSummaries, readRunRecord } from "./runHistory.js";

function read(toolCallId: string, overrides: Record<string, unknown> = {}): ExecutionFactInput {
  return { kind: "tool_result", requestId: "request", toolCallId, toolName: "read_file", isError: false,
    output: JSON.stringify({ path: "logs/a.txt", version: "sha256:v1", character_offset: 0, total_characters: 6, complete: true, truncated: false, content: "abcdef", ...overrides }) };
}

function binaryMetadata(toolCallId: string, overrides: Record<string, unknown> = {}): ExecutionFactInput {
  return { kind: "tool_result", requestId: "request", toolCallId, toolName: "read_file", isError: false,
    output: JSON.stringify({ path: "delivery.sqlite", read_only: true, content_kind: "binary", inspection_only: true,
      size_bytes: 8192, sha256: "1".repeat(64), format: "sqlite", ...overrides }) };
}

test("binary metadata remains a successful inspection without counting a text read or degrading replayed facts", () => {
  const facts = createExecutionFacts();
  const receipt = { ...binaryMetadata("metadata"), executionId: "metadata-1" };
  recordExecutionFact(facts, receipt);
  assert.equal(facts.toolCalls, 1);
  assert.equal(facts.successfulToolCalls, 1);
  assert.equal(facts.fileReads, 0);
  assert.equal(facts.unclassifiedFileReads, 0);
  assert.equal(facts.completeness, "complete");
  assert.deepEqual(facts.readRanges, []);

  const restored = normalizeExecutionFacts(JSON.parse(JSON.stringify(facts)));
  assert.deepEqual(restored, facts);
  recordExecutionFact(restored, receipt);
  assert.deepEqual(restored, facts);
  recordExecutionFact(restored, read("text"));
  assert.equal(restored.toolCalls, 2);
  assert.equal(restored.successfulToolCalls, 2);
  assert.equal(restored.fileReads, 1);
  assert.equal(restored.completeness, "complete");
  assert.deepEqual(normalizeExecutionFacts(restored), restored);
});

test("malformed binary metadata cannot hide an unclassified successful file read", () => {
  for (const overrides of [
    { path: "" }, { read_only: false }, { inspection_only: false }, { content_kind: "text" },
    { size_bytes: -1 }, { size_bytes: 1.5 }, { size_bytes: Number.MAX_SAFE_INTEGER + 1 },
    { sha256: "not-a-sha256" }, { sha256: "1".repeat(63) }, { sha256: "A".repeat(64) },
    { content: "unread bytes" }, { content: null }, { version: "editable-version" }, { version: null },
  ]) {
    const facts = createExecutionFacts();
    recordExecutionFact(facts, binaryMetadata("metadata", overrides));
    assert.equal(facts.toolCalls, 1, JSON.stringify(overrides));
    assert.equal(facts.successfulToolCalls, 1, JSON.stringify(overrides));
    assert.equal(facts.fileReads, 1, JSON.stringify(overrides));
    assert.equal(facts.unclassifiedFileReads, 1, JSON.stringify(overrides));
    assert.equal(facts.completeness, "unknown", JSON.stringify(overrides));
    assert.deepEqual(normalizeExecutionFacts(facts), facts);
  }
});

test("distinct dispatches with reused provider IDs are counted but replayed receipts stay idempotent", () => {
  const facts = createExecutionFacts();
  const first = { ...read("call_0"), executionId: "1" };
  const next = { ...read("call_0"), executionId: "2" };
  recordExecutionFact(facts, first);
  recordExecutionFact(facts, next);
  recordExecutionFact(facts, next);
  assert.equal(facts.toolCalls, 2);
  assert.equal(facts.fileReads, 2);
  assert.equal(facts.duplicateFileReads, 1);
  assert.equal(facts.completeness, "complete");
});

test("actual read ranges distinguish duplicate reads, continuation, and changed versions", () => {
  const facts = createExecutionFacts();
  recordExecutionFact(facts, read("one", { path: "logs/./a.txt", content: "abc", complete: false, truncated: true }));
  recordExecutionFact(facts, read("two", { content: "abc", complete: false, truncated: true }));
  recordExecutionFact(facts, read("three", { character_offset: 3, content: "def", complete: false }));
  recordExecutionFact(facts, read("four", { version: "sha256:v2" }));
  recordExecutionFact(facts, read("four", { version: "sha256:v2" }));
  const summary = summarizeExecutionFacts(facts);
  assert.equal(summary.completeness, "complete");
  assert.equal(summary.fileReads, 4);
  assert.equal(summary.duplicateFileReads, 1);
  assert.equal(summary.pagedFileReads, 1);
  assert.equal(summary.updatedFileReads, 1);
  assert.equal(summary.readRanges[0].count, 2);
  assert.deepEqual(summary.readRanges.map(({ start, end }) => [start, end]), [[0, 3], [3, 6], [0, 6]]);
  assert.equal("observedFactIds" in summary, false);
});

test("full outputs are classified before the UI's 5000 character limit", () => {
  const facts = createExecutionFacts();
  const content = "A".repeat(50_000);
  recordExecutionFact(facts, read("long", { content, total_characters: content.length }));
  recordExecutionFact(facts, read("long-again", { content, total_characters: content.length }));
  assert.equal(facts.duplicateFileReads, 1);
  assert.equal(facts.readRanges[0].end, 50_000);
  assert.equal(JSON.stringify(facts).includes(content), false);
});

test("malformed read evidence is unknown, while errors and denial are distinct from successful reads", () => {
  const facts = createExecutionFacts();
  recordExecutionFact(facts, { kind: "tool_result", requestId: "r", toolCallId: "malformed", toolName: "read_file", output: "{truncated", isError: false });
  recordExecutionFact(facts, { kind: "tool_result", requestId: "r", toolCallId: "failed", toolName: "read_file", output: "Error", isError: true });
  recordExecutionFact(facts, { kind: "tool_result", requestId: "r", toolCallId: "denied", toolName: "read_file", output: "Denied", isError: true, denied: true });
  assert.equal(facts.completeness, "unknown");
  assert.equal(facts.toolCalls, 3);
  assert.equal(facts.fileReads, 1);
  assert.equal(facts.unclassifiedFileReads, 1);
  assert.equal(facts.failedToolCalls, 1);
  assert.equal(facts.deniedToolCalls, 1);
});

test("compaction outcomes retain real summary, fallback, and failure evidence", () => {
  const facts = createExecutionFacts();
  recordExecutionFact(facts, { kind: "compaction", attemptId: "one", outcome: "summary", tokensBefore: 60_100, tokensAfter: 15_000 });
  recordExecutionFact(facts, { kind: "compaction", attemptId: "two", outcome: "fallback_trim", tokensBefore: 60_200, tokensAfter: 20_000 });
  recordExecutionFact(facts, { kind: "compaction", attemptId: "three", outcome: "failed", tokensBefore: 60_300 });
  recordExecutionFact(facts, { kind: "compaction", attemptId: "three", outcome: "failed", tokensBefore: 60_300 });
  assert.deepEqual(facts.compactions, { summaryCount: 1, fallbackTrimCount: 1, failedCount: 2, last: { outcome: "failed", tokensBefore: 60_300 } });
  assert.deepEqual(normalizeExecutionFacts(facts), facts);
  assert.equal(normalizeExecutionFacts(undefined).completeness, "unknown");
  assert.equal(normalizeExecutionFacts({ ...facts, toolCalls: -1 }).completeness, "unknown");
  assert.equal("rawOutput" in normalizeExecutionFacts({ ...facts, rawOutput: "must not persist" }), false);
});

test("aggregation capacity marks unknown without evicting identities or overcounting a replay", () => {
  const facts = createExecutionFacts();
  facts.observedFactIds = Array.from({ length: 10_000 }, (_, index) => `sha256:${index.toString(16).padStart(64, "0")}`);
  facts.toolCalls = 10_000;
  facts.successfulToolCalls = 10_000;
  recordExecutionFact(facts, read("over-capacity"));
  assert.equal(facts.completeness, "unknown");
  assert.equal(facts.toolCalls, 10_000);
  assert.equal(facts.observedFactIds.length, 10_000);
  assert.equal(normalizeExecutionFacts(facts).completeness, "unknown");
});

test("durable aggregates survive the 250 tool-history cap and recorder reload", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-execution-facts-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const recorder = new AgentRunRecorder(workspace, "facts-run", "conversation", "code");
  await recorder.start();
  for (let i = 0; i < 301; i += 1) {
    const toolCallId = `read-${i}`;
    await recorder.toolState({ requestId: "request", toolCallId, name: "read_file", status: "completed" });
    await recorder.recordExecutionFact(read(toolCallId));
  }
  assert.equal(recorder.snapshot().toolExecutions.length, 250);
  assert.equal(recorder.getExecutionFacts().fileReads, 301);
  assert.equal(recorder.getExecutionFacts().duplicateFileReads, 300);
  const restored = new AgentRunRecorder(workspace, "facts-run", "conversation", "code");
  await restored.recordExecutionFact(read("read-300"));
  assert.equal(restored.getExecutionFacts().fileReads, 301);
  assert.equal(readRunRecord(workspace, "facts-run").executionFacts?.duplicateFileReads, 300);
  assert.equal(listRunSummaries(workspace)[0].executionFacts?.completeness, "complete");
  await restored.finish("stopped");
});

test("legacy run records cannot claim complete execution facts from clipped history", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-legacy-facts-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const recorder = new AgentRunRecorder(workspace, "legacy", "conversation", "code");
  await recorder.start();
  await recorder.finish("stopped");
  const file = path.join(workspace, ".history/runs/legacy.json");
  const record = JSON.parse(await fs.readFile(file, "utf8"));
  delete record.executionFacts;
  await fs.writeFile(file, JSON.stringify(record));
  assert.equal(readRunRecord(workspace, "legacy").executionFacts?.completeness, "unknown");
  assert.equal(listRunSummaries(workspace)[0].executionFacts?.completeness, "unknown");
});
