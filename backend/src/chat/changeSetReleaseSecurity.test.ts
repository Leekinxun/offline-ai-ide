import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { captureChangeSet, ChangeSetStoreCorruptionError, getChangeSet } from "./changeSets.js";
import { createManagedWorktree } from "./worktrees.js";
import { releaseTestGit, releaseTestRepository } from "./changeSetReleaseTestSupport.js";

test("schema-v3 integrity binds every capture and transition semantic independent of JSON key order", async (t) => {
  const directory = releaseTestRepository(t);
  const worktree = createManagedWorktree(directory, { name: "integrity-matrix", ownerId: "writer", parentRunId: "parent-run", childRunId: "child-run", toolCallId: "tool-call" });
  fs.writeFileSync(path.join(worktree.path, "a.txt"), "matrix\n");
  fs.writeFileSync(path.join(worktree.path, "b.txt"), "second\n");
  releaseTestGit(worktree.path, ["add", "."]);
  releaseTestGit(worktree.path, ["commit", "-m", "matrix"]);
  const changeSet = captureChangeSet(directory, worktree.id, { passed: true, command: "matrix", parentTaskId: 7, agentName: "teammate:writer", memberName: "writer", nested: { beta: 2, alpha: 1 } });
  const target = path.join(directory, ".history", "change-sets", `${changeSet.id}.json`);
  const source = fs.readFileSync(target, "utf8");
  const original = JSON.parse(source) as Record<string, any>;
  const cases: Array<[string, (value: Record<string, any>) => void]> = [
    ["id", (value) => { value.id = "b".repeat(64); }], ["worktreeId", (value) => { value.worktreeId += "-tampered"; }],
    ["dirty", (value) => { value.dirty = !value.dirty; }], ["ownerId", (value) => { value.ownerId = "other"; }],
    ["parentRunId", (value) => { value.parentRunId = "other-parent"; }], ["parentTaskId", (value) => { value.parentTaskId += 1; }],
    ["childRunId", (value) => { value.childRunId = "other-child"; }], ["toolCallId", (value) => { value.toolCallId = "other-tool"; }],
    ["agentName", (value) => { value.agentName = "teammate:other"; }], ["memberName", (value) => { value.memberName = "other"; }],
    ["branch", (value) => { value.branch += "-other"; }], ["baseSha", (value) => { value.baseSha = "1".repeat(40); }],
    ["headSha", (value) => { value.headSha = "2".repeat(40); }], ["changedFiles", (value) => { value.changedFiles.push("extra.txt"); }],
    ["patchSha256", (value) => { value.patchSha256 = "3".repeat(64); }], ["patchBlob", (value) => { value.patchBlob = "blobs/other.patch"; }],
    ["patchManifest.path", (value) => { value.patchManifest[0].path = "blobs/other.patch"; }], ["patchManifest.sha256", (value) => { value.patchManifest[0].sha256 = "4".repeat(64); }],
    ["patchManifest.kind", (value) => { value.patchManifest[0].kind = "untracked"; }], ["checks", (value) => { value.checks = { passed: false }; }],
    ["verificationEvidence", (value) => { value.verificationEvidence = { passed: false }; }], ["status", (value) => { value.status = "applied"; }],
    ["decision", (value) => { value.decision = "merge"; }], ["reviewedAt", (value) => { value.reviewedAt = "2030-01-01T00:00:00.000Z"; }],
    ["decisionActorId", (value) => { value.decisionActorId = "other-actor"; }], ["decisionActorIsAdmin", (value) => { value.decisionActorIsAdmin = true; }],
    ["appliedAt", (value) => { value.appliedAt = "2030-01-01T00:00:00.000Z"; }], ["failedAt", (value) => { value.failedAt = "2030-01-01T00:00:00.000Z"; }],
    ["createdAt", (value) => { value.createdAt = "2030-01-01T00:00:00.000Z"; }], ["captureIntegritySha256", (value) => { value.captureIntegritySha256 = "5".repeat(64); }],
    ["transitionVersion", (value) => { value.transitionVersion += 1; }], ["transitionIntegritySha256", (value) => { value.transitionIntegritySha256 = "6".repeat(64); }],
    ["unknown authorization semantic", (value) => { value.authorizedBy = "writer"; }],
  ];
  for (const [field, mutate] of cases) await t.test(field, () => {
    const tampered = structuredClone(original);
    mutate(tampered);
    fs.writeFileSync(target, `${JSON.stringify(tampered, null, 2)}\n`);
    assert.throws(() => getChangeSet(directory, changeSet.id), (error: unknown) => error instanceof ChangeSetStoreCorruptionError && error.recoveryStatus === "needs_attention");
    fs.writeFileSync(target, source);
  });
  const reverseKeys = (value: any): any => Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, nested]) => [key, reverseKeys(nested)])) : value;
  fs.writeFileSync(target, `${JSON.stringify(reverseKeys(original), null, 2)}\n`);
  assert.equal(getChangeSet(directory, changeSet.id).captureIntegritySha256, changeSet.captureIntegritySha256);
});
