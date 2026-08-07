import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApprovedExecutionPlan } from "./executionPlans.js";
import {
  PLAN_CODE_HANDOFF_PROMPT,
  PLAN_HANDOFF_CONFIRMATION,
  resolvePlanCodeHandoff,
  shouldCompletePlanRunAfterTool,
} from "./planHandoff.js";

const input = {
  goal: "Automatically execute an approved plan",
  files: ["src/feature.ts"],
  steps: ["Implement the feature"],
  risks: [],
  verification_commands: ["npm test"],
  acceptance_criteria: ["Code starts after approval"],
};

test("hands an approved Plan run to Code exactly after successful completion", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-plan-handoff-"));
  try {
    const plan = createApprovedExecutionPlan(workspaceDir, input, {
      conversationId: "conversation-1",
      planRunId: "run-plan",
    });
    assert.equal(resolvePlanCodeHandoff({
      workspaceDir,
      conversationId: "conversation-1",
      planRunId: "run-plan",
      finalStatus: "completed",
    })?.id, plan.id);
    assert.match(PLAN_CODE_HANDOFF_PROMPT, /Code mode/);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("does not hand off failed, stopped, or unrelated Plan runs", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-plan-handoff-"));
  try {
    createApprovedExecutionPlan(workspaceDir, input, {
      conversationId: "conversation-1",
      planRunId: "run-plan",
    });
    assert.equal(resolvePlanCodeHandoff({
      workspaceDir,
      conversationId: "conversation-1",
      planRunId: "run-plan",
      finalStatus: "failed",
    }), null);
    assert.equal(resolvePlanCodeHandoff({
      workspaceDir,
      conversationId: "conversation-1",
      planRunId: "run-plan",
      finalStatus: "stopped",
    }), null);
    assert.equal(resolvePlanCodeHandoff({
      workspaceDir,
      conversationId: "conversation-1",
      planRunId: "another-run",
      finalStatus: "completed",
    }), null);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("ends the Plan loop immediately after an approved submit_plan tool", () => {
  assert.equal(shouldCompletePlanRunAfterTool({
    mode: "plan",
    toolName: "submit_plan",
    isError: false,
  }), true);
  assert.equal(shouldCompletePlanRunAfterTool({
    mode: "plan",
    toolName: "submit_plan",
    isError: true,
  }), false);
  assert.equal(shouldCompletePlanRunAfterTool({
    mode: "code",
    toolName: "submit_plan",
    isError: false,
  }), false);
  assert.match(PLAN_HANDOFF_CONFIRMATION, /Code mode/);
});
