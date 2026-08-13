import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import express from "express";
import { filesRouter } from "../routes/files.js";
import { RepositoryIndexStore } from "../indexing/indexStore.js";
import { getRepositoryIndexStatus, rebuildRepositoryIndex } from "../indexing/repositoryIndex.js";
import { subscribeWorkspaceMutations } from "./mutationRegistry.js";

function git(directory: string, args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function repository(t: TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-file-routes-index-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  git(directory, ["init", "-q"]); git(directory, ["config", "user.email", "routes@test.local"]); git(directory, ["config", "user.name", "Routes Test"]);
  fs.writeFileSync(path.join(directory, ".gitignore"), ".history/\n");
  return directory;
}

async function serve(workspaceDir: string) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).userSession = { workspaceDir, username: `route-${path.basename(workspaceDir)}`, token: `route-${crypto.randomUUID()}`, isolated: false }; next(); });
  app.use(filesRouter);
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address === "object");
  return { base: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

async function mutate(base: string, route: string, method: "POST" | "DELETE", body?: unknown): Promise<Response> {
  return fetch(`${base}${route}`, { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
}

async function waitForRevision(workspaceDir: string, revision: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (getRepositoryIndexStatus(workspaceDir).revision > revision) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`repository index revision did not advance from ${revision}`);
}

function indexed(store: RepositoryIndexStore, filePath: string) {
  return store.readShard(store.shardId(filePath))[filePath];
}

test("direct create, delete, rename, copy, and move routes incrementally update file and directory prefixes", async (t) => {
  const workspace = repository(t);
  fs.mkdirSync(path.join(workspace, "src", "nested"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "copy-target")); fs.mkdirSync(path.join(workspace, "move-target"));
  fs.writeFileSync(path.join(workspace, "src", "one.ts"), "export const one = 1;\n");
  fs.writeFileSync(path.join(workspace, "src", "nested", "two.ts"), "export const two = 2;\n");
  fs.writeFileSync(path.join(workspace, "untouched.ts"), "export const untouched = true;\n");
  git(workspace, ["add", "."]); git(workspace, ["commit", "-qm", "fixture"]);
  await rebuildRepositoryIndex(workspace);
  const store = new RepositoryIndexStore(workspace); const untouchedAt = indexed(store, "untouched.ts")!.indexedAt; const sourceOneAt = indexed(store, "src/one.ts")!.indexedAt;
  const server = await serve(workspace); t.after(server.close);

  let revision = getRepositoryIndexStatus(workspace).revision;
  assert.equal((await mutate(server.base, "/create", "POST", { path: "created.ts", is_directory: false })).status, 200);
  await waitForRevision(workspace, revision); assert(indexed(store, "created.ts"));

  revision = getRepositoryIndexStatus(workspace).revision;
  assert.equal((await mutate(server.base, "/rename", "POST", { old_path: "created.ts", new_path: "renamed.ts" })).status, 200);
  await waitForRevision(workspace, revision); assert.equal(indexed(store, "created.ts"), undefined); assert(indexed(store, "renamed.ts"));

  revision = getRepositoryIndexStatus(workspace).revision;
  assert.equal((await mutate(server.base, "/copy", "POST", { source_path: "renamed.ts", target_directory: "copy-target" })).status, 200);
  await waitForRevision(workspace, revision); assert(indexed(store, "copy-target/renamed.ts"));

  revision = getRepositoryIndexStatus(workspace).revision;
  assert.equal((await mutate(server.base, "/move", "POST", { source_path: "copy-target/renamed.ts", target_directory: "move-target" })).status, 200);
  await waitForRevision(workspace, revision); assert.equal(indexed(store, "copy-target/renamed.ts"), undefined); assert(indexed(store, "move-target/renamed.ts"));

  revision = getRepositoryIndexStatus(workspace).revision;
  assert.equal((await mutate(server.base, "/delete?path=move-target%2Frenamed.ts", "DELETE")).status, 200);
  await waitForRevision(workspace, revision); assert.equal(indexed(store, "move-target/renamed.ts"), undefined);

  revision = getRepositoryIndexStatus(workspace).revision;
  assert.equal((await mutate(server.base, "/copy", "POST", { source_path: "src", target_directory: "copy-target" })).status, 200);
  await waitForRevision(workspace, revision);
  assert(indexed(store, "copy-target/src/one.ts")); assert(indexed(store, "copy-target/src/nested/two.ts"));
  assert.equal(indexed(store, "src/one.ts")!.indexedAt, sourceOneAt, "directory copy must scan only the destination prefix");

  revision = getRepositoryIndexStatus(workspace).revision;
  assert.equal((await mutate(server.base, "/rename", "POST", { old_path: "copy-target/src", new_path: "copied-src" })).status, 200);
  await waitForRevision(workspace, revision);
  assert.equal(indexed(store, "copy-target/src/one.ts"), undefined); assert(indexed(store, "copied-src/one.ts")); assert(indexed(store, "copied-src/nested/two.ts"));

  revision = getRepositoryIndexStatus(workspace).revision;
  assert.equal((await mutate(server.base, "/move", "POST", { source_path: "copied-src", target_directory: "move-target" })).status, 200);
  await waitForRevision(workspace, revision);
  assert.equal(indexed(store, "copied-src/one.ts"), undefined); assert(indexed(store, "move-target/copied-src/one.ts")); assert(indexed(store, "move-target/copied-src/nested/two.ts"));

  revision = getRepositoryIndexStatus(workspace).revision;
  assert.equal((await mutate(server.base, "/delete?path=move-target%2Fcopied-src", "DELETE")).status, 200);
  await waitForRevision(workspace, revision);
  assert.equal(indexed(store, "move-target/copied-src/one.ts"), undefined); assert.equal(indexed(store, "move-target/copied-src/nested/two.ts"), undefined);
  assert.equal(indexed(store, "untouched.ts")!.indexedAt, untouchedAt, "prefix invalidations must not rescan unrelated files");
});

test("failed direct mutations emit no successful invalidation", async (t) => {
  const workspace = repository(t); fs.mkdirSync(path.join(workspace, "target"));
  fs.writeFileSync(path.join(workspace, "base.ts"), "export const base = true;\n"); fs.writeFileSync(path.join(workspace, "target", "base.ts"), "conflict\n");
  git(workspace, ["add", "."]); git(workspace, ["commit", "-qm", "fixture"]); await rebuildRepositoryIndex(workspace);
  const revision = getRepositoryIndexStatus(workspace).revision; const events: string[] = [];
  const unsubscribe = subscribeWorkspaceMutations((event) => { if (event.workspaceDir === path.resolve(workspace)) events.push(`${event.operation}:${event.path}`); }); t.after(unsubscribe);
  const server = await serve(workspace); t.after(server.close);
  assert.equal((await mutate(server.base, "/create", "POST", { path: "base.ts", is_directory: false })).status, 409);
  assert.equal((await mutate(server.base, "/delete?path=missing.ts", "DELETE")).status, 404);
  assert.equal((await mutate(server.base, "/rename", "POST", { old_path: "missing.ts", new_path: "other.ts" })).status, 404);
  assert.equal((await mutate(server.base, "/copy", "POST", { source_path: "base.ts", target_directory: "target" })).status, 409);
  assert.equal((await mutate(server.base, "/move", "POST", { source_path: "base.ts", target_directory: "target" })).status, 409);
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.deepEqual(events, []); assert.equal(getRepositoryIndexStatus(workspace).revision, revision);
});

test("route invalidation remains partitioned by physical worktree", async (t) => {
  const workspace = repository(t); fs.writeFileSync(path.join(workspace, "base.ts"), "export const mainBase = true;\n");
  git(workspace, ["add", "."]); git(workspace, ["commit", "-qm", "base"]);
  const worktree = path.join(path.dirname(workspace), `${path.basename(workspace)}-route-worktree`);
  t.after(() => { try { git(workspace, ["worktree", "remove", "--force", worktree]); } catch { /* cleanup */ } });
  git(workspace, ["worktree", "add", "-q", "-b", `route-${Date.now()}`, worktree]);
  await Promise.all([rebuildRepositoryIndex(workspace), rebuildRepositoryIndex(worktree)]);
  const worktreeRevision = getRepositoryIndexStatus(worktree).revision; const server = await serve(workspace); t.after(server.close);
  const mainRevision = getRepositoryIndexStatus(workspace).revision;
  assert.equal((await mutate(server.base, "/create", "POST", { path: "main-only.ts", is_directory: false })).status, 200);
  await waitForRevision(workspace, mainRevision); await new Promise((resolve) => setTimeout(resolve, 50));
  assert(indexed(new RepositoryIndexStore(workspace), "main-only.ts"));
  assert.equal(indexed(new RepositoryIndexStore(worktree), "main-only.ts"), undefined);
  assert.equal(getRepositoryIndexStatus(worktree).revision, worktreeRevision);
});
