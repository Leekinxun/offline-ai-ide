import assert from "node:assert/strict";
import test from "node:test";
import { getDiffLineRevealScrollTop, toReviewLineSelection } from "../frontend/src/components/pierreDiffPolicy.js";

test("Pierre selections retain file-side coordinates for review comments", () => {
  assert.deepEqual(toReviewLineSelection({ start: 21, end: 24, side: "deletions" }),
    { side: "original", startLine: 21, endLine: 24 });
  assert.deepEqual(toReviewLineSelection({ start: 9, end: 4, side: "additions" }),
    { side: "modified", startLine: 4, endLine: 9 });
  assert.deepEqual(toReviewLineSelection({ start: 2, end: 2, side: "additions", endSide: "additions" }),
    { side: "modified", startLine: 2, endLine: 2 });
});

test("ambiguous, cross-side and invalid selections cannot become review comments", () => {
  for (const range of [null, { start: 1, end: 2 },
    { start: 1, end: 2, side: "deletions" as const, endSide: "additions" as const },
    { start: 0, end: 2, side: "additions" as const },
    { start: 1, end: NaN, side: "additions" as const },
    { start: 1.5, end: 2, side: "additions" as const }]) {
    assert.equal(toReviewLineSelection(range), null);
  }
});

test("keyboard reveal uses file-side virtual positions even when matching line numbers are far apart", async () => {
  // Import the renderer directly: the package's browser barrel also initializes
  // CodeView platform detection, which is unrelated to this DOM-free layout test.
  const packageDirectory = new URL("../frontend/node_modules/@pierre/diffs/dist/", import.meta.url);
  const { VirtualizedFileDiff } = await import(new URL("components/VirtualizedFileDiff.js", packageDirectory).href);
  const { Virtualizer } = await import(new URL("components/Virtualizer.js", packageDirectory).href);
  const { parseDiffFromFile } = await import(new URL("utils/parseDiffFromFile.js", packageDirectory).href);
  const fileDiff = parseDiffFromFile(
    { name: "replacement.ts", contents: Array.from({ length: 300 }, (_, index) => `old ${index}`).join("\n") },
    { name: "replacement.ts", contents: "replacement\n" },
  );
  const instance = new VirtualizedFileDiff({ diffStyle: "unified", expandUnchanged: true, disableFileHeader: true },
    new Virtualizer(), { lineHeight: 20 });
  instance.updateCodeViewLayout(fileDiff, 0);
  const oldLine = instance.getLinePosition(1, "deletions");
  const newLine = instance.getLinePosition(1, "additions");
  assert.ok(oldLine && newLine);
  assert.ok(newLine.top > oldLine.top + 5_000, "The fixture must distinguish the two line-1 positions");
  const scrollTop = getDiffLineRevealScrollTop(0, 250, newLine.top, newLine.height);
  assert.ok(scrollTop > 5_000, "A new-side selection must reveal its added line, not old line 1");
  assert.ok(newLine.top >= scrollTop && newLine.top + newLine.height <= scrollTop + 250);
  assert.equal(getDiffLineRevealScrollTop(scrollTop, 250, oldLine.top, oldLine.height), oldLine.top);
});

test("keyboard reveal retains visible rows and aligns an oversized wrapped row at its start", () => {
  assert.equal(getDiffLineRevealScrollTop(100, 250, 180, 20), 100);
  assert.equal(getDiffLineRevealScrollTop(100, 250, 400, 20), 170);
  assert.equal(getDiffLineRevealScrollTop(100, 250, 20, 20), 20);
  assert.equal(getDiffLineRevealScrollTop(100, 250, 180, 300), 180);
});
