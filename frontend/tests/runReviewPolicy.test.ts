import assert from "node:assert/strict";
import test from "node:test";
import {
  binaryEvidenceForFile,
  bulkReviewPolicy,
  reviewActionPolicy,
  type ReviewFile,
} from "../src/components/runReviewPolicy.ts";

const BEFORE_HASH = "a".repeat(64);
const AFTER_HASH = "b".repeat(64);

const baseFile = (overrides: Partial<ReviewFile> = {}): ReviewFile => ({
  path: "asset.png",
  operation: "modify",
  originalExists: true,
  modifiedExists: true,
  originalHash: BEFORE_HASH,
  modifiedHash: AFTER_HASH,
  originalSize: 12,
  modifiedSize: 34,
  revision: "rev-1",
  mutationIds: ["mutation-1"],
  hunks: [],
  additions: null,
  deletions: null,
  hasChanges: true,
  isBinary: true,
  isTooLarge: false,
  updatedAt: 1,
  rollbackState: "applied",
  reviewState: "pending",
  ...overrides,
});

const idle = { readOnly: false, running: false, busy: false, stale: false };

test("binary review evidence uses hashes and originalSize/modifiedSize", () => {
  const evidence = binaryEvidenceForFile(baseFile());
  assert.equal(evidence.complete, true);
  assert.equal(evidence.originalSize, 12);
  assert.equal(evidence.modifiedSize, 34);
});

test("complete binary evidence allows file-level keep and revert but blocks comments and hunk actions", () => {
  const file = baseFile({ hunks: [{ id: "h1", mutationId: "mutation-1", preimageHash: "a", postimageHash: "b", reverted: false, kept: false }] });
  assert.deepEqual(reviewActionPolicy(file, idle), { keep: true, revert: true, comment: false });
  assert.deepEqual(reviewActionPolicy(file, idle, file.hunks[0]), { keep: false, revert: false, comment: false });
});

test("binary files without complete evidence remain protected", () => {
  const missingSize = baseFile({ modifiedSize: undefined });
  assert.equal(binaryEvidenceForFile(missingSize).complete, false);
  assert.deepEqual(reviewActionPolicy(missingSize, idle), { keep: false, revert: false, comment: false });
  assert.equal(bulkReviewPolicy({ runId: "run", revision: "rev", files: [missingSize] }, { readOnly: false, busy: false, loading: false }).unavailable, true);
});

test("binary evidence rejects non-64-hex hashes and unsafe sizes", () => {
  assert.equal(binaryEvidenceForFile(baseFile({ modifiedHash: "not-a-recorded-digest" })).complete, false);
  assert.equal(binaryEvidenceForFile(baseFile({ modifiedSize: Number.MAX_SAFE_INTEGER + 1 })).complete, false);
});

test("bulk keep accepts pending binary files with complete evidence", () => {
  const text = baseFile({ path: "src/app.ts", isBinary: false, original: "a", modified: "b", additions: 1, deletions: 1 });
  const binary = baseFile();
  const policy = bulkReviewPolicy({ runId: "run", revision: "rev", files: [text, binary] }, { readOnly: false, busy: false, loading: false });
  assert.deepEqual(policy, { count: 2, allowed: true, unavailable: false });
});

test("binary create and delete require evidence only for existing sides", () => {
  assert.equal(binaryEvidenceForFile(baseFile({ operation: "create", originalExists: false, originalHash: "", originalSize: undefined })).complete, true);
  assert.equal(binaryEvidenceForFile(baseFile({ operation: "delete", modifiedExists: false, modifiedHash: "", modifiedSize: undefined })).complete, true);
});
