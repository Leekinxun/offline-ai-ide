import assert from "node:assert/strict";
import test from "node:test";
import { classifyToolApproval, ToolApprovalSession } from "./toolApproval.js";

test("read-only tools do not require approval", () => {
  assert.deepEqual(classifyToolApproval("read_file", { path: "src/index.ts" }), { kind: "none" });
});

test("protected writes are blocked before approval", () => {
  const result = classifyToolApproval("write_file", { path: ".git/config" });
  assert.equal(result.kind, "blocked");
  assert.equal(classifyToolApproval("write_file", { path: ".crewforge/policy-audit.jsonl" }).kind, "blocked");
  assert.equal(classifyToolApproval("edit_file", { path: "src/.crewforge/state.json" }).kind, "blocked");
});

test("agent bash network commands are blocked before an approval can be requested", () => {
  for (const command of ["curl https://example.test", "git pull", "npm publish", "gcloud projects list"]) {
    const result = classifyToolApproval("bash", { command });
    assert.equal(result.kind, "blocked", command);
    if (result.kind === "blocked") {
      assert.match(result.reason, /Agent shell network is blocked.*MCP\/integration.*user terminal/i);
    }
  }
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

test("approves current and future medium-risk requests only for one conversation", async () => {
  const approvalIds: string[] = [];
  const session = new ToolApprovalSession((request) => approvalIds.push(request.approvalId), 1000);
  const input = {
    requestId: "req",
    toolCallId: "call-a",
    name: "edit_file",
    input: { path: "src/a.ts" },
    risk: "medium" as const,
    reason: "modify",
    scope: "src/a.ts",
    canAllowSession: true,
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

test("conversation approval never bypasses explicit bash or MCP approval", async () => {
  const requests: Array<{ approvalId: string; name: string }> = [];
  const session = new ToolApprovalSession((request) => {
    requests.push({ approvalId: request.approvalId, name: request.name });
  }, 1000);
  session.allowConversation("conversation-a");

  const bash = session.request({
    conversationId: "conversation-a",
    requestId: "req-bash",
    toolCallId: "call-bash",
    name: "bash",
    input: { command: "npm test" },
    risk: "high",
    reason: "compatibility shell",
    scope: "npm test",
    canAllowSession: false,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].name, "bash");
  assert.equal(session.resolve(requests[0].approvalId, "allow_once"), true);
  assert.equal(await bash, "allow_once");

  const mcp = session.request({
    conversationId: "conversation-a",
    requestId: "req-mcp",
    toolCallId: "call-mcp",
    name: "mcp_external_write",
    input: { action: "create" },
    risk: "high",
    reason: "external integration",
    scope: "mcp_external_write:create",
    canAllowSession: false,
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].name, "mcp_external_write");
  assert.equal(session.resolve(requests[1].approvalId, "deny"), true);
  assert.equal(await mcp, "deny");
});

test("allowConversation does not resolve an already pending high-risk action", async () => {
  const requests: string[] = [];
  const session = new ToolApprovalSession((request) => requests.push(request.approvalId), 1000);
  const pending = session.request({
    conversationId: "conversation-a",
    requestId: "req-task",
    toolCallId: "call-task",
    name: "task",
    input: { prompt: "work" },
    risk: "high",
    reason: "autonomous task",
    scope: "work",
    canAllowSession: false,
  });
  assert.equal(session.allowConversation("conversation-a"), 0);
  assert.equal(session.resolve(requests[0], "allow_session"), true);
  assert.equal(await pending, "allow_once");
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

test("pending approvals are exposed to the conversation completion gate", async () => {
  const ids: string[] = [];
  const session = new ToolApprovalSession((request) => ids.push(request.approvalId), 1000);
  const pending = session.request({ conversationId: "conversation-a", requestId: "request", toolCallId: "call", name: "task", input: { prompt: "work" }, risk: "high", reason: "agent", scope: "work", canAllowSession: false });
  assert.equal(session.pendingCount(), 1);
  assert.equal(session.pendingCount("conversation-a"), 1);
  assert.equal(session.pendingCount("conversation-b"), 0);
  session.resolve(ids[0], "deny");
  await pending;
  assert.equal(session.pendingCount("conversation-a"), 0);
});
