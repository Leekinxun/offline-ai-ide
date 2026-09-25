import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { authRouter } from "../routes/auth.js";
import {
  SessionManager,
  sessionManager,
  setCreateSessionSingletonsForTests,
  setSessionManagerForTests,
} from "./sessionManager.js";

test("HTTP login verifies passwords off the event loop and throttles guesses", async (t) => {
  const oldManager = sessionManager;
  const root = await mkdtemp(path.join(os.tmpdir(), "crewforge-async-login-"));
  const workspace = path.join(root, "project");
  await mkdir(workspace);
  const usersPath = path.join(root, "users.json");
  await writeFile(usersPath, JSON.stringify({
    allowedRoots: [root],
    users: [{ username: "alice", password: "secret", defaultWorkspace: workspace }],
  }));
  setCreateSessionSingletonsForTests(() => ({ taskManager: {} as any, messageBus: {} as any, teammateManager: {} as any }));
  const manager = new SessionManager(usersPath);
  setSessionManagerForTests(manager);
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/api/auth/login`;
  t.after(async () => {
    setSessionManagerForTests(oldManager);
    setCreateSessionSingletonsForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  let settled = false;
  const pending = manager.loginAsync("alice", "incorrect").then((result) => {
    settled = true;
    return result;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  // A synchronous scrypt call would not yield before the verification ends.
  assert.equal(settled, false);
  assert.equal(await pending, null);

  const post = (username: string, password: string) => fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const success = await post("alice", "secret");
  assert.equal(success.status, 200);
  assert.ok((await success.json() as { token: string }).token);
  const saved = JSON.parse(await readFile(usersPath, "utf8")) as { users: Array<{ password: string }> };
  assert.match(saved.users[0].password, /^scrypt\$/);
  const unknown = await post("missing", "bad-password");
  assert.equal(unknown.status, 401);
  assert.deepEqual(await unknown.json(), { error: "Invalid credentials" });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await post("alice", "wrong-password");
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Invalid credentials" });
  }
  const limited = await post("alice", "wrong-password");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "1");

  const registration = await fetch(url.replace(/\/login$/, "/register"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "charlie", password: "registration-secret" }),
  });
  assert.equal(registration.status, 201);
  const afterRegistration = JSON.parse(await readFile(usersPath, "utf8")) as {
    pendingRegistrations: Array<{ username: string; password: string }>;
  };
  assert.match(afterRegistration.pendingRegistrations.find((entry) => entry.username === "charlie")?.password || "", /^scrypt\$/);

  const stale = manager.loginAsync("alice", "secret");
  manager.updateUserPassword("alice", "replacement-secret");
  assert.equal(await stale, null);
  assert.ok(await manager.loginAsync("alice", "replacement-secret"));
});
