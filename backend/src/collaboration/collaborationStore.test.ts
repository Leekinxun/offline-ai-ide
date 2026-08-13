import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyChangeSetDecision, captureChangeSet, ChangeSetCollaborationGateError, preflightChangeSetDecision } from "../chat/changeSets.js";
import { createManagedWorktree } from "../chat/worktrees.js";
import { recordKnownFileMutation } from "../files/mutationRegistry.js";
import { CollaborationStore, CollaborationStoreCorruptionError, CollaborationVersionConflictError, collaborationDigest } from "./collaborationStore.js";
import { createChangeSetMergePreview } from "./changeSetCollaboration.js";

function git(dir: string, args: string[]): string { return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function fixture(t: test.TestContext) { const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-collab-")); t.after(() => fs.rmSync(workspace, { recursive: true, force: true })); git(workspace, ["init"]); git(workspace, ["config", "user.email", "test@example.com"]); git(workspace, ["config", "user.name", "Test"]); fs.mkdirSync(path.join(workspace, "src")); fs.writeFileSync(path.join(workspace, "src/a.ts"), "one\ntwo\nthree\n"); git(workspace, ["add", "."]); git(workspace, ["commit", "-m", "base"]); return workspace; }

test("durable claims, comments, mentions, review requests, and anchors survive restart and relocate deterministically", (t) => {
  const workspace = fixture(t); const store = new CollaborationStore(workspace); const initial = store.snapshot();
  const claimed = store.upsertClaim({ subject: { kind: "human", id: "alice" }, path: "src/a.ts", claimed: true, startLine: 2, endLine: 2, selectedText: "two" }, initial.version);
  assert.throws(() => store.upsertClaim({ subject: { kind: "agent", id: "agent-one" }, path: "src/a.ts", claimed: true, startLine: 2, endLine: 2 }, claimed.version), /already claimed/i);
  const comment = store.addComment({ author: { kind: "human", id: "alice" }, body: "Please check @agent-one", path: "src/a.ts", startLine: 2, selectedText: "two", evidenceLinks: ["run:1"], agentIds: ["agent-one"] }, claimed.version);
  assert.deepEqual(comment.mentions, [{ kind: "agent", id: "agent-one" }]); assert.deepEqual(comment.evidenceLinks, ["run:1"]);
  const afterComment = store.snapshot(); const request = store.createReviewRequest({ createdBy: { kind: "human", id: "alice" }, assignees: [{ kind: "human", id: "bob" }, { kind: "agent", id: "agent-one" }], path: "src/a.ts", startLine: 2, selectedText: "two" }, afterComment.version); assert.equal(request.assignees.length, 2);
  const before = fs.readFileSync(path.join(workspace, "src/a.ts"), "utf8"); const after = `zero\n${before}`; fs.writeFileSync(path.join(workspace, "src/a.ts"), after); recordKnownFileMutation({ workspaceDir: workspace, path: "src/a.ts", source: "user", actor: "alice", mtimeMs: Date.now(), preimageContent: before, content: after });
  const restarted = new CollaborationStore(workspace).snapshot(); const relocated = restarted.comments.find((item) => item.id === comment.id)!; assert.equal(relocated.anchor.status, "relocated"); assert.equal(relocated.anchor.startLine, 3); assert(restarted.activity.some((item) => item.type === "mention")); assert(restarted.activity.some((item) => item.type === "mutation"));
  fs.writeFileSync(path.join(workspace, "src/a.ts"), "content without anchor\n"); const stale = new CollaborationStore(workspace).snapshot().comments.find((item) => item.id === comment.id)!; assert.equal(stale.anchor.status, "stale");
});

test("unsaved buffers and saved/upstream drift block ChangeSet integration until an exact CAS merge decision", (t) => {
  const workspace = fixture(t); const worktree = createManagedWorktree(workspace, { name: "agent", ownerId: "agent-one" }); fs.writeFileSync(path.join(worktree.path, "src/a.ts"), "agent\n"); git(worktree.path, ["add", "src/a.ts"]); git(worktree.path, ["commit", "-m", "agent"]); const changeSet = captureChangeSet(workspace, worktree.id, { test: "passed" });
  const saved = fs.readFileSync(path.join(workspace, "src/a.ts")); const store = new CollaborationStore(workspace); store.registerBuffer({ username: "alice", path: "src/a.ts", version: 1, digest: collaborationDigest("human unsaved\n"), savedDigest: collaborationDigest(saved), revision: "buffer-1" });
  const blocked = preflightChangeSetDecision(workspace, changeSet, "apply"); assert.equal(blocked.collaborationConflicts?.[0]?.code, "unsaved_human_buffer");
  const preview = createChangeSetMergePreview(workspace, { changeSetId: changeSet.id, path: "src/a.ts", actorId: "alice" }); assert.equal(preview.humanDigest, collaborationDigest("human unsaved\n")); assert.equal(preview.revision, changeSet.patchSha256);
  assert.throws(() => store.decideMerge({ previewId: preview.id, expectedPreviewVersion: 0, actorId: "alice", choice: "apply-agent", revision: preview.revision, baseDigest: preview.baseDigest, humanDigest: preview.humanDigest, upstreamDigest: preview.upstreamDigest, agentDigest: preview.agentDigest }), CollaborationVersionConflictError);
  store.decideMerge({ previewId: preview.id, expectedPreviewVersion: preview.version, actorId: "alice", choice: "apply-agent", revision: preview.revision, baseDigest: preview.baseDigest, humanDigest: preview.humanDigest, upstreamDigest: preview.upstreamDigest, agentDigest: preview.agentDigest, reason: "Use reviewed agent hunk" });
  assert.equal(preflightChangeSetDecision(workspace, changeSet, "apply").collaborationConflicts, undefined);
  store.registerBuffer({ username: "alice", path: "src/a.ts", version: 2, digest: collaborationDigest("newer human buffer\n"), savedDigest: collaborationDigest(saved), revision: "buffer-2" }); const stale = preflightChangeSetDecision(workspace, changeSet, "apply"); assert.equal(stale.collaborationConflicts?.[0]?.humanDigest, collaborationDigest("newer human buffer\n")); assert.equal(store.snapshot().mergeDecisions[0]?.status, "stale");
});

test("keep-human remains pending and blocks the immutable agent patch until save and a preserving new revision", (t) => {
  const workspace = fixture(t); const worktree = createManagedWorktree(workspace, { name: "agent-human", ownerId: "agent-one" }); fs.writeFileSync(path.join(worktree.path, "src/a.ts"), "agent would overwrite\n"); git(worktree.path, ["add", "src/a.ts"]); git(worktree.path, ["commit", "-m", "agent first"]); const first = captureChangeSet(workspace, worktree.id, { test: "passed" });
  const original = fs.readFileSync(path.join(workspace, "src/a.ts"), "utf8"); const human = "human kept\n"; const store = new CollaborationStore(workspace); store.registerBuffer({ username: "alice", path: "src/a.ts", version: 1, digest: collaborationDigest(human), savedDigest: collaborationDigest(original), revision: "buffer-1" });
  const firstPreview = createChangeSetMergePreview(workspace, { changeSetId: first.id, path: "src/a.ts", actorId: "alice" }); const pending = store.decideMerge({ previewId: firstPreview.id, expectedPreviewVersion: firstPreview.version, actorId: "alice", choice: "apply-human", revision: firstPreview.revision, baseDigest: firstPreview.baseDigest, humanDigest: firstPreview.humanDigest, upstreamDigest: firstPreview.upstreamDigest, agentDigest: firstPreview.agentDigest });
  assert.equal(pending.status, "resolution_pending"); assert.equal(firstPreview.allowedActions.find((item) => item.choice === "apply-human")?.requiresSave, true); assert.equal(firstPreview.allowedActions.find((item) => item.choice === "apply-human")?.requiresNewRevision, true);
  assert.throws(() => applyChangeSetDecision(workspace, first, "apply"), ChangeSetCollaborationGateError); assert.equal(fs.readFileSync(path.join(workspace, "src/a.ts"), "utf8"), original);
  fs.writeFileSync(path.join(workspace, "src/a.ts"), human); store.registerBuffer({ username: "alice", path: "src/a.ts", version: 2, digest: collaborationDigest(human), savedDigest: collaborationDigest(human), revision: "buffer-2" }); assert.equal(preflightChangeSetDecision(workspace, first, "apply").collaborationConflicts?.[0]?.resolutionStatus, "stale");
  fs.writeFileSync(path.join(worktree.path, "src/a.ts"), human); git(worktree.path, ["add", "src/a.ts"]); git(worktree.path, ["commit", "-m", "agent preserves human"]); const revised = captureChangeSet(workspace, worktree.id, { test: "passed" }); assert.notEqual(revised.patchSha256, first.patchSha256);
  const revisedPreview = createChangeSetMergePreview(workspace, { changeSetId: revised.id, path: "src/a.ts", actorId: "alice" }); const resolved = store.decideMerge({ previewId: revisedPreview.id, expectedPreviewVersion: revisedPreview.version, actorId: "alice", choice: "apply-human", revision: revisedPreview.revision, baseDigest: revisedPreview.baseDigest, humanDigest: revisedPreview.humanDigest, upstreamDigest: revisedPreview.upstreamDigest, agentDigest: revisedPreview.agentDigest, supersedesDecisionId: pending.id });
  assert.equal(resolved.status, "resolved"); assert.equal(resolved.supersedesDecisionId, pending.id); assert.equal(preflightChangeSetDecision(workspace, revised, "apply").collaborationConflicts, undefined);
});

test("manual decision is audit-only and cannot unlock until its saved digest is preserved by a new revision", (t) => {
  const workspace = fixture(t); const worktree = createManagedWorktree(workspace, { name: "agent-manual", ownerId: "agent-one" }); fs.writeFileSync(path.join(worktree.path, "src/a.ts"), "agent\n"); git(worktree.path, ["add", "src/a.ts"]); git(worktree.path, ["commit", "-m", "agent"]); const first = captureChangeSet(workspace, worktree.id, { test: "passed" });
  const original = fs.readFileSync(path.join(workspace, "src/a.ts"), "utf8"); const manual = "manual resolution\n"; const store = new CollaborationStore(workspace); store.registerBuffer({ username: "alice", path: "src/a.ts", version: 1, digest: collaborationDigest(manual), savedDigest: collaborationDigest(original), revision: "manual-1" }); const preview = createChangeSetMergePreview(workspace, { changeSetId: first.id, path: "src/a.ts", actorId: "alice" });
  const pending = store.decideMerge({ previewId: preview.id, expectedPreviewVersion: preview.version, actorId: "alice", choice: "manual", revision: preview.revision, baseDigest: preview.baseDigest, humanDigest: preview.humanDigest, upstreamDigest: preview.upstreamDigest, agentDigest: preview.agentDigest, resolvedDigest: collaborationDigest(manual) }); assert.equal(pending.status, "resolution_pending"); assert.equal(preflightChangeSetDecision(workspace, first, "apply").collaborationConflicts?.[0]?.resolutionStatus, "resolution_pending"); assert.throws(() => applyChangeSetDecision(workspace, first, "apply"), ChangeSetCollaborationGateError); assert.equal(fs.readFileSync(path.join(workspace, "src/a.ts"), "utf8"), original);
  fs.writeFileSync(path.join(workspace, "src/a.ts"), manual); store.registerBuffer({ username: "alice", path: "src/a.ts", version: 2, digest: collaborationDigest(manual), savedDigest: collaborationDigest(manual), revision: "manual-2" }); fs.writeFileSync(path.join(worktree.path, "src/a.ts"), manual); git(worktree.path, ["add", "src/a.ts"]); git(worktree.path, ["commit", "-m", "preserve manual"]); const revised = captureChangeSet(workspace, worktree.id, { test: "passed" }); const next = createChangeSetMergePreview(workspace, { changeSetId: revised.id, path: "src/a.ts", actorId: "alice" }); const resolved = store.decideMerge({ previewId: next.id, expectedPreviewVersion: next.version, actorId: "alice", choice: "manual", revision: next.revision, baseDigest: next.baseDigest, humanDigest: next.humanDigest, upstreamDigest: next.upstreamDigest, agentDigest: next.agentDigest, resolvedDigest: collaborationDigest(manual), supersedesDecisionId: pending.id }); assert.equal(resolved.status, "resolved"); assert.equal(preflightChangeSetDecision(workspace, revised, "apply").collaborationConflicts, undefined);
});

test("two agents and a human can own non-overlapping ranges while overlap is fenced", (t) => {
  const workspace = fixture(t); const store = new CollaborationStore(workspace); let state = store.snapshot(); state = store.upsertClaim({ subject: { kind: "human", id: "alice" }, path: "src/a.ts", claimed: true, startLine: 1, endLine: 1 }, state.version); state = store.upsertClaim({ subject: { kind: "agent", id: "agent-one" }, path: "src/a.ts", claimed: true, startLine: 2, endLine: 2 }, state.version); state = store.upsertClaim({ subject: { kind: "agent", id: "agent-two" }, path: "src/a.ts", claimed: true, startLine: 3, endLine: 3 }, state.version); assert.equal(state.claims.length, 3); assert.throws(() => store.upsertClaim({ subject: { kind: "human", id: "bob" }, path: "src/a.ts", claimed: true, startLine: 2, endLine: 3 }, state.version), /already claimed/i);
});

test("saved human edits and committed upstream drift are distinguished and remain exact-revision blockers", (t) => {
  const workspace = fixture(t); const worktree = createManagedWorktree(workspace, { name: "agent-drift", ownerId: "agent-one" }); fs.writeFileSync(path.join(worktree.path, "src/a.ts"), "agent\n"); git(worktree.path, ["add", "src/a.ts"]); git(worktree.path, ["commit", "-m", "agent"]); const changeSet = captureChangeSet(workspace, worktree.id, { test: "passed" });
  fs.writeFileSync(path.join(workspace, "src/a.ts"), "human saved\n"); let preflight = preflightChangeSetDecision(workspace, changeSet, "apply"); assert.equal(preflight.collaborationConflicts?.[0]?.code, "saved_human_drift");
  git(workspace, ["add", "src/a.ts"]); git(workspace, ["commit", "-m", "upstream"]); preflight = preflightChangeSetDecision(workspace, changeSet, "apply"); assert.equal(preflight.collaborationConflicts?.[0]?.code, "upstream_drift"); assert.equal(preflight.collaborationConflicts?.[0]?.revision, changeSet.patchSha256);
});

test("missing collaboration state remains an empty compatible store", (t) => {
  const workspace = fixture(t);
  const state = new CollaborationStore(workspace).snapshot();
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.version, 1);
  assert.deepEqual(state.buffers, []);
});

test("corrupt and future-schema collaboration state blocks preflight without rewriting source", async (t) => {
  for (const [label, source] of [
    ["corrupt", "{not-json\n"],
    ["future", `${JSON.stringify({ schemaVersion: 2, version: 1, buffers: [] })}\n`],
  ] as const) {
    await t.test(label, () => {
      const workspace = fixture(t); const worktree = createManagedWorktree(workspace, { name: `store-${label}` });
      fs.writeFileSync(path.join(worktree.path, "src/a.ts"), "agent\n"); git(worktree.path, ["add", "src/a.ts"]); git(worktree.path, ["commit", "-m", "agent"]);
      const changeSet = captureChangeSet(workspace, worktree.id, { test: "passed" });
      const target = path.join(workspace, ".team", "collaboration-v1.json"); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, source);
      assert.throws(() => preflightChangeSetDecision(workspace, changeSet, "apply"), CollaborationStoreCorruptionError);
      assert.equal(fs.readFileSync(path.join(workspace, "src/a.ts"), "utf8"), "one\ntwo\nthree\n");
      assert.equal(fs.readFileSync(target, "utf8"), source);
    });
  }
});

test("unreadable collaboration state blocks integration assessment and remains untouched", (t) => {
  const workspace = fixture(t); const target = path.join(workspace, ".team", "collaboration-v1.json"); fs.mkdirSync(target, { recursive: true });
  assert.throws(() => new CollaborationStore(workspace).integrationAssessment({ id: "change", patchSha256: "a".repeat(64), baseSha: git(workspace, ["rev-parse", "HEAD"]), changedFiles: ["src/a.ts"] }), CollaborationStoreCorruptionError);
  assert.equal(fs.lstatSync(target).isDirectory(), true);
});
