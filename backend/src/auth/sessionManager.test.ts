import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "./sessionManager.js";

test("keeps workspace selection isolated between sessions for the same user", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crownforge-session-"));
  const projectA = path.join(root, "project-a");
  const nestedProject = path.join(projectA, "nested-project");
  const projectB = path.join(root, "project-b");
  const configPath = path.join(root, "users.json");
  await mkdir(projectA);
  await mkdir(nestedProject);
  await mkdir(projectB);
  const escapingLink = path.join(root, "outside-link");
  if (process.platform !== "win32") {
    await symlink(path.dirname(root), escapingLink, "dir");
  }
  await writeFile(configPath, JSON.stringify({
    allowedRoots: [root],
    users: [{
      username: "alice",
      password: "secret",
      defaultWorkspace: projectA,
      isAdmin: false,
    }],
  }));

  try {
    const manager = new SessionManager(configPath);
    const first = manager.login("alice", "secret");
    const second = manager.login("alice", "secret");
    assert.ok(first);
    assert.ok(second);
    assert.notEqual(first.token, second.token);

    const canonicalProjectA = await realpath(projectA);
    const canonicalNestedProject = await realpath(nestedProject);
    assert.equal(first.workspaceRoot, canonicalProjectA);
    assert.equal(manager.getSession(first.token)?.workspaceRoot, canonicalProjectA);
    assert.deepEqual(manager.listUserWorkspaceDirectories(first.token), {
      path: canonicalProjectA,
      rootPath: canonicalProjectA,
      entries: [{ name: "nested-project", path: canonicalNestedProject }],
    });
    assert.equal(manager.listUserWorkspaceDirectories(first.token, root), null);
    assert.equal(manager.listUserWorkspaceDirectories(first.token, projectB), null);
    assert.equal(manager.changeWorkspaceWithinUserRoot(first.token, projectB), null);
    assert.deepEqual(
      manager.changeWorkspaceWithinUserRoot(first.token, nestedProject),
      { workspaceDir: canonicalNestedProject }
    );

    assert.deepEqual(manager.changeWorkspace(first.token, projectB), {
      workspaceDir: await realpath(projectB),
    });
    assert.equal(manager.getSession(first.token)?.workspaceDir, await realpath(projectB));
    assert.equal(manager.getSession(second.token)?.workspaceDir, await realpath(projectA));
    assert.equal(manager.changeWorkspace(first.token, path.join(root, "missing")), null);
    assert.equal(manager.changeWorkspace(first.token, path.dirname(root)), null);
    if (process.platform !== "win32") {
      assert.equal(manager.changeWorkspace(first.token, escapingLink), null);
      assert.equal(manager.isSelectableWorkspace(escapingLink), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists registration requests and allows login only after admin approval", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crownforge-registration-"));
  const adminWorkspace = path.join(root, "admin-project");
  const configPath = path.join(root, "users.json");
  await mkdir(adminWorkspace);
  await writeFile(configPath, JSON.stringify({
    allowedRoots: [root],
    users: [{
      username: "admin",
      password: "admin123",
      defaultWorkspace: adminWorkspace,
      isAdmin: true,
    }],
  }));

  try {
    const manager = new SessionManager(configPath);
    const registration = manager.requestRegistration("alice", "secret12");
    assert.equal(registration.username, "alice");
    assert.equal(typeof registration.requestedAt, "number");
    assert.equal(manager.login("alice", "secret12"), null);
    assert.throws(
      () => manager.requestRegistration("alice", "another-secret"),
      /already registered or pending approval/
    );
    assert.throws(
      () => manager.requestRegistration("invalid user", "secret12"),
      /must start with a letter or number/
    );
    assert.throws(
      () => manager.requestRegistration("..", "secret12"),
      /must start with a letter or number/
    );
    assert.throws(
      () => manager.createUser({
        username: "alice",
        password: "admin-created",
        defaultWorkspace: path.join(root, "manual-alice"),
      }),
      /pending registration request/
    );
    assert.throws(
      () => manager.requestRegistration("short-password", "123"),
      /at least 6 characters/
    );

    const reloaded = new SessionManager(configPath);
    assert.deepEqual(reloaded.listPendingRegistrations(), [registration]);
    const approved = reloaded.approveRegistration("alice");
    assert.equal(approved.isAdmin, false);
    assert.equal(approved.defaultWorkspace, path.join(root, "alice"));
    assert.deepEqual(reloaded.listPendingRegistrations(), []);
    assert.ok(reloaded.login("alice", "secret12"));

    reloaded.requestRegistration("bob", "secret12");
    reloaded.rejectRegistration("bob");
    assert.deepEqual(reloaded.listPendingRegistrations(), []);
    assert.equal(reloaded.login("bob", "secret12"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("locks derived isolated sessions to their managed worktree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crownforge-isolated-session-"));
  const project = path.join(root, "project");
  const worktree = path.join(root, ".crownforge-worktrees", "project", "vibe-1");
  const other = path.join(root, "other");
  const configPath = path.join(root, "users.json");
  await mkdir(project, { recursive: true });
  await mkdir(worktree, { recursive: true });
  await mkdir(other, { recursive: true });
  await writeFile(configPath, JSON.stringify({
    allowedRoots: [root],
    users: [{ username: "alice", password: "secret", defaultWorkspace: project }],
  }));

  try {
    const manager = new SessionManager(configPath);
    const parent = manager.login("alice", "secret");
    assert.ok(parent);
    const isolated = manager.createIsolatedSession(parent.token, worktree);
    assert.equal(isolated.isolated, true);
    assert.equal(isolated.workspaceDir, await realpath(worktree));
    assert.equal(manager.changeWorkspace(isolated.token, other), null);
    assert.equal(manager.getSession(parent.token)?.workspaceDir, await realpath(project));
    assert.throws(() => manager.createIsolatedSession(isolated.token, worktree), /Nested isolated sessions/);
    assert.throws(() => manager.createIsolatedSession(parent.token, other), /managed worktree/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
