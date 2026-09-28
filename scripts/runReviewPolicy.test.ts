import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewChanges, reviewActionPolicy, reviewSelection, reviewStatus, runChangesUrl, validReviewComment, type ReviewFile } from "../frontend/src/components/runReviewPolicy.js";

function file(): ReviewFile {
  return { path: "src/a.ts", operation: "modify", original: "old\nline\n", modified: "new\nline\n",
    originalExists: true, modifiedExists: true, originalHash: "before", modifiedHash: "after", revision: "fixed-revision",
    mutationIds: ["mutation-1"], hunks: [{ id: "hunk-1", mutationId: "mutation-1", preimageHash: "a", postimageHash: "b", reverted: false, kept: false }],
    additions: 1, deletions: 1, hasChanges: true, isBinary: false, isTooLarge: false, updatedAt: 1, rollbackState: "applied", reviewState: "pending" };
}
const ready = { readOnly: false, running: false, busy: false, stale: false };

test("review reads fixed run/request/file scope and refuses mismatched responses", () => {
  const url = runChangesUrl("run/one", "turn two", "src/a.ts");
  assert.equal(url, "/api/chat/runs/run%2Fone/changes?requestId=turn+two&path=src%2Fa.ts");
  assert.equal(parseReviewChanges({ runId: "r", revision: "v", files: [file()] }, "r").files.length, 1);
  assert.throws(() => parseReviewChanges({ runId: "other", revision: "v", files: [] }, "r"), /belong/);
  assert.throws(() => parseReviewChanges({ runId: "r", requestId: "old-turn", revision: "v", files: [] }, "r", "new-turn"), /request/);
  assert.throws(() => parseReviewChanges({ runId: "r", revision: "v", files: [{ path: "a" }] }, "r"), /incomplete/);
});

test("review actions protect readonly, stale, unavailable and running states", () => {
  const candidate = file();
  assert.deepEqual(reviewActionPolicy(candidate, ready), { keep: true, revert: true, comment: true });
  for (const input of [{ ...ready, readOnly: true }, { ...ready, stale: true }, { ...ready, busy: true }]) {
    assert.deepEqual(reviewActionPolicy(candidate, input), { keep: false, revert: false, comment: false });
  }
  assert.deepEqual(reviewActionPolicy({ ...candidate, unavailableReason: "missing" }, ready), { keep: false, revert: false, comment: false });
  assert.deepEqual(reviewActionPolicy(candidate, { ...ready, running: true }), { keep: true, revert: false, comment: true });
  assert.equal(reviewActionPolicy({ ...candidate, reviewState: "kept" }, ready).keep, false);
  assert.equal(reviewActionPolicy({ ...candidate, rollbackState: "reverted" }, ready).revert, false);
});

test("hunk decisions bind both mutation id and current review revision", () => {
  const candidate = file(); const hunk = candidate.hunks[0];
  assert.deepEqual(reviewSelection(candidate, "turn", hunk), { path: "src/a.ts", expectedRevision: "fixed-revision", requestId: "turn", ids: ["mutation-1"], hunkIds: ["hunk-1"] });
  assert.deepEqual(reviewSelection(candidate), { path: "src/a.ts", expectedRevision: "fixed-revision", ids: ["mutation-1"] });
  assert.equal(reviewStatus(candidate, { ...hunk, kept: true }), "kept");
  assert.equal(reviewStatus(candidate, { ...hunk, kept: true, reverted: true }), "reverted");
  assert.equal(reviewStatus({ ...candidate, reviewState: "partially_kept" }), "partial");
  assert.equal(reviewActionPolicy(candidate, ready, { ...hunk, kept: true }).revert, true);
});

test("line feedback is bounded and tied to the viewed side and revision", () => {
  const candidate = file();
  const comment = { path: candidate.path, revision: candidate.revision, side: "modified" as const, startLine: 1, endLine: 2, text: "Improve this" };
  assert.equal(validReviewComment(candidate, comment), true);
  for (const update of [{ revision: "stale" }, { path: "other" }, { startLine: 0 }, { startLine: 2, endLine: 1 }, { endLine: 500 }, { text: " " }]) assert.equal(validReviewComment(candidate, { ...comment, ...update }), false);
  assert.equal(validReviewComment({ ...candidate, original: "" }, { ...comment, side: "original", endLine: 1 }), true);
});
