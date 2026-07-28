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
} from "./worktrees.js";

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

  const removed = removeManagedWorktree(repository, created.id);
  assert.equal(removed.id, created.id);
  assert.equal(fs.existsSync(created.path), false);
  assert.equal(listManagedWorktrees(repository).length, 0);
});
