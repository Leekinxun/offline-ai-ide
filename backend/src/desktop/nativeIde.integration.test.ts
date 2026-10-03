import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NativeIdeClient, shutdownDesktopNativeIde } from "./nativeIdeClient.js";
import { launchDesktopPty, readDesktopFile, readDesktopFileTree, readDesktopGitStatus, watchDesktopWorkspace } from "./nativeIdeServices.js";

const executable = process.env.CROWNFORGE_TEST_NATIVE_IDE || fileURLToPath(new URL(`../../../desktop/rust/target/debug/crownforge-ide-core${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
const available = fs.existsSync(executable);

test("desktop Rust services preserve file, search, Git, PTY and watcher contracts", { skip: !available, timeout: 30_000 }, async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-native-integration-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-native-outside-"));
  const previousDesktop = process.env.CREWFORGE_DESKTOP;
  const previousCore = process.env.CROWNFORGE_IDE_CORE_EXECUTABLE;
  process.env.CREWFORGE_DESKTOP = "1";
  process.env.CROWNFORGE_IDE_CORE_EXECUTABLE = executable;
  const client = new NativeIdeClient(executable);
  t.after(async () => {
    await client.close(); await shutdownDesktopNativeIde();
    if (previousDesktop === undefined) delete process.env.CREWFORGE_DESKTOP; else process.env.CREWFORGE_DESKTOP = previousDesktop;
    if (previousCore === undefined) delete process.env.CROWNFORGE_IDE_CORE_EXECUTABLE; else process.env.CROWNFORGE_IDE_CORE_EXECUTABLE = previousCore;
    fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(workspace, "src"));
  fs.writeFileSync(path.join(workspace, "src", "中文.ts"), "前缀😀搜索目标\n");
  fs.writeFileSync(path.join(workspace, ".env"), "SECRET=搜索目标\n");
  fs.writeFileSync(path.join(outside, "private.txt"), "outside");
  if (process.platform !== "win32") fs.symlinkSync(outside, path.join(workspace, "escape"));
  const tree = await readDesktopFileTree(workspace);
  assert.deepEqual(tree.map((entry) => entry.name), ["src"]);
  assert.equal((await readDesktopFile(workspace, "src/中文.ts")).content, "前缀😀搜索目标\n");
  assert.ok((await readDesktopFile(workspace, "src/中文.ts")).mtimeMs > 0);
  await assert.rejects(client.request("fs.read", { workspaceDir: workspace, path: "../private.txt" }));
  if (process.platform !== "win32") await assert.rejects(client.request("fs.read", { workspaceDir: workspace, path: "escape/private.txt" }));
  const result = await client.request<{ results: Array<{ path: string; column: number; matchLength: number }> }>("search", { workspaceDir: workspace, query: "搜索目标", useIgnoreFiles: false });
  assert.deepEqual(result.results.map(({ path, column, matchLength }) => ({ path, column, matchLength })), [{ path: "src/中文.ts", column: 5, matchLength: 4 }]);
  execFileSync("git", ["init", "--quiet"], { cwd: workspace });
  const status = await readDesktopGitStatus(workspace);
  assert.equal(status.isRepo, true); assert.ok(status.entries.some((entry) => entry.path === "src/中文.ts"));
  await assert.rejects(client.request("git.exec", { workspaceDir: workspace, args: ["reset", "--hard"] }));

  let resolveChange!: () => void;
  const changed = new Promise<void>((resolve) => { resolveChange = resolve; });
  const stopWatch = await watchDesktopWorkspace(workspace, resolveChange);
  t.after(stopWatch);
  fs.writeFileSync(path.join(workspace, "src", "changed.ts"), "const changed = true;\n");
  await Promise.race([changed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Native watcher did not observe the file")), 5000))]);

  if (process.platform !== "win32") {
    const terminal = launchDesktopPty(workspace, { executable: "/bin/sh", args: ["-i"] }, { PATH: "/usr/bin:/bin", TERM: "xterm-256color" });
    t.after(() => terminal.terminate());
    let output = "";
    let resolveOutput!: () => void;
    const received = new Promise<void>((resolve) => { resolveOutput = resolve; });
    terminal.onData((value) => { output += value; if (output.includes("NATIVE_OK_中文")) resolveOutput(); });
    const exited = new Promise<number | null>((resolve) => terminal.onExit(resolve));
    terminal.write("printf 'NATIVE_OK_中文\\n'; exit 7\n");
    await Promise.race([received, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Native PTY produced no output")), 5000))]);
    assert.equal(await exited, 7);
  }
});
