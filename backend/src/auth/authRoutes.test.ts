import assert from "node:assert/strict";
import express from "express";
import crypto from "node:crypto";
import { initializeDesktopBootstrapCredential } from "./desktopBootstrapCredential.js";
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
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function serveWithRemoteAddress(manager: SessionManager, remoteAddress: string) {
  setSessionManagerForTests(manager);
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, "remoteAddress", {
      value: remoteAddress,
      configurable: true,
    });
    next();
  });
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

function getWithHost(port: number, path: string, host: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path,
      method: "GET",
      headers: { Host: host },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve({ status: response.statusCode || 0 }));
    });
    request.on("error", reject);
    request.end();
  });
}

async function desktopManager(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "crownforge-auth-desktop-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const project = path.join(root, "project");
  await mkdir(project, { recursive: true });
  const configPath = path.join(root, "users.json");
  await writeFile(configPath, JSON.stringify({
    allowedRoots: [root],
    users: [
      { username: "admin", password: "secret", defaultWorkspace: project, isAdmin: true },
      { username: "alice", password: "secret", defaultWorkspace: project, isAdmin: false },
    ],
  }));
  return { root, project, manager: new SessionManager(configPath) };
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

test("desktop /me requires the private host credential before bootstrapping a local admin session", async (t) => {
  const originalManager = sessionManager;
  const priorDesktop = process.env.CREWFORGE_DESKTOP;
  process.env.CREWFORGE_DESKTOP = "1";
  const priorCredential = process.env.CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN;
  const credential = crypto.randomBytes(32).toString("hex");
  process.env.CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN = credential;
  initializeDesktopBootstrapCredential();
  assert.equal(process.env.CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN, undefined);
  t.after(() => {
    initializeDesktopBootstrapCredential();
    if (priorCredential === undefined) delete process.env.CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN; else process.env.CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN = priorCredential;
    setSessionManagerForTests(originalManager);
    if (priorDesktop === undefined) delete process.env.CREWFORGE_DESKTOP;
    else process.env.CREWFORGE_DESKTOP = priorDesktop;
  });

  const { manager } = await desktopManager(t);
  const server = await serve(manager);
  try {
    assert.equal((await fetch(`${server.base}/me`)).status, 401);
    const bootstrapped = await fetch(`${server.base}/me`, { headers: { "X-CrownForge-Desktop-Bootstrap": credential } });
    assert.equal(bootstrapped.status, 200);
    assert.equal(bootstrapped.headers.get("cache-control"), "no-store");
    const payload = await bootstrapped.json() as { username: string; isAdmin: boolean; desktop: boolean; token: string };
    assert.equal(payload.username, "admin");
    assert.equal(payload.isAdmin, true);
    assert.equal(payload.desktop, true);
    assert.ok(payload.token);

    const hostileHost = await getWithHost(server.port, "/api/auth/me", "example.test");
    assert.equal(hostileHost.status, 401);

    const invalidToken = await fetch(`${server.base}/me`, { headers: { Authorization: "Bearer missing" } });
    assert.equal(invalidToken.status, 401);
    const invalidScheme = await fetch(`${server.base}/me`, { headers: { Authorization: "Basic invalid" } });
    assert.equal(invalidScheme.status, 401);
  } finally {
    await server.close();
  }
});

test("desktop /me refuses passwordless bootstrap from a non-loopback socket", async (t) => {
  const originalManager = sessionManager;
  const priorDesktop = process.env.CREWFORGE_DESKTOP;
  process.env.CREWFORGE_DESKTOP = "1";
  t.after(() => {
    setSessionManagerForTests(originalManager);
    if (priorDesktop === undefined) delete process.env.CREWFORGE_DESKTOP;
    else process.env.CREWFORGE_DESKTOP = priorDesktop;
  });

  const { manager } = await desktopManager(t);
  const server = await serveWithRemoteAddress(manager, "192.0.2.10");
  try {
    const response = await fetch(`${server.base}/me`);
    assert.equal(response.status, 401);
  } finally {
    await server.close();
  }
});

test("web /me still requires a token and desktop preserves valid isolated sessions", async (t) => {
  const originalManager = sessionManager;
  const priorDesktop = process.env.CREWFORGE_DESKTOP;
  t.after(() => {
    setSessionManagerForTests(originalManager);
    if (priorDesktop === undefined) delete process.env.CREWFORGE_DESKTOP;
    else process.env.CREWFORGE_DESKTOP = priorDesktop;
  });

  const { root, manager } = await desktopManager(t);
  delete process.env.CREWFORGE_DESKTOP;
  const webServer = await serve(manager);
  try {
    const webAnonymous = await fetch(`${webServer.base}/me`);
    assert.equal(webAnonymous.status, 401);
    assert.equal(webAnonymous.headers.get("cache-control"), "no-store");
  } finally {
    await webServer.close();
  }

  process.env.CREWFORGE_DESKTOP = "1";
  const session = manager.login("alice", "secret");
  assert.ok(session);
  const worktree = path.join(root, ".crownforge-worktrees", "project", "vibe-2");
  await mkdir(worktree, { recursive: true });
  const isolated = manager.createIsolatedSession(session.token, worktree);
  const desktopServer = await serve(manager);
  try {
    const response = await fetch(`${desktopServer.base}/me`, {
      headers: { Authorization: `Bearer ${isolated.token}` },
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { username: string; isAdmin: boolean; isolated: boolean; workspaceDir: string; token: string };
    assert.equal(payload.username, "alice");
    assert.equal(payload.isAdmin, false);
    assert.equal(payload.isolated, true);
    assert.equal(payload.workspaceDir, await realpath(worktree));
    assert.equal(payload.token, isolated.token);
  } finally {
    await desktopServer.close();
  }
});
