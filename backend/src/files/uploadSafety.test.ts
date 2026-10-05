import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import express from "express";
import { filesRouter } from "../routes/files.js";

interface MutableSession {
  token: string;
  username: string;
  workspaceDir: string;
  workspaceRoot: string;
  isAdmin: boolean;
  isolated: boolean;
}

async function serveUploadRoute(
  session: MutableSession
): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).userSession = session;
    next();
  });
  app.use(filesRouter);

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
}

function workspace(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-upload-safety-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function sessionFor(workspaceDir: string): MutableSession {
  return {
    token: `upload-${crypto.randomUUID()}`,
    username: "upload-test",
    workspaceDir,
    workspaceRoot: workspaceDir,
    isAdmin: true,
    isolated: false,
  };
}

function writeJournal(workspaceDir: string, journal: unknown): string {
  const journalPath = path.join(workspaceDir, ".checkpoints", "mutations.json");
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  return journalPath;
}

async function upload(
  base: string,
  input: {
    targetPath?: string;
    overwrite?: boolean;
    entries: Array<{ path: string; content: string; name?: string }>;
  }
): Promise<Response> {
  const form = new FormData();
  if (input.targetPath !== undefined) form.append("targetPath", input.targetPath);
  if (input.overwrite) form.append("overwrite", "true");
  for (const entry of input.entries) {
    form.append("paths", entry.path);
    form.append("files", new Blob([entry.content], { type: "text/plain" }), entry.name || path.basename(entry.path));
  }
  return fetch(`${base}/upload`, { method: "POST", body: form });
}

test("upload accepts a legacy cache skipped journal before writing files", async (t) => {
  const root = workspace(t);
  const journalPath = writeJournal(root, {
    schemaVersion: 1,
    records: [],
    skipped: [
      {
        workspaceDir: path.resolve(root),
        path: "src/__pycache__/storage.cpython-314.pyc",
        runId: "run",
        toolCallId: "tool",
        reason: "binary",
        recordedAt: Date.now(),
      },
    ],
  });
  const beforeJournal = fs.readFileSync(journalPath, "utf8");
  const server = await serveUploadRoute(sessionFor(root));
  t.after(server.close);

  const response = await upload(server.base, {
    targetPath: "uploads",
    entries: [
      { path: "one.txt", content: "one" },
      { path: "two.txt", content: "two" },
    ],
  });

  assert.equal(response.status, 200);
  assert.equal(fs.readFileSync(path.join(root, "uploads", "one.txt"), "utf8"), "one");
  assert.equal(fs.readFileSync(path.join(root, "uploads", "two.txt"), "utf8"), "two");
  assert.equal(fs.readFileSync(journalPath, "utf8"), beforeJournal);
});

test("upload rejects an invalid journal before overwrite writes", async (t) => {
  const root = workspace(t);
  writeJournal(root, { schemaVersion: 1, records: [], skipped: [{ path: "../bad" }] });
  const existing = path.join(root, "uploads", "same.txt");
  fs.mkdirSync(path.dirname(existing), { recursive: true });
  fs.writeFileSync(existing, "old");
  const server = await serveUploadRoute(sessionFor(root));
  t.after(server.close);

  const response = await upload(server.base, {
    targetPath: "uploads",
    overwrite: true,
    entries: [{ path: "same.txt", content: "new" }],
  });
  const body = (await response.json()) as { code?: string };

  assert.equal(response.status, 422);
  assert.equal(body.code, "mutation_journal_evidence_invalid");
  assert.equal(fs.readFileSync(existing, "utf8"), "old");
});

test("upload preflights every path in the batch before writing", async (t) => {
  const root = workspace(t);
  const server = await serveUploadRoute(sessionFor(root));
  t.after(server.close);

  const response = await upload(server.base, {
    targetPath: "uploads",
    entries: [
      { path: "ok.txt", content: "ok" },
      { path: "../late-invalid.txt", content: "bad" },
    ],
  });
  const body = (await response.json()) as { code?: string };

  assert.equal(response.status, 400);
  assert.equal(body.code, "UPLOAD_INVALID_PATH");
  assert.equal(fs.existsSync(path.join(root, "uploads", "ok.txt")), false);
});

test("upload rejects raw absolute paths before normalizing separators", async (t) => {
  const root = workspace(t);
  const server = await serveUploadRoute(sessionFor(root));
  t.after(server.close);

  const response = await upload(server.base, {
    entries: [{ path: "/absolute.txt", content: "bad" }],
  });
  const body = (await response.json()) as { code?: string };

  assert.equal(response.status, 400);
  assert.equal(body.code, "UPLOAD_INVALID_PATH");
  assert.equal(fs.existsSync(path.join(root, "absolute.txt")), false);
});

test("upload rejects file and child path collisions before writing", async (t) => {
  const root = workspace(t);
  const server = await serveUploadRoute(sessionFor(root));
  t.after(server.close);

  const response = await upload(server.base, {
    targetPath: "uploads",
    entries: [
      { path: "a.txt", content: "file" },
      { path: "a.txt/child.txt", content: "child" },
    ],
  });
  const body = (await response.json()) as { code?: string };

  assert.equal(response.status, 400);
  assert.equal(body.code, "UPLOAD_INVALID_PATH");
  assert.equal(fs.existsSync(path.join(root, "uploads", "a.txt")), false);
});

test("upload rejects symlink components that point at active stores", async (t) => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, ".checkpoints"), { recursive: true });
  fs.symlinkSync(path.join(root, ".checkpoints"), path.join(root, "alias"), "dir");
  const server = await serveUploadRoute(sessionFor(root));
  t.after(server.close);

  const response = await upload(server.base, {
    entries: [{ path: "alias/blobs/file.txt", content: "bad" }],
  });
  const body = (await response.json()) as { code?: string };

  assert.equal(response.status, 400);
  assert.equal(body.code, "UPLOAD_INVALID_PATH");
  assert.equal(fs.existsSync(path.join(root, ".checkpoints", "blobs", "file.txt")), false);
});

test("upload keeps imported project stores and generated directories as data", async (t) => {
  const root = workspace(t);
  const server = await serveUploadRoute(sessionFor(root));
  t.after(server.close);

  const entries = [
    { path: ".git/config", content: "[core]\n" },
    { path: ".omx/notepad.md", content: "notes" },
    { path: "frontend/node_modules/pkg/index.js", content: "module.exports = 1;" },
    { path: "frontend/dist/app.js", content: "dist" },
    { path: "src/__pycache__/main.cpython-314.pyc", content: "cache" },
  ];
  const response = await upload(server.base, { targetPath: "auto_cc", entries });

  assert.equal(response.status, 200);
  for (const entry of entries) {
    assert.equal(fs.readFileSync(path.join(root, "auto_cc", entry.path), "utf8"), entry.content);
  }
});

test("upload rejects active workspace metadata stores before writing", async (t) => {
  const root = workspace(t);
  const server = await serveUploadRoute(sessionFor(root));
  t.after(server.close);

  const response = await upload(server.base, {
    entries: [
      { path: ".checkpoints/mutations.json", content: "{}" },
      { path: "after.txt", content: "after" },
    ],
  });
  const body = (await response.json()) as { code?: string };

  assert.equal(response.status, 400);
  assert.equal(body.code, "UPLOAD_INVALID_PATH");
  assert.equal(fs.existsSync(path.join(root, ".checkpoints", "mutations.json")), false);
  assert.equal(fs.existsSync(path.join(root, "after.txt")), false);
});

test("upload reports partial failure when a race creates a later target", async (t) => {
  const root = workspace(t);
  const server = await serveUploadRoute(sessionFor(root));
  t.after(server.close);
  const originalWriteFileSync = fs.writeFileSync;
  let injected = false;
  t.after(() => {
    fs.writeFileSync = originalWriteFileSync;
  });
  fs.writeFileSync = ((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
    if (typeof file === "string" && file.endsWith(path.join("uploads", "second.txt")) && !injected) {
      injected = true;
      originalWriteFileSync(file, "raced");
    }
    return originalWriteFileSync(file, data, options);
  }) as typeof fs.writeFileSync;

  const response = await upload(server.base, {
    targetPath: "uploads",
    entries: [
      { path: "first.txt", content: "first" },
      { path: "second.txt", content: "second" },
    ],
  });
  const body = (await response.json()) as { code?: string };

  assert.equal(response.status, 500);
  assert.equal(body.code, "UPLOAD_PARTIAL_FAILURE");
  assert.equal(fs.readFileSync(path.join(root, "uploads", "first.txt"), "utf8"), "first");
  assert.equal(fs.readFileSync(path.join(root, "uploads", "second.txt"), "utf8"), "raced");
});
