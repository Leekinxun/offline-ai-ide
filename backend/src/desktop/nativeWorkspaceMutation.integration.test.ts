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
import { buildFileVersion } from "../files/mutationRegistry.js";
import { shutdownDesktopNativeIde } from "./nativeIdeClient.js";

const executable = process.env.CROWNFORGE_TEST_NATIVE_IDE || fileURLToPath(new URL(`../../../desktop/rust/target/debug/crownforge-ide-core${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));

test("desktop /write publishes through Rust mutation receipts and preserves user attribution", { skip: !fs.existsSync(executable), timeout: 30_000 }, async (t) => {
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-native-write-")));
  const target = path.join(workspace, "note.txt");
  fs.writeFileSync(target, "before");
  const originalDesktop = process.env.CREWFORGE_DESKTOP;
  const originalCore = process.env.CROWNFORGE_IDE_CORE_EXECUTABLE;
  process.env.CREWFORGE_DESKTOP = "1";
  process.env.CROWNFORGE_IDE_CORE_EXECUTABLE = executable;

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    (req as any).userSession = { workspaceDir: workspace, username: "native-user", token: crypto.randomUUID(), isolated: false };
    next();
  });
  app.use(filesRouter);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await shutdownDesktopNativeIde();
    if (originalDesktop === undefined) delete process.env.CREWFORGE_DESKTOP; else process.env.CREWFORGE_DESKTOP = originalDesktop;
    if (originalCore === undefined) delete process.env.CROWNFORGE_IDE_CORE_EXECUTABLE; else process.env.CROWNFORGE_IDE_CORE_EXECUTABLE = originalCore;
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(file) === target) throw new Error("Node write path should not publish desktop saves");
    return Reflect.apply(originalWriteFileSync, fs, [file, ...args]);
  }) as typeof fs.writeFileSync;
  try {
    const response = await fetch(`${base}/write`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "note.txt", content: "after", expectedVersion: buildFileVersion("before") }),
    });
    const payload = await response.json() as { version?: string; updatedAt?: number; detail?: string };
    assert.equal(response.status, 200, payload.detail);
    assert.equal(payload.version, buildFileVersion("after"));
    assert.ok(payload.updatedAt && payload.updatedAt > 0);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  assert.equal(fs.readFileSync(target, "utf8"), "after");
  const read = await fetch(`${base}/read?path=note.txt`);
  assert.equal(read.status, 200);
  const body = await read.json() as { content: string; source?: string; actor?: string };
  assert.equal(body.content, "after");
  assert.equal(body.source, "user");
  assert.equal(body.actor, "native-user");
});
