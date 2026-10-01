import assert from "node:assert/strict";
import test from "node:test";
import { changeDiffUrl, parseRunDiff } from "../frontend/src/components/changeDiffSource.js";

test("historical changes use the selected run even when the path exists in current Git", () => {
  assert.equal(changeDiffUrl("src/a b.ts", "run/old"), "/api/chat/runs/run%2Fold/changes?path=src%2Fa%20b.ts");
  assert.equal(changeDiffUrl("src/a.ts"), "/api/files/git-diff?path=src%2Fa.ts");
  const payload = parseRunDiff({ files: [{ path: "src/a.ts", original: "before", modified: "after", revision: "fixed-revision" }] }, "src/a.ts");
  assert.equal(payload.original, "before");
  assert.equal(payload.modified, "after");
  assert.equal(payload.revision, "fixed-revision");
});

test("missing, partial, or unavailable run evidence fails instead of showing another version", () => {
  assert.throws(() => parseRunDiff({ files: [] }, "a.ts"), /no recorded change/);
  assert.throws(() => parseRunDiff({ files: [{ path: "a.ts", original: "before" }] }, "a.ts"), /unavailable/);
  assert.throws(() => parseRunDiff({ files: [{ path: "a.ts", unavailableReason: "Journal gap" }] }, "a.ts"), /Journal gap/);
  assert.throws(() => parseRunDiff({ original: "HEAD", modified: "disk" }, "a.ts"), /unavailable/);
});
