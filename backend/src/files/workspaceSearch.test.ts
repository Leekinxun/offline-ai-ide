import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  searchWorkspace,
  WorkspaceSearchError,
} from "./workspaceSearch.js";

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "crewforge-search-"));
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(path.join(workspace, "docs"), { recursive: true });
  await mkdir(path.join(workspace, "ignored"), { recursive: true });
  await writeFile(
    path.join(workspace, "src", "app.ts"),
    "const SearchTarget = '搜索目标';\n// SearchTarget SearchTarget\n"
  );
  await writeFile(path.join(workspace, "docs", "guide.md"), "searchtarget\n");
  await writeFile(path.join(workspace, ".ignore"), "ignored/\n");
  await writeFile(path.join(workspace, "ignored", "secret.txt"), "SearchTarget\n");
  return workspace;
}

test("searches with bundled ripgrep and returns every match", async (t) => {
  const workspace = await createWorkspace();
  t.after(() => rm(workspace, { recursive: true, force: true }));

  const response = await searchWorkspace({
    workspaceDir: workspace,
    query: "SearchTarget",
    matchCase: true,
  });

  assert.equal(response.truncated, false);
  assert.deepEqual(
    response.results.map(({ path, line, column }) => ({ path, line, column })),
    [
      { path: "src/app.ts", line: 1, column: 7 },
      { path: "src/app.ts", line: 2, column: 4 },
      { path: "src/app.ts", line: 2, column: 17 },
    ]
  );
});

test("supports folder scope, globs, ignore files, and unicode columns", async (t) => {
  const workspace = await createWorkspace();
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(path.join(workspace, "src", "unicode.ts"), "前缀搜索目标后缀\n");

  const scoped = await searchWorkspace({
    workspaceDir: workspace,
    query: "搜索目标",
    scopePath: "src",
    include: "*.{ts,tsx}",
  });
  assert.deepEqual(
    scoped.results.map(({ path, column, matchLength }) => ({ path, column, matchLength })),
    [
      { path: "src/app.ts", column: 23, matchLength: 4 },
      { path: "src/unicode.ts", column: 3, matchLength: 4 },
    ]
  );

  const ignored = await searchWorkspace({
    workspaceDir: workspace,
    query: "SearchTarget",
    matchCase: true,
    scopePath: "ignored",
    useIgnoreFiles: false,
  });
  assert.equal(ignored.results[0]?.path, "ignored/secret.txt");
});

test("reports invalid regular expressions", async (t) => {
  const workspace = await createWorkspace();
  t.after(() => rm(workspace, { recursive: true, force: true }));

  await assert.rejects(
    searchWorkspace({ workspaceDir: workspace, query: "[", isRegex: true }),
    (error: unknown) =>
      error instanceof WorkspaceSearchError && error.code === "FAILED"
  );
});

test("stops after the configured result limit", async (t) => {
  const workspace = await createWorkspace();
  t.after(() => rm(workspace, { recursive: true, force: true }));

  const response = await searchWorkspace({
    workspaceDir: workspace,
    query: "SearchTarget",
    matchCase: true,
    useIgnoreFiles: false,
    maxResults: 2,
  });

  assert.equal(response.results.length, 2);
  assert.equal(response.truncated, true);
});

test("honors cancellation before the process starts", async (t) => {
  const workspace = await createWorkspace();
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    searchWorkspace({ workspaceDir: workspace, query: "target", signal: controller.signal }),
    (error: unknown) =>
      error instanceof WorkspaceSearchError && error.code === "ABORTED"
  );
});
