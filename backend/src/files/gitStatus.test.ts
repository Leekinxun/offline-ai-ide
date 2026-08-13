import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseGitStatusOutput, parseGitStatusV2Output, readGitStatus, scopeGitStatusEntries } from "./gitStatus.js";

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

test("scopes repository-root Git paths to the selected workspace directory", () => {
  const parsed = parseGitStatusOutput([
    "## main",
    " M packages/app/src/main.ts",
    "?? packages/app/new.ts",
    " M packages/other/ignored.ts",
  ].join("\n"));
  const entries = scopeGitStatusEntries(parsed.entries, "packages/app");
  assert.deepEqual(entries.map((entry) => entry.path), ["src/main.ts", "new.ts"]);
});

test("parses porcelain v2 NUL records without treating path contents as syntax", () => {
  const status = parseGitStatusV2Output([
    "# branch.oid 0123456789012345678901234567890123456789",
    "# branch.head feature",
    "# branch.upstream origin/feature",
    "# branch.ab +3 -2",
    "1 .M N... 100644 100644 100644 0123456789012345678901234567890123456789 0123456789012345678901234567890123456789 path with -> arrow.ts",
    "2 R. N... 100644 100644 100644 0123456789012345678901234567890123456789 0123456789012345678901234567890123456789 R100 renamed\nfile.ts",
    "old -> name.ts",
    "? 新文件.ts",
    "",
  ].join("\0"));
  assert.equal(status.branch, "feature");
  assert.equal(status.headSha, "0123456789012345678901234567890123456789");
  assert.equal(status.upstream, "origin/feature");
  assert.equal(status.ahead, 3);
  assert.equal(status.behind, 2);
  assert.deepEqual(status.entries.map((entry) => entry.path), [
    "path with -> arrow.ts",
    "renamed\nfile.ts",
    "新文件.ts",
  ]);
  assert.equal(status.entries[1].previousPath, "old -> name.ts");
});

test("reads Git status relative to a selected subdirectory workspace", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "crownforge-git-workspace-"));
  const workspace = path.join(repo, "packages", "app");
  const outside = path.join(repo, "packages", "other");
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(workspace, "tracked.ts"), "export const value = 1;\n");
  await writeFile(path.join(outside, "ignored.ts"), "export const ignored = 1;\n");

  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", [
      "-c", "user.name=CrownForge Tests",
      "-c", "user.email=tests@crownforge.local",
      "commit", "-qm", "fixture",
    ], { cwd: repo });
    await writeFile(path.join(workspace, "tracked.ts"), "export const value = 2;\n");
    await writeFile(path.join(workspace, "new.ts"), "export const next = true;\n");
    await writeFile(path.join(outside, "ignored.ts"), "export const ignored = 2;\n");

    const status = readGitStatus(workspace);
    assert.equal(status.isRepo, true);
    assert.deepEqual(status.entries.map((entry) => entry.path).sort(), ["new.ts", "tracked.ts"]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
