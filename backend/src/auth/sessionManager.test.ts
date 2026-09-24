import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../config.js";
import { SessionManager, setCreateSessionSingletonsForTests } from "./sessionManager.js";

test("desktop mode refuses damaged or empty credentials instead of defaulting to admin123", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crownforge-desktop-users-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const usersPath = path.join(root, "users.json");
  const script = "await import('./src/auth/sessionManager.ts')";
  for (const contents of ["{", "{}", '{"users":[]}', '{"users":[{}]}']) {
    await writeFile(usersPath, contents);
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, CREWFORGE_DESKTOP: "1", USERS_CONFIG: usersPath, WORKSPACE_DIR: root, APP_SETTINGS_CONFIG: path.join(root, "app-settings.json"), PLUGINS_DIR: path.join(root, "plugins") },
      encoding: "utf8",
    });
    assert.notEqual(child.status, 0, `desktop accepted invalid users.json: ${contents}`);
    assert.doesNotMatch(child.stdout, /using defaults/);
  }
});

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

test("lists allowed roots through platform-specific ancestor separators", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crownforge-allowed-roots-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "group", "project");
  await mkdir(workspace, { recursive: true });
  const configPath = path.join(root, "users.json");
  await writeFile(configPath, JSON.stringify({
    allowedRoots: [workspace],
    users: [{ username: "alice", password: "secret", defaultWorkspace: workspace }],
  }));
  const manager = new SessionManager(configPath);
  assert.deepEqual(manager.listDirectories(root), [{ name: "group", path: path.join(root, "group") }]);
  assert.deepEqual(manager.listDirectories(path.join(root, "group")), [{ name: "project", path: workspace }]);
  assert.deepEqual(manager.listDirectories(path.join(root, "elsewhere")), []);
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

test("desktop trusted picker can persist and reopen a workspace outside the web root", async (t) => {
  const priorDesktop = process.env.CREWFORGE_DESKTOP;
  const priorDefaultWorkspace = config.defaultWorkspaceDir;
  process.env.CREWFORGE_DESKTOP = "1";

  const root = await mkdtemp(path.join(os.tmpdir(), "crownforge-desktop-pick-"));
  const initial = path.join(root, "initial");
  const external = path.join(root, "external-volume", "project");
  const configPath = path.join(root, "users.json");
  config.defaultWorkspaceDir = initial;
  t.after(async () => {
    if (priorDesktop === undefined) delete process.env.CREWFORGE_DESKTOP;
    else process.env.CREWFORGE_DESKTOP = priorDesktop;
    config.defaultWorkspaceDir = priorDefaultWorkspace;
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(initial, { recursive: true });
  await mkdir(external, { recursive: true });
  await writeFile(configPath, JSON.stringify({
    allowedRoots: [initial],
    users: [{ username: "alice", password: "secret", defaultWorkspace: initial }],
  }));

  const manager = new SessionManager(configPath);
  const session = manager.login("alice", "secret");
  assert.ok(session);
  assert.equal(manager.changeWorkspaceWithinUserRoot(session.token, external), null);

  const canonicalExternal = await realpath(external);
  assert.deepEqual(
    manager.changeWorkspaceFromTrustedDesktopPicker(session.token, external),
    { workspaceDir: canonicalExternal, workspaceRoot: canonicalExternal }
  );
  assert.equal(manager.getSession(session.token)?.workspaceRoot, canonicalExternal);

  const persisted = JSON.parse(await readFile(configPath, "utf8")) as {
    allowedRoots: string[];
    users: Array<{ username: string; defaultWorkspace: string }>;
  };
  assert.ok(persisted.allowedRoots.includes(canonicalExternal));
  assert.equal(persisted.users.find((user) => user.username === "alice")?.defaultWorkspace, canonicalExternal);

  const restarted = new SessionManager(configPath);
  const restartedSession = restarted.login("alice", "secret");
  assert.ok(restartedSession);
  assert.equal(restartedSession.workspaceDir, canonicalExternal);

  await rm(path.join(root, "external-volume"), { recursive: true, force: true });
  const fallback = new SessionManager(configPath).login("alice", "secret");
  assert.ok(fallback);
  assert.equal(fallback.workspaceDir, await realpath(initial));
  await assert.rejects(() => access(external));

  await writeFile(configPath, JSON.stringify({
    allowedRoots: [canonicalExternal],
    users: [{ username: "alice", password: "secret", defaultWorkspace: canonicalExternal }],
  }));
  const legacyFallback = new SessionManager(configPath).login("alice", "secret");
  assert.ok(legacyFallback);
  assert.equal(legacyFallback.workspaceDir, await realpath(initial));
  await assert.rejects(() => access(external));
});

test("desktop login falls back to built-in workspace when saved external startup fails", async (t) => {
  const priorDesktop = process.env.CREWFORGE_DESKTOP;
  const priorDefaultWorkspace = config.defaultWorkspaceDir;
  process.env.CREWFORGE_DESKTOP = "1";

  const root = await mkdtemp(path.join(os.tmpdir(), "crownforge-desktop-startup-fallback-"));
  const initial = path.join(root, "initial");
  const external = path.join(root, "external");
  const configPath = path.join(root, "users.json");
  config.defaultWorkspaceDir = initial;
  t.after(async () => {
    setCreateSessionSingletonsForTests();
    if (priorDesktop === undefined) delete process.env.CREWFORGE_DESKTOP;
    else process.env.CREWFORGE_DESKTOP = priorDesktop;
    config.defaultWorkspaceDir = priorDefaultWorkspace;
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(initial, { recursive: true });
  await mkdir(external, { recursive: true });
  const canonicalInitial = await realpath(initial);
  const canonicalExternal = await realpath(external);
  await writeFile(configPath, JSON.stringify({
    allowedRoots: [canonicalInitial, canonicalExternal],
    users: [{ username: "alice", password: "secret", defaultWorkspace: canonicalExternal }],
  }));

  setCreateSessionSingletonsForTests((workspaceDir) => {
    if (workspaceDir === canonicalExternal) {
      throw new Error("simulated startup failure");
    }
    return {
      taskManager: {} as any,
      messageBus: {} as any,
      teammateManager: {} as any,
    };
  });

  const session = new SessionManager(configPath).login("alice", "secret");
  assert.ok(session);
  assert.equal(session.workspaceDir, canonicalInitial);
});

test("desktop trusted picker rejects invalid and isolated workspace changes", async (t) => {
  const priorDesktop = process.env.CREWFORGE_DESKTOP;
  process.env.CREWFORGE_DESKTOP = "1";
  const root = await mkdtemp(path.join(os.tmpdir(), "crownforge-desktop-invalid-"));
  t.after(async () => {
    if (priorDesktop === undefined) delete process.env.CREWFORGE_DESKTOP;
    else process.env.CREWFORGE_DESKTOP = priorDesktop;
    await rm(root, { recursive: true, force: true });
  });

  const project = path.join(root, "project");
  const worktree = path.join(root, ".crownforge-worktrees", "project", "vibe-1");
  const configPath = path.join(root, "users.json");
  await mkdir(project, { recursive: true });
  await mkdir(worktree, { recursive: true });
  await writeFile(configPath, JSON.stringify({
    allowedRoots: [root],
    users: [{ username: "alice", password: "secret", defaultWorkspace: project }],
  }));

  const manager = new SessionManager(configPath);
  const session = manager.login("alice", "secret");
  assert.ok(session);
  assert.equal(manager.changeWorkspaceFromTrustedDesktopPicker(session.token, path.join(root, "missing")), null);

  const isolated = manager.createIsolatedSession(session.token, worktree);
  assert.equal(manager.changeWorkspaceFromTrustedDesktopPicker(isolated.token, project), null);
});
