import assert from "node:assert/strict";
import test from "node:test";
import { parseRunDiff } from "../src/components/changeDiffSource.ts";

test("parseRunDiff returns binary metadata without exposing binary content", () => {
  const payload = parseRunDiff({
    runId: "run-1",
    revision: "rev-1",
    files: [{
      path: "public/logo.png",
      revision: "file-rev",
      operation: "modify",
      originalExists: true,
      modifiedExists: true,
      originalHash: "a".repeat(64),
      modifiedHash: "b".repeat(64),
      originalSize: 128,
      modifiedSize: 256,
      original: "should-not-be-used",
      modified: "should-not-be-used",
      diff: "binary payload should not be copied",
      isBinary: true,
      isTooLarge: false,
      hasChanges: true,
      mutationIds: ["m1"],
      hunks: [],
      updatedAt: 42,
    }],
  }, "public/logo.png");

  assert.equal(payload.isBinary, true);
  assert.equal(payload.original, "");
  assert.equal(payload.modified, "");
  assert.equal(payload.diff, "");
  assert.equal(payload.originalHash, "a".repeat(64));
  assert.equal(payload.modifiedHash, "b".repeat(64));
  assert.equal(payload.originalSize, 128);
  assert.equal(payload.modifiedSize, 256);
});

test("parseRunDiff rejects binary files with incomplete metadata", () => {
  assert.throws(() => parseRunDiff({
    runId: "run-1",
    revision: "rev-1",
    files: [{
      path: "public/logo.png",
      revision: "file-rev",
      operation: "modify",
      originalExists: true,
      modifiedExists: true,
      originalHash: "a".repeat(64),
      modifiedHash: "b".repeat(64),
      originalSize: 128,
      isBinary: true,
      isTooLarge: false,
      hasChanges: true,
      mutationIds: ["m1"],
      hunks: [],
    }],
  }, "public/logo.png"), /binary change evidence is unavailable/i);
});
