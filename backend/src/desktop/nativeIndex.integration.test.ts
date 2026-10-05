import { publishDesktopFileMutation } from "../files/mutationRegistry.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { shutdownDesktopNativeIde } from "./nativeIdeClient.js";
import { rebuildRepositoryIndex, retrieveRepositoryContext, findRepositoryDefinitionAsync } from "../indexing/repositoryIndex.js";
import { RepositoryIndexStore } from "../indexing/indexStore.js";
const executable = process.env.CROWNFORGE_TEST_NATIVE_IDE ?? fileURLToPath(new URL(`../../../desktop/rust/target/debug/crownforge-ide-core${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));

test("desktop index publishes through Rust and parses sources without blocking the main loop", { skip: !fs.existsSync(executable), timeout: 60_000 }, async (t) => {
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "native-index-complete-")));
  const previous = [process.env.CREWFORGE_DESKTOP, process.env.CROWNFORGE_IDE_CORE_EXECUTABLE];
  process.env.CREWFORGE_DESKTOP = "1"; process.env.CROWNFORGE_IDE_CORE_EXECUTABLE = executable;
  t.after(async () => { await shutdownDesktopNativeIde();
    for (const [index, name] of ["CREWFORGE_DESKTOP", "CROWNFORGE_IDE_CORE_EXECUTABLE"].entries()) { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; }
    fs.rmSync(workspace, { recursive: true, force: true }); });
  for (let i = 0; i < 120; i++) fs.writeFileSync(path.join(workspace, `module${i}.ts`), Array.from({ length: 100 }, (_, n) => `export function item${i}_${n}(v: number) { return v + ${n}; }`).join("\n"));
  const write = fs.writeFileSync, rename = fs.renameSync;
  fs.writeFileSync = ((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(target).includes("repository-index") && !String(target).endsWith(".lock")) throw new Error("Node must not publish native index bytes");
    return Reflect.apply(write, fs, [target, ...args]);
  }) as typeof write;
  fs.renameSync = ((source: fs.PathLike, target: fs.PathLike) => {
    if (String(target).includes("repository-index")) throw new Error("Node must not install native index bytes");
    return rename(source, target);
  }) as typeof rename;
  let ticks = 0; const timer = setInterval(() => ticks++, 5);
  try { const status = await rebuildRepositoryIndex(workspace); assert.equal(status.status, "ready"); assert.equal(status.fileCount, 120); }
  finally { clearInterval(timer); fs.writeFileSync = write; fs.renameSync = rename; }
  assert.ok(ticks >= 5, `Main loop only advanced ${ticks} times`);
  const definition = await findRepositoryDefinitionAsync(workspace, "item0_0"); assert.equal(definition?.path, "module0.ts");
  assert.equal(new RepositoryIndexStore(workspace).readAllFiles().size, 120);
  await publishDesktopFileMutation({ workspaceDir: workspace, path: "module0.ts", source: "assistant_tool", runId: "index-event", preimageContent: fs.readFileSync(path.join(workspace, "module0.ts"), "utf8"), postimageContent: "export const changed = 1;" });
  const store = new RepositoryIndexStore(workspace), deadline = Date.now() + 10_000;
  while (!store.readShard(store.shardId("module0.ts"))["module0.ts"]?.symbols.some((entry) => entry.name === "changed")) {
    assert.ok(Date.now() < deadline, "Mutation notification reused a released writer lease or failed to refresh the index");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(await findRepositoryDefinitionAsync(workspace, "item0_0"), null);
  fs.writeFileSync(path.join(workspace, ".ignore"), "module1.ts\n");
  const found = await retrieveRepositoryContext({ workspaceDir: workspace, query: "item1_0", pinnedPaths: ["module1.ts"] });
  assert.ok(found.every((entry) => entry.path !== "module1.ts"));
});
