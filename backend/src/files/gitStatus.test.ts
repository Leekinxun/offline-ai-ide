import assert from "node:assert/strict";
import test from "node:test";
import { parseGitStatusOutput } from "./gitStatus.js";

test("parses tracked, untracked, renamed and conflicted Git changes", () => {
  const status = parseGitStatusOutput([
    "## feature...origin/feature [ahead 2, behind 1]",
    " M src/a.ts",
    "?? new file.ts",
    "R  old.ts -> new.ts",
    "UU src/conflict.ts",
  ].join("\n"));

  assert.equal(status.branch, "feature");
  assert.equal(status.upstream, "origin/feature");
  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 1);
  assert.deepEqual(status.entries.map((entry) => entry.kind), ["modified", "untracked", "renamed", "conflicted"]);
  assert.equal(status.entries[2].previousPath, "old.ts");
  assert.equal(status.entries[2].path, "new.ts");
});
