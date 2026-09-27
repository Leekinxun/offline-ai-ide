import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  executeRepositoryInspectionTool,
  REPOSITORY_INSPECTION_TOOLS,
} from "./repositoryInspection.js";

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "crewforge-inspection-"));
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(path.join(workspace, "docs"), { recursive: true });
  await mkdir(path.join(workspace, "dist"), { recursive: true });
  await mkdir(path.join(workspace, ".git"), { recursive: true });
  await writeFile(path.join(workspace, "src", "app.ts"), "export const marker = 'Needle';\n");
  await writeFile(path.join(workspace, "src", "app.test.ts"), "Needle in test\n");
  await writeFile(path.join(workspace, "docs", "guide.md"), "Needle in docs\n");
  await writeFile(path.join(workspace, "dist", "bundle.js"), "Needle generated\n");
  await writeFile(path.join(workspace, ".env"), "password=supersecret123\n");
  await writeFile(path.join(workspace, "src", "secretNote.ts"), "const password = 'supersecret123';\nNeedle\n");
  await writeFile(path.join(workspace, ".git", "config"), "Needle hidden\n");
  const outside = await mkdtemp(path.join(os.tmpdir(), "crewforge-inspection-outside-"));
  await writeFile(path.join(outside, "outside.ts"), "Needle outside\n");
  await symlink(path.join(outside, "outside.ts"), path.join(workspace, "src", "outside-link.ts"));
  return workspace;
}

test("declares exactly the safe repository inspection tools", () => {
  assert.deepEqual(
    REPOSITORY_INSPECTION_TOOLS.map((tool) => tool.function.name),
    ["find_files", "search_files", "list_directory"]
  );
});

test("find_files applies glob, path policy, secret filtering, symlink exclusion, and limits", async (t) => {
  const workspace = await createWorkspace();
  t.after(() => rm(workspace, { recursive: true, force: true }));

  const output = await executeRepositoryInspectionTool(
    "find_files",
    { pattern: "src/**/*.ts", max_results: 10 },
    workspace
  );
  const parsed = JSON.parse(output) as { results: string[]; truncated: boolean };

  assert.deepEqual(parsed.results, ["src/app.test.ts", "src/app.ts"]);
  assert.equal(parsed.truncated, false);
  assert.doesNotMatch(output, /secretNote|outside-link|dist|\.git/);

  const limited = JSON.parse(await executeRepositoryInspectionTool(
    "find_files",
    { pattern: "**/*", max_results: 1 },
    workspace
  )) as { results: string[]; truncated: boolean };
  assert.equal(limited.results.length, 1);
  assert.equal(limited.truncated, true);
});

test("search_files filters ripgrep matches through read_file authorization", async (t) => {
  const workspace = await createWorkspace();
  t.after(() => rm(workspace, { recursive: true, force: true }));

  const output = await executeRepositoryInspectionTool(
    "search_files",
    { query: "Needle", path: ".", max_results: 20 },
    workspace
  );
  const parsed = JSON.parse(output) as { results: Array<{ path: string; preview: string }>; truncated: boolean };
  const resultPaths = parsed.results.map((result) => result.path);

  assert.deepEqual(resultPaths, ["docs/guide.md", "src/app.test.ts", "src/app.ts"]);
  assert.equal(parsed.truncated, false);
  assert.doesNotMatch(output, /secretNote|generated|hidden|outside/);

  const regex = JSON.parse(await executeRepositoryInspectionTool(
    "search_files",
    { query: "Needle in (docs|test)", regex: true, max_results: 5 },
    workspace
  )) as { results: Array<{ path: string }> };
  assert.deepEqual(regex.results.map((result) => result.path), ["docs/guide.md", "src/app.test.ts"]);
});

test("list_directory rejects traversal and hides protected, generated, secret, and symlink entries", async (t) => {
  const workspace = await createWorkspace();
  t.after(() => rm(workspace, { recursive: true, force: true }));

  const root = JSON.parse(await executeRepositoryInspectionTool(
    "list_directory",
    { path: ".", max_results: 20 },
    workspace
  )) as { entries: Array<{ path: string; type: string }> };
  assert.deepEqual(root.entries.map((entry) => entry.path), ["docs", "src"]);

  const src = JSON.parse(await executeRepositoryInspectionTool(
    "list_directory",
    { path: "src", max_results: 20 },
    workspace
  )) as { entries: Array<{ path: string; type: string }> };
  assert.deepEqual(src.entries.map((entry) => entry.path), ["src/app.test.ts", "src/app.ts"]);

  const traversal = await executeRepositoryInspectionTool(
    "list_directory",
    { path: "../" },
    workspace
  );
  assert.match(traversal, /^Error:/);
});
