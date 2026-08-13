import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyChangeSetDecision, captureChangeSet, changeSetReviewRevision, ChangeSetCaptureGitError, ChangeSetEvidenceGapError, ChangeSetIntegrationCrashError, ChangeSetStoreCorruptionError, getChangeSet, listChangeSets, preflightChangeSetDecision, recoverInterruptedChangeSet, setChangeSetGitCommandHookForTests, setChangeSetIntegrationHookForTests } from "./changeSets.js";
import { createManagedWorktree, listManagedWorktrees, removeManagedWorktree, WorktreeMetadataCorruptionError } from "./worktrees.js";
import { ReviewFindingStore, ReviewFindingStoreCorruptionError } from "./reviewFindingStore.js";
import { scheduleChangeSetReview, setChangeSetReviewRunnerForTests, listChangeSetReviewRuns } from "./changeSetReviewRun.js";
import { CURRENT_CHANGE_SET_SCHEMA_VERSION, CURRENT_CHANGE_SET_WAL_SCHEMA_VERSION } from "./changeSetSchema.js";

function git(directory: string, args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repo(t: test.TestContext): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-change-set-"));
  const directory = path.join(parent, "repo");
  fs.mkdirSync(directory); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  git(directory, ["init"]); git(directory, ["config", "user.email", "test@example.com"]); git(directory, ["config", "user.name", "CrewForge Test"]);
  fs.writeFileSync(path.join(directory, "a.txt"), "base\n"); git(directory, ["add", "."]); git(directory, ["commit", "-m", "base"]);
  return directory;
}

function commit(worktree: string, text: string): void {
  fs.writeFileSync(path.join(worktree, "a.txt"), text); git(worktree, ["add", "a.txt"]); git(worktree, ["commit", "-m", "change"]);
}
async function independentlyReview(directory: string, id: string): Promise<void> { setChangeSetReviewRunnerForTests(async () => []); scheduleChangeSetReview(directory, id, "test"); for (let attempt = 0; attempt < 100; attempt += 1) { if (listChangeSetReviewRuns(directory, id)[0]?.status === "completed") return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error("review did not complete"); }
test("captures stable change-set identity and verification evidence", (t) => {
  const directory = repo(t); const worktree = createManagedWorktree(directory, { name: "one", ownerId: "agent", runId: "run", toolId: "tool" });
  commit(worktree.path, "one\n");
  const first = captureChangeSet(directory, worktree.id, { command: "test", passed: true });
  const second = captureChangeSet(directory, worktree.id, { command: "test", passed: true });
  assert.equal(first.id, second.id); assert.equal(first.schemaVersion, CURRENT_CHANGE_SET_SCHEMA_VERSION); assert.equal(first.patchSha256.length, 64); assert.deepEqual(first.verificationEvidence, { command: "test", passed: true });
  assert.deepEqual(first.changedFiles, ["a.txt"]);
});

test("recapture creates a new immutable revision when evidence changes without changing patch bytes", (t) => {
  const directory = repo(t); const worktree = createManagedWorktree(directory, { name: "recapture-evidence" }); commit(worktree.path, "same-patch\n");
  const first = captureChangeSet(directory, worktree.id, { command: "test", passed: false }); const second = captureChangeSet(directory, worktree.id, { command: "test", passed: true });
  assert.notEqual(first.id, second.id); assert.equal(first.patchSha256, second.patchSha256); assert.notEqual(changeSetReviewRevision(first), changeSetReviewRevision(second));
  assert.equal(getChangeSet(directory, first.id).verificationEvidence && (getChangeSet(directory, first.id).verificationEvidence as { passed: boolean }).passed, false);
  assert.equal(getChangeSet(directory, second.id).verificationEvidence && (getChangeSet(directory, second.id).verificationEvidence as { passed: boolean }).passed, true);
});

test("transition compare-and-swap rejects a stale decision without losing the accepted state", (t) => {
  const directory = repo(t); const worktree = createManagedWorktree(directory, { name: "transition-cas" }); commit(worktree.path, "transition\n");
  const changeSet = captureChangeSet(directory, worktree.id, { passed: true }); const stale = structuredClone(changeSet); const captureRevision = changeSetReviewRevision(changeSet);
  const accepted = applyChangeSetDecision(directory, changeSet, "request_revision", { id: "review-lead", isAdmin: true }).changeSet;
  assert.equal(accepted.transitionVersion, 2); assert.equal(changeSetReviewRevision(accepted), captureRevision);
  assert.equal(accepted.decisionActorId, "review-lead"); assert.equal(accepted.decisionActorIsAdmin, true);
  assert.throws(() => applyChangeSetDecision(directory, stale, "reject"), /transition version conflict/);
  assert.equal(getChangeSet(directory, changeSet.id).status, "needs_revision");
});

test("captures empty work as a cleanup-safe no_changes completion", (t) => {
  const directory = repo(t); const worktree = createManagedWorktree(directory, { name: "empty" });
  const changeSet = captureChangeSet(directory, worktree.id, { command: "noop" });
  assert.equal(changeSet.status, "no_changes"); assert.deepEqual(changeSet.changedFiles, []); assert.equal(changeSet.captureIntegritySha256?.length, 64); assert.equal(changeSet.transitionIntegritySha256?.length, 64);
  removeManagedWorktree(directory, worktree.id);
});

test("required git status and name-only failures cannot become incomplete or no-change ChangeSets", async (t) => {
  for (const phase of ["status", "name-only"] as const) {
    await t.test(phase, (t) => {
      const directory = repo(t); const worktree = createManagedWorktree(directory, { name: `git-${phase}` });
      fs.writeFileSync(path.join(worktree.path, "a.txt"), `${phase}\n`);
      setChangeSetGitCommandHookForTests((_directory, args) => {
        if ((phase === "status" && args[0] === "status") || (phase === "name-only" && args.includes("--name-only"))) throw new Error(`simulated ${phase} failure`);
      });
      t.after(() => setChangeSetGitCommandHookForTests(undefined));
      assert.throws(() => captureChangeSet(directory, worktree.id, { passed: true }), (error: unknown) =>
        error instanceof ChangeSetCaptureGitError && error.code === "change_set_capture_git_failed" && error.command.includes(phase === "status" ? "status" : "--name-only")
      );
      setChangeSetGitCommandHookForTests(undefined);
      assert.deepEqual(listChangeSets(directory), []);
      assert.equal(listManagedWorktrees(directory).find((entry) => entry.id === worktree.id)?.status, "needs_attention");
    });
  }
});

test("preflight rejects child patches targeting .crewforge control metadata", (t) => {
  const directory = repo(t); const worktree = createManagedWorktree(directory, { name: "protected" });
  fs.mkdirSync(path.join(worktree.path, ".crewforge")); fs.writeFileSync(path.join(worktree.path, ".crewforge", "audit.jsonl"), "forged\n");
  const changeSet = captureChangeSet(directory, worktree.id);
  const preflight = preflightChangeSetDecision(directory, changeSet, "apply");
  assert.equal(preflight.applicable, false); assert.match(preflight.reasons.join(";"), /protected|unsafe/i);
});

test("preflight detects overlapping isolated write scopes without parent changes", (t) => {
  const directory = repo(t); const one = createManagedWorktree(directory, { name: "one" }); const two = createManagedWorktree(directory, { name: "two" });
  commit(one.path, "one\n"); commit(two.path, "two\n");
  const first = captureChangeSet(directory, one.id); const second = captureChangeSet(directory, two.id);
  const preflight = preflightChangeSetDecision(directory, second, "apply");
  assert.equal(git(directory, ["show", "HEAD:a.txt"]), "base");
  assert.equal(preflight.overlappingWorktrees.some((entry) => entry.worktreeId === first.worktreeId), true);
  assert.equal(preflight.applicable, false);
});

test("corrupt worktree metadata cannot hide overlapping scope or permit a decision update", (t) => {
  const directory = repo(t); const one = createManagedWorktree(directory, { name: "corrupt-scope-one" }); const two = createManagedWorktree(directory, { name: "corrupt-scope-two" });
  commit(one.path, "one\n"); commit(two.path, "two\n");
  const first = captureChangeSet(directory, one.id); const second = captureChangeSet(directory, two.id);
  const metadata = path.join(directory, ".history", "worktrees", `${one.id}.json`); const corrupt = "{not-json\n"; fs.writeFileSync(metadata, corrupt);
  assert.throws(() => preflightChangeSetDecision(directory, second, "apply"), WorktreeMetadataCorruptionError);
  assert.throws(() => applyChangeSetDecision(directory, first, "reject"), WorktreeMetadataCorruptionError);
  assert.equal(getChangeSet(directory, first.id).status, "ready_for_review");
  assert.equal(fs.readFileSync(metadata, "utf8"), corrupt);
});

test("preflight detects a three-way conflict against a changed parent", (t) => {
  const directory = repo(t); const worktree = createManagedWorktree(directory, { name: "conflict" });
  commit(worktree.path, "worktree\n"); const changeSet = captureChangeSet(directory, worktree.id);
  fs.writeFileSync(path.join(directory, "a.txt"), "parent\n"); git(directory, ["add", "a.txt"]); git(directory, ["commit", "-m", "parent change"]);
  const preflight = preflightChangeSetDecision(directory, changeSet, "apply");
  assert.equal(preflight.threeWayConflict, true); assert.equal(preflight.applicable, false);
});

test("refuses cleanup of dirty or unreviewed worktrees", (t) => {
  const directory = repo(t); const worktree = createManagedWorktree(directory, { name: "unsafe" });
  fs.writeFileSync(path.join(worktree.path, "a.txt"), "dirty\n");
  assert.throws(() => removeManagedWorktree(directory, worktree.id), /dirty/);
});

test("explicit apply integrates a reviewed committed change set", async (t) => {
  const directory = repo(t); const worktree = createManagedWorktree(directory, { name: "apply" });
  commit(worktree.path, "applied\n"); const changeSet = captureChangeSet(directory, worktree.id, { command: "test", passed: true });
  await independentlyReview(directory, changeSet.id); const result = applyChangeSetDecision(directory, changeSet, "apply");
  assert.equal(result.changeSet.status, "applied"); assert.equal(git(directory, ["show", "HEAD:a.txt"]), "applied");
  removeManagedWorktree(directory, worktree.id);
});

test("persisted mutation evidence gaps block every integration decision after independent review", async (t) => {
  for (const decision of ["apply", "cherry_pick", "merge"] as const) {
    await t.test(decision, async () => {
      const directory = repo(t); const worktree = createManagedWorktree(directory, { name: `gap-${decision}` });
      commit(worktree.path, `gap-${decision}\n`);
      const changeSet = captureChangeSet(directory, worktree.id, {
        command: "test",
        passed: true,
        mutationEvidenceGaps: [{ path: "a.txt", reason: "unreadable" }],
      });
      await independentlyReview(directory, changeSet.id);
      const preflight = preflightChangeSetDecision(directory, changeSet.id, decision);
      assert.equal(preflight.applicable, false);
      assert.deepEqual(preflight.changeEvidenceGaps, [{ path: "a.txt", reason: "unreadable" }]);
      assert.equal(preflight.blockingFindings?.length || 0, 0);
      assert.match(preflight.reasons.join(";"), /mutation evidence.*unreadable/i);
      assert.throws(() => applyChangeSetDecision(directory, changeSet.id, decision), ChangeSetEvidenceGapError);
      assert.equal(getChangeSet(directory, changeSet.id).status, "needs_attention");
      assert.equal(recoverInterruptedChangeSet(directory, changeSet.id).status, "needs_attention");
      assert.equal(git(directory, ["show", "HEAD:a.txt"]), "base");
      assert.equal(applyChangeSetDecision(directory, changeSet.id, "request_revision").changeSet.status, "needs_revision");
    });
  }
});

test("restart-style reads preserve and reject persisted equivalent change-evidence gaps without preflight mutation", async (t) => {
  const directory = repo(t); const worktree = createManagedWorktree(directory, { name: "persisted-gap" }); commit(worktree.path, "persisted-gap\n");
  const changeSet = captureChangeSet(directory, worktree.id, { passed: true });
  await independentlyReview(directory, changeSet.id);
  const target = path.join(directory, ".history", "change-sets", `${changeSet.id}.json`);
  const legacy = JSON.parse(fs.readFileSync(target, "utf8")) as Record<string, unknown>;
  legacy.schemaVersion = 1;
  legacy.checks = { changeEvidence: { blocked: true, reason: "oversized", path: "a.txt" } };
  legacy.verificationEvidence = { passed: true };
  delete legacy.integritySha256;
  fs.writeFileSync(target, `${JSON.stringify(legacy, null, 2)}\n`);
  const source = fs.readFileSync(target, "utf8");
  const reloaded = getChangeSet(directory, changeSet.id);
  assert.equal(reloaded.status, "ready_for_review");
  const preflight = preflightChangeSetDecision(directory, reloaded.id, "apply");
  assert.equal(preflight.applicable, false);
  assert.deepEqual(preflight.changeEvidenceGaps, [{ path: "a.txt", reason: "oversized" }]);
  assert.equal(fs.readFileSync(target, "utf8"), source);
  assert.throws(() => applyChangeSetDecision(directory, reloaded.id, "apply"), /Legacy ChangeSet is read-only/);
});

test("committed merge and cherry-pick decisions preserve their reviewed integration semantics through CAS", async (t) => {
  for (const decision of ["merge", "cherry_pick"] as const) {
    await t.test(decision, async () => {
      const directory = repo(t); const worktree = createManagedWorktree(directory, { name: `decision-${decision}` });
      commit(worktree.path, `${decision}\n`); const changeSet = captureChangeSet(directory, worktree.id, { passed: true });
      await independentlyReview(directory, changeSet.id);
      const result = applyChangeSetDecision(directory, changeSet, decision);
      assert.equal(result.changeSet.status, "applied");
      assert.equal(result.changeSet.decision, decision);
      assert.equal(git(directory, ["show", "HEAD:a.txt"]), decision);
    });
  }
});

function criticalFinding(directory: string, revision: string, reviewer = "reviewer", changeSetId?: string) {
  const store = new ReviewFindingStore(directory);
  const finding = store.ingest({ id: `finding-${reviewer}`, severity: "critical", path: "a.txt", line: 1, message: `must fix (${reviewer})`, evidence: ["review output"] }, { id: reviewer, revision, ...(changeSetId ? { changeSetId } : {}) });
  assert(finding);
  return { store, finding };
}

test("critical findings block immutable change-set integration with machine-readable preflight data", async (t) => {
  const directory = repo(t); const worktree = createManagedWorktree(directory, { name: "blocked", ownerId: "writer" }); commit(worktree.path, "blocked\n");
  const changeSet = captureChangeSet(directory, worktree.id, { command: "test", passed: true }); await independentlyReview(directory, changeSet.id); criticalFinding(directory, changeSetReviewRevision(changeSet), "reviewer", changeSet.id);
  const preflight = preflightChangeSetDecision(directory, changeSet, "apply");
  assert.equal(preflight.applicable, false); assert.equal(preflight.blockingFindings?.[0]?.id.startsWith("finding-"), true);
  assert.throws(() => applyChangeSetDecision(directory, changeSet, "apply"), /review gate/i);
  assert.equal(git(directory, ["show", "HEAD:a.txt"]), "base");
});

test("review gate isolates unbound and unrelated same-revision findings", async (t) => {
  const directory = repo(t); const one = createManagedWorktree(directory, { name: "scope-one" }); const two = createManagedWorktree(directory, { name: "scope-two" }); commit(one.path, "same\n"); commit(two.path, "same\n");
  const current = captureChangeSet(directory, one.id, { passed: true }); const unrelated = captureChangeSet(directory, two.id, { passed: true }); assert.equal(current.patchSha256, unrelated.patchSha256); await independentlyReview(directory, current.id); const revision = changeSetReviewRevision(current);
  const store = new ReviewFindingStore(directory);
  const other = store.ingest({ severity: "critical", path: "a.txt", line: 1, message: "other change set", evidence: ["evidence"] }, { id: "reviewer-other", revision, changeSetId: unrelated.id });
  const unbound = store.ingest({ severity: "critical", path: "a.txt", line: 1, message: "legacy unbound", evidence: ["evidence"] }, { id: "reviewer-unbound", revision });
  const bound = store.ingest({ severity: "critical", path: "a.txt", line: 1, message: "current bound", evidence: ["evidence"] }, { id: "reviewer-current", revision, changeSetId: current.id });
  assert(other && unbound && bound); const blocks = preflightChangeSetDecision(directory, current, "apply").blockingFindings || [];
  assert.equal(blocks.some(item => item.id === other.id), false); assert.equal(blocks.some(item => item.id === unbound.id), false); assert.equal(blocks.some(item => item.id === bound.id), true);
});

test("corrupt persisted patches take precedence over a simultaneous missing-review gate", (t) => {
  const directory = repo(t); const worktree = createManagedWorktree(directory, { name: "corrupt-unreviewed" }); commit(worktree.path, "corrupt\n");
  const changeSet = captureChangeSet(directory, worktree.id);
  fs.writeFileSync(path.join(directory, ".history", "change-sets", changeSet.patchBlob!), "tampered");
  assert.throws(() => preflightChangeSetDecision(directory, changeSet, "apply"), ChangeSetStoreCorruptionError);
  assert.throws(() => applyChangeSetDecision(directory, changeSet, "apply"), ChangeSetStoreCorruptionError);
  assert.equal(git(directory, ["show", "HEAD:a.txt"]), "base");
});

test("independently reviewed and verified findings permit integration", async (t) => {
  const directory = repo(t); const worktree = createManagedWorktree(directory, { name: "verified", ownerId: "writer" }); commit(worktree.path, "verified\n");
  const original = captureChangeSet(directory, worktree.id, { command: "test", passed: true }); setChangeSetReviewRunnerForTests(async (input) => input.changeSet.id === original.id ? [{ severity: "critical", path: "a.txt", line: 1, message: "must fix (reviewer)", evidence: ["review output"] }] : []); scheduleChangeSetReview(directory, original.id, "test"); for (let i = 0; i < 100 && !new ReviewFindingStore(directory).list()[0]; i += 1) await new Promise(resolve => setTimeout(resolve, 10)); const store = new ReviewFindingStore(directory); const finding = store.list()[0]!;
  const fixWorktree = createManagedWorktree(directory, { name: "verified-fix", ownerId: "writer" }); commit(fixWorktree.path, "fixed\n"); const fix = captureChangeSet(directory, fixWorktree.id, { command: "test", passed: true });
  store.transition(finding.id, "accepted", { id: "reviewer", revision: changeSetReviewRevision(original) }); const accepted = store.list({ changeSetId: original.id })[0]; store.transition(finding.id, "fixed", { id: "writer" }, { expectedVersion: accepted.version, fixRef: fix.id });
  scheduleChangeSetReview(directory, fix.id, "test"); for (let i = 0; i < 100 && !listChangeSetReviewRuns(directory, fix.id).some(run => run.stage === "review" && run.status === "completed"); i += 1) await new Promise(resolve => setTimeout(resolve, 10)); scheduleChangeSetReview(directory, fix.id, "test", "reverify"); for (let i = 0; i < 100 && store.list().find(x => x.id === finding.id)?.lifecycle !== "verified"; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  applyChangeSetDecision(directory, original, "reject"); removeManagedWorktree(directory, worktree.id);
  assert.equal(applyChangeSetDecision(directory, fix, "apply").changeSet.status, "applied");
});

test("a reasoned authorized waiver can integrate but self-verification and stale revisions cannot", async (t) => {
  const directory = repo(t); const worktree = createManagedWorktree(directory, { name: "waiver", ownerId: "writer" }); commit(worktree.path, "waiver\n");
  const changeSet = captureChangeSet(directory, worktree.id, { command: "test", passed: true }); const { store, finding } = criticalFinding(directory, changeSetReviewRevision(changeSet), "reviewer", changeSet.id); await independentlyReview(directory, changeSet.id);
  store.transition(finding.id, "dismissed", { id: "reviewer" }, { reason: "Accepted operational risk" });
  assert.throws(() => applyChangeSetDecision(directory, changeSet, "apply", { id: "operator", isAdmin: false }), /review gate/i);
  assert.equal(applyChangeSetDecision(directory, changeSet, "apply", { id: "admin", isAdmin: true }).changeSet.status, "applied");

  const second = createManagedWorktree(directory, { name: "self-verify", ownerId: "writer" }); commit(second.path, "second\n"); const selfChangeSet = captureChangeSet(directory, second.id, { command: "test", passed: true }); const selfRevision = changeSetReviewRevision(selfChangeSet); const self = criticalFinding(directory, selfRevision, "outside-reviewer", selfChangeSet.id);
  self.store.transition(self.finding.id, "accepted", { id: "outside-reviewer" }); self.store.transition(self.finding.id, "fixed", { id: "writer" }); assert.throws(() => self.store.transition(self.finding.id, "verified", { id: "writer" }, { evidence: ["claimed"], revision: selfRevision }), /independent review run/);
  assert.throws(() => applyChangeSetDecision(directory, selfChangeSet, "apply"), /review gate/i);
  applyChangeSetDecision(directory, selfChangeSet, "reject");
  // A verifier record for an old immutable patch is invalid for a newly captured revision.
  const stale = createManagedWorktree(directory, { name: "stale", ownerId: "writer" }); commit(stale.path, "stale\n"); const staleChangeSet = captureChangeSet(directory, stale.id, { command: "test", passed: true }); const staleRevision = changeSetReviewRevision(staleChangeSet); const oldRevision = `${staleRevision}-old`; const staleFinding = criticalFinding(directory, oldRevision, "stale-reviewer", staleChangeSet.id);
  // A different-revision review does not bind the new change set, so add a current finding with stale verification.
  const current = criticalFinding(directory, staleRevision, "current-reviewer", staleChangeSet.id); current.store.transition(current.finding.id, "accepted", { id: "current-reviewer" }); current.store.transition(current.finding.id, "fixed", { id: "writer" }); assert.throws(() => current.store.transition(current.finding.id, "verified", { id: "current-verifier" }, { evidence: ["old test"], revision: oldRevision }), /independent review run/);
  assert.throws(() => applyChangeSetDecision(directory, staleChangeSet, "apply"), /review gate/i);
  assert.equal(staleFinding.finding.reviewer?.revision, oldRevision);
});

test("explicit apply preserves dirty deletions and untracked files from its persisted blob", async (t) => {
  const directory = repo(t); fs.writeFileSync(path.join(directory, "delete.txt"), "remove\n"); git(directory, ["add", "."]); git(directory, ["commit", "-m", "add delete target"]);
  const worktree = createManagedWorktree(directory, { name: "dirty", parentRunId: "parent", childRunId: "child", toolCallId: "call" });
  fs.writeFileSync(path.join(worktree.path, "a.txt"), "committed and mixed\n"); git(worktree.path, ["add", "a.txt"]); git(worktree.path, ["commit", "-m", "committed portion"]); fs.rmSync(path.join(worktree.path, "delete.txt")); fs.writeFileSync(path.join(worktree.path, "new.txt"), "new\n");
  const changeSet = captureChangeSet(directory, worktree.id, { passed: true });
  assert.equal(changeSet.status, "ready_for_review"); assert.equal(changeSet.parentRunId, "parent"); assert.equal(fs.existsSync(path.join(directory, ".history", "change-sets", changeSet.patchBlob!)), true);
  for (const decision of ["merge", "cherry_pick"] as const) { const preflight = preflightChangeSetDecision(directory, changeSet, decision); assert.equal(preflight.applicable, false); assert.match(preflight.reasons.join(";"), /committed-only.*use apply/i); }
  await independentlyReview(directory, changeSet.id); applyChangeSetDecision(directory, changeSet, "apply");
  assert.equal(fs.readFileSync(path.join(directory, "a.txt"), "utf8"), "committed and mixed\n"); assert.equal(fs.existsSync(path.join(directory, "delete.txt")), false); assert.equal(fs.readFileSync(path.join(directory, "new.txt"), "utf8"), "new\n");
});

test("missing and schema-v1 ChangeSet stores remain compatible", (t) => {
  const directory = repo(t);
  assert.deepEqual(listChangeSets(directory), []);
  const worktree = createManagedWorktree(directory, { name: "legacy-change-set" }); commit(worktree.path, "legacy\n");
  const changeSet = captureChangeSet(directory, worktree.id, { passed: true });
  const target = path.join(directory, ".history", "change-sets", `${changeSet.id}.json`);
  const legacy = JSON.parse(fs.readFileSync(target, "utf8")) as Record<string, unknown>;
  const legacyId = "e".repeat(64); const legacyTarget = path.join(directory, ".history", "change-sets", `${legacyId}.json`);
  legacy.schemaVersion = 1; legacy.id = legacyId; legacy.status = "rejected"; legacy.decision = "reject"; legacy.reviewedAt = new Date().toISOString(); delete legacy.integritySha256; delete legacy.patchBlob; delete legacy.patchManifest; delete legacy.captureIntegritySha256; delete legacy.transitionVersion; delete legacy.transitionIntegritySha256;
  fs.rmSync(target); fs.writeFileSync(legacyTarget, `${JSON.stringify(legacy)}\n`);
  const source = fs.readFileSync(legacyTarget, "utf8");
  assert.equal(getChangeSet(directory, legacyId).schemaVersion, 1);
  assert.equal(listChangeSets(directory)[0]?.id, legacyId);
  assert.throws(() => scheduleChangeSetReview(directory, legacyId, "reviewer"), /Legacy change set/);
  assert.throws(() => applyChangeSetDecision(directory, legacyId, "apply"), /Legacy ChangeSet is read-only/);
  assert.equal(fs.readFileSync(legacyTarget, "utf8"), source);
  const recaptured = captureChangeSet(directory, worktree.id, { passed: true }); assert.equal(recaptured.schemaVersion, 3); assert.notEqual(recaptured.id, legacyId); assert.equal(fs.readFileSync(legacyTarget, "utf8"), source);
});

test("corrupt and future-schema ChangeSet metadata blocks preflight without rewriting source", async (t) => {
  for (const [label, mutate] of [
    ["corrupt", () => "{not-json\n"],
    ["future", (source: string) => `${JSON.stringify({ ...JSON.parse(source), schemaVersion: 4 })}\n`],
  ] as const) {
    await t.test(label, () => {
      const directory = repo(t); const worktree = createManagedWorktree(directory, { name: `metadata-${label}` }); commit(worktree.path, `${label}\n`);
      const changeSet = captureChangeSet(directory, worktree.id, { passed: true }); const target = path.join(directory, ".history", "change-sets", `${changeSet.id}.json`);
      const source = mutate(fs.readFileSync(target, "utf8")); fs.writeFileSync(target, source);
      assert.throws(() => preflightChangeSetDecision(directory, changeSet.id, "apply"), ChangeSetStoreCorruptionError);
      assert.equal(git(directory, ["show", "HEAD:a.txt"]), "base");
      assert.equal(fs.readFileSync(target, "utf8"), source);
    });
  }
});

test("unreadable ChangeSet metadata blocks listing and remains untouched", (t) => {
  const directory = repo(t); const target = path.join(directory, ".history", "change-sets", `${"a".repeat(64)}.json`); fs.mkdirSync(target, { recursive: true });
  assert.throws(() => listChangeSets(directory), ChangeSetStoreCorruptionError);
  assert.equal(fs.lstatSync(target).isDirectory(), true);
});

test("write-ahead integration survives a crash after the exact branch CAS and restart reconciliation is idempotent", async (t) => {
  const directory = repo(t); const worktree = createManagedWorktree(directory, { name: "crash-after-cas" }); commit(worktree.path, "applied-after-restart\n");
  const changeSet = captureChangeSet(directory, worktree.id, { command: "test", passed: true }); await independentlyReview(directory, changeSet.id);
  setChangeSetIntegrationHookForTests((stage) => { if (stage === "after_parent_mutation") throw new ChangeSetIntegrationCrashError("simulated process exit"); });
  t.after(() => setChangeSetIntegrationHookForTests(undefined));

  assert.throws(() => applyChangeSetDecision(directory, changeSet, "apply"), ChangeSetIntegrationCrashError);
  setChangeSetIntegrationHookForTests(undefined);
  assert.equal(getChangeSet(directory, changeSet.id).status, "applying");
  assert.equal(git(directory, ["show", "HEAD:a.txt"]), "applied-after-restart");
  const transaction = JSON.parse(fs.readFileSync(path.join(directory, ".history", "change-sets", "transactions", `${changeSet.id}.json`), "utf8")) as Record<string, unknown>;
  assert.equal(transaction.schemaVersion, CURRENT_CHANGE_SET_WAL_SCHEMA_VERSION);
  assert.equal(transaction.phase, "mutating");
  assert.equal(transaction.originalHead, changeSet.baseSha);
  assert.equal(transaction.expectedParentHead, changeSet.baseSha);
  assert.equal(typeof transaction.expectedParentRef, "string");
  assert.equal(typeof transaction.intendedHead, "string");
  assert.equal(transaction.resultHead, undefined);

  const recovered = recoverInterruptedChangeSet(directory, changeSet.id);
  assert.equal(recovered.status, "applied");
  assert.equal(recoverInterruptedChangeSet(directory, changeSet.id).status, "applied");
  assert.equal(git(directory, ["show", "HEAD:a.txt"]), "applied-after-restart");
});

test("restart recovery rejects a tampered integration WAL before touching the parent", async (t) => {
  const directory = repo(t); const worktree = createManagedWorktree(directory, { name: "tampered-wal" }); commit(worktree.path, "wal-child\n");
  const changeSet = captureChangeSet(directory, worktree.id, { passed: true }); await independentlyReview(directory, changeSet.id);
  setChangeSetIntegrationHookForTests((stage) => { if (stage === "after_write_ahead") throw new ChangeSetIntegrationCrashError("simulated stop before CAS"); });
  t.after(() => setChangeSetIntegrationHookForTests(undefined));
  assert.throws(() => applyChangeSetDecision(directory, changeSet, "apply"), ChangeSetIntegrationCrashError); setChangeSetIntegrationHookForTests(undefined);
  const transactionPath = path.join(directory, ".history", "change-sets", "transactions", `${changeSet.id}.json`); const transaction = JSON.parse(fs.readFileSync(transactionPath, "utf8")); transaction.intendedHead = changeSet.baseSha;
  fs.writeFileSync(transactionPath, `${JSON.stringify(transaction, null, 2)}\n`);
  assert.throws(() => recoverInterruptedChangeSet(directory, changeSet.id), (error: unknown) => error instanceof ChangeSetStoreCorruptionError && error.recoveryStatus === "needs_attention");
  assert.equal(git(directory, ["show", "HEAD:a.txt"]), "base"); assert.equal(getChangeSet(directory, changeSet.id).status, "applying");
});

test("a restart before parent mutation restores the exact reviewed ChangeSet for one safe retry", async (t) => {
  const directory = repo(t); const worktree = createManagedWorktree(directory, { name: "crash-before-cas" }); commit(worktree.path, "retry-once\n");
  const changeSet = captureChangeSet(directory, worktree.id, { passed: true }); await independentlyReview(directory, changeSet.id);
  setChangeSetIntegrationHookForTests((stage) => { if (stage === "after_write_ahead") throw new ChangeSetIntegrationCrashError(); });
  t.after(() => setChangeSetIntegrationHookForTests(undefined));
  assert.throws(() => applyChangeSetDecision(directory, changeSet, "apply"), ChangeSetIntegrationCrashError);
  setChangeSetIntegrationHookForTests(undefined);
  assert.equal(git(directory, ["show", "HEAD:a.txt"]), "base");
  const recovered = recoverInterruptedChangeSet(directory, changeSet.id);
  assert.equal(recovered.status, "ready_for_review");
  assert.equal(applyChangeSetDecision(directory, recovered, "apply").changeSet.status, "applied");
  assert.equal(git(directory, ["show", "HEAD:a.txt"]), "retry-once");
});

test("parent/ref drift and partial working-tree mutation become needs_attention without data loss", async (t) => {
  await t.test("parent ref drift", async (t) => {
    const directory = repo(t); const worktree = createManagedWorktree(directory, { name: "parent-drift" }); commit(worktree.path, "agent\n");
    const changeSet = captureChangeSet(directory, worktree.id, { passed: true }); await independentlyReview(directory, changeSet.id);
    const original = git(directory, ["rev-parse", "HEAD"]); const tree = git(directory, ["rev-parse", "HEAD^{tree}"]); const drift = git(directory, ["commit-tree", tree, "-p", original, "-m", "external drift"]); const ref = git(directory, ["symbolic-ref", "HEAD"]);
    setChangeSetIntegrationHookForTests((stage) => { if (stage === "after_write_ahead") { git(directory, ["update-ref", ref, drift, original]); git(directory, ["reset", "--hard", drift]); } });
    t.after(() => setChangeSetIntegrationHookForTests(undefined));
    assert.throws(() => applyChangeSetDecision(directory, changeSet, "apply"), /parent.*changed|CAS|drift/i);
    setChangeSetIntegrationHookForTests(undefined);
    assert.equal(git(directory, ["rev-parse", "HEAD"]), drift);
    assert.equal(getChangeSet(directory, changeSet.id).status, "needs_attention");
    assert.equal(recoverInterruptedChangeSet(directory, changeSet.id).status, "needs_attention");
  });

  await t.test("working tree partial mutation", async (t) => {
    const directory = repo(t); const worktree = createManagedWorktree(directory, { name: "partial-parent" }); commit(worktree.path, "agent\n");
    const changeSet = captureChangeSet(directory, worktree.id, { passed: true }); await independentlyReview(directory, changeSet.id);
    setChangeSetIntegrationHookForTests((stage) => { if (stage === "after_write_ahead") fs.writeFileSync(path.join(directory, "human.txt"), "do not lose\n"); });
    t.after(() => setChangeSetIntegrationHookForTests(undefined));
    assert.throws(() => applyChangeSetDecision(directory, changeSet, "apply"), /clean|changed|CAS/i);
    setChangeSetIntegrationHookForTests(undefined);
    assert.equal(fs.readFileSync(path.join(directory, "human.txt"), "utf8"), "do not lose\n");
    assert.equal(git(directory, ["show", "HEAD:a.txt"]), "base");
    assert.equal(getChangeSet(directory, changeSet.id).status, "needs_attention");
  });
});

test("corrupt review findings block ChangeSet preflight without rewriting either source", (t) => {
  const directory = repo(t); const worktree = createManagedWorktree(directory, { name: "corrupt-review-gate" }); commit(worktree.path, "reviewed\n");
  const changeSet = captureChangeSet(directory, worktree.id, { passed: true });
  const target = path.join(directory, ".history", "review-findings.json"); const source = "{not-json\n"; fs.writeFileSync(target, source);
  assert.throws(() => preflightChangeSetDecision(directory, changeSet, "apply"), ReviewFindingStoreCorruptionError);
  assert.equal(git(directory, ["show", "HEAD:a.txt"]), "base");
  assert.equal(fs.readFileSync(target, "utf8"), source);
  assert.equal(getChangeSet(directory, changeSet.id).status, "ready_for_review");
});
