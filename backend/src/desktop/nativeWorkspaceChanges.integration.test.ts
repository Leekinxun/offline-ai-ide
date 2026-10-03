import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import express from "express";
import { filesRouter } from "../routes/files.js";
import { shutdownDesktopNativeIde } from "./nativeIdeClient.js";

const executable = process.env.CROWNFORGE_TEST_NATIVE_IDE || fileURLToPath(new URL(`../../../desktop/rust/target/debug/crownforge-ide-core${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));

test("desktop /changes uses real Rust versions and Web retains its filesystem contract", { skip: !fs.existsSync(executable), timeout: 30_000 }, async (t) => {
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-changes-http-")));
  fs.mkdirSync(path.join(workspace, "目录"));
  const target = path.join(workspace, "目录", "文件.txt"); fs.writeFileSync(target, "before\n");
  const originalDesktop = process.env.CREWFORGE_DESKTOP, originalCore = process.env.CROWNFORGE_IDE_CORE_EXECUTABLE;
  process.env.CREWFORGE_DESKTOP = "1"; process.env.CROWNFORGE_IDE_CORE_EXECUTABLE = executable;
  let scans = 0;
  const originalReadDirectory = fs.readdirSync;
  fs.readdirSync = ((directory: fs.PathLike, ...args: unknown[]) => {
    if (typeof directory === "string" && (directory === workspace || directory.startsWith(`${workspace}${path.sep}`))) scans++;
    return (originalReadDirectory as any)(directory, ...args);
  }) as typeof fs.readdirSync;
  t.after(() => {
    fs.readdirSync = originalReadDirectory; shutdownDesktopNativeIde();
    if (originalDesktop === undefined) delete process.env.CREWFORGE_DESKTOP; else process.env.CREWFORGE_DESKTOP = originalDesktop;
    if (originalCore === undefined) delete process.env.CROWNFORGE_IDE_CORE_EXECUTABLE; else process.env.CROWNFORGE_IDE_CORE_EXECUTABLE = originalCore;
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  const app = express();
  app.use((req, _res, next) => { (req as any).userSession = { workspaceDir: workspace, username: "changes-fixture", token: crypto.randomUUID(), isolated: false }; next(); });
  app.use(filesRouter);
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const query = async (since: number) => {
    const response = await fetch(`${base}/changes?since=${since}`); assert.equal(response.status, 200);
    return response.json() as Promise<{ changed: boolean; latestMtime: number }>;
  };
  const first = await query(0); assert.equal(first.changed, true);
  let cursor = first.latestMtime;
  const untilChanged = async () => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const result = await query(cursor);
      if (result.changed) { assert.ok(result.latestMtime > cursor); cursor = result.latestMtime; return; }
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.fail("Rust did not observe a visible workspace change");
  };
  // Same-mtime saves were invisible to the old timestamp traversal.
  const oldStat = fs.statSync(target);
  fs.writeFileSync(target, "after!\n"); fs.utimesSync(target, oldStat.atime, oldStat.mtime);
  await untilChanged();
  fs.renameSync(path.join(workspace, "目录"), path.join(workspace, "改名目录")); await untilChanged();
  fs.rmSync(path.join(workspace, "改名目录", "文件.txt")); await untilChanged();
  await new Promise(resolve => setTimeout(resolve, 200));
  const settled = await query(cursor); cursor = settled.latestMtime;
  assert.equal((await query(cursor)).changed, false);
  assert.equal(scans, 0, "Desktop /changes must never recursively traverse the workspace in Node");

  shutdownDesktopNativeIde();
  process.env.CROWNFORGE_IDE_CORE_EXECUTABLE = path.join(workspace, "missing-core");
  assert.equal((await fetch(`${base}/changes?since=${cursor}`)).status, 503);
  assert.equal(scans, 0, "A disconnected native runtime must not silently fall back to Node scans");
  process.env.CROWNFORGE_IDE_CORE_EXECUTABLE = executable;
  const restarted = await query(cursor); assert.equal(restarted.changed, true); assert.ok(restarted.latestMtime > cursor);
  assert.equal((await fetch(`${base}/changes?since=-1`)).status, 400);

  process.env.CREWFORGE_DESKTOP = "0";
  const since = Date.now() + 10_000;
  const web = await query(since);
  assert.deepEqual(web, { changed: false, latestMtime: since });
  assert.ok(scans > 0, "The existing Web traversal branch must remain active even when a core path is present");
});
