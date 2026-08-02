import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createApprovedExecutionPlan,
  findLatestApprovedExecutionPlan,
  readExecutionPlan,
  updateExecutionPlanStatus,
} from "./executionPlans.js";

const input = {
  goal: "Implement Plan to Code handoff",
  files: ["src/agent", "README.md"],
  steps: ["Add the contract", "Enforce it"],
  risks: ["Existing direct Code flows change"],
  verification_commands: ["npm test", "npm run build"],
  acceptance_criteria: ["Code requires an approved Plan"],
};

test("persists approved plans and tracks their execution lifecycle", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-plan-"));
  try {
    const plan = createApprovedExecutionPlan(workspaceDir, input, {
      conversationId: "conversation-1",
      planRunId: "run-plan",
    });
    assert.equal(readExecutionPlan(workspaceDir, plan.id).status, "approved");
    assert.equal(findLatestApprovedExecutionPlan(workspaceDir, "conversation-1")?.id, plan.id);

    updateExecutionPlanStatus(workspaceDir, plan.id, "in_progress", "run-code");
    const running = readExecutionPlan(workspaceDir, plan.id);
    assert.deepEqual(running.executionRunIds, ["run-code"]);

    updateExecutionPlanStatus(workspaceDir, plan.id, "completed", "run-code");
    assert.equal(findLatestApprovedExecutionPlan(workspaceDir, "conversation-1"), null);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("rejects unsafe file scopes in submitted plans", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-plan-"));
  try {
    assert.throws(() => createApprovedExecutionPlan(workspaceDir, {
      ...input,
      files: ["../outside.ts"],
    }, {
      conversationId: "conversation-1",
      planRunId: "run-plan",
    }), /Invalid plan file scope/);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});
