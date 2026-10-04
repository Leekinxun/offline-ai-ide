import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bundledGitReadPaths, gitExecutable } from "../utils/gitRuntime.js";

test("Web ignores desktop Git overrides and development retains system Git", () => {
  assert.equal(gitExecutable({ CROWNFORGE_GIT_EXECUTABLE: "untrusted-relative", CROWNFORGE_BUNDLED_TOOLS_REQUIRED: "1" }), "git");
  assert.equal(gitExecutable({ CREWFORGE_DESKTOP: "1", CROWNFORGE_IDE_CORE_EXECUTABLE: "/fixture/core" }), "git");
});

test("packaged desktop requires its absolute Git executable without a PATH fallback", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-git-resolver-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "git-fixture");
  fs.writeFileSync(executable, "owned disposable executable path fixture");
  const env = { CREWFORGE_DESKTOP: "1", CROWNFORGE_IDE_CORE_EXECUTABLE: "/fixture/core", CROWNFORGE_BUNDLED_TOOLS_REQUIRED: "1", PATH: "" };
  assert.throws(() => gitExecutable(env), /Bundled Git runtime is missing/);
  assert.throws(() => gitExecutable({ ...env, CROWNFORGE_GIT_EXECUTABLE: "git" }), /must be absolute/);
  assert.throws(() => gitExecutable({ ...env, CROWNFORGE_GIT_EXECUTABLE: directory }), /regular file/);
  assert.equal(gitExecutable({ ...env, CROWNFORGE_GIT_EXECUTABLE: executable }), fs.realpathSync.native(executable));
});

test("desktop Git read grants stay within its owner-provided runtime and outside the workspace", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-git-runtime-grants-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "runtime"); const workspace = path.join(directory, "workspace");
  fs.mkdirSync(root); fs.mkdirSync(workspace);
  const executable = path.join(root, "git-fixture"); fs.writeFileSync(executable, "owned path fixture");
  const env = { CREWFORGE_DESKTOP: "1", CROWNFORGE_IDE_CORE_EXECUTABLE: "/fixture/core", CROWNFORGE_GIT_EXECUTABLE: executable, CROWNFORGE_GIT_RUNTIME_ROOT: root };
  assert.deepEqual(bundledGitReadPaths(workspace, env), [fs.realpathSync.native(root)]);
  assert.throws(() => bundledGitReadPaths(directory, env), /outside the workspace/);
  assert.throws(() => bundledGitReadPaths(workspace, { ...env, CROWNFORGE_GIT_EXECUTABLE: path.join(workspace, "git") }));
  assert.deepEqual(bundledGitReadPaths(workspace, { ...env, CREWFORGE_DESKTOP: "0" }), []);
});
