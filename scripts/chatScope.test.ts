import assert from "node:assert/strict";
import test from "node:test";
import { acceptsConversationEvent, canBindAcceptedRequest } from "../frontend/src/utils/chatScope.js";

test("tokens, approvals and terminal events from another conversation never enter the active view", () => {
  for (const type of ["token", "thinking", "tool_call", "tool_result", "tool_approval_request", "done", "error", "run_state"]) {
    assert.equal(acceptsConversationEvent({ type, conversationId: "background", runId: "run-a", requestId: "req" }, { conversationId: "selected", runId: "run-b", viewEpoch: 2 }, { conversationId: "background", viewEpoch: 1 }), false, type);
  }
});

test("a late unscoped ACK or error cannot bind a new draft after navigation", () => {
  const oldRequest = { conversationId: null, viewEpoch: 1 };
  assert.equal(canBindAcceptedRequest(oldRequest, null, 2), false);
  assert.equal(canBindAcceptedRequest(oldRequest, "selected", 1), false);
  assert.equal(canBindAcceptedRequest(oldRequest, null, 1), true);
  assert.equal(acceptsConversationEvent({ type: "error", requestId: "req" }, { conversationId: null, viewEpoch: 2 }, oldRequest), false);
});

test("a new-draft Code admission conflict is shown without binding another task", () => {
  const conflict = { type: "error", conversationId: "server-allocated", requestId: "new-code" };
  const pending = { conversationId: null, viewEpoch: 2 };
  assert.equal(acceptsConversationEvent(conflict, { conversationId: null, viewEpoch: 2 }, pending), true);
  assert.equal(acceptsConversationEvent(conflict, { conversationId: null, viewEpoch: 3 }, pending), false);
  assert.equal(acceptsConversationEvent(conflict, { conversationId: "other-task", viewEpoch: 2 }, pending), false);
});

test("a run replacement rejects old event streams even within the same conversation", () => {
  const selected = { conversationId: "task", runId: "new-run", viewEpoch: 3 };
  assert.equal(acceptsConversationEvent({ type: "token", conversationId: "task", runId: "old-run", requestId: "old" }, selected), false);
  assert.equal(acceptsConversationEvent({ type: "token", conversationId: "task", runId: "new-run", requestId: "new" }, selected), true);
  assert.equal(acceptsConversationEvent({ type: "conversation_snapshot", conversationId: "task", runId: "new-run" }, selected), true);
});

test("only a request from this view can introduce a new running run before snapshot", () => {
  const event = { type: "run_state", conversationId: "task", runId: "new-run", requestId: "new", status: "running" };
  assert.equal(acceptsConversationEvent(event, { conversationId: "task", runId: "old-run", viewEpoch: 4 }, { conversationId: "task", viewEpoch: 3 }), false);
  assert.equal(acceptsConversationEvent(event, { conversationId: "task", runId: "old-run", viewEpoch: 4 }, { conversationId: "task", viewEpoch: 4 }), true);
});
