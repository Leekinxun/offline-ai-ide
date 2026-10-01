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

test("arbitrary shell commands remain per-action approvals", async () => {
  let approvalId = "";
  const session = new ToolApprovalSession((request) => { approvalId = request.approvalId; }, 1000);
  const pending = session.request({
    requestId: "req",
    toolCallId: "call",
    name: "bash",
    input: { command: "node scripts/custom-check.js" },
    risk: "high",
    reason: "execute",
    scope: "node scripts/custom-check.js",
    canAllowSession: false,
  });
  session.resolve(approvalId, "allow_session");
  assert.equal(await pending, "allow_once");
});

test("local validation shell approvals can be reused without covering arbitrary shell", async () => {
  const approvalIds: string[] = [];
  const validation = classifyToolApproval("bash", { command: "npm test" }, { workspaceDir: "/tmp/workspace-a" });
  assert.equal(validation.kind, "approval");
  assert.equal(validation.kind === "approval" && validation.risk, "medium");
  assert.equal(validation.kind === "approval" && validation.canAllowSession, true);
  const python = classifyToolApproval("process_start", { command: "python3 -m unittest discover" }, { workspaceDir: "/tmp/workspace-a" });
  assert.equal(python.kind, "approval");
  assert.equal(python.kind === "approval" && python.risk, "medium");
  assert.notEqual(python.kind === "approval" && python.sessionKey, validation.kind === "approval" && validation.sessionKey);
  const otherWorkspace = classifyToolApproval("bash", { command: "ruff check ." }, { workspaceDir: "/tmp/workspace-b" });
  assert.equal(otherWorkspace.kind, "approval");
  assert.notEqual(otherWorkspace.kind === "approval" && otherWorkspace.sessionKey, validation.kind === "approval" && validation.sessionKey);
  const arbitrary = classifyToolApproval("bash", { command: "node scripts/custom-check.js" });
  assert.equal(arbitrary.kind, "approval");
  assert.equal(arbitrary.kind === "approval" && arbitrary.risk, "high");
  for (const command of ["npm test && git status", "python3 -m unittest | cat"]) {
    const composed = classifyToolApproval("bash", { command }, { workspaceDir: "/tmp/workspace-a" });
    assert.equal(composed.kind, "approval", command);
    assert.equal(composed.kind === "approval" && composed.risk, "high", command);
    assert.equal(composed.kind === "approval" && composed.canAllowSession, false, command);
  }
  assert.equal(classifyToolApproval("bash", { command: "ruff check . > result.txt" }, { workspaceDir: "/tmp/workspace-a" }).kind, "blocked");

  const session = new ToolApprovalSession((request) => approvalIds.push(request.approvalId), 1000);
  const input = {
    requestId: "req",
    toolCallId: "call",
    name: "bash",
    input: { command: "npm test" },
    risk: "medium" as const,
    reason: "validate",
    scope: "npm test",
    canAllowSession: true,
    sessionKey: validation.kind === "approval" ? validation.sessionKey : undefined,
  };
  const first = session.request(input);
  session.resolve(approvalIds[0], "allow_session");
  assert.equal(await first, "allow_session");
  assert.equal(await session.request({ ...input, toolCallId: "call-2" }), "allow_session");

  const high = session.request({ ...input, toolCallId: "call-3", input: { command: "node scripts/custom-check.js" }, risk: "high", canAllowSession: false, sessionKey: undefined });
  assert.equal(approvalIds.length, 2);
  session.resolve(approvalIds[1], "allow_once");
  assert.equal(await high, "allow_once");
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
    input: { command: "node scripts/custom-check.js" },
    risk: "high",
    reason: "compatibility shell",
    scope: "node scripts/custom-check.js",
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

test("approval outcomes distinguish timeout, explicit rejection, and cancellation without accepting late decisions", async () => {
  const input = { conversationId: "conversation", requestId: "request", toolCallId: "call", name: "bash", input: { command: "node scripts/custom-check.js" }, risk: "high" as const, reason: "run script", scope: "node scripts/custom-check.js", canAllowSession: false };
  let approvalId = "";
  const session = new ToolApprovalSession((request) => { approvalId = request.approvalId; }, 10);
  const timeout = session.requestDetailed(input);
  const expiredId = approvalId;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await timeout, { decision: "deny", cause: "timed_out", timeoutMs: 10 });
  assert.equal(session.pendingCount(), 0);
  assert.equal(session.resolve(expiredId, "allow_once"), false);

  const rejected = session.requestDetailed({ ...input, toolCallId: "rejected" });
  assert.equal(session.resolve(approvalId, "deny"), true);
  assert.deepEqual(await rejected, { decision: "deny", cause: "user_denied" });
  const cancelled = session.requestDetailed({ ...input, toolCallId: "cancelled" });
  session.cancelAll();
  assert.deepEqual(await cancelled, { decision: "deny", cause: "cancelled" });
  assert.equal(session.resolve(approvalId, "allow_once"), false);
});

test("bulk conversation approval resolves ordinary actions but preserves high-risk, Plan, network, and other conversations", async () => {
  const session = new ToolApprovalSession(() => {}, 1000);
  const base = { conversationId: "conversation-a", requestId: "request", toolCallId: "write", name: "write_file", input: { path: "src/a.ts" } as Record<string, unknown>, risk: "medium" as const, reason: "action", scope: "action", canAllowSession: true };
  const write = session.requestDetailed(base);
  const pending = [
    session.requestDetailed({ ...base, toolCallId: "high", name: "bash", input: { command: "node scripts/custom-check.js" }, risk: "high" }),
    session.requestDetailed({ ...base, toolCallId: "plan", name: "submit_plan", canAllowSession: false }),
    session.requestDetailed({ ...base, toolCallId: "network", name: "bash", input: { command: "curl https://example.test", allow_network: true } }),
    session.requestDetailed({ ...base, conversationId: "conversation-b", toolCallId: "other" }),
  ];
  assert.equal(session.allowConversation("conversation-a"), 1);
  assert.deepEqual(await write, { decision: "allow_once" });
  assert.deepEqual(session.listPending().map((item) => item.toolCallId), ["high", "plan", "network", "other"]);
  assert.equal(session.allowConversation("conversation-a"), 0);
  assert.deepEqual(await session.requestDetailed({ ...base, toolCallId: "future-write" }), { decision: "allow_once" });
  const futurePlan = session.requestDetailed({ ...base, toolCallId: "future-plan", name: "submit_plan" });
  assert.equal(session.pendingCount("conversation-a"), 4);
  session.cancelAll();
  assert.ok((await Promise.all([...pending, futurePlan])).every((outcome) => outcome.cause === "cancelled"));
});

test("a cached directory grant cannot authorize high-risk actions or an explicit Plan", async () => {
  let id = "";
  const session = new ToolApprovalSession((request) => { id = request.approvalId; }, 1000);
  const base = { requestId: "request", toolCallId: "write", name: "write_file", input: { path: "src/a.ts" }, risk: "medium" as const, reason: "write", scope: "src", canAllowSession: true, sessionKey: "write_file:src" };
  const write = session.request(base); session.resolve(id, "allow_session");
  assert.equal(await write, "allow_session");
  const high = session.request({ ...base, toolCallId: "high", name: "bash", input: { command: "node scripts/custom-check.js" }, risk: "high" });
  const plan = session.request({ ...base, toolCallId: "plan", name: "submit_plan" });
  assert.equal(session.pendingCount(), 2);
  session.cancelAll();
  assert.deepEqual(await Promise.all([high, plan]), ["deny", "deny"]);
});
