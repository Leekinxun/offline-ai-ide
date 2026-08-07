import assert from "node:assert/strict";
import test from "node:test";
import { createPermissionAuthorizer, narrowPermissionAuthorizer } from "./permissionService.js";
import { resolveAgentProfile } from "./agentProfiles.js";
import type { ExecutionPlan } from "../chat/executionPlans.js";

const request = {
  requestId: "request-1",
  toolCallId: "call-1",
  name: "write_file",
  input: { path: "src/a.ts" },
  agentName: "child:general-purpose",
};

test("child side effects still require the inherited interactive approval", async () => {
  const approvals: string[] = [];
  const authorize = createPermissionAuthorizer({
    mode: "code",
    readOnly: false,
    requestApproval: async (input) => {
      approvals.push(input.name);
      return "allow_once";
    },
  });
  assert.equal((await authorize(request)).allowed, true);
  assert.deepEqual(approvals, ["write_file"]);
});

test("child permissions fail closed without an approval channel", async () => {
  const authorize = createPermissionAuthorizer({ mode: "code", readOnly: false });
  const result = await authorize(request);
  assert.equal(result.allowed, false);
  assert.match(result.reason || "", /approval channel/i);
});

test("read-only roles and Plan capability boundaries block side-effecting tools", async () => {
  const readOnly = createPermissionAuthorizer({ mode: "code", readOnly: true });
  assert.equal((await readOnly(request)).allowed, false);
  const plan = createPermissionAuthorizer({
    mode: "plan",
    readOnly: false,
    requestApproval: async () => "allow_once",
  });
  const result = await plan({ ...request, name: "mcp_remote_write" });
  assert.equal(result.allowed, false);
  assert.match(result.reason || "", /Plan mode/i);
});

test("an approved Plan authorizes only its scoped Code actions without duplicate prompts", async () => {
  const executionPlan: ExecutionPlan = {
    id: "plan-1",
    conversationId: "conversation-1",
    planRunId: "run-plan",
    status: "approved",
    goal: "Update one feature",
    files: ["src/a.ts", "users.json"],
    steps: ["Edit the feature"],
    risks: [],
    verificationCommands: ["npm test"],
    acceptanceCriteria: ["Tests pass"],
    createdAt: 1,
    approvedAt: 1,
    updatedAt: 1,
    executionRunIds: [],
  };
  let approvalCount = 0;
  const authorize = createPermissionAuthorizer({
    mode: "code",
    readOnly: false,
    executionPlan,
    requestApproval: async () => {
      approvalCount += 1;
      return "allow_once";
    },
  });

  assert.deepEqual(await authorize({ ...request, name: "edit_file" }), {
    allowed: true,
    decision: "not_required",
  });
  assert.deepEqual(await authorize({
    ...request,
    name: "bash",
    input: { command: "npm test" },
  }), { allowed: true, decision: "not_required" });
  assert.equal((await authorize({
    ...request,
    name: "edit_file",
    input: { path: "src/outside.ts" },
  })).allowed, false);
  assert.equal((await authorize({
    ...request,
    name: "write_file",
    input: { path: "users.json" },
  })).allowed, false);
  assert.equal(approvalCount, 0);
});

test("stopped runs deny future child actions without opening an approval", async () => {
  const controller = new AbortController();
  controller.abort();
  let approvalCount = 0;
  const authorize = createPermissionAuthorizer({
    mode: "code",
    readOnly: false,
    signal: controller.signal,
    requestApproval: async () => {
      approvalCount += 1;
      return "allow_once";
    },
  });
  assert.equal((await authorize(request)).allowed, false);
  assert.equal(approvalCount, 0);
});

test("derived child permissions can only narrow the parent authorizer", async () => {
  let parentCalls = 0;
  const parent = async () => {
    parentCalls += 1;
    return { allowed: true };
  };
  const child = narrowPermissionAuthorizer(parent, resolveAgentProfile("explore"));
  assert.equal((await child({ ...request, name: "read_file" })).allowed, true);
  assert.equal((await child(request)).allowed, false);
  assert.equal(parentCalls, 1);
});
