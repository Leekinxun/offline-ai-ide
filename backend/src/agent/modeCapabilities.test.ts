import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionPlan } from "../chat/executionPlans.js";
import { evaluateInspectionCommand, evaluateModeCapability } from "./modeCapabilities.js";

const plan: ExecutionPlan = {
  id: "plan-1",
  conversationId: "conversation-1",
  planRunId: "run-plan",
  status: "approved",
  goal: "Tighten mode boundaries",
  files: ["src/agent", "README.md"],
  steps: ["Implement policy"],
  risks: [],
  verificationCommands: ["npm test", "npm run build"],
  acceptanceCriteria: ["Out-of-scope writes are rejected"],
  createdAt: 1,
  approvedAt: 1,
  updatedAt: 1,
  executionRunIds: [],
};

test("Plan and Review allow inspection commands but reject composed shell actions", () => {
  assert.equal(evaluateInspectionCommand("rg -n plan src").allowed, true);
  assert.equal(evaluateInspectionCommand("git diff -- src").allowed, true);
  assert.equal(evaluateInspectionCommand("rg plan src | head").allowed, false);
  assert.equal(evaluateModeCapability({
    mode: "plan",
    toolName: "write_file",
    input: { path: "src/a.ts" },
  }).allowed, false);
});

test("Code is constrained to approved files and verification commands", () => {
  assert.equal(evaluateModeCapability({
    mode: "code",
    toolName: "edit_file",
    input: { path: "src/agent/loop.ts" },
    executionPlan: plan,
  }).allowed, true);
  const outside = evaluateModeCapability({
    mode: "code",
    toolName: "write_file",
    input: { path: "src/routes/admin.ts" },
    executionPlan: plan,
  });
  assert.equal(outside.allowed, false);
  assert.equal(outside.requiresReplan, true);
  assert.equal(evaluateModeCapability({
    mode: "code",
    toolName: "bash",
    input: { command: "npm test" },
    executionPlan: plan,
  }).allowed, true);
  assert.equal(evaluateModeCapability({
    mode: "code",
    toolName: "bash",
    input: { command: "npm run deploy" },
    executionPlan: plan,
  }).allowed, false);
});

test("Code can edit and execute directly without an approved Plan", () => {
  assert.deepEqual(evaluateModeCapability({
    mode: "code",
    toolName: "edit_file",
    input: { path: "src/routes/admin.ts" },
  }), { allowed: true });
  assert.deepEqual(evaluateModeCapability({
    mode: "code",
    toolName: "bash",
    input: { command: "npm test" },
  }), { allowed: true });
});
