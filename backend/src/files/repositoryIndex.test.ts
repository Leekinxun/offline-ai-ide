import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { findDefinitionInWorkspace } from "../utils/definitionSearch.js";
import { recordKnownFileMutation } from "./mutationRegistry.js";
import { RepositoryIndexStore } from "../indexing/indexStore.js";
import {
  getRepositoryIndexStatus,
  invalidateRepositoryIndex,
  rebuildRepositoryIndex,
  retrieveRepositoryContext,
} from "../indexing/repositoryIndex.js";

function git(directory: string, args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function repository(t: TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-index-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  git(directory, ["init", "-q"]); git(directory, ["config", "user.email", "index@test.local"]); git(directory, ["config", "user.name", "Index Test"]);
  return directory;
}

test("builds an offline symbol/import/reference/test/Git index and retrieves freshness-checked context", async (t) => {
  const workspace = repository(t);
  fs.mkdirSync(path.join(workspace, "src")); fs.mkdirSync(path.join(workspace, "tests"));
  fs.writeFileSync(path.join(workspace, "src", "service.ts"), "export function calculateTotal(value: number) { return value + 1; }\n");
  fs.writeFileSync(path.join(workspace, "src", "consumer.ts"), "import { calculateTotal } from './service';\nexport const result = calculateTotal(2);\n");
  fs.writeFileSync(path.join(workspace, "tests", "service.test.ts"), "import { calculateTotal } from '../src/service';\ncalculateTotal(1);\n");
  fs.writeFileSync(path.join(workspace, "worker.py"), "from helpers import run\n\ndef python_worker():\n    return run()\n");
  git(workspace, ["add", "."]); git(workspace, ["commit", "-qm", "fixture"]);

  const status = await rebuildRepositoryIndex(workspace);
  assert.equal(status.status, "ready"); assert.equal(status.fileCount >= 4, true);
  const found = await retrieveRepositoryContext({ workspaceDir: workspace, query: "calculateTotal", currentPath: "src/consumer.ts", maxResults: 20 });
  assert.equal(found.some((entry) => entry.kind === "definition" && entry.path === "src/service.ts"), true);
  assert.equal(found.some((entry) => entry.kind === "reference" && entry.path === "src/consumer.ts"), true);
  assert.equal(found.some((entry) => entry.kind === "test" && entry.path === "tests/service.test.ts"), true);
  assert.equal(found.every((entry) => Boolean(entry.contentDigest && entry.freshness.verifiedAt)), true);
  assert.equal(findDefinitionInWorkspace(workspace, "calculateTotal", "src/consumer.ts")?.path, "src/service.ts");
});

test("incremental create, modify, delete, and rename update only affected records and mutation events trigger refresh", async (t) => {
  const workspace = repository(t); fs.mkdirSync(path.join(workspace, "src"));
  fs.writeFileSync(path.join(workspace, "src", "one.ts"), "export const one = 1;\n");
  let other = "src/two.ts"; const store = new RepositoryIndexStore(workspace);
  for (let index = 0; store.shardId(other) === store.shardId("src/one.ts"); index += 1) other = `src/two-${index}.ts`;
  fs.writeFileSync(path.join(workspace, other), "export const two = 2;\n");
  await rebuildRepositoryIndex(workspace);
  const otherBefore = store.readShard(store.shardId(other))[other];

  fs.writeFileSync(path.join(workspace, "src", "one.ts"), "export const oneChanged = 3;\n");
  await invalidateRepositoryIndex(workspace, [{ path: "src/one.ts", operation: "modify" }]);
  assert.equal(store.readShard(store.shardId(other))[other]?.indexedAt, otherBefore?.indexedAt);
  assert.equal(store.readShard(store.shardId("src/one.ts"))["src/one.ts"]?.symbols[0]?.name, "oneChanged");

  fs.writeFileSync(path.join(workspace, "src", "created.ts"), "export const created = true;\n");
  await invalidateRepositoryIndex(workspace, [{ path: "src/created.ts", operation: "create" }]);
  assert.equal(store.readShard(store.shardId("src/created.ts"))["src/created.ts"]?.symbols[0]?.name, "created");
  fs.renameSync(path.join(workspace, "src", "created.ts"), path.join(workspace, "src", "renamed.ts"));
  await invalidateRepositoryIndex(workspace, [{ path: "src/renamed.ts", previousPath: "src/created.ts", operation: "rename" }]);
  assert.equal(store.readShard(store.shardId("src/created.ts"))["src/created.ts"], undefined);
  assert.equal(store.readShard(store.shardId("src/renamed.ts"))["src/renamed.ts"]?.symbols[0]?.name, "created");
  fs.rmSync(path.join(workspace, "src", "renamed.ts"));
  await invalidateRepositoryIndex(workspace, [{ path: "src/renamed.ts", operation: "delete" }]);
  assert.equal(store.readShard(store.shardId("src/renamed.ts"))["src/renamed.ts"], undefined);

  const revision = getRepositoryIndexStatus(workspace).revision;
  fs.writeFileSync(path.join(workspace, other), "export const eventUpdated = 4;\n");
  const stat = fs.statSync(path.join(workspace, other));
  recordKnownFileMutation({ workspaceDir: workspace, path: other, source: "user", mtimeMs: stat.mtimeMs });
  for (let index = 0; index < 100 && getRepositoryIndexStatus(workspace).revision === revision; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(getRepositoryIndexStatus(workspace).revision > revision, true);
  assert.equal(store.readShard(store.shardId(other))[other]?.symbols[0]?.name, "eventUpdated");
});

test("ignored, protected, generated, binary, oversized, and symlink content never enters retrieval and ignore changes purge old records", async (t) => {
  const workspace = repository(t); const outside = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-index-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "policy")); fs.mkdirSync(path.join(workspace, ".history"));
  fs.writeFileSync(path.join(workspace, "policy", "safe.ts"), "export const policySafe = true;\n");
  fs.writeFileSync(path.join(workspace, "policy", "generated.ts"), "// @generated\nexport const policyGenerated = true;\n");
  fs.writeFileSync(path.join(workspace, "policy", "binary.ts"), Buffer.from([1, 0, 2]));
  fs.writeFileSync(path.join(workspace, "policy", "large.ts"), "x".repeat(1024 * 1024 + 1));
  fs.writeFileSync(path.join(workspace, ".history", "secret.ts"), "export const forbiddenHistory = true;\n");
  fs.writeFileSync(path.join(outside, "escape.ts"), "export const escapedSymbol = true;\n");
  fs.symlinkSync(path.join(outside, "escape.ts"), path.join(workspace, "policy", "escape.ts"));
  await rebuildRepositoryIndex(workspace);
  for (const symbol of ["policyGenerated", "forbiddenHistory", "escapedSymbol"]) {
    assert.equal((await retrieveRepositoryContext({ workspaceDir: workspace, query: symbol, pinnedPaths: [".history/secret.ts", "policy/generated.ts"] })).length, 0);
  }
  fs.writeFileSync(path.join(workspace, ".gitignore"), "policy/safe.ts\n");
  await invalidateRepositoryIndex(workspace, [{ path: ".gitignore", operation: "create" }]);
  assert.equal((await retrieveRepositoryContext({ workspaceDir: workspace, query: "policySafe", pinnedPaths: ["policy/safe.ts"] })).length, 0);
});

test("physical worktrees receive distinct partitions and dead owners cannot strand the index lock", async (t) => {
  const workspace = repository(t); fs.writeFileSync(path.join(workspace, "base.ts"), "export const baseValue = 1;\n"); git(workspace, ["add", "."]); git(workspace, ["commit", "-qm", "base"]);
  const worktree = path.join(path.dirname(workspace), `${path.basename(workspace)}-worktree`); t.after(() => { try { git(workspace, ["worktree", "remove", "--force", worktree]); } catch { /* cleanup */ } });
  git(workspace, ["worktree", "add", "-q", "-b", "index-worktree", worktree]);
  fs.writeFileSync(path.join(worktree, "base.ts"), "export const worktreeValue = 2;\n");
  await Promise.all([rebuildRepositoryIndex(workspace), rebuildRepositoryIndex(worktree)]);
  assert.notEqual(getRepositoryIndexStatus(workspace).partitionId, getRepositoryIndexStatus(worktree).partitionId);
  assert.equal((await retrieveRepositoryContext({ workspaceDir: workspace, query: "worktreeValue" })).length, 0);
  assert.equal((await retrieveRepositoryContext({ workspaceDir: worktree, query: "worktreeValue" })).some((entry) => entry.path === "base.ts"), true);

  const store = new RepositoryIndexStore(workspace); fs.mkdirSync(store.rootDir, { recursive: true });
  fs.writeFileSync(path.join(store.rootDir, ".lock"), JSON.stringify({ ownerToken: "dead", ownerPid: 99999999, createdAt: 1 }));
  assert.equal(store.withLock(() => "recovered"), "recovered");
});

test("incremental mutations re-resolve imports and repair reverse edges after directory rename", async (t) => {
  const workspace = repository(t); fs.mkdirSync(path.join(workspace, "src", "old"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "old", "target.ts"), "export const targetValue = 1;\n");
  fs.writeFileSync(path.join(workspace, "src", "consumer.ts"), "export const before = true;\n");
  await rebuildRepositoryIndex(workspace); const store = new RepositoryIndexStore(workspace);
  fs.writeFileSync(path.join(workspace, "src", "consumer.ts"), "import { targetValue } from './old/target';\nexport const used = targetValue;\n");
  await invalidateRepositoryIndex(workspace, [{ path: "src/consumer.ts", operation: "modify" }]);
  assert.equal(store.readShard(store.shardId("src/consumer.ts"))["src/consumer.ts"].imports[0].resolvedPath, "src/old/target.ts");
  fs.writeFileSync(path.join(workspace, "src", "future-consumer.ts"), "import { futureValue } from './future';\nexport const futureUsed = futureValue;\n");
  await invalidateRepositoryIndex(workspace, [{ path: "src/future-consumer.ts", operation: "create" }]);
  assert.equal(store.readShard(store.shardId("src/future-consumer.ts"))["src/future-consumer.ts"].imports[0].resolvedPath, undefined);
  fs.writeFileSync(path.join(workspace, "src", "future.ts"), "export const futureValue = 2;\n");
  await invalidateRepositoryIndex(workspace, [{ path: "src/future.ts", operation: "create" }]);
  assert.equal(store.readShard(store.shardId("src/future-consumer.ts"))["src/future-consumer.ts"].imports[0].resolvedPath, "src/future.ts");
  fs.renameSync(path.join(workspace, "src", "old"), path.join(workspace, "src", "renamed"));
  await invalidateRepositoryIndex(workspace, [{ path: "src/renamed", previousPath: "src/old", operation: "rename", scope: "prefix" }]);
  assert.equal(store.readShard(store.shardId("src/consumer.ts"))["src/consumer.ts"].imports[0].resolvedPath, undefined);
  assert.equal(store.readAllFiles().has("src/old/target.ts"), false); assert.equal(store.readAllFiles().has("src/renamed/target.ts"), true);
});
