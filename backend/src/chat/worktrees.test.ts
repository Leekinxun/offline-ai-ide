import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createManagedWorktree,
  listManagedWorktrees,
  removeManagedWorktree,
  WorktreeMetadataCorruptionError,
} from "./worktrees.js";
import { applyChangeSetDecision, captureChangeSet } from "./changeSets.js";

function git(directory: string, args: string[]): void {
  execFileSync("git", ["-C", directory, ...args], { stdio: "ignore" });
}

test("creates, lists, and safely removes managed git worktrees", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-worktree-"));
  const repository = path.join(parent, "repo");
  fs.mkdirSync(repository);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  git(repository, ["init"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  git(repository, ["config", "user.name", "CrewForge Test"]);
  fs.writeFileSync(path.join(repository, "README.md"), "base\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "-m", "initial"]);

  const created = createManagedWorktree(repository, { name: "feature" });
  assert.match(created.id, /^feature-/);
  assert.equal(fs.existsSync(path.join(created.path, "README.md")), true);
  assert.equal(listManagedWorktrees(repository).some((entry) => entry.id === created.id), true);

  fs.writeFileSync(path.join(created.path, "review.txt"), "review\n");
  git(created.path, ["add", "review.txt"]);
  git(created.path, ["commit", "-m", "reviewable"]);
  const changeSet = captureChangeSet(repository, created.id);
  applyChangeSetDecision(repository, changeSet, "reject");
  const removed = removeManagedWorktree(repository, created.id);
  assert.equal(removed.id, created.id);
  assert.equal(fs.existsSync(created.path), false);
  assert.equal(listManagedWorktrees(repository).length, 0);
});

test("only missing worktree metadata is treated as legacy while corrupt, unreadable, and future metadata fail closed", async (t) => {
  for (const [label, corrupt] of [
    ["corrupt", (file: string) => fs.writeFileSync(file, "{not-json\n")],
    ["future", (file: string) => { const value = JSON.parse(fs.readFileSync(file, "utf8")); fs.writeFileSync(file, `${JSON.stringify({ ...value, schemaVersion: 2 })}\n`); }],
    ["unreadable", (file: string) => { fs.rmSync(file); fs.mkdirSync(file); }],
  ] as const) {
    await t.test(label, () => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), `crewforge-worktree-${label}-`));
      const repository = path.join(parent, "repo"); fs.mkdirSync(repository); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
      git(repository, ["init"]); git(repository, ["config", "user.email", "test@example.com"]); git(repository, ["config", "user.name", "CrewForge Test"]);
      fs.writeFileSync(path.join(repository, "README.md"), "base\n"); git(repository, ["add", "."]); git(repository, ["commit", "-m", "initial"]);
      const created = createManagedWorktree(repository, { name: label });
      const metadata = path.join(repository, ".history", "worktrees", `${created.id}.json`); corrupt(metadata);
      assert.throws(() => listManagedWorktrees(repository), WorktreeMetadataCorruptionError);
      assert.throws(() => removeManagedWorktree(repository, created.id), WorktreeMetadataCorruptionError);
      assert.equal(fs.existsSync(created.path), true);
    });
  }

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-worktree-legacy-"));
  const repository = path.join(parent, "repo"); fs.mkdirSync(repository); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  git(repository, ["init"]); git(repository, ["config", "user.email", "test@example.com"]); git(repository, ["config", "user.name", "CrewForge Test"]);
  fs.writeFileSync(path.join(repository, "README.md"), "base\n"); git(repository, ["add", "."]); git(repository, ["commit", "-m", "initial"]);
  const legacy = createManagedWorktree(repository, { name: "legacy" });
  fs.rmSync(path.join(repository, ".history", "worktrees", `${legacy.id}.json`));
  assert.equal(listManagedWorktrees(repository).find((entry) => entry.id === legacy.id)?.baseSha, undefined);
  assert.equal(removeManagedWorktree(repository, legacy.id).id, legacy.id);
});
