import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRunEvent } from "../src/types/index.ts";
import { isQuietCompletionEvent } from "../src/utils/runEventDisplay.ts";

const completion = (overrides: Partial<AgentRunEvent> = {}): AgentRunEvent => ({
  id: "completion-event",
  timestamp: 1,
  kind: "tool_result",
  label: "Repository quality gate passed",
  ...overrides,
});

test("quiet successful completion events in chat without hiding warnings or tool output", () => {
  assert.equal(isQuietCompletionEvent(completion()), true);
  assert.equal(isQuietCompletionEvent(completion({ label: "门禁质量已通过" })), true);
  assert.equal(isQuietCompletionEvent(completion({ kind: "error", isError: true, label: "Repository quality hook warnings" })), false);
  assert.equal(isQuietCompletionEvent(completion({ isError: true })), false);
  assert.equal(isQuietCompletionEvent(completion({ toolName: "bash" })), false);
});
