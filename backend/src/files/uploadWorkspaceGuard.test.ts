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
  session: MutableSession,
  options: { switchWorkspaceOnRequestEndTo?: string } = {}
): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  app.use((req, _res, next) => {
    if (options.switchWorkspaceOnRequestEndTo) {
      req.on("end", () => {
        session.workspaceDir = options.switchWorkspaceOnRequestEndTo!;
      });
    }
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

function workspacePair(t: TestContext): { first: string; second: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-upload-workspace-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  return { first, second };
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

async function upload(
  base: string,
  fields: { expectedWorkspaceDir?: string } = {}
): Promise<Response> {
  const form = new FormData();
  form.append("targetPath", "uploads");
  form.append("paths", "folder/file.txt");
  if (fields.expectedWorkspaceDir !== undefined) {
    form.append("expectedWorkspaceDir", fields.expectedWorkspaceDir);
  }
  form.append("files", new Blob(["hello"], { type: "text/plain" }), "file.txt");
  return fetch(`${base}/upload`, { method: "POST", body: form });
}

test("upload rejects a multipart batch when expectedWorkspaceDir differs from the pinned workspace", async (t) => {
  const { first, second } = workspacePair(t);
  const server = await serveUploadRoute(sessionFor(first));
  t.after(server.close);

  const response = await upload(server.base, { expectedWorkspaceDir: second });
  const body = await response.json() as { code?: string; detail?: string };

  assert.equal(response.status, 409);
  assert.equal(body.code, "UPLOAD_WORKSPACE_CHANGED");
  assert.match(body.detail || "", /Workspace changed during upload/);
  assert.equal(fs.existsSync(path.join(first, "uploads", "folder", "file.txt")), false);
  assert.equal(fs.existsSync(path.join(second, "uploads", "folder", "file.txt")), false);
});

test("legacy upload rejects if the session workspace changes while multer parses the request", async (t) => {
  const { first, second } = workspacePair(t);
  const session = sessionFor(first);
  const server = await serveUploadRoute(session, { switchWorkspaceOnRequestEndTo: second });
  t.after(server.close);

  const response = await upload(server.base);
  const body = await response.json() as { code?: string };

  assert.equal(response.status, 409);
  assert.equal(body.code, "UPLOAD_WORKSPACE_CHANGED");
  assert.equal(fs.existsSync(path.join(first, "uploads", "folder", "file.txt")), false);
  assert.equal(fs.existsSync(path.join(second, "uploads", "folder", "file.txt")), false);
});
