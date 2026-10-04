import assert from "node:assert/strict";
import test from "node:test";
import { EN_MESSAGES, ZH_CN_MESSAGES } from "../src/i18n/messages.ts";
import type { AgentRunState } from "../src/types/index.ts";
import {
  failureReasonFromEvents,
  messageFailureText,
  runFailureNotice,
} from "../src/utils/runFailureNotice.ts";

const baseRun = (overrides: Partial<AgentRunState> = {}): AgentRunState => ({
  runId: "run-1",
  conversationId: "conversation-1",
  mode: "code",
  status: "failed",
  startedAt: 1,
  updatedAt: 2,
  metrics: {
    iterations: 30,
    modelCalls: 30,
    toolCalls: 0,
    toolErrors: 0,
    modelErrors: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    estimatedTokensPeak: 0,
    compactionCount: 0,
  },
  eventCount: 0,
  events: [],
  ...overrides,
});

test("shows a localized maximum-iteration failure notice only for failed runs", () => {
  const notice = runFailureNotice(baseRun({
    failureReason: "Agent loop exceeded maximum iterations (30)",
  }));

  assert.deepEqual(notice, {
    kind: "max_iterations",
    reason: "Agent loop exceeded maximum iterations (30)",
    limit: 30,
  });
  assert.equal(ZH_CN_MESSAGES["chat.failure.maxIterations.title"], "执行轮次已达上限（{limit}）");
  assert.equal(ZH_CN_MESSAGES["chat.failure.maxIterations.body"], "任务尚未完成，现有修改已保留。");
  assert.equal(EN_MESSAGES["chat.failure.maxIterations.title"], "Maximum round limit reached ({limit})");

  assert.equal(runFailureNotice(baseRun({
    status: "completed",
    failureReason: "Agent loop exceeded maximum iterations (30)",
  })), null);
});

test("parses current and archived maximum-iteration limits dynamically", () => {
  assert.deepEqual(runFailureNotice(baseRun({
    failureReason: "Agent loop exceeded maximum iterations (130)",
  })), {
    kind: "max_iterations",
    reason: "Agent loop exceeded maximum iterations (130)",
    limit: 130,
  });
  assert.deepEqual(runFailureNotice(baseRun({
    failureReason: "Agent loop exceeded maximum iterations (330)",
  })), {
    kind: "max_iterations",
    reason: "Agent loop exceeded maximum iterations (330)",
    limit: 330,
  });
  assert.equal(runFailureNotice(baseRun({
    failureReason: "Agent loop exceeded maximum iterations (0)",
  }))?.kind, "generic");
});

test("keeps generic failure causes visible", () => {
  const notice = runFailureNotice(baseRun({
    failureReason: "Provider returned HTTP 429",
  }));

  assert.deepEqual(notice, {
    kind: "generic",
    reason: "Provider returned HTTP 429",
  });
});

test("hydrates failed historical runs from summary and fatal events", () => {
  assert.equal(runFailureNotice(baseRun(), {
    changedFiles: [],
    toolCallCount: 0,
    errorCount: 1,
    commandCount: 0,
    failureReason: "History summary failure",
  })?.reason, "History summary failure");

  const eventsNotice = runFailureNotice(baseRun({
    events: [
      { id: "evt-1", timestamp: 1, kind: "model_call", label: "Started" },
      { id: "evt-2", timestamp: 2, kind: "error", label: "Fatal agent error", detail: "Loop crashed" },
    ],
  }));
  assert.equal(eventsNotice?.reason, "Loop crashed");
  assert.equal(failureReasonFromEvents([{ id: "evt-3", timestamp: 3, kind: "error", label: "Fallback label" }]), "Fallback label");
});

test("uses meaningful historical fatal details before generic final failure labels", () => {
  const notice = runFailureNotice(baseRun({
    events: [
      { id: "evt-1", timestamp: 1, kind: "error", label: "Fatal agent error", detail: "Agent loop exceeded maximum iterations (30)" },
      { id: "evt-2", timestamp: 2, kind: "run_finished", label: "Agent run failed", isError: true },
    ],
  }));

  assert.deepEqual(notice, {
    kind: "max_iterations",
    reason: "Agent loop exceeded maximum iterations (30)",
    limit: 30,
  });
});

test("does not treat recovered tool result errors as the overall failure cause", () => {
  const notice = runFailureNotice(baseRun({
    events: [
      { id: "evt-1", timestamp: 1, kind: "tool_result", label: "Command failed", detail: "lint failed", isError: true },
      { id: "evt-2", timestamp: 2, kind: "error", label: "Fatal agent error", detail: "Provider disconnected" },
    ],
  }));

  assert.equal(notice?.reason, "Provider disconnected");
});

test("completed runs with nonfatal errors do not show a failure banner", () => {
  const notice = runFailureNotice(baseRun({
    status: "completed",
    events: [{ id: "evt-1", timestamp: 1, kind: "error", label: "Tool warning", detail: "Recovered" }],
  }));

  assert.equal(notice, null);
});

test("running runs clear stale failure reasons", () => {
  const notice = runFailureNotice(baseRun({
    status: "running",
    failureReason: "Agent loop exceeded maximum iterations (330)",
  }));

  assert.equal(notice, null);
});

test("message-level failures preserve streamed content and attach the error", () => {
  assert.deepEqual(messageFailureText("partial streamed answer", "Provider disconnected"), {
    content: "partial streamed answer",
    error: "Provider disconnected",
  });
});

test("summary-only history restores a failure while current running state takes precedence", () => {
  const summary = { changedFiles: [], toolCallCount: 0, errorCount: 1, commandCount: 0, failureReason: "Provider disconnected" };
  assert.equal(runFailureNotice(null, summary)?.reason, "Provider disconnected");
  assert.equal(runFailureNotice(baseRun({ status: "running" }), summary), null);
});

test("missing fatal cause is explicit and a recovered tool error is not blamed", () => {
  const notice = runFailureNotice(baseRun({ events: [
    { id: "tool", timestamp: 1, kind: "tool_result", label: "Tool failed", isError: true, detail: "Recovered search error" },
    { id: "finished", timestamp: 2, kind: "run_finished", label: "Agent run failed", isError: true },
  ] }));
  assert.deepEqual(notice, { kind: "generic", reason: "" });
  assert.equal(runFailureNotice(baseRun())?.reason, "");
  assert.ok(ZH_CN_MESSAGES["chat.failure.unknown.body"].includes("未记录具体失败原因"));
});
