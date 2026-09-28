import assert from "node:assert/strict";
import test from "node:test";
import type { ReviewFile, ReviewHunk } from "../frontend/src/components/runReviewPolicy.js";
import { reviewActionPolicy } from "../frontend/src/components/runReviewPolicy.js";
import { buildEditorReviewLayout, canApplyEditorReviewAction, canKeepEditorFileChanges, matchesRecordedEditorFile, type EditorReviewSnapshot } from "../frontend/src/editor/editorChangeReviewPolicy.js";

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

test("kept hunks leave the editor but remain undoable in Changes", () => {
  const kept = file({ hunks: [hunk({ kept: true })] });
  const evidence = structuredClone(kept);
  assert.equal(buildEditorReviewLayout(kept, kept.path, kept.modified!, false), null);
  assert.equal(canApplyEditorReviewAction(snapshot(), current(), kept, kept.hunks[0], "keep", { running: false, busy: false }), false);
  assert.equal(canApplyEditorReviewAction(snapshot(), current(), kept, kept.hunks[0], "revert", { running: false, busy: false }), false);
  assert.equal(reviewActionPolicy(kept, { readOnly: false, running: false, busy: false, stale: false }, kept.hunks[0]).revert, true);
  assert.deepEqual(kept, evidence, "hiding an editor overlay must not change its historical evidence");
});

test("reverted and foreign hunk IDs cannot act in the editor", () => {
  const reverted = file({ hunks: [hunk({ reverted: true })] });
  assert.equal(canApplyEditorReviewAction(snapshot(), current(), reverted, reverted.hunks[0], "revert", { running: false, busy: false }), false);
  assert.equal(canApplyEditorReviewAction(snapshot(), current(), file(), hunk({ mutationId: "foreign" }), "revert", { running: false, busy: false }), false);
});

test("keeping one separated block removes only its decoration and controls", () => {
  const value = file({ original: "head\nold\nmiddle\nold two\ntail\n", modified: "head\nnew\nmiddle\nnew two\ntail\n",
    reviewState: "partially_kept", hunks: [hunk({ kept: true }), hunk({ id: "h2", preimage: "old two\n", postimage: "new two\n" })] });
  const layout = buildEditorReviewLayout(value, value.path, value.modified!, false)!;
  assert.equal(layout.blocks.length, 1);
  assert.deepEqual(layout.blocks[0].removed, ["old two\n"]);
  assert.equal(layout.blocks[0].modifiedStartLine, 4);
  assert.deepEqual(layout.positionedHunks.map((entry) => entry.hunk.id), ["h2"]);
  value.hunks[1].kept = true;
  assert.equal(buildEditorReviewLayout(value, value.path, value.modified!, false), null);
});

test("a shared diff block stays pending while any of its hunks needs review", () => {
  const value = file({ original: "head\nold\nold two\ntail\n", modified: "head\nnew\nnew two\ntail\n",
    hunks: [hunk({ kept: true }), hunk({ id: "h2", preimage: "old two\n", postimage: "new two\n" })] });
  const layout = buildEditorReviewLayout(value, value.path, value.modified!, false)!;
  assert.equal(layout.blocks.length, 1);
  assert.deepEqual(layout.positionedHunks.map((entry) => entry.hunk.id), ["h2"]);
});

test("whole-file review state hides overlays even without hunk metadata or within large diffs", () => {
  for (const value of [file({ reviewState: "kept", hunks: [] }), file({ reviewState: "kept", original: "old\n".repeat(501), modified: "new\n".repeat(501) })]) {
    assert.equal(buildEditorReviewLayout(value, value.path, value.modified!, false), null);
  }
});

test("unreviewed whole-file mutations are not hidden by an empty or partially covered hunk list", () => {
  assert.ok(buildEditorReviewLayout(file({ hunks: [] }), "src/a.ts", "head\nnew\ntail\n", false));
  const value = file({ mutationIds: ["create", "m1"], hunks: [hunk({ kept: true })], reviewState: "partially_kept" });
  const layout = buildEditorReviewLayout(value, value.path, value.modified!, false)!;
  assert.ok(layout, "the Changes fallback remains available for the unreviewed create");
  assert.deepEqual(layout.blocks, [], "accepted changes are not repainted to represent unknown history");
});

test("unpositioned pending history retains the Changes fallback after a newer block is kept", () => {
  const value = file({ mutationIds: ["m0", "m1"], hunks: [hunk({ mutationId: "m0", id: "earlier" }), hunk({ kept: true })] });
  const layout = buildEditorReviewLayout(value, value.path, value.modified!, false)!;
  assert.deepEqual(layout.blocks, []);
  assert.deepEqual(layout.unavailableHunks.map((entry) => entry.id), ["earlier"]);
});

test("a newly pending mutation is shown after earlier changes were kept", () => {
  const value = file({ mutationIds: ["earlier", "m1"], hunks: [hunk({ mutationId: "earlier", id: "kept", kept: true }), hunk()] });
  const layout = buildEditorReviewLayout(value, value.path, value.modified!, false)!;
  assert.equal(layout.blocks.length, 1);
  assert.deepEqual(layout.positionedHunks.map((entry) => entry.hunk.id), ["h1"]);
});

test("keep-all current-file action requires the exact saved writable file", () => {
  const value = file();
  assert.equal(canKeepEditorFileChanges(value, current(value), false), true);
  for (const invalid of [{ dirty: true }, { readOnly: true }, { content: "human edit" }, { path: "other.ts" }]) {
    assert.equal(canKeepEditorFileChanges(value, { ...current(value), ...invalid }, false), false);
  }
  assert.equal(canKeepEditorFileChanges(value, current(value), true), false);
  assert.equal(canKeepEditorFileChanges({ ...value, reviewState: "kept" }, current(value), false), false);
  assert.equal(canKeepEditorFileChanges(null, current(value), false), false);
});
