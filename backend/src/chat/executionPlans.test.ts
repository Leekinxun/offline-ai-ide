import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createApprovedExecutionPlan,
  CURRENT_EXECUTION_PLAN_SCHEMA_VERSION,
  findLatestApprovedExecutionPlan,
  findLatestBoundExecutionPlan,
  readExecutionPlan,
  requestExecutionPlanAmendment,
  resolveExecutionPlanAmendment,
  updateExecutionPlanStatus,
} from "./executionPlans.js";
import { checkExecutionPlanFreshness } from "./planFreshness.js";

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
    assert.equal(plan.schemaVersion, CURRENT_EXECUTION_PLAN_SCHEMA_VERSION);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(workspaceDir, ".history", "plans", `${plan.id}.json`), "utf8")).schemaVersion,
      CURRENT_EXECUTION_PLAN_SCHEMA_VERSION
    );
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

test("persists and resolves plan amendment requests", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-plan-amendment-"));
  try {
    const plan = createApprovedExecutionPlan(workspaceDir, input, {
      conversationId: "conversation-1", planRunId: "run-plan",
    });
    const requested = requestExecutionPlanAmendment(workspaceDir, plan.id, {
      reason: "Cover the new command and file",
      requestedFiles: ["src/new.ts", "./src/new.ts"],
      requestedVerificationCommands: ["npm run check", "npm run check"],
    }, "run-code");
    const amendment = requested.amendmentRequests?.[0];
    assert.equal(requested.status, "needs_revision");
    assert.deepEqual(amendment?.requestedFiles, ["src/new.ts"]);
    assert.deepEqual(amendment?.requestedVerificationCommands, ["npm run check"]);

    const approved = resolveExecutionPlanAmendment(workspaceDir, plan.id, amendment!.id, "approved");
    assert.equal(approved.status, "approved");
    assert.equal(approved.amendmentRequests?.[0]?.status, "approved");
    assert.ok(approved.files.includes("src/new.ts"));
    assert.ok(approved.verificationCommands.includes("npm run check"));

    const rejectedRequest = requestExecutionPlanAmendment(workspaceDir, plan.id, {
      reason: "This scope is optional", requestedFiles: ["README.md"],
    }, "run-code");
    const rejected = resolveExecutionPlanAmendment(
      workspaceDir, plan.id, rejectedRequest.amendmentRequests!.at(-1)!.id, "rejected"
    );
    assert.equal(rejected.amendmentRequests?.at(-1)?.status, "rejected");
    assert.equal(rejected.status, "approved");
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("keeps needs_revision plans bound so Code cannot downgrade to direct execution", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-plan-binding-"));
  try {
    const plan = createApprovedExecutionPlan(workspaceDir, input, {
      conversationId: "conversation-1", planRunId: "run-plan",
    });
    const revised = requestExecutionPlanAmendment(workspaceDir, plan.id, {
      reason: "Scope changed", requestedFiles: ["src/new.ts"],
    }, "run-code");
    assert.equal(findLatestApprovedExecutionPlan(workspaceDir, "conversation-1"), null);
    assert.equal(findLatestBoundExecutionPlan(workspaceDir, "conversation-1")?.id, revised.id);
    updateExecutionPlanStatus(workspaceDir, plan.id, "completed");
    assert.equal(findLatestBoundExecutionPlan(workspaceDir, "conversation-1"), null);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("rejects a stale relevant workspace snapshot but ignores unrelated files", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-plan-freshness-"));
  try {
    fs.mkdirSync(path.join(workspaceDir, "src"));
    fs.writeFileSync(path.join(workspaceDir, "src", "selected.ts"), "export const value = 1;\n");
    const plan = createApprovedExecutionPlan(workspaceDir, { ...input, files: ["src/selected.ts"] }, {
      conversationId: "conversation-1", planRunId: "run-plan",
    });
    assert.ok(plan.approvalFingerprint);
    fs.writeFileSync(path.join(workspaceDir, "README.md"), "unrelated\n");
    assert.equal(checkExecutionPlanFreshness(workspaceDir, plan).fresh, true);
    fs.writeFileSync(path.join(workspaceDir, "src", "selected.ts"), "export const value = 2;\n");
    assert.deepEqual(checkExecutionPlanFreshness(workspaceDir, plan), {
      fresh: false, reason: "approved workspace snapshot is stale",
    });
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("fingerprints a workspace-root scope while excluding internal directories", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-plan-root-scope-"));
  try {
    fs.writeFileSync(path.join(workspaceDir, "tracked-by-snapshot.txt"), "one\n");
    const plan = createApprovedExecutionPlan(workspaceDir, { ...input, files: ["."] }, {
      conversationId: "conversation-1", planRunId: "run-plan",
    });
    assert.equal(checkExecutionPlanFreshness(workspaceDir, plan).fresh, true);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("approval of an amendment refreshes the snapshot and retains pending amendment state", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-plan-amendment-freshness-"));
  try {
    fs.mkdirSync(path.join(workspaceDir, "src"));
    fs.writeFileSync(path.join(workspaceDir, "src", "a.ts"), "a\n");
    fs.writeFileSync(path.join(workspaceDir, "src", "b.ts"), "b\n");
    const plan = createApprovedExecutionPlan(workspaceDir, { ...input, files: ["src/a.ts"] }, {
      conversationId: "conversation-1", planRunId: "run-plan",
    });
    requestExecutionPlanAmendment(workspaceDir, plan.id, {
      reason: "include b", requestedFiles: ["src/b.ts"],
    }, "run-code");
    const second = requestExecutionPlanAmendment(workspaceDir, plan.id, {
      reason: "another decision", requestedVerificationCommands: ["npm run check"],
    }, "run-code");
    const refreshed = resolveExecutionPlanAmendment(workspaceDir, plan.id, second.amendmentRequests![0]!.id, "approved");
    assert.equal(refreshed.status, "needs_revision");
    assert.equal(refreshed.amendmentRequests!.at(-1)!.status, "pending");
    assert.ok(refreshed.approvalFingerprint);
    assert.equal(checkExecutionPlanFreshness(workspaceDir, refreshed).fresh, true);
    const approved = resolveExecutionPlanAmendment(workspaceDir, plan.id, second.amendmentRequests!.at(-1)!.id, "approved");
    assert.equal(approved.status, "approved");
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("normalizes legacy plans and rejects future schemas", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-plan-schema-"));
  try {
    const plansDir = path.join(workspaceDir, ".history", "plans");
    fs.mkdirSync(plansDir, { recursive: true });
    const legacy = {
      id: "plan-legacy", conversationId: "conversation-1", planRunId: "run-plan", status: "approved",
      goal: "Legacy", files: ["src/agent"], steps: ["Edit"], risks: [],
      verificationCommands: ["npm test"], acceptanceCriteria: ["Works"], createdAt: 1,
      updatedAt: 1, executionRunIds: [],
    };
    fs.writeFileSync(path.join(plansDir, "plan-legacy.json"), JSON.stringify(legacy));
    fs.writeFileSync(path.join(plansDir, "plan-future.json"), JSON.stringify({
      ...legacy, id: "plan-future", schemaVersion: CURRENT_EXECUTION_PLAN_SCHEMA_VERSION + 1,
    }));

    assert.equal(readExecutionPlan(workspaceDir, "plan-legacy").schemaVersion, CURRENT_EXECUTION_PLAN_SCHEMA_VERSION);
    assert.deepEqual(readExecutionPlan(workspaceDir, "plan-legacy").amendmentRequests, []);
    assert.throws(() => readExecutionPlan(workspaceDir, "plan-future"), /Execution plan is invalid/);
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
