import assert from "node:assert/strict";
import test from "node:test";
import type { ReviewFile, ReviewHunk } from "../frontend/src/components/runReviewPolicy.js";
import { buildEditorReviewLayout, canApplyEditorReviewAction, matchesRecordedEditorFile, type EditorReviewSnapshot } from "../frontend/src/editor/editorChangeReviewPolicy.js";

const hunk = (overrides: Partial<ReviewHunk> = {}): ReviewHunk => ({ id: "h1", mutationId: "m1", preimageHash: "pre", postimageHash: "post", preimage: "old\n", postimage: "new\n", reverted: false, kept: false, ...overrides });
const file = (overrides: Partial<ReviewFile> = {}): ReviewFile => ({
  path: "src/a.ts", operation: "modify", original: "head\nold\ntail\n", modified: "head\nnew\ntail\n", originalExists: true, modifiedExists: true,
  originalHash: "before", modifiedHash: "after", revision: "revision-1", mutationIds: ["m1"], hunks: [hunk()], additions: 1, deletions: 1,
  hasChanges: true, isBinary: false, isTooLarge: false, updatedAt: 1, rollbackState: "applied", reviewState: "pending", ...overrides,
});
const snapshot = (value = file()): EditorReviewSnapshot => ({ path: value.path, modelUri: `file:///repo/${value.path}`, modelVersion: 4, content: value.modified!, revision: value.revision });
const current = (value = file()) => ({ ...snapshot(value), dirty: false, readOnly: false });

test("persistent review maps added and deleted lines with an exact saved snapshot", () => {
  const value = file(); const layout = buildEditorReviewLayout(value, value.path, value.modified!, false)!;
  assert.deepEqual(layout.blocks, [{ id: "1:1", originalStartLine: 2, modifiedStartLine: 2, removed: ["old\n"], added: ["new\n"] }]);
  assert.equal(layout.positionedHunks[0].blockId, "1:1");
  assert.equal(layout.positionedHunks[0].startLine, 2);
  assert.equal(layout.positionedHunks[0].endLine, 2);
});

test("dirty or diverged buffers never display actionable recorded changes", () => {
  const value = file();
  assert.equal(buildEditorReviewLayout(value, value.path, value.modified!, true), null);
  assert.equal(buildEditorReviewLayout(value, value.path, "head\nuser\ntail\n", false), null);
  assert.equal(buildEditorReviewLayout(value, "src/other.ts", value.modified!, false), null);
});

test("normalized separators match while case-distinct paths do not", () => {
  const value = file();
  assert.equal(matchesRecordedEditorFile(value, "./src\\a.ts", value.modified!, false), true);
  assert.equal(matchesRecordedEditorFile(value, "src/A.ts", value.modified!, false), false);
});

test("unchanged and reverted, unavailable, binary or oversized evidence cannot decorate the editor", () => {
  for (const changes of [{ hasChanges: false }, { rollbackState: "reverted" as const }, { unavailableReason: "missing" }, { isBinary: true }, { isTooLarge: true }, { modifiedExists: false }]) {
    const value = file(changes);
    assert.equal(buildEditorReviewLayout(value, value.path, value.modified!, false), null);
  }
});

test("a historical hunk is not positioned using a coincidental match in the newest mutation", () => {
  const value = file({ mutationIds: ["m1", "m2"], hunks: [hunk()] });
  const layout = buildEditorReviewLayout(value, value.path, value.modified!, false)!;
  assert.equal(layout.positionedHunks.length, 0);
  assert.deepEqual(layout.unavailableHunks.map((entry) => entry.id), ["h1"]);
});

test("ambiguous, truncated and overwritten hunk fragments require full review", () => {
  for (const value of [
    file({ original: "head\nold\nnew\ntail\n", modified: "head\nnew\nnew\ntail\n" }),
    file({ hunks: [hunk({ truncated: true })] }),
    file({ hunks: [hunk({ postimage: "intermediate\n" })] }),
    file({ hunks: [hunk({ postimage: undefined })] }),
  ]) {
    const layout = buildEditorReviewLayout(value, value.path, value.modified!, false)!;
    assert.equal(layout.positionedHunks.length, 0);
    assert.equal(layout.unavailableHunks.length, 1);
  }
});

test("a unique deletion in one mutation is placed before the surviving line", () => {
  const value = file({ modified: "head\ntail\n", hunks: [hunk({ postimage: "" })] });
  const layout = buildEditorReviewLayout(value, value.path, value.modified!, false)!;
  assert.equal(layout.blocks[0].modifiedStartLine, 2);
  assert.deepEqual(layout.blocks[0].added, []);
  assert.equal(layout.positionedHunks[0].startLine, 2);
});

test("deletions without intermediate positions across mutations are not guessed", () => {
  const value = file({ modified: "head\ntail\n", mutationIds: ["previous", "m1"], hunks: [hunk({ postimage: "" })] });
  const layout = buildEditorReviewLayout(value, value.path, value.modified!, false)!;
  assert.equal(layout.positionedHunks.length, 0);
  assert.equal(layout.unavailableHunks.length, 1);
});

test("insertion into an empty file and deleting all text produce no phantom added lines", () => {
  const insertion = file({ original: "", modified: "new\n", hunks: [hunk({ preimage: "" })] });
  const inserted = buildEditorReviewLayout(insertion, insertion.path, insertion.modified!, false)!;
  assert.deepEqual(inserted.blocks[0].removed, []);
  assert.deepEqual(inserted.blocks[0].added, ["new\n"]);
  assert.equal(inserted.positionedHunks[0].startLine, 1);
  const deletion = file({ original: "old\n", modified: "", hunks: [hunk({ postimage: "" })] });
  const deleted = buildEditorReviewLayout(deletion, deletion.path, "", false)!;
  assert.deepEqual(deleted.blocks[0].added, []);
  assert.equal(deleted.positionedHunks[0].startLine, 1);
});

test("large unchanged prefixes and suffixes retain precise small decorations", () => {
  const prefix = "unchanged\n".repeat(2000); const suffix = "still unchanged\n".repeat(2000);
  const value = file({ original: prefix + "old\n" + suffix, modified: prefix + "new\n" + suffix });
  const layout = buildEditorReviewLayout(value, value.path, value.modified!, false)!;
  assert.equal(layout.largeDiff, false);
  assert.equal(layout.blocks.length, 1);
  assert.equal(layout.blocks[0].modifiedStartLine, 2001);
});

test("oversized changed middles use full review instead of painting unchanged code as additions", () => {
  const value = file({ original: Array.from({ length: 501 }, (_, i) => `old${i}\n`).join(""), modified: Array.from({ length: 501 }, (_, i) => `new${i}\n`).join("") });
  const layout = buildEditorReviewLayout(value, value.path, value.modified!, false)!;
  assert.equal(layout.largeDiff, true); assert.deepEqual(layout.blocks, []);
  assert.deepEqual(layout.positionedHunks, []);
});

test("running tasks permit keep but forbid undoing saved hunks", () => {
  const value = file();
  assert.equal(canApplyEditorReviewAction(snapshot(), current(), value, value.hunks[0], "keep", { running: true, busy: false }), true);
  assert.equal(canApplyEditorReviewAction(snapshot(), current(), value, value.hunks[0], "revert", { running: true, busy: false }), false);
});

test("click-time validation refuses typing, undo-version drift, model replacement and revision drift", () => {
  const value = file();
  for (const state of [{ dirty: true }, { modelVersion: 5 }, { modelUri: "file:///other/a.ts" }, { content: "user text" }, { path: "other.ts" }, { readOnly: true }]) {
    assert.equal(canApplyEditorReviewAction(snapshot(), { ...current(), ...state }, value, value.hunks[0], "revert", { running: false, busy: false }), false);
  }
  assert.equal(canApplyEditorReviewAction(snapshot(), current(), file({ revision: "new-revision" }), value.hunks[0], "revert", { running: false, busy: false }), false);
  assert.equal(canApplyEditorReviewAction(snapshot(), current(), value, value.hunks[0], "revert", { running: false, busy: true }), false);
});

test("kept hunks can be explicitly undone, while reverted and foreign IDs cannot act", () => {
  const kept = file({ hunks: [hunk({ kept: true })] });
  assert.equal(canApplyEditorReviewAction(snapshot(), current(), kept, kept.hunks[0], "keep", { running: false, busy: false }), false);
  assert.equal(canApplyEditorReviewAction(snapshot(), current(), kept, kept.hunks[0], "revert", { running: false, busy: false }), true);
  const reverted = file({ hunks: [hunk({ reverted: true })] });
  assert.equal(canApplyEditorReviewAction(snapshot(), current(), reverted, reverted.hunks[0], "revert", { running: false, busy: false }), false);
  assert.equal(canApplyEditorReviewAction(snapshot(), current(), file(), hunk({ mutationId: "foreign" }), "revert", { running: false, busy: false }), false);
});
