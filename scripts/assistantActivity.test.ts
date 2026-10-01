import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRunState, ChatMessage, ToolApprovalRequest } from "../frontend/src/types/index.js";
import { assistantToolStatus, isAssistantMessageVisible, selectAssistantActivity, updateAssistantMessage } from "../frontend/src/utils/assistantActivity.js";

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({ role: "assistant", requestId: "current", content: "", timestamp: 1, ...overrides });
const step = { toolCallId: "read", name: "read_file", input: { path: "src/main.ts" } };
const approval: ToolApprovalRequest = { approvalId: "approval", requestId: "current", toolCallId: "read", name: "read_file", input: step.input, risk: "medium", reason: "approve", scope: "src/main.ts", canAllowSession: false, createdAt: 1 };
const base = { connected: true, isStreaming: true, activeRequestIds: ["current"], pendingApprovals: [] };

test("reasoning-only and tool-only assistant messages stay visible before final content exists", () => {
  assert.equal(isAssistantMessageVisible(message()), false);
  assert.equal(isAssistantMessageVisible(message({ thinking: "Actual provider reasoning" })), true);
  assert.equal(isAssistantMessageVisible(message({ toolCalls: [step] })), true);
});

test("a newly submitted request shows waiting even if the previous run was completed", () => {
  const current = message({ activity: { phase: "waiting", waitingFor: "acceptance", updatedAt: 10 } });
  const result = selectAssistantActivity({ ...base, messages: [message({ requestId: "old", thinking: "Old reasoning", content: "Old reply" }), current], runState: { status: "completed" } as AgentRunState });
  assert.equal(result?.phase, "waiting");
  assert.equal(result?.detailKey, "assistantActivity.requestSent");
  assert.equal(current.thinking, undefined, "waiting must not manufacture model reasoning");
});

test("real event phases distinguish reasoning, tool call, approval and the next model wait", () => {
  const current = message({ thinking: "Provider chunk", activity: { phase: "reasoning", updatedAt: 2 } });
  assert.equal(selectAssistantActivity({ ...base, messages: [current] })?.phase, "reasoning");
  current.toolCalls = [step]; current.activity = { phase: "tool", toolCallId: "read", updatedAt: 3 };
  assert.equal(selectAssistantActivity({ ...base, messages: [current] })?.phase, "tool");
  assert.equal(selectAssistantActivity({ ...base, messages: [current], pendingApprovals: [approval] })?.phase, "approval");
  current.activity = { phase: "waiting", waitingFor: "model", updatedAt: 4 };
  assert.equal(selectAssistantActivity({ ...base, messages: [current] })?.phase, "waiting", "old reasoning does not imply the next request has emitted reasoning");
  current.content = "Partial reply"; current.activity = { phase: "responding", updatedAt: 5 };
  assert.equal(selectAssistantActivity({ ...base, messages: [current] })?.phase, "responding");
  assert.equal(selectAssistantActivity({ ...base, messages: [current], isStreaming: false }), null);
});

test("a delta can restore an absent assistant placeholder without losing the first chunk", () => {
  const first = updateAssistantMessage([], "current", (entry) => ({ ...entry, thinking: "first" }), 10);
  const second = updateAssistantMessage(first, "current", (entry) => ({ ...entry, thinking: `${entry.thinking} second` }), 11);
  assert.equal(second.length, 1);
  assert.equal(second[0].thinking, "first second");
  assert.equal(second[0].timestamp, 10);
  assert.equal(updateAssistantMessage(second, undefined, () => message()), second);
});

test("tool status uses actual results, does not confuse empty output with running, and preserves interruptions", () => {
  assert.equal(assistantToolStatus(step, true, []), "running");
  assert.equal(assistantToolStatus(step, true, [approval]), "awaiting_permission");
  assert.equal(assistantToolStatus({ ...step, result: "" }, true, []), "completed");
  assert.equal(assistantToolStatus({ ...step, result: "error", isError: true }, false, []), "failed");
  assert.equal(assistantToolStatus(step, false, []), "interrupted");
});

test("a disconnected stream reports reconnecting instead of inventing current server progress", () => {
  const result = selectAssistantActivity({ ...base, connected: false, messages: [message({ thinking: "Earlier reasoning" })] });
  assert.equal(result?.labelKey, "assistantActivity.reconnecting");
});
