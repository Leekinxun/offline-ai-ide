import assert from "node:assert/strict";
import express from "express";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { authRouter } from "../routes/auth.js";
import { SessionManager, sessionManager, setSessionManagerForTests } from "./sessionManager.js";

async function serve(manager: SessionManager) {
  setSessionManagerForTests(manager);
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    base: `http://127.0.0.1:${address.port}/api/auth`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("auth routes expose desktop state and parent path for workspace navigation", async (t) => {
  const originalManager = sessionManager;
  const priorDesktop = process.env.CREWFORGE_DESKTOP;
  process.env.CREWFORGE_DESKTOP = "1";
  const root = await mkdtemp(path.join(os.tmpdir(), "crownforge-auth-routes-"));
  t.after(async () => {
    setSessionManagerForTests(originalManager);
    if (priorDesktop === undefined) delete process.env.CREWFORGE_DESKTOP;
    else process.env.CREWFORGE_DESKTOP = priorDesktop;
    await rm(root, { recursive: true, force: true });
  });

  const project = path.join(root, "project");
  const nested = path.join(project, "nested");
  await mkdir(nested, { recursive: true });
  const canonicalProject = await realpath(project);
  const canonicalNested = await realpath(nested);
  const configPath = path.join(root, "users.json");
  await writeFile(configPath, JSON.stringify({
    allowedRoots: [root],
    users: [{ username: "alice", password: "secret", defaultWorkspace: project }],
  }));

  const server = await serve(new SessionManager(configPath));
  try {
    const login = await fetch(`${server.base}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "secret" }),
    });
    assert.equal(login.status, 200);
    const session = await login.json() as { token: string; desktop: boolean };
    assert.equal(session.desktop, true);

    const me = await fetch(`${server.base}/me`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    assert.equal(me.status, 200);
    assert.equal((await me.json() as { desktop: boolean }).desktop, true);

    const listRoot = await fetch(`${server.base}/workspace/list`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    assert.equal(listRoot.status, 200);
    assert.equal((await listRoot.json() as { parentPath: string | null }).parentPath, null);

    const listNested = await fetch(`${server.base}/workspace/list?path=${encodeURIComponent(canonicalNested)}`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    assert.equal(listNested.status, 200);
    const body = await listNested.json() as { canNavigateUp: boolean; parentPath: string | null };
    assert.equal(body.canNavigateUp, true);
    assert.equal(body.parentPath, canonicalProject);
  } finally {
    await server.close();
  }
});

test("desktop workspace pick route handles cancellation and rejects isolated sessions", async (t) => {
  const originalManager = sessionManager;
  const priorDesktop = process.env.CREWFORGE_DESKTOP;
  const originalSend = process.send;
  process.env.CREWFORGE_DESKTOP = "1";
  const root = await mkdtemp(path.join(os.tmpdir(), "crownforge-auth-pick-"));
  t.after(async () => {
    setSessionManagerForTests(originalManager);
    if (priorDesktop === undefined) delete process.env.CREWFORGE_DESKTOP;
    else process.env.CREWFORGE_DESKTOP = priorDesktop;
    process.send = originalSend;
    await rm(root, { recursive: true, force: true });
  });

  const project = path.join(root, "project");
  const worktree = path.join(root, ".crownforge-worktrees", "project", "vibe-1");
  await mkdir(project, { recursive: true });
  await mkdir(worktree, { recursive: true });
  const configPath = path.join(root, "users.json");
  await writeFile(configPath, JSON.stringify({
    allowedRoots: [root],
    users: [{ username: "alice", password: "secret", defaultWorkspace: project }],
  }));

  const manager = new SessionManager(configPath);
  const session = manager.login("alice", "secret");
  assert.ok(session);
  const isolated = manager.createIsolatedSession(session.token, worktree);
  const server = await serve(manager);
  process.send = ((message: unknown) => {
    const request = message as { type: string; requestId: string };
    assert.equal(request.type, "desktop-pick-folder");
    setImmediate(() => {
      (process as any).emit("message", {
        type: "desktop-pick-folder-result",
        requestId: request.requestId,
        path: null,
      });
    });
    return true;
  }) as typeof process.send;

  try {
    const cancelled = await fetch(`${server.base}/workspace/pick`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.token}` },
    });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(await cancelled.json(), { cancelled: true });

    const rejected = await fetch(`${server.base}/workspace/pick`, {
      method: "POST",
      headers: { Authorization: `Bearer ${isolated.token}` },
    });
    assert.equal(rejected.status, 403);
  } finally {
    await server.close();
  }
});
