import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { checkpointsRouter } from "../routes/checkpoints.js";
import { chatRouter } from "../routes/chat.js";
import { recordFileMutation } from "../files/mutationRegistry.js";
import { AgentRunRecorder } from "./runHistory.js";
import { applyChangeSetDecision, captureChangeSet, computeChangeSetTransitionIntegrity, ChangeSetIntegrationCrashError, getChangeSet, setChangeSetIntegrationHookForTests, type ChangeSet } from "./changeSets.js";
import { listChangeSetReviewRuns, scheduleChangeSetReview, setChangeSetReviewRunnerForTests } from "./changeSetReviewRun.js";
import { createManagedWorktree } from "./worktrees.js";

async function withCheckpointApi(workspaceDir: string, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express(); app.use(express.json());
  app.use((_req, _res, next) => { (_req as any).userSession = { workspaceDir, token: `test-${Date.now()}` }; next(); });
  app.use(checkpointsRouter);
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address === "object");
  try { await run(`http://127.0.0.1:${address.port}`); } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

async function withChatApi(workspaceDir: string, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express(); app.use(express.json());
  app.use((_req, _res, next) => { (_req as any).userSession = { workspaceDir, token: `test-${Date.now()}` }; next(); }); app.use(chatRouter);
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address === "object");
  try { await run(`http://127.0.0.1:${address.port}`); } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

function git(directory: string, args: string[]): string { return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function changeSetRepository(t: test.TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-recovery-route-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  git(directory, ["init"]); git(directory, ["config", "user.email", "test@example.com"]); git(directory, ["config", "user.name", "CrewForge Test"]);
  fs.writeFileSync(path.join(directory, "a.txt"), "base\n"); git(directory, ["add", "."]); git(directory, ["commit", "-m", "base"]); return directory;
}
function interruptedChangeSet(repository: string): ChangeSet {
  const worktree = createManagedWorktree(repository, { name: `recover-${Date.now()}` }); fs.writeFileSync(path.join(worktree.path, "a.txt"), "child\n"); git(worktree.path, ["add", "a.txt"]); git(worktree.path, ["commit", "-m", "child"]);
  const changeSet = captureChangeSet(repository, worktree.id); const metadataPath = path.join(repository, ".history", "change-sets", `${changeSet.id}.json`);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as ChangeSet; metadata.status = "applying"; metadata.decision = "apply"; metadata.transitionVersion = metadata.transitionVersion! + 1;
  metadata.transitionIntegritySha256 = computeChangeSetTransitionIntegrity(metadata);
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  const transactionDir = path.join(repository, ".history", "change-sets", "transactions"); fs.mkdirSync(transactionDir, { recursive: true }); fs.writeFileSync(path.join(transactionDir, `${metadata.id}.json`), JSON.stringify({ schemaVersion: 1, changeSetId: metadata.id, phase: "applying", originalHead: git(repository, ["rev-parse", "HEAD"]) })); return metadata;
}
async function reviewedChangeSet(repository: string, name: string): Promise<ChangeSet> {
  const worktree = createManagedWorktree(repository, { name }); fs.writeFileSync(path.join(worktree.path, "a.txt"), `${name}\n`); git(worktree.path, ["add", "a.txt"]); git(worktree.path, ["commit", "-m", name]);
  const changeSet = captureChangeSet(repository, worktree.id, { command: "test", passed: true }); setChangeSetReviewRunnerForTests(async () => []); scheduleChangeSetReview(repository, changeSet.id, "route-reviewer");
  for (let attempt = 0; attempt < 100; attempt += 1) { if (listChangeSetReviewRuns(repository, changeSet.id)[0]?.status === "completed") return changeSet; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("review did not complete");
}

test("lists mutation metadata without blob paths and rejects unknown selections", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-checkpoint-routes-"));
  try {
    fs.writeFileSync(path.join(workspaceDir, "source.ts"), "after");
    const mutation = recordFileMutation({ workspaceDir, path: "source.ts", source: "assistant_tool", runId: "run-a", toolCallId: "tool-a", preimageContent: "before", postimageContent: "after" });
    await withCheckpointApi(workspaceDir, async (baseUrl) => {
      const listed = await fetch(`${baseUrl}/mutations?runId=run-a`); assert.equal(listed.status, 200);
      const payload = await listed.json() as { mutations: Array<Record<string, unknown>> };
      assert.equal(payload.mutations.length, 1); assert.equal(payload.mutations[0].id, mutation.id);
      assert.equal("preimageContent" in payload.mutations[0], false); assert.equal("postimageBlob" in payload.mutations[0], false);
      const invalid = await fetch(`${baseUrl}/mutations/rollback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: ["missing"] }) });
      assert.equal(invalid.status, 400);
    });
  } finally { fs.rmSync(workspaceDir, { recursive: true, force: true }); }
});

test("reports rollback conflicts before writing and validates change-set ids", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-checkpoint-routes-"));
  try {
    fs.writeFileSync(path.join(workspaceDir, "source.ts"), "manual edit");
    const mutation = recordFileMutation({ workspaceDir, path: "source.ts", source: "assistant_tool", preimageContent: "before", postimageContent: "after" });
    await withCheckpointApi(workspaceDir, async (baseUrl) => {
      const rollback = await fetch(`${baseUrl}/mutations/rollback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [mutation.id] }) });
      assert.equal(rollback.status, 409); assert.equal(fs.readFileSync(path.join(workspaceDir, "source.ts"), "utf8"), "manual edit");
      const changeSet = await fetch(`${baseUrl}/change-sets/not-an-id`); assert.equal(changeSet.status, 400);
    });
  } finally { fs.rmSync(workspaceDir, { recursive: true, force: true }); }
});

test("run revert preserves manual edits and requires confirmation for legacy full restore", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-run-revert-"));
  try {
    const recorder = new AgentRunRecorder(workspaceDir, "run-safe", "conversation", "code"); await recorder.start(); await recorder.finish("completed");
    fs.writeFileSync(path.join(workspaceDir, "source.ts"), "manual");
    recordFileMutation({ workspaceDir, path: "source.ts", source: "assistant_tool", runId: "run-safe", preimageContent: "before", postimageContent: "after" });
    const legacy = new AgentRunRecorder(workspaceDir, "run-legacy", "conversation", "code"); await legacy.start(); await legacy.finish("completed");
    await withChatApi(workspaceDir, async (baseUrl) => {
      const conflict = await fetch(`${baseUrl}/runs/run-safe/revert`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.equal(conflict.status, 409); assert.equal(fs.readFileSync(path.join(workspaceDir, "source.ts"), "utf8"), "manual");
      const missingConfirmation = await fetch(`${baseUrl}/runs/run-legacy/revert`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.equal(missingConfirmation.status, 409); const payload = await missingConfirmation.json() as { legacyFullRestoreRequired?: boolean }; assert.equal(payload.legacyFullRestoreRequired, true);
    });
  } finally { fs.rmSync(workspaceDir, { recursive: true, force: true }); }
});

test("recovers an interrupted change set only while the parent is unchanged", async (t) => {
  const repository = changeSetRepository(t); const changeSet = interruptedChangeSet(repository);
  await withCheckpointApi(repository, async (baseUrl) => {
    const listed = await fetch(`${baseUrl}/change-sets`); const listedPayload = await listed.json() as { changeSets: Array<{ id: string; recovery: { state: string; actionAvailable: boolean } }> };
    assert.deepEqual(listedPayload.changeSets.find((entry) => entry.id === changeSet.id)?.recovery, { state: "interrupted", actionAvailable: true, inspectionRequired: true });
    const response = await fetch(`${baseUrl}/change-sets/${changeSet.id}/recover`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); assert.equal(response.status, 200);
    const payload = await response.json() as { changeSet: { status: string }; recovery: { state: string; transactionStatus: string } }; assert.equal(payload.changeSet.status, "failed"); assert.deepEqual(payload.recovery, { state: "recovered", transactionStatus: "failed", manualRecoveryRequired: false });
    const repeated = await fetch(`${baseUrl}/change-sets/${changeSet.id}/recover`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.deepEqual((await repeated.json() as any).recovery, { state: "not_required", transactionStatus: "failed", manualRecoveryRequired: false });
  });
});

test("recover route reports the actual pre-CAS, post-CAS, idle, and unresolved outcomes", async (t) => {
  await t.test("pre-CAS restart", async (t) => {
    const repository = changeSetRepository(t); const changeSet = await reviewedChangeSet(repository, "pre-cas-route");
    setChangeSetIntegrationHookForTests((stage) => { if (stage === "after_write_ahead") throw new ChangeSetIntegrationCrashError(); }); t.after(() => setChangeSetIntegrationHookForTests(undefined));
    assert.throws(() => applyChangeSetDecision(repository, changeSet, "apply"), ChangeSetIntegrationCrashError); setChangeSetIntegrationHookForTests(undefined);
    await withCheckpointApi(repository, async (baseUrl) => { const response = await fetch(`${baseUrl}/change-sets/${changeSet.id}/recover`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); assert.equal(response.status, 200); const payload = await response.json() as any; assert.equal(payload.changeSet.status, "ready_for_review"); assert.deepEqual(payload.recovery, { state: "recovered", transactionStatus: "recovered", manualRecoveryRequired: false }); });
  });
  await t.test("post-CAS restart", async (t) => {
    const repository = changeSetRepository(t); const changeSet = await reviewedChangeSet(repository, "post-cas-route");
    setChangeSetIntegrationHookForTests((stage) => { if (stage === "after_parent_mutation") throw new ChangeSetIntegrationCrashError(); }); t.after(() => setChangeSetIntegrationHookForTests(undefined));
    assert.throws(() => applyChangeSetDecision(repository, changeSet, "apply"), ChangeSetIntegrationCrashError); setChangeSetIntegrationHookForTests(undefined);
    await withCheckpointApi(repository, async (baseUrl) => { const response = await fetch(`${baseUrl}/change-sets/${changeSet.id}/recover`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); assert.equal(response.status, 200); const payload = await response.json() as any; assert.equal(payload.changeSet.status, "applied"); assert.deepEqual(payload.recovery, { state: "recovered", transactionStatus: "applied", manualRecoveryRequired: false }); });
  });
  await t.test("idle", async (t) => {
    const repository = changeSetRepository(t); const changeSet = await reviewedChangeSet(repository, "idle-route");
    await withCheckpointApi(repository, async (baseUrl) => { const response = await fetch(`${baseUrl}/change-sets/${changeSet.id}/recover`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); assert.equal(response.status, 200); assert.deepEqual((await response.json() as any).recovery, { state: "not_required", transactionStatus: "unchanged", manualRecoveryRequired: false }); });
  });
  await t.test("needs attention", async (t) => {
    const repository = changeSetRepository(t); const changeSet = await reviewedChangeSet(repository, "attention-route"); const original = git(repository, ["rev-parse", "HEAD"]); const tree = git(repository, ["rev-parse", "HEAD^{tree}"]); const drift = git(repository, ["commit-tree", tree, "-p", original, "-m", "drift"]); const ref = git(repository, ["symbolic-ref", "HEAD"]);
    setChangeSetIntegrationHookForTests((stage) => { if (stage === "after_write_ahead") { git(repository, ["update-ref", ref, drift, original]); git(repository, ["reset", "--hard", drift]); } }); t.after(() => setChangeSetIntegrationHookForTests(undefined));
    assert.throws(() => applyChangeSetDecision(repository, changeSet, "apply")); setChangeSetIntegrationHookForTests(undefined); assert.equal(getChangeSet(repository, changeSet.id).status, "needs_attention");
    await withCheckpointApi(repository, async (baseUrl) => { const response = await fetch(`${baseUrl}/change-sets/${changeSet.id}/recover`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); assert.equal(response.status, 200); assert.deepEqual((await response.json() as any).recovery, { state: "needs_attention", transactionStatus: "needs_attention", manualRecoveryRequired: true }); });
  });
});

test("requires manual recovery after parent divergence without leaking repository paths", async (t) => {
  const repository = changeSetRepository(t); const changeSet = interruptedChangeSet(repository);
  fs.writeFileSync(path.join(repository, "a.txt"), "parent\n"); git(repository, ["add", "a.txt"]); git(repository, ["commit", "-m", "parent"]);
  await withCheckpointApi(repository, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/change-sets/${changeSet.id}/recover`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); assert.equal(response.status, 409);
    const payload = await response.json() as { error: string; recovery: { manualRecoveryRequired: boolean } }; assert.equal(payload.recovery.manualRecoveryRequired, true); assert.equal(JSON.stringify(payload).includes(repository), false);
  });
});

test("recover route returns a typed conflict while integration owns the coordination lock", async (t) => { const repository = changeSetRepository(t); const changeSet = interruptedChangeSet(repository); const lock = path.join(repository, ".history", "change-sets", "integration.lock"); fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "live", createdAt: Date.now() }), { flag: "wx" }); t.after(() => fs.rmSync(lock, { force: true })); await withCheckpointApi(repository, async (baseUrl) => { const response = await fetch(`${baseUrl}/change-sets/${changeSet.id}/recover`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); assert.equal(response.status, 409); const payload = await response.json() as any; assert.equal(payload.code, "change_set_integration_conflict"); assert.equal(payload.recovery.state, "integration_in_progress"); }); });
