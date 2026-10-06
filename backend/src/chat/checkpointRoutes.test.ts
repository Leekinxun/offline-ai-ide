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
import { buildFileHash, captureCheckpointMutationsDetailed, recordFileMutation } from "../files/mutationRegistry.js";
import { createCheckpoint } from "./checkpoints.js";
import { beginExternalToolEffects } from "./externalToolEffects.js";
import { AgentRunRecorder } from "./runHistory.js";
import { appendConversationMessage, createConversationId, listConversationSummaries, readConversationMessages } from "./history.js";
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

test("binary mutation API exposes audit metadata and restores exact bytes without exposing blobs", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-binary-route-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const before = Buffer.from([0, 255, 128, 1]);
  const after = Buffer.from([0, 254, 129, 2, 3]);
  fs.writeFileSync(path.join(workspace, "artifact.sqlite"), before);
  const checkpoint = createCheckpoint(workspace);
  fs.writeFileSync(path.join(workspace, "artifact.sqlite"), after);
  const capture = captureCheckpointMutationsDetailed(workspace, { checkpointId: checkpoint.id, runId: "binary-run", toolCallId: "sqlite-update" });
  await withCheckpointApi(workspace, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/mutations?runId=binary-run`);
    assert.equal(response.status, 200);
    const payload = await response.json() as { mutations: Array<Record<string, unknown>> };
    const mutation = payload.mutations[0];
    assert.equal(mutation.preimageHash, buildFileHash(before));
    assert.equal(mutation.postimageHash, buildFileHash(after));
    assert.equal(mutation.preimageSize, before.byteLength);
    assert.equal(mutation.postimageSize, after.byteLength);
    assert.equal(mutation.preimageBinary, true);
    assert.equal(mutation.postimageBinary, true);
    assert.equal(mutation.rollbackScope, "whole-file");
    for (const privateField of ["workspaceDir", "preimageContent", "preimageBlob", "postimageBlob"]) assert.equal(privateField in mutation, false, privateField);
    const rollback = await fetch(`${baseUrl}/mutations/rollback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [capture.records[0].id] }) });
    assert.equal(rollback.status, 200);
    assert.deepEqual(fs.readFileSync(path.join(workspace, "artifact.sqlite")), before);
  });
});

async function withChatApi(workspaceDir: string, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express(); app.use(express.json());
  app.use((_req, _res, next) => { (_req as any).userSession = { workspaceDir, token: `test-${Date.now()}` }; next(); }); app.use(chatRouter);
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address === "object");
  try { await run(`http://127.0.0.1:${address.port}`); } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test("turn undo restores only its files and forks context at the exact request boundary", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-turn-undo-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const conversationId = createConversationId();
  for (const message of [
    { role: "user" as const, requestId: "turn-one", content: "first" },
    { role: "assistant" as const, requestId: "turn-one", content: "first result" },
    { role: "user" as const, requestId: "turn-two", content: "second" },
    { role: "assistant" as const, requestId: "turn-two", content: "second result" },
  ]) await appendConversationMessage(workspace, conversationId, { ...message, timestamp: 100 });
  const run = new AgentRunRecorder(workspace, "run-turn-undo", conversationId, "code");
  await run.start(); await run.finish("completed");
  fs.writeFileSync(path.join(workspace, "code.ts"), "C");
  fs.writeFileSync(path.join(workspace, "human.txt"), "keep me");
  recordFileMutation({ workspaceDir: workspace, path: "code.ts", source: "assistant_tool", runId: run.runId, requestId: "turn-one", preimageContent: "A", postimageContent: "B" });
  recordFileMutation({ workspaceDir: workspace, path: "code.ts", source: "assistant_tool", runId: run.runId, requestId: "turn-two", preimageContent: "B", postimageContent: "C" });
  await withChatApi(workspace, async (baseUrl) => {
    const evidence = await (await fetch(`${baseUrl}/runs/${run.runId}/changes?requestId=turn-two`)).json() as { revision: string };
    const response = await fetch(`${baseUrl}/runs/${run.runId}/revert`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: "turn-two", expectedRevision: evidence.revision, forkBeforeRequest: true, expectedWorkspace: workspace }) });
    assert.equal(response.status, 200);
    const result = await response.json() as { conversation: { id: string } };
    assert.equal(fs.readFileSync(path.join(workspace, "code.ts"), "utf8"), "B");
    assert.equal(fs.readFileSync(path.join(workspace, "human.txt"), "utf8"), "keep me");
    assert.deepEqual(readConversationMessages(workspace, result.conversation.id).map((message) => message.content), ["first", "first result"]);
    assert.equal(readConversationMessages(workspace, conversationId).length, 4);
  });
});

test("external command receipts block broad undo while exact file rollback still works", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-external-undo-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const run = new AgentRunRecorder(workspace, "run-external-undo", "conversation", "code");
  await run.start();
  await run.toolState({ toolCallId: "shell-1", requestId: "turn", name: "bash", status: "running", rollbackCoverage: "untracked" });
  await run.finish("completed");
  await beginExternalToolEffects(workspace, {
    runId: run.runId,
    requestId: "turn",
    toolCallId: "shell-1",
    toolName: "bash",
  });
  fs.writeFileSync(path.join(workspace, "code.ts"), "B");
  recordFileMutation({ workspaceDir: workspace, path: "code.ts", source: "assistant_tool", runId: run.runId, requestId: "turn", preimageContent: "A", postimageContent: "B" });

  await withChatApi(workspace, async (baseUrl) => {
    const evidence = await (await fetch(`${baseUrl}/runs/${run.runId}/changes?requestId=turn`)).json() as { revision: string; externalToolEffects?: unknown[]; files: Array<{ path: string; revision: string }> };
    assert.equal(evidence.externalToolEffects?.length, 1);
    const broad = await fetch(`${baseUrl}/runs/${run.runId}/revert`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: "turn", expectedRevision: evidence.revision }) });
    assert.equal(broad.status, 409);
    assert.equal((await broad.json() as { code?: string }).code, "external_tool_rollback_unavailable");
    assert.equal(fs.readFileSync(path.join(workspace, "code.ts"), "utf8"), "B");

    const selected = await fetch(`${baseUrl}/runs/${run.runId}/revert`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: "turn", path: "code.ts", expectedRevision: evidence.files[0].revision }) });
    assert.equal(selected.status, 200, JSON.stringify(await selected.json()));
    assert.equal(fs.readFileSync(path.join(workspace, "code.ts"), "utf8"), "A");
  });
});

test("missing expected external command receipts fail closed", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-external-missing-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const run = new AgentRunRecorder(workspace, "run-external-missing", "conversation", "code");
  await run.start();
  await run.toolState({ toolCallId: "shell-missing", requestId: "turn", name: "bash", status: "failed", rollbackCoverage: "untracked" });
  await run.finish("failed");
  recordFileMutation({ workspaceDir: workspace, path: "code.ts", source: "assistant_tool", runId: run.runId, requestId: "turn", preimageContent: "A", postimageContent: "B" });

  await withChatApi(workspace, async (baseUrl) => {
    const evidence = await fetch(`${baseUrl}/runs/${run.runId}/changes?requestId=turn`);
    assert.equal(evidence.status, 409);
    assert.equal((await evidence.json() as { code?: string }).code, "external_tool_rollback_unavailable");
  });
});

test("conflicted turn undo leaves conversation history unchanged and removes its prepared fork", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-turn-undo-conflict-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const conversationId = createConversationId();
  await appendConversationMessage(workspace, conversationId, { role: "user", requestId: "turn", content: "edit", timestamp: Date.now() });
  const run = new AgentRunRecorder(workspace, "run-turn-conflict", conversationId, "code");
  await run.start(); await run.finish("completed");
  fs.writeFileSync(path.join(workspace, "code.ts"), "human changed it");
  recordFileMutation({ workspaceDir: workspace, path: "code.ts", source: "assistant_tool", runId: run.runId, requestId: "turn", preimageContent: "A", postimageContent: "B" });
  await withChatApi(workspace, async (baseUrl) => {
    const evidence = await (await fetch(`${baseUrl}/runs/${run.runId}/changes?requestId=turn`)).json() as { revision: string };
    const response = await fetch(`${baseUrl}/runs/${run.runId}/revert`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: "turn", expectedRevision: evidence.revision, forkBeforeRequest: true, expectedWorkspace: workspace }) });
    assert.equal(response.status, 409);
    assert.deepEqual(listConversationSummaries(workspace).map((entry) => entry.id), [conversationId]);
    assert.equal(fs.readFileSync(path.join(workspace, "code.ts"), "utf8"), "human changed it");
  });
});

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

test("run changes route and scoped rollback bind selections to a stable revision and owning run", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-run-review-routes-"));
  try {
    const recorder = new AgentRunRecorder(workspaceDir, "review-run", "conversation", "code"); await recorder.start(); await recorder.finish("completed");
    const first = recordFileMutation({ workspaceDir, path: "source.ts", source: "assistant_tool", runId: "review-run", preimageContent: "A", postimageContent: "B" });
    const last = recordFileMutation({ workspaceDir, path: "source.ts", source: "assistant_tool", runId: "review-run", preimageContent: "B", postimageContent: "C" });
    const foreign = recordFileMutation({ workspaceDir, path: "other.ts", source: "assistant_tool", runId: "other-run", preimageContent: "X", postimageContent: "Y" });
    fs.writeFileSync(path.join(workspaceDir, "source.ts"), "C");
    fs.writeFileSync(path.join(workspaceDir, "other.ts"), "Y");
    await withChatApi(workspaceDir, async (baseUrl) => {
      const post = (body: unknown) => fetch(`${baseUrl}/runs/review-run/revert`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const list = await fetch(`${baseUrl}/runs/review-run/changes`);
      assert.equal(list.status, 200);
      const summary = await list.json() as any;
      assert.equal(summary.files.length, 1); assert.equal(summary.files[0].original, undefined);
      const response = await fetch(`${baseUrl}/runs/review-run/changes?path=source.ts`);
      assert.equal(response.status, 200);
      const changes = await response.json() as any;
      const revision = changes.files[0].revision;
      assert.equal(changes.files[0].original, "A"); assert.equal(changes.files[0].modified, "C");
      assert.equal((await fetch(`${baseUrl}/runs/review-run/changes?path=..%2Fprivate`)).status, 400);
      assert.equal((await fetch(`${baseUrl}/runs/missing/changes`)).status, 404);
      assert.equal((await post({ path: "source.ts" })).status, 400);
      assert.equal((await post({ path: "source.ts", expectedRevision: "0".repeat(64) })).status, 409);
      assert.equal((await post({ path: "source.ts", ids: [foreign.id], expectedRevision: revision })).status, 400);
      const reverted = await post({ path: "source.ts", expectedRevision: revision });
      assert.equal(reverted.status, 200);
      assert.deepEqual((await reverted.json() as any).rollback.applied, [last.id, first.id]);
      assert.equal(fs.readFileSync(path.join(workspaceDir, "source.ts"), "utf8"), "A");
      assert.equal(fs.readFileSync(path.join(workspaceDir, "other.ts"), "utf8"), "Y");
      assert.equal((await post({ path: "source.ts", expectedRevision: revision })).status, 409);
      const after = await (await fetch(`${baseUrl}/runs/review-run/changes?path=source.ts`)).json() as any;
      assert.equal(after.files[0].modified, "C"); assert.equal(after.files[0].rollbackState, "reverted");
      assert.equal((await post({ path: "source.ts", expectedRevision: after.files[0].revision })).status, 200);
    });
  } finally { fs.rmSync(workspaceDir, { recursive: true, force: true }); }
});

test("run hunk rollback can target one mutation and rejects unrelated hunk IDs", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-run-hunk-routes-"));
  try {
    const recorder = new AgentRunRecorder(workspaceDir, "hunk-run", "conversation", "code"); await recorder.start(); await recorder.finish("completed");
    const mutation = recordFileMutation({ workspaceDir, path: "source.ts", source: "assistant_tool", runId: "hunk-run", preimageContent: "A=before\nkeep\nB=before\n", postimageContent: "A=after\nkeep\nB=after\n" });
    fs.writeFileSync(path.join(workspaceDir, "source.ts"), "A=after\nkeep\nB=after\n");
    await withChatApi(workspaceDir, async (baseUrl) => {
      const changes = await (await fetch(`${baseUrl}/runs/hunk-run/changes?path=source.ts`)).json() as any;
      const body = { path: "source.ts", ids: [mutation.id], hunkIds: ["missing"], expectedRevision: changes.files[0].revision };
      const post = () => fetch(`${baseUrl}/runs/hunk-run/revert`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      assert.equal((await post()).status, 400);
      body.hunkIds = [mutation.hunks![0].id];
      assert.equal((await post()).status, 200);
      assert.equal(fs.readFileSync(path.join(workspaceDir, "source.ts"), "utf8"), "A=before\nkeep\nB=after\n");
    });
  } finally { fs.rmSync(workspaceDir, { recursive: true, force: true }); }
});

test("request-scoped HTTP revert cannot undo an earlier or foreign turn", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-turn-routes-"));
  try {
    const recorder = new AgentRunRecorder(workspaceDir, "turn-run", "conversation", "code"); await recorder.start(); await recorder.finish("completed");
    const first = recordFileMutation({ workspaceDir, path: "source.ts", source: "assistant_tool", runId: "turn-run", requestId: "turn-one", preimageContent: "A", postimageContent: "B" });
    const last = recordFileMutation({ workspaceDir, path: "source.ts", source: "assistant_tool", runId: "turn-run", requestId: "turn-two", preimageContent: "B", postimageContent: "C" });
    fs.writeFileSync(path.join(workspaceDir, "source.ts"), "C");
    await withChatApi(workspaceDir, async (baseUrl) => {
      const get = (query: string) => fetch(`${baseUrl}/runs/turn-run/changes${query}`);
      const changes = await (await get("?requestId=turn-two")).json() as any;
      assert.deepEqual(changes.files[0].mutationIds, [last.id]);
      const post = (body: unknown) => fetch(`${baseUrl}/runs/turn-run/revert`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      assert.equal((await post({ requestId: "turn-two", ids: [first.id], expectedRevision: changes.revision })).status, 400);
      assert.equal((await post({ requestId: "turn-two", expectedRevision: changes.revision })).status, 200);
      assert.equal(fs.readFileSync(path.join(workspaceDir, "source.ts"), "utf8"), "B");
      assert.equal((await post({ requestId: "missing", legacyFullRestore: true, expectedRevision: changes.revision })).status, 400);
      assert.deepEqual(await (await get("?requestId=")).json(), await (await get("")).json());
    });
  } finally { fs.rmSync(workspaceDir, { recursive: true, force: true }); }
});

test("keep route rejects stale revisions and persists file and hunk review without rewriting files", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-keep-routes-"));
  try {
    const recorder = new AgentRunRecorder(workspaceDir, "keep-run", "conversation", "code"); await recorder.start(); await recorder.finish("completed");
    const mutation = recordFileMutation({ workspaceDir, path: "source.ts", source: "assistant_tool", runId: "keep-run", preimageContent: "A=old\nkeep\nB=old\n", postimageContent: "A=new\nkeep\nB=new\n" });
    fs.writeFileSync(path.join(workspaceDir, "source.ts"), "user changed the working file");
    await withChatApi(workspaceDir, async (baseUrl) => {
      const get = async () => (await (await fetch(`${baseUrl}/runs/keep-run/changes?path=source.ts`)).json() as any).files[0];
      const keep = (body: unknown) => fetch(`${baseUrl}/runs/keep-run/changes/keep`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const initial = await get();
      assert.equal((await keep({ path: "source.ts", expectedRevision: "0".repeat(64) })).status, 409);
      assert.equal((await keep({ path: "source.ts", expectedRevision: initial.revision, ids: ["foreign"] })).status, 400);
      assert.equal((await keep({ path: "source.ts", expectedRevision: initial.revision, ids: [mutation.id], hunkIds: [mutation.hunks![0].id] })).status, 200);
      const partial = await get(); assert.equal(partial.reviewState, "partially_kept"); assert.equal(partial.hunks[0].kept, true);
      assert.equal((await keep({ path: "source.ts", expectedRevision: initial.revision })).status, 409);
      assert.equal((await keep({ path: "source.ts", expectedRevision: partial.revision })).status, 200);
      assert.equal((await get()).reviewState, "kept");
      assert.equal(fs.readFileSync(path.join(workspaceDir, "source.ts"), "utf8"), "user changed the working file");
    });
  } finally { fs.rmSync(workspaceDir, { recursive: true, force: true }); }
});

test("turn undo at the history limit preserves its original audit and fork, and failed undo prunes nothing", async (t) => {
  for (const conflict of [false, true]) {
    await t.test(conflict ? "failed undo preserves every existing conversation" : "successful undo preserves source and fork within the limit", async (t) => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-turn-undo-retention-"));
      t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
      const conversationId = createConversationId();
      for (const message of [
        { role: "user" as const, requestId: "earlier", content: "keep this context" },
        { role: "assistant" as const, content: "earlier answer" },
        { role: "user" as const, requestId: "latest", content: "keep this undo audit" },
        { role: "assistant" as const, content: "undone answer" },
      ]) await appendConversationMessage(workspace, conversationId, { ...message, timestamp: Date.now() });
      const otherIds: string[] = [];
      for (let index = 0; index < 29; index += 1) {
        const id = createConversationId(); otherIds.push(id);
        await appendConversationMessage(workspace, id, { role: "user", content: "other conversation " + index, timestamp: Date.now() });
        fs.utimesSync(path.join(workspace, ".history", id + ".jsonl"), new Date(10_000 + index * 1000), new Date(10_000 + index * 1000));
      }
      fs.utimesSync(path.join(workspace, ".history", conversationId + ".jsonl"), new Date(1000), new Date(1000));
      const before = listConversationSummaries(workspace).map((entry) => entry.id).sort();
      assert.equal(before.length, 30);
      const recorder = new AgentRunRecorder(workspace, "retention-run", conversationId, "code"); await recorder.start(); await recorder.finish("completed");
      fs.writeFileSync(path.join(workspace, "source.ts"), conflict ? "user edit" : "after");
      recordFileMutation({ workspaceDir: workspace, path: "source.ts", source: "assistant_tool", runId: recorder.runId, requestId: "latest", preimageContent: "before", postimageContent: "after" });
      await withChatApi(workspace, async (baseUrl) => {
        const evidence = await (await fetch(`${baseUrl}/runs/${recorder.runId}/changes?requestId=latest`)).json() as { revision: string };
        const response = await fetch(`${baseUrl}/runs/${recorder.runId}/revert`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: "latest", expectedRevision: evidence.revision, forkBeforeRequest: true, expectedWorkspace: workspace }) });
        assert.equal(response.status, conflict ? 409 : 200);
        const result = await response.json() as { conversation?: { id: string } };
        const after = listConversationSummaries(workspace).map((entry) => entry.id).sort();
        assert.equal(after.length, 30);
        assert.deepEqual(readConversationMessages(workspace, conversationId).map((message) => message.content), ["keep this context", "earlier answer", "keep this undo audit", "undone answer"]);
        if (conflict) { assert.deepEqual(after, before); assert.equal(fs.readFileSync(path.join(workspace, "source.ts"), "utf8"), "user edit"); }
        else {
          assert.ok(result.conversation?.id); assert.ok(after.includes(result.conversation.id)); assert.ok(after.includes(conversationId));
          assert.equal(after.includes(otherIds[0]), false);
          assert.deepEqual(readConversationMessages(workspace, result.conversation.id).map((message) => message.content), ["keep this context", "earlier answer"]);
          assert.equal(fs.readFileSync(path.join(workspace, "source.ts"), "utf8"), "before");
        }
      });
    });
  }
});
