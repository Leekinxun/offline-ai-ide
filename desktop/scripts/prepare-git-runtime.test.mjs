import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareGitRuntime, runtimeInventory, validateArchiveEntries, smokeGitRuntime, verifyGitRuntime } from "./prepare-git-runtime.mjs";

test("archive paths cannot escape or redirect the verified Git extraction", () => {
  validateArchiveEntries(["cmd/git.exe", "usr/bin/", "git-2.56.0/Makefile"]);
  for (const entry of ["../git", "/bin/git", "C:/git.exe", "usr\\git.exe", "usr/../git.exe", "usr//git.exe", "x\0y"]) assert.throws(() => validateArchiveEntries([entry]), /Unsafe/);
});

test("runtime inventory preserves relative file aliases and rejects external links", t => {
  if (process.platform === "win32") { t.skip("Unprivileged Windows symlink creation is unavailable"); return; }
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-git-links-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, "runtime"); fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "libexec")); fs.writeFileSync(path.join(root, "bin/git"), "owned fixture");
  fs.symlinkSync("../bin/git", path.join(root, "libexec/git"));
  assert.equal(runtimeInventory(root).links["libexec/git"], "../bin/git");
  const copy = path.join(fixture, "relocated"); fs.cpSync(root, copy, { recursive: true, verbatimSymlinks: true });
  assert.deepEqual(runtimeInventory(copy), runtimeInventory(root));
  fs.writeFileSync(path.join(fixture, "outside"), "outside"); fs.symlinkSync("../../outside", path.join(root, "libexec/escape"));
  assert.throws(() => runtimeInventory(root), /escapes/);
});

test("preparing a foreign architecture cannot download or build a runtime", async () => {
  await assert.rejects(prepareGitRuntime({ arch: process.arch === "arm64" ? "x64" : "arm64" }), /matching/);
});

test("a prepared real Git runtime relocates and works without system Git on PATH", t => {
  const directory = process.env.CROWNFORGE_TEST_GIT_RUNTIME_DIRECTORY;
  if (!directory) { t.skip("Set CROWNFORGE_TEST_GIT_RUNTIME_DIRECTORY to a prepared runtime for real acceptance"); return; }
  const report = smokeGitRuntime(directory);
  assert.equal(report.systemGitOnPath, false);
  assert.ok(report.checks.includes("worktree add/remove"));
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-git-integrity-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const copy = path.join(fixture, "runtime"); fs.cpSync(directory, copy, { recursive: true, verbatimSymlinks: true });
  const runtime = verifyGitRuntime(copy);
  fs.appendFileSync(runtime.executable, "unreviewed substitution");
  assert.throws(() => verifyGitRuntime(copy), /changed/);
});
