import assert from "node:assert/strict";
import test from "node:test";
import { classifyToolApproval, ToolApprovalSession } from "./toolApproval.js";

test("read-only tools do not require approval", () => {
  assert.deepEqual(classifyToolApproval("read_file", { path: "src/index.ts" }), { kind: "none" });
});

test("protected writes are blocked before approval", () => {
  const result = classifyToolApproval("write_file", { path: ".git/config" });
  assert.equal(result.kind, "blocked");
});

test("file writes can be allowed for the current directory session", async () => {
  const requests: string[] = [];
  const session = new ToolApprovalSession((request) => requests.push(request.approvalId), 1000);
  const input = {
    requestId: "req",
    toolCallId: "call",
    name: "edit_file",
    input: { path: "src/a.ts" },
    risk: "medium" as const,
    reason: "modify",
    scope: "src/a.ts",
    canAllowSession: true,
    sessionKey: "edit_file:src",
  };
  const first = session.request(input);
  assert.equal(session.resolve(requests[0], "allow_session"), true);
  assert.equal(await first, "allow_session");
  assert.equal(await session.request({ ...input, toolCallId: "call-2" }), "allow_session");
  assert.equal(requests.length, 1);
});

test("shell commands remain per-action approvals", async () => {
  let approvalId = "";
  const session = new ToolApprovalSession((request) => { approvalId = request.approvalId; }, 1000);
  const pending = session.request({
    requestId: "req",
    toolCallId: "call",
    name: "bash",
    input: { command: "npm test" },
    risk: "high",
    reason: "execute",
    scope: "npm test",
    canAllowSession: false,
  });
  session.resolve(approvalId, "allow_session");
  assert.equal(await pending, "allow_once");
});

test("approves current and future requests only for one conversation", async () => {
  const approvalIds: string[] = [];
  const session = new ToolApprovalSession((request) => approvalIds.push(request.approvalId), 1000);
  const input = {
    requestId: "req",
    toolCallId: "call-a",
    name: "bash",
    input: { command: "npm test" },
    risk: "high" as const,
    reason: "execute",
    scope: "npm test",
    canAllowSession: false,
  };
  const first = session.request({ ...input, conversationId: "conversation-a" });
  const other = session.request({ ...input, conversationId: "conversation-b", toolCallId: "call-b" });

  assert.equal(session.allowConversation("conversation-a"), 1);
  assert.equal(await first, "allow_once");
  assert.equal(
    await session.request({ ...input, conversationId: "conversation-a", toolCallId: "call-a2" }),
    "allow_once"
  );
  assert.equal(approvalIds.length, 2);
  session.resolve(approvalIds[1], "deny");
  assert.equal(await other, "deny");
});

test("execution plans always require an explicit approval decision", async () => {
  const approvalIds: string[] = [];
  const session = new ToolApprovalSession((request) => approvalIds.push(request.approvalId), 1000);
  session.allowConversation("conversation-a");
  const pending = session.request({
    conversationId: "conversation-a",
    requestId: "req-plan",
    toolCallId: "call-plan",
    name: "submit_plan",
    input: { goal: "Implement capability boundaries" },
    risk: "medium",
    reason: "approve plan",
    scope: "Implement capability boundaries",
    canAllowSession: false,
  });
  assert.equal(approvalIds.length, 1);
  session.resolve(approvalIds[0], "allow_once");
  assert.equal(await pending, "allow_once");
});
