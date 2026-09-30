import assert from "node:assert/strict";
import test from "node:test";
import type { ToolApprovalRequest } from "../frontend/src/types/index.js";
import { applyToolApprovalSnapshot, approvalTaskAction, canApproveToolInConversation } from "../frontend/src/utils/toolApprovalPolicy.js";
import { EN_MESSAGES, ZH_CN_MESSAGES } from "../frontend/src/i18n/messages.js";

const request = (overrides: Partial<ToolApprovalRequest> = {}): ToolApprovalRequest => ({
  conversationId: "conversation-a", approvalId: "write-1", requestId: "request-1", toolCallId: "call-1",
  name: "edit_file", input: { path: "src/main.ts" }, risk: "medium", reason: "Edit file", scope: "src/main.ts", canAllowSession: true, ...overrides,
});
const current = { conversationId: "conversation-a", runId: "run-a" };

test("only ordinary medium-risk requests qualify for conversation approval", () => {
  assert.equal(canApproveToolInConversation(request()), true);
  for (const overrides of [
    { name: "bash", risk: "high", input: { command: "pwd" } },
    { name: "process_start", risk: "high" },
    { name: "mcp_remote", risk: "high" },
    { name: "submit_plan", risk: "medium" },
    { name: "bash", risk: "medium", input: { command: "download", allow_network: true } },
  ] satisfies Partial<ToolApprovalRequest>[]) {
    assert.equal(canApproveToolInConversation(request(overrides)), false, overrides.name);
  }
});

test("mixed queues offer a bulk action without letting the first high-risk request hide eligible writes", () => {
  const high = request({ approvalId: "shell", risk: "high", name: "bash" });
  const plan = request({ approvalId: "plan", name: "submit_plan" });
  const write = request();
  assert.equal([high, plan].find(canApproveToolInConversation), undefined);
  assert.equal([high, plan, write].find(canApproveToolInConversation), write);
});

test("authoritative bulk acknowledgement preserves unresolved shell and Plan requests", () => {
  const write = request();
  const shell = request({ approvalId: "shell", name: "bash", risk: "high" });
  const plan = request({ approvalId: "plan", name: "submit_plan" });
  const original = [write, shell, plan];
  const remaining = [shell, plan];
  assert.deepEqual(applyToolApprovalSnapshot(original, { ...current, pendingApprovals: remaining }, current), remaining);
  assert.deepEqual(original, [write, shell, plan], "Request queue is retained until an acknowledgement is applied");
  assert.deepEqual(applyToolApprovalSnapshot(original, { ...current, pendingApprovals: [] }, current), []);
});

test("stale or invalid bulk acknowledgements never hide the current run's approvals", () => {
  const pending = [request()];
  for (const snapshot of [
    { conversationId: "another", runId: "run-a", pendingApprovals: [] },
    { conversationId: "conversation-a", runId: "old-run", pendingApprovals: [] },
    { ...current, pendingApprovals: [request({ conversationId: "another" })] },
  ]) assert.equal(applyToolApprovalSnapshot(pending, snapshot, current), pending);
  assert.equal(applyToolApprovalSnapshot(pending, { ...current, pendingApprovals: [] }, { conversationId: null, runId: null }), pending);
  assert.equal(applyToolApprovalSnapshot(pending, { ...current, pendingApprovals: undefined as unknown as ToolApprovalRequest[] }, current), pending);
});

test("pending approval takes priority over both streaming and recovery actions", () => {
  assert.equal(approvalTaskAction(true, true, false), "approval");
  assert.equal(approvalTaskAction(true, false, true), "approval");
  assert.equal(approvalTaskAction(false, true, false), "stop");
  assert.equal(approvalTaskAction(false, false, true), "resume");
  assert.equal(approvalTaskAction(false, false, false), "idle");
});

test("approval navigation and individual-action boundaries have complete English and Chinese copy", () => {
  for (const messages of [EN_MESSAGES, ZH_CN_MESSAGES]) {
    for (const key of ["chat.approval.allowConversation", "chat.approval.view", "chat.approval.waiting", "chat.approval.individualRequired", "chat.approval.bulkScope"]) {
      assert.ok(messages[key]?.trim(), key);
    }
  }
});
