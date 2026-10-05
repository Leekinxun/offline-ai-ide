import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRunEvent, AgentRunState, ConversationRunSummary } from "../src/types/index.ts";
import { failureReasonFromEvents, messageFailureText, runFailureNotice } from "../src/utils/runFailureNotice.ts";

const summary = (failureReason?: string): ConversationRunSummary => ({
  changedFiles: [],
  toolCallCount: 0,
  errorCount: failureReason ? 1 : 0,
  commandCount: 0,
  ...(failureReason ? { failureReason } : {}),
});

const errorEvent = (overrides: Partial<AgentRunEvent> = {}): AgentRunEvent => ({
  id: overrides.id || "event-error",
  timestamp: overrides.timestamp || 1,
  kind: "error",
  label: "Run failed",
  ...overrides,
});

const runState = (
  overrides: Partial<Pick<AgentRunState, "status" | "failureReason" | "summary" | "events">> = {},
): Pick<AgentRunState, "status" | "failureReason" | "summary" | "events"> => ({
  status: "failed",
  events: [],
  ...overrides,
});

test("returns max iteration notices with the dynamic limit for localized UI keys", () => {
  assert.deepEqual(
    runFailureNotice(runState({ failureReason: "Agent loop exceeded maximum iterations (130)" })),
    {
      kind: "max_iterations",
      reason: "Agent loop exceeded maximum iterations (130)",
      limit: 130,
    },
  );

  assert.deepEqual(
    runFailureNotice(runState({ failureReason: "Agent loop exceeded maximum iterations (330)" })),
    {
      kind: "max_iterations",
      reason: "Agent loop exceeded maximum iterations (330)",
      limit: 330,
    },
  );
});

test("prefers historical summary failure reason over generic final labels", () => {
  assert.deepEqual(
    runFailureNotice(runState({
      summary: summary("Backend connection closed unexpectedly"),
      events: [errorEvent({ id: "final", label: "Run failed" })],
    })),
    {
      kind: "generic",
      reason: "Backend connection closed unexpectedly",
    },
  );
});

test("prefers fatal event detail over generic final labels", () => {
  assert.equal(
    failureReasonFromEvents([
      errorEvent({ id: "fatal", timestamp: 1, detail: "Workspace upload failed" }),
      errorEvent({ id: "final", timestamp: 2, label: "Run failed" }),
    ]),
    "Workspace upload failed",
  );
});

test("returns no notice for completed or running states even when stale failures remain", () => {
  for (const status of ["completed", "running"] as const) {
    assert.equal(
      runFailureNotice(runState({ status, failureReason: "Previous run failed", summary: summary("Previous summary failed") })),
      null,
    );
  }
});

test("keeps explicit fatal reasons ahead of recovered tool errors", () => {
  assert.deepEqual(
    runFailureNotice(runState({
      failureReason: "Agent loop exceeded maximum iterations (130)",
      events: [errorEvent({ id: "tool-error", timestamp: 2, detail: "Tool failed but was recovered" })],
    })),
    {
      kind: "max_iterations",
      reason: "Agent loop exceeded maximum iterations (130)",
      limit: 130,
    },
  );
});

test("preserves streamed message content when attaching an error", () => {
  assert.deepEqual(messageFailureText("Partial answer already streamed", "Network disconnected"), {
    content: "Partial answer already streamed",
    error: "Network disconnected",
  });
});
