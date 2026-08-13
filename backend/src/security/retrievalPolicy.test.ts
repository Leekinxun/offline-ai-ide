import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  evaluateContextPath,
  readAuthorizedWorkspaceFile,
} from "../agent/contextPolicy.js";
import { createRetrievalReferenceFixture } from "../indexing/fixtures/referenceFixture.js";
import { RepositoryIndexStore, repositoryPartitionId } from "../indexing/indexStore.js";
import {
  invalidateRepositoryIndex,
  rebuildRepositoryIndex,
  retrieveRepositoryContext,
} from "../indexing/repositoryIndex.js";
import { getContextIndexAdapter } from "../agent/contextManifestIndex.js";

async function fixtureFor(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "crewforge-retrieval-security-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return createRetrievalReferenceFixture(root);
}

test("retrieval policy denies protected, secret, generated, and symlink content", async (t) => {
  const fixture = await fixtureFor(t);
  const denied = [
    ".git/config",
    ".history/protected-decoy.ts",
    ".checkpoints/protected-decoy.ts",
    ".team/state.json",
    ".tasks/tasks.json",
    ".transcripts/private.jsonl",
    ".codex/instructions.md",
    ".omx/state.json",
    ".crewforge/index.json",
    ".env.local",
    "credentials.json",
    "dist/bundle.ts",
  ];
  for (const candidate of denied) {
    assert.equal(evaluateContextPath(candidate).allowed, false, candidate);
  }
  assert.throws(() => readAuthorizedWorkspaceFile(fixture.main, "src/generated/client.ts"), /generated/i);
  assert.throws(() => readAuthorizedWorkspaceFile(fixture.main, "src/symlinkLeak.ts"), /symlink/i);
  assert.equal(readAuthorizedWorkspaceFile(fixture.main, ".github/CODEOWNERS").path, ".github/CODEOWNERS");
});

test("cold index contains no ignored, protected, generated, or symlink records", async (t) => {
  const fixture = await fixtureFor(t);
  fs.mkdirSync(path.join(fixture.main, ".team"), { recursive: true });
  fs.writeFileSync(path.join(fixture.main, ".team", "private.ts"), "export const TEAM_PRIVATE = true;\n");
  fs.mkdirSync(path.join(fixture.main, ".tasks"), { recursive: true });
  fs.writeFileSync(path.join(fixture.main, ".tasks", "private.ts"), "export const TASK_PRIVATE = true;\n");
  const status = await rebuildRepositoryIndex(fixture.main);
  assert.equal(status.status, "ready");
  const paths = new Set(new RepositoryIndexStore(fixture.main).readAllFiles().keys());
  for (const forbidden of [
    "ignored/bug-decoy.ts",
    "ignored-by-ignore/decoy.ts",
    "ignored-by-rgignore/decoy.ts",
    ".history/protected-decoy.ts",
    ".checkpoints/protected-decoy.ts",
    ".transcripts/private.jsonl",
    ".team/private.ts",
    ".tasks/private.ts",
    "src/generated/client.ts",
    "dist/bundle.ts",
    "src/symlinkLeak.ts",
  ]) assert.equal(paths.has(forbidden), false, forbidden);
});

test("main and managed worktrees have independent partitions and live content", async (t) => {
  const fixture = await fixtureFor(t);
  assert.equal(new Set([
    repositoryPartitionId(fixture.main),
    repositoryPartitionId(fixture.worktreeA),
    repositoryPartitionId(fixture.worktreeB),
  ]).size, 3);
  await Promise.all([
    rebuildRepositoryIndex(fixture.main),
    rebuildRepositoryIndex(fixture.worktreeA),
    rebuildRepositoryIndex(fixture.worktreeB),
  ]);
  const [main, worktreeA, worktreeB] = await Promise.all([
    retrieveRepositoryContext({ workspaceDir: fixture.main, query: "WORKTREE_VARIANT", maxResults: 10, maxTokens: 10_000 }),
    retrieveRepositoryContext({ workspaceDir: fixture.worktreeA, query: "WORKTREE_VARIANT", maxResults: 10, maxTokens: 10_000 }),
    retrieveRepositoryContext({ workspaceDir: fixture.worktreeB, query: "WORKTREE_VARIANT", maxResults: 10, maxTokens: 10_000 }),
  ]);
  const contentFor = (entries: typeof main) => entries.find((entry) => entry.path === "src/worktree/variant.ts")?.content || "";
  assert.match(contentFor(main), /main-reference/);
  assert.match(contentFor(worktreeA), /worktree-a-reference/);
  assert.match(contentFor(worktreeB), /worktree-b-reference/);
});

test("ignore policy changes purge stale indexed content", async (t) => {
  const fixture = await fixtureFor(t);
  await rebuildRepositoryIndex(fixture.main);
  const store = new RepositoryIndexStore(fixture.main);
  assert.equal(store.readAllFiles().has("policy/newly-ignored.ts"), true);
  fixture.applyIgnorePolicyChange();
  await invalidateRepositoryIndex(fixture.main, [{ path: ".gitignore", operation: "modify" }]);
  assert.equal(store.readAllFiles().has("policy/newly-ignored.ts"), false);
  const results = await retrieveRepositoryContext({
    workspaceDir: fixture.main,
    query: "POLICY_CHANGE_SECRET",
    maxResults: 20,
    maxTokens: 20_000,
  });
  assert.equal(results.some((entry) => entry.path === "policy/newly-ignored.ts"), false);
});

test("live retrieval synchronously rejects newly ignored and content-secret files without explicit invalidation", async (t) => {
  const fixture = await fixtureFor(t);
  const ignoredPath = "policy/live-ignore.ts"; const secretPath = "src/live-secret.ts";
  fs.writeFileSync(path.join(fixture.main, ignoredPath), "export const LIVE_IGNORE_CANARY = true;\n");
  fs.writeFileSync(path.join(fixture.main, secretPath), "export const LIVE_SECRET_CANARY = true;\n");
  await rebuildRepositoryIndex(fixture.main);
  assert.equal((await retrieveRepositoryContext({ workspaceDir: fixture.main, query: "LIVE_IGNORE_CANARY", pinnedPaths: [ignoredPath] })).some((entry) => entry.path === ignoredPath), true);
  fs.appendFileSync(path.join(fixture.main, ".gitignore"), `\n${ignoredPath}\n`);
  const ignored = await retrieveRepositoryContext({ workspaceDir: fixture.main, query: "LIVE_IGNORE_CANARY", pinnedPaths: [ignoredPath] });
  assert.equal(ignored.some((entry) => entry.path === ignoredPath), false);
  assert.equal(new RepositoryIndexStore(fixture.main).readAllFiles().has(ignoredPath), false, "ignore fingerprint change must synchronously purge stale records");

  fs.writeFileSync(path.join(fixture.main, secretPath), "export const LIVE_SECRET_CANARY = \"sk-live_LEAKCANARY_123456789\";\n");
  const secret = await retrieveRepositoryContext({ workspaceDir: fixture.main, query: "LIVE_SECRET_CANARY", pinnedPaths: [secretPath] });
  assert.equal(secret.some((entry) => entry.path === secretPath), false);
  assert.equal(JSON.stringify(secret).includes("LEAKCANARY"), false);
  const adapterResult = await getContextIndexAdapter().retrieve(fixture.main, {
    query: "LIVE_SECRET_CANARY", maxResults: 10, maxTokens: 10_000,
    preferences: { schemaVersion: 1, conversationId: "security", version: 1, pins: [{ id: "secret-pin", path: secretPath, createdAt: 1 }], excludes: [], updatedAt: 1 },
    viewer: { username: "security-viewer", isAdmin: false }, scope: { kind: "workspace", scopeId: "security" },
  });
  assert.equal(adapterResult.some((entry) => entry.path === secretPath && entry.decision === "included"), false);
  assert.equal(adapterResult.some((entry) => entry.path === secretPath && entry.decision === "excluded" && entry.pinned), true);
  assert.equal(JSON.stringify(adapterResult).includes("LEAKCANARY"), false);
});

test("Git exclude policy discovery degrades safely for non-Git and bare workspaces", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crewforge-git-policy-fallback-")); t.after(() => rm(root, { recursive: true, force: true }));
  const plain = path.join(root, "plain"); fs.mkdirSync(plain); fs.writeFileSync(path.join(plain, "plain.ts"), "export const plainFallback = true;\n");
  assert.equal((await rebuildRepositoryIndex(plain)).status, "ready");
  assert.equal((await retrieveRepositoryContext({ workspaceDir: plain, query: "plainFallback" })).some((entry) => entry.path === "plain.ts"), true);
  const bare = path.join(root, "bare.git"); execFileSync("git", ["init", "--bare", "-q", bare]); fs.writeFileSync(path.join(bare, "bare-source.ts"), "export const bareFallback = true;\n");
  assert.equal((await rebuildRepositoryIndex(bare)).status, "ready");
});

test("semantic off performs no network and local pollution or failure cannot bypass policy", async (t) => {
  const fixture = await fixtureFor(t);
  await rebuildRepositoryIndex(fixture.main);
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error("network forbidden in retrieval test");
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const baseline = await retrieveRepositoryContext({
    workspaceDir: fixture.main,
    query: "applyDiscount",
    maxResults: 50,
    maxTokens: 50_000,
    semantic: { mode: "off" },
  });
  assert.equal(networkCalls, 0);

  const polluted = await retrieveRepositoryContext({
    workspaceDir: fixture.main,
    query: "applyDiscount",
    maxResults: 50,
    maxTokens: 50_000,
    semantic: {
      mode: "local",
      rerank: async (_query, candidates) => {
        assert.equal(candidates.some((candidate) => candidate.content !== undefined), false);
        return [
          "path:.history/protected-decoy.ts",
          "path:src/symlinkLeak.ts",
          ...candidates.map((candidate) => candidate.sourceKey).reverse(),
        ];
      },
    },
  });
  assert.equal(polluted.some((entry) => entry.path?.startsWith(".history/") || entry.path === "src/symlinkLeak.ts"), false);

  const fallback = await retrieveRepositoryContext({
    workspaceDir: fixture.main,
    query: "applyDiscount",
    maxResults: 50,
    maxTokens: 50_000,
    semantic: { mode: "local", rerank: async () => { throw new Error("local semantic unavailable"); } },
  });
  assert.deepEqual(fallback.map((entry) => entry.sourceKey), baseline.map((entry) => entry.sourceKey));
  assert.equal(networkCalls, 0);
});

test("single-file invalidation changes one indexed record and leaves unrelated partitions intact", async (t) => {
  const fixture = await fixtureFor(t);
  await rebuildRepositoryIndex(fixture.main);
  const store = new RepositoryIndexStore(fixture.main);
  const before = store.readAllFiles();
  const targetPath = "src/payments/money.ts";
  fs.appendFileSync(path.join(fixture.main, targetPath), "export const invalidationProbe = true;\n", "utf8");
  await invalidateRepositoryIndex(fixture.main, [{ path: targetPath, operation: "modify" }]);
  const after = store.readAllFiles();
  const changed = [...after].filter(([filePath, file]) => {
    const previous = before.get(filePath);
    return !previous || previous.contentHash !== file.contentHash || previous.indexedAt !== file.indexedAt;
  }).map(([filePath]) => filePath);
  assert.deepEqual(changed, [targetPath]);
  for (const [filePath, previous] of before) {
    if (filePath === targetPath) continue;
    const current = after.get(filePath);
    assert.ok(current, filePath);
    assert.equal(current.contentHash, previous.contentHash, filePath);
    assert.equal(current.indexedAt, previous.indexedAt, filePath);
  }
});
