import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createConversationId, appendConversationMessage } from "../chat/history.js";
import { SessionManager, sessionManager, setCreateSessionSingletonsForTests, setSessionManagerForTests } from "../auth/sessionManager.js";
import { TeamManager } from "../team/teamManager.js";
import { canWriteActiveWorkspace, setTeamManagerForTests } from "../team/sessionBridge.js";
import { mobileCookieName, mobilePairingManager } from "./pairing.js";
import { buildMobileSnapshot, buildMobileTaskDetail, getMobileContext } from "./data.js";
import { mobileDataRouter } from "../routes/mobileData.js";

test("mobile projection follows current team role and revokes a removed member", async (t) => {
  const originalManager = sessionManager;
  const root = await mkdtemp(path.join(os.tmpdir(), "crewforge-mobile-data-"));
  const personal = path.join(root, "personal");
  const shared = path.join(root, "shared");
  await mkdir(personal); await mkdir(shared);
  const usersFile = path.join(root, "users.json");
  await writeFile(usersFile, JSON.stringify({
    allowedRoots: [root],
    users: [
      { username: "alice", password: "alice-pass", defaultWorkspace: personal },
      { username: "bob", password: "bob-pass", defaultWorkspace: personal },
    ],
  }));
  const previousBase = process.env.MOBILE_PUBLIC_BASE_URL;
  process.env.MOBILE_PUBLIC_BASE_URL = "http://127.0.0.1:39373";
  const manager = new SessionManager(usersFile);
  const teams = new TeamManager(path.join(root, "team-store"));
  const team = teams.createTeam({ username: "bob", teamName: "Shared project", workspaceDir: shared });
  teams.joinTeamByInvite(teams.createInvite(team.id, "bob", "viewer").code, "alice");
  setCreateSessionSingletonsForTests(() => ({ taskManager: {} as any, messageBus: {} as any, teammateManager: {} as any }));
  setSessionManagerForTests(manager);
  setTeamManagerForTests(teams);
  let deviceId: string | undefined;
  t.after(async () => {
    if (deviceId) mobilePairingManager.revoke(deviceId);
    setSessionManagerForTests(originalManager);
    setTeamManagerForTests(null);
    setCreateSessionSingletonsForTests();
    if (previousBase === undefined) delete process.env.MOBILE_PUBLIC_BASE_URL;
    else process.env.MOBILE_PUBLIC_BASE_URL = previousBase;
    await rm(root, { recursive: true, force: true });
  });

  const login = manager.login("alice", "alice-pass");
  assert.ok(login);
  const parent = manager.getSession(login.token);
  assert.ok(parent);
  const pairing = mobilePairingManager.create(parent);
  const claim = mobilePairingManager.claim(pairing.ticket);
  mobilePairingManager.approve(pairing.id, login.token);
  const exchanged = mobilePairingManager.exchange(claim.claimToken);
  const phone = exchanged.session;
  deviceId = phone.id;
  mobilePairingManager.setScope(phone, `team:${team.id}`);

  const conversationId = createConversationId();
  await appendConversationMessage(shared, conversationId, {
    role: "user", content: "Review sk-1234567890abcdef", timestamp: Date.now(),
  });
  const parentLastSeen = parent.lastSeenAt;
  const context = getMobileContext(phone);
  const snapshot = buildMobileSnapshot(context, 7);
  assert.equal(parent.lastSeenAt, parentLastSeen, "read-only projection must not extend the parent idle deadline");
  assert.equal(snapshot.sequence, 7);
  assert.equal(snapshot.workspace.role, "viewer");
  assert.equal(snapshot.workspace.canWrite, false);
  assert.equal(snapshot.approvals.length, 0);
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.tasks[0].id, conversationId);
  const detail = buildMobileTaskDetail(context, conversationId);
  assert.match(detail.messages[0].content, /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(detail), /sk-1234567890abcdef/);

  const app = express();
  app.use(express.json());
  app.use("/api/mobile/data", mobileDataRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  process.env.MOBILE_PUBLIC_BASE_URL = origin;
  const cookie = `${mobileCookieName()}=${exchanged.cookieSecret}`;
  const startBody = JSON.stringify({ commandId: "viewer-start-1234", action: "start", message: "Change project files", mode: "code" });
  const denied = await fetch(`${origin}/api/mobile/data/commands`, {
    method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json", "x-crewforge-mobile-csrf": phone.csrfToken }, body: startBody,
  });
  assert.equal(denied.status, 403);
  const noCsrf = await fetch(`${origin}/api/mobile/data/commands`, {
    method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, body: startBody,
  });
  assert.equal(noCsrf.status, 403);

  teams.removeMember(team.id, "bob", "alice");
  assert.equal(mobilePairingManager.getSession(exchanged.cookieSecret), null);
  const stale = { ...parent, workspaceDir: shared };
  assert.equal(canWriteActiveWorkspace(stale), false);
});

test("a personal mobile scope closes if its directory becomes a team workspace", async (t) => {
  const originalManager = sessionManager;
  const root = await mkdtemp(path.join(os.tmpdir(), "crewforge-mobile-scope-"));
  const workspace = path.join(root, "project");
  await mkdir(workspace);
  const usersFile = path.join(root, "users.json");
  await writeFile(usersFile, JSON.stringify({
    allowedRoots: [root],
    users: [
      { username: "alice", password: "alice-pass", defaultWorkspace: workspace },
      { username: "bob", password: "bob-pass", defaultWorkspace: workspace },
    ],
  }));
  const previousBase = process.env.MOBILE_PUBLIC_BASE_URL;
  process.env.MOBILE_PUBLIC_BASE_URL = "http://127.0.0.1:39373";
  const manager = new SessionManager(usersFile);
  const teams = new TeamManager(path.join(root, "team-store"));
  setCreateSessionSingletonsForTests(() => ({ taskManager: {} as any, messageBus: {} as any, teammateManager: {} as any }));
  setSessionManagerForTests(manager);
  setTeamManagerForTests(teams);
  let deviceId: string | undefined;
  t.after(async () => {
    if (deviceId) mobilePairingManager.revoke(deviceId);
    setSessionManagerForTests(originalManager);
    setTeamManagerForTests(null);
    setCreateSessionSingletonsForTests();
    if (previousBase === undefined) delete process.env.MOBILE_PUBLIC_BASE_URL;
    else process.env.MOBILE_PUBLIC_BASE_URL = previousBase;
    await rm(root, { recursive: true, force: true });
  });
  const login = manager.login("alice", "alice-pass");
  assert.ok(login);
  const parent = manager.getSession(login.token);
  assert.ok(parent);
  const pairing = mobilePairingManager.create(parent);
  const claim = mobilePairingManager.claim(pairing.ticket);
  mobilePairingManager.approve(pairing.id, login.token);
  const exchanged = mobilePairingManager.exchange(claim.claimToken);
  deviceId = exchanged.session.id;
  assert.ok(mobilePairingManager.getSession(exchanged.cookieSecret));

  teams.createTeam({ username: "bob", teamName: "New shared project", workspaceDir: workspace });
  assert.equal(mobilePairingManager.getSession(exchanged.cookieSecret), null);
  assert.equal(canWriteActiveWorkspace(parent), false);
});
