import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import express from "express";
import { filesRouter } from "../routes/files.js";
import { getDesktopNativeIde, shutdownDesktopNativeIde } from "./nativeIdeClient.js";
import { readDesktopFileTree } from "./nativeIdeServices.js";

const executable = process.env.CROWNFORGE_TEST_NATIVE_IDE ?? fileURLToPath(new URL(`../../../desktop/rust/target/debug/crownforge-ide-core${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));

test("desktop tree switches roots and loads only the requested directory through native IPC", { skip: !fs.existsSync(executable), timeout: 30_000 }, async (t) => {
  const fixture = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "native-tree-switch-")));
  const a = path.join(fixture, "a"), b = path.join(fixture, "b");
  fs.mkdirSync(path.join(a, "sorting"), { recursive: true }); fs.writeFileSync(path.join(a, "sorting", "bubble_sort.py"), "old");
  fs.mkdirSync(path.join(b, "docs"), { recursive: true }); fs.writeFileSync(path.join(b, "docs", "new.md"), "new");
  fs.mkdirSync(path.join(b, "node_modules", "deep", "nested"), { recursive: true }); fs.writeFileSync(path.join(b, "node_modules", "deep", "nested", "package.js"), "dependency");
  fs.writeFileSync(path.join(b, ".hidden"), "hidden");
  const previous = [process.env.CREWFORGE_DESKTOP, process.env.CROWNFORGE_IDE_CORE_EXECUTABLE];
  process.env.CREWFORGE_DESKTOP = "1"; process.env.CROWNFORGE_IDE_CORE_EXECUTABLE = executable;
  let workspace = a;
  const app = express(); app.use((req, _res, next) => { (req as any).userSession = { workspaceDir: workspace }; next(); }); app.use(filesRouter);
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await shutdownDesktopNativeIde();
    for (const [i, name] of ["CREWFORGE_DESKTOP", "CROWNFORGE_IDE_CORE_EXECUTABLE"].entries()) { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }
    fs.rmSync(fixture, { recursive: true, force: true }); });
  const client = getDesktopNativeIde(), request = client.request;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  client.request = (async (method: string, params: Record<string, unknown>, options?: unknown) => { calls.push({ method, params }); return Reflect.apply(request, client, [method, params, options]); }) as typeof request;
  t.after(() => { client.request = request; });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const get = async (suffix = "") => { const response = await fetch(`http://127.0.0.1:${address.port}/tree${suffix}`); assert.equal(response.status, 200); return response.json() as Promise<Array<{ name: string; path: string; children?: unknown[]; childrenLoaded?: boolean }>>; };
  assert.deepEqual((await get()).map((node) => node.path), ["sorting"]);
  workspace = b;
  const root = await get(); assert.deepEqual(root.map((node) => node.path), ["docs", "node_modules"]);
  assert.ok(root.every((node) => node.childrenLoaded === false && node.children?.length === 0));
  assert.deepEqual((await get("?path=docs")).map((node) => node.path), ["docs/new.md"]);
  assert.deepEqual((await get("?path=node_modules")).map((node) => node.path), ["node_modules/deep"]);
  assert.deepEqual(calls.filter((call) => call.method === "fs.entries").map((call) => [call.params.workspaceDir, call.params.path]), [[a, ""], [b, ""], [b, "docs"], [b, "node_modules"]]);
  const pathsResponse = await fetch(`http://127.0.0.1:${address.port}/paths?query=new`);
  assert.equal(pathsResponse.status, 200); assert.deepEqual((await pathsResponse.json() as { paths: string[] }).paths, ["docs/new.md"]);
  const stale = await fetch(`http://127.0.0.1:${address.port}/tree?expectedWorkspaceDir=${encodeURIComponent(a)}`); assert.equal(stale.status, 409);
  const stalePaths = await fetch(`http://127.0.0.1:${address.port}/paths?query=new&expectedWorkspaceDir=${encodeURIComponent(a)}`); assert.equal(stalePaths.status, 409);
  await assert.rejects(readDesktopFileTree(b, "../a"));
});
