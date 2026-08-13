import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type test from "node:test";
import { AgentRunRecorder } from "./runHistory.js";
import { createApprovedExecutionPlan } from "./executionPlans.js";
import { createManagedWorktree } from "./worktrees.js";
import { captureChangeSet } from "./changeSets.js";
import { listChangeSetReviewRuns, scheduleChangeSetReview, setChangeSetReviewRunnerForTests } from "./changeSetReviewRun.js";
import { ReviewFindingStore } from "./reviewFindingStore.js";
import type { CompletionEvidence } from "./completionEvidence.js";

function git(dir: string, args: string[]): string { return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
async function settle(workspace: string, id: string): Promise<void> { for (let attempt = 0; attempt < 200; attempt += 1) { const run = listChangeSetReviewRuns(workspace).find((item) => item.id === id); if (run && ["completed", "failed", "interrupted"].includes(run.status)) { if (run.status !== "completed") throw new Error(run.error || `Review run ${run.status}`); return; } await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error("Review run did not settle"); }

export async function createArtifactFixture(t: test.TestContext, options: { withFinding?: boolean; secret?: string; patchContent?: string } = {}) {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-artifact-test-")); const workspace = path.join(outer, "repo"); fs.mkdirSync(workspace);
  t.after(() => { setChangeSetReviewRunnerForTests(); fs.rmSync(outer, { recursive: true, force: true }); });
  git(workspace, ["init"]); git(workspace, ["config", "user.email", "test@example.com"]); git(workspace, ["config", "user.name", "CrewForge Test"]);
  fs.writeFileSync(path.join(workspace, "a.txt"), "base\n"); git(workspace, ["add", "."]); git(workspace, ["commit", "-m", "base"]);
  const plan = createApprovedExecutionPlan(workspace, { goal: "Change a safely", files: ["a.txt"], steps: ["edit", "verify"], risks: [], verification_commands: ["npm test"], acceptance_criteria: ["tests pass"] }, { conversationId: "conversation-1", planRunId: "plan-run-1" });
  const completionEvidence: CompletionEvidence = { schemaVersion: 1, outcome: "completed", ledger: { changedFiles: ["a.txt"], verification: [{ command: "npm test", status: "passed", toolCallId: "tool-test-1", exitCode: 0, outputDigest: "sha256:test-output" }], criteria: [{ criterion: "tests pass", state: "passed", evidenceRefs: ["tool-test-1"] }], blockers: [] } };
  const recorder = new AgentRunRecorder(workspace, "child-run-1", "conversation-1", "code", undefined, { parentRunId: "parent-run-1", parentToolCallId: "parent-tool-1" }, plan.id, "test-model", "approved_plan");
  await recorder.start(); await recorder.finish("completed", {}, { changedFiles: ["a.txt"], toolCallCount: 1, errorCount: 0, commandCount: 1 }, completionEvidence);
  const originalWorktree = createManagedWorktree(workspace, { name: "artifact", ownerId: "writer", parentRunId: "parent-run-1", childRunId: "child-run-1", toolCallId: "parent-tool-1" });
  fs.writeFileSync(path.join(originalWorktree.path, "a.txt"), options.patchContent || "changed\n"); git(originalWorktree.path, ["add", "a.txt"]); git(originalWorktree.path, ["commit", "-m", "change"]);
  const originalChangeSet = captureChangeSet(workspace, originalWorktree.id, completionEvidence);
  let pass = 0; const secret = options.secret || "sk_artifactsecret123";
  setChangeSetReviewRunnerForTests(async (input) => {
    pass += 1;
    if (!options.withFinding || input.stage === "reverify" || pass > 1) return [];
    return [{ severity: "error", path: "a.txt", line: 1, message: "Change requires verification", evidence: [`reproduced with ${secret}`] }];
  });
  const review = scheduleChangeSetReview(workspace, originalChangeSet.id, "operator", "review"); await settle(workspace, review.id);
  let worktree = originalWorktree; let changeSet = originalChangeSet;
  if (options.withFinding) {
    const fixWorktree = createManagedWorktree(workspace, { name: "artifact-fix", ownerId: "writer", parentRunId: "parent-run-1", childRunId: "child-run-1", toolCallId: "parent-tool-1" });
    fs.writeFileSync(path.join(fixWorktree.path, "a.txt"), "fixed\n"); git(fixWorktree.path, ["add", "a.txt"]); git(fixWorktree.path, ["commit", "-m", "fix"]);
    const fixChangeSet = captureChangeSet(workspace, fixWorktree.id, completionEvidence);
    const store = new ReviewFindingStore(workspace); const finding = store.list({ changeSetId: originalChangeSet.id })[0];
    store.transition(finding.id, "accepted", { id: "writer" }, { expectedVersion: finding.version });
    const accepted = store.list({ changeSetId: originalChangeSet.id })[0]; store.transition(accepted.id, "fixed", { id: "writer" }, { expectedVersion: accepted.version, fixRef: fixChangeSet.id });
    const fixReview = scheduleChangeSetReview(workspace, fixChangeSet.id, "operator", "review"); await settle(workspace, fixReview.id);
    const reverify = scheduleChangeSetReview(workspace, fixChangeSet.id, "operator", "reverify"); await settle(workspace, reverify.id);
    worktree = fixWorktree; changeSet = fixChangeSet;
  }
  return { outer, workspace, plan, completionEvidence, worktree, changeSet, originalWorktree, originalChangeSet, secret };
}
