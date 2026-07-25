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
