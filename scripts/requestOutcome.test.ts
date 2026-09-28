import assert from "node:assert/strict";
import test from "node:test";
import { inlineRequestStatus, recordRequestOutcome } from "../frontend/src/utils/requestOutcome.js";

test("a complete-looking code block is not applicable until the request actually succeeds", () => {
  assert.equal(inlineRequestStatus(undefined, false), "streaming");
  assert.equal(inlineRequestStatus("failed", false), "error");
  assert.equal(inlineRequestStatus("stopped", false), "cancelled");
  assert.equal(inlineRequestStatus("completed", false), "completed");
  assert.equal(inlineRequestStatus("completed", true), "cancelled");
});
test("late completion cannot revive a failed or stopped request and state remains bounded", () => {
  let outcomes = recordRequestOutcome({}, "a", "stopped");
  outcomes = recordRequestOutcome(outcomes, "a", "completed");
  assert.equal(outcomes.a, "stopped");
  outcomes = recordRequestOutcome(outcomes, "b", "failed");
  assert.equal(recordRequestOutcome(outcomes, "b", "completed").b, "failed");
  for (let index = 0; index < 400; index++) outcomes = recordRequestOutcome(outcomes, String(index), "completed");
  assert.equal(Object.keys(outcomes).length, 300);
});
