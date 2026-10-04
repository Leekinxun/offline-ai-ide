import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRunRecorder, getRunsDir, listRunSummaries, readRunRecord } from "./runHistory.js";
import { appendConversationMessage, listConversationSummaries, normalizeConversationRunSummary, updateConversationState } from "./history.js";

function fixture(t: test.TestContext): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-run-failure-reason-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  return workspace;
}

const summary = { changedFiles: ["app.ts"], toolCallCount: 47, errorCount: 1, commandCount: 0 };

test("legacy failed runs expose the fatal cause on reload and summaries without rewriting history", (t) => {
  const workspace = fixture(t);
  const reason = "Agent loop exceeded maximum iterations (30)";
  const file = path.join(getRunsDir(workspace), "legacy-limit.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = JSON.stringify({ runId: "legacy-limit", conversationId: "task", mode: "code", status: "failed", startedAt: 1, updatedAt: 3,
    metrics: { iterations: 30, toolCalls: 47 }, summary,
    events: [
      { id: "tool", timestamp: 1, kind: "tool_result", label: "Read failed; agent recovered", detail: "File not found", isError: true },
      { id: "crash", timestamp: 2, kind: "error", label: "Agent run crashed", detail: reason, isError: true },
      { id: "finish", timestamp: 3, kind: "run_finished", label: "Agent run failed", isError: true },
    ] });
  fs.writeFileSync(file, bytes);
  assert.equal(readRunRecord(workspace, "legacy-limit").failureReason, reason);
  const listed = listRunSummaries(workspace)[0];
  assert.equal(listed.failureReason, reason);
  assert.equal(listed.summary?.failureReason, reason);
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
});

test("failure causes are sanitized, persisted and copied into the final event and conversation summary", async (t) => {
  const workspace = fixture(t);
  const recorder = new AgentRunRecorder(workspace, "provider-error", "task", "ask");
  await recorder.start();
  await recorder.event({ kind: "error", label: "Agent run crashed", detail: "Provider rejected Bearer sk_failuresecret123", isError: true });
  const finished = await recorder.finish("failed", {}, summary);
  assert.equal(finished.failureReason, "Provider rejected Bearer [REDACTED]");
  assert.equal(finished.events.at(-1)?.detail, finished.failureReason);
  assert.equal(finished.summary?.failureReason, finished.failureReason);
  assert.equal(readRunRecord(workspace, recorder.runId).failureReason, finished.failureReason);
  assert.equal(JSON.parse(fs.readFileSync(path.join(getRunsDir(workspace), `${recorder.runId}.json`), "utf8")).failureReason, finished.failureReason);
  await appendConversationMessage(workspace, "task", { role: "user", content: "Investigate", timestamp: 1 });
  await updateConversationState(workspace, "task", { status: "failed", summary: finished.summary, lastRunId: recorder.runId });
  assert.equal(listConversationSummaries(workspace)[0].summary?.failureReason, finished.failureReason);
  await updateConversationState(workspace, "task", { status: "running" });
  assert.equal(listConversationSummaries(workspace)[0].summary?.failureReason, undefined);
  assert.equal(finished.summary?.failureReason, finished.failureReason, "clearing conversation state must not mutate the supplied run summary");
});

test("startup and runtime failures keep an explicit cause even without an error event", async (t) => {
  for (const reason of ["Could not create checkpoint", "Runtime evidence store unavailable", "Agent loop exceeded maximum iterations (30)"]) {
    const workspace = fixture(t);
    const recorder = new AgentRunRecorder(workspace, "startup", "task", "ask");
    await recorder.start();
    const finished = await recorder.finish("failed", {}, undefined, undefined, undefined, reason);
    assert.equal(finished.failureReason, reason);
    assert.equal(finished.summary?.failureReason, reason);
    assert.equal(finished.events.at(-1)?.detail, reason);
    assert.equal(readRunRecord(workspace, "startup").failureReason, reason);
  }
});

test("completed and stopped runs do not retain stale failure reasons or recovered tool errors", async (t) => {
  for (const status of ["completed", "stopped"] as const) {
    const workspace = fixture(t);
    const recorder = new AgentRunRecorder(workspace, "recovered", "task", "ask");
    await recorder.start();
    await recorder.event({ kind: "tool_result", label: "Transient tool failure", detail: "Read failed", isError: true });
    await recorder.event({ kind: "error", label: "Agent run crashed", detail: "Old failure", isError: true });
    const finished = await recorder.finish(status, {}, { ...summary, failureReason: "Old failure" }, undefined, undefined, "Old failure");
    assert.equal(finished.status, status);
    assert.equal(finished.failureReason, undefined);
    assert.equal(finished.summary?.failureReason, undefined);
    assert.equal(finished.events.at(-1)?.detail, undefined);
    assert.equal(readRunRecord(workspace, recorder.runId).failureReason, undefined);
  }
});

test("an unrelated nonfatal error cannot be mistaken for the cause of a legacy failed run", (t) => {
  const workspace = fixture(t);
  const file = path.join(getRunsDir(workspace), "unrelated.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ runId: "unrelated", conversationId: "task", mode: "code", status: "failed", metrics: {},
    events: [{ id: "snapshot-warning", timestamp: 1, kind: "error", label: "Subagent workspace checkpoint unavailable", detail: "Optional snapshot unavailable", isError: true }] }));
  assert.equal(readRunRecord(workspace, "unrelated").failureReason, undefined);
});

test("quality gate and required verification failures expose their completion cause", (t) => {
  const workspace = fixture(t);
  const cases = [
    { runId: "quality", qualityGate: { schemaVersion: 1, status: "blocked", runId: "quality", scopeId: "run:quality", error: "Quality hook exited with code 1" }, expected: "Quality hook exited with code 1" },
    { runId: "check", completionEvidence: { schemaVersion: 1, outcome: "validation_failed", ledger: { changedFiles: [], verification: [{ command: "npm test", status: "failed" }], criteria: [], blockers: [] } }, expected: "Verification failed: npm test (failed)" },
  ];
  fs.mkdirSync(getRunsDir(workspace), { recursive: true });
  for (const { expected, ...record } of cases) {
    fs.writeFileSync(path.join(getRunsDir(workspace), `${record.runId}.json`), JSON.stringify({ ...record, conversationId: "task", mode: "code", status: "failed", metrics: {}, events: [] }));
    assert.equal(readRunRecord(workspace, record.runId).failureReason, expected);
  }
});

test("conversation failure reason normalization bounds and redacts the display text", () => {
  const normalized = normalizeConversationRunSummary({ ...summary, failureReason: `  Runtime failed token=secret-value ${"x".repeat(2500)}  ` });
  assert.ok(normalized?.failureReason?.startsWith("Runtime failed token=[REDACTED]"));
  assert.equal(normalized?.failureReason?.length, 2000);
  const complete = normalizeConversationRunSummary({ ...summary, failureReason: "Old failure", completionEvidence: {
    schemaVersion: 1, outcome: "completed", ledger: { changedFiles: [], verification: [], criteria: [], blockers: [] },
  } });
  assert.equal(complete?.failureReason, undefined);
});
