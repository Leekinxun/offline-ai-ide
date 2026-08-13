import assert from "node:assert/strict";
import test from "node:test";
import {
  changeSetDecisionAllowed,
  changeSetRecoveryDecisions,
  changeSetStatusTone,
  isChangeSetIntegrable,
} from "../frontend/src/components/changeSetRecoveryPolicy.js";
import { EN_MESSAGES, ZH_CN_MESSAGES } from "../frontend/src/i18n/messages.js";
import {
  changeSetPatchContentSha256,
  changeSetReviewRevision,
  isCurrentChangeSet,
  parsePublicChangeSet,
} from "../frontend/src/hooks/changeSetContract.js";

const digest = (character: string) => character.repeat(64);
const commit = (character: string) => character.repeat(40);

function publicChangeSet(schemaVersion: 1 | 2 | 3): Record<string, unknown> {
  return {
    schemaVersion,
    id: digest("a"),
    worktreeId: "worktree-1",
    baseSha: commit("b"),
    branch: "crewforge/change",
    headSha: commit("c"),
    dirty: true,
    changedFiles: ["src/example.ts"],
    status: "ready_for_review",
    createdAt: "2026-08-11T00:00:00.000Z",
    recovery: { state: "not_required", actionAvailable: false, inspectionRequired: false },
    patch: { sha256: digest("d"), available: true, files: [{ path: "blobs/patch", sha256: digest("d"), kind: "patch" }] },
    ...(schemaVersion === 3 ? {
      captureIntegritySha256: digest("e"),
      transitionVersion: 1,
      transitionIntegritySha256: digest("f"),
    } : { integritySha256: digest("1") }),
  };
}

test("needs_attention offers only safe recovery decisions and never integration", () => {
  const changeSet = parsePublicChangeSet({ ...publicChangeSet(3), status: "needs_attention" });
  assert.deepEqual(changeSetRecoveryDecisions(changeSet), ["request_revision", "reject"]);
  assert.equal(changeSetDecisionAllowed(changeSet, "request_revision"), true);
  assert.equal(changeSetDecisionAllowed(changeSet, "reject"), true);
  for (const decision of ["apply", "merge", "cherry_pick"] as const) {
    assert.equal(changeSetDecisionAllowed(changeSet, decision), false, decision);
  }
  assert.equal(isChangeSetIntegrable(changeSet), false);
  assert.equal(changeSetStatusTone("needs_attention"), "warning");
});

test("only ready_for_review is integration-eligible", () => {
  assert.equal(isChangeSetIntegrable(parsePublicChangeSet(publicChangeSet(3))), true);
  for (const status of ["running", "applying", "applied", "rejected", "needs_revision", "needs_attention", "failed", "no_changes"] as const) {
    assert.equal(isChangeSetIntegrable(parsePublicChangeSet({ ...publicChangeSet(3), status })), false, status);
  }
});

test("needs_attention recovery copy exists in English and Simplified Chinese", () => {
  for (const messages of [EN_MESSAGES, ZH_CN_MESSAGES]) {
    for (const key of [
      "recovery.changeSetStatus.needs_attention",
      "recovery.needsAttentionDescription",
      "recovery.needsAttentionActions",
      "recovery.requestRevision",
      "recovery.reject",
    ]) assert.ok(messages[key], key);
  }
});

test("schema-v3 public ChangeSets expose the server integrity envelopes and patch content digest", () => {
  const changeSet = parsePublicChangeSet(publicChangeSet(3));
  assert.equal(isCurrentChangeSet(changeSet), true);
  if (!isCurrentChangeSet(changeSet)) return;
  assert.equal(changeSet.captureIntegritySha256, digest("e"));
  assert.equal(changeSet.transitionVersion, 1);
  assert.equal(changeSet.transitionIntegritySha256, digest("f"));
  assert.equal(changeSetReviewRevision(changeSet), digest("e"));
  assert.equal(changeSetPatchContentSha256(changeSet), digest("d"));
  assert.equal("captureIntegrityVersion" in changeSet, false);
  assert.equal("patchContentSha256" in changeSet, false);
});

test("schema-v1/v2 public ChangeSets remain readable but fail closed for mutations", () => {
  for (const schemaVersion of [1, 2] as const) {
    const changeSet = parsePublicChangeSet(publicChangeSet(schemaVersion));
    assert.equal(isCurrentChangeSet(changeSet), false);
    assert.deepEqual(changeSetRecoveryDecisions(changeSet), []);
    assert.equal(isChangeSetIntegrable(changeSet), false);
  }
});

test("public ChangeSet parsing rejects unsupported or incomplete integrity contracts", () => {
  const missingCapture = publicChangeSet(3);
  delete missingCapture.captureIntegritySha256;
  assert.throws(() => parsePublicChangeSet(missingCapture), /capture integrity/i);
  assert.throws(() => parsePublicChangeSet({ ...publicChangeSet(3), schemaVersion: 4 }), /schema version/i);
  assert.throws(() => parsePublicChangeSet({ ...publicChangeSet(3), status: "ready" }), /status/i);
  assert.throws(() => parsePublicChangeSet({ ...publicChangeSet(3), patch: { sha256: "not-a-digest", available: true, files: [] } }), /patch/i);
});
