import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { authRouter } from "../routes/auth.js";
import { mobilePairingRouter } from "../routes/mobilePairing.js";
import { getMobilePublicBaseUrl, getMobileSessionFromUpgrade, mobileCookieHeader, mobilePairingManager } from "../mobile/pairing.js";
import { TeamManager } from "../team/teamManager.js";
import { setTeamManagerForTests } from "../team/sessionBridge.js";
import {
  SessionManager,
  sessionManager,
  setCreateSessionSingletonsForTests,
  setSessionManagerForTests,
} from "./sessionManager.js";

test("public mobile cookies require HTTPS and default credentials block pairing", async (t) => {
  const oldBase = process.env.MOBILE_PUBLIC_BASE_URL;
  const oldNodeEnv = process.env.NODE_ENV;
  const root = await mkdtemp(path.join(os.tmpdir(), "crewforge-mobile-defaults-"));
  t.after(async () => {
    if (oldBase === undefined) delete process.env.MOBILE_PUBLIC_BASE_URL;
    else process.env.MOBILE_PUBLIC_BASE_URL = oldBase;
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
    await rm(root, { recursive: true, force: true });
  });
  const usersPath = path.join(root, "users.json");
  await writeFile(usersPath, JSON.stringify({
    allowedRoots: [root],
    users: [{ username: "admin", password: "admin123", defaultWorkspace: root, isAdmin: true }],
  }));
  const manager = new SessionManager(usersPath);
  assert.equal(manager.canExposeMobile(), false);
  manager.updateUserPassword("admin", "longer-secret");
  assert.equal(manager.canExposeMobile(), true);
  process.env.MOBILE_PUBLIC_BASE_URL = "https://crewforge.example";
  assert.match(mobileCookieHeader("example", 60), /^__Host-crewforge_mobile=example;.*; Secure$/);
  process.env.MOBILE_PUBLIC_BASE_URL = "http://127.0.0.1:3000";
  process.env.NODE_ENV = "production";
  assert.throws(() => getMobilePublicBaseUrl(), /HTTPS origin/);
});

test("legacy passwords migrate to scrypt and desktop sessions expire or revoke", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crewforge-password-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "project");
  await mkdir(workspace);
  const configPath = path.join(root, "users.json");
  await writeFile(configPath, JSON.stringify({
    allowedRoots: [root],
    users: [
      { username: "alice", password: "secret", defaultWorkspace: workspace },
      { username: "bob", password: "another-secret", defaultWorkspace: workspace },
    ],
    pendingRegistrations: [{ username: "charlie", password: "pending-secret", requestedAt: Date.now() }],
  }));
  setCreateSessionSingletonsForTests(() => ({ taskManager: {} as any, messageBus: {} as any, teammateManager: {} as any }));
  t.after(() => setCreateSessionSingletonsForTests());
  const manager = new SessionManager(configPath);
  assert.equal(manager.login("alice", "bad"), null);
  assert.equal((JSON.parse(await readFile(configPath, "utf8")) as any).users[0].password, "secret");
  const alice = manager.login("alice", "secret");
  assert.ok(alice);
  const persisted = JSON.parse(await readFile(configPath, "utf8")) as any;
  assert.ok(persisted.users.every((user: any) => /^scrypt\$/.test(user.password)));
  assert.ok(persisted.pendingRegistrations.every((entry: any) => /^scrypt\$/.test(entry.password)));
  assert.ok(manager.login("bob", "another-secret"));
  assert.equal(manager.login("bob", "wrong"), null);

  const live = manager.getSession(alice.token);
  assert.ok(live);
  live.expiresAt = Date.now() - 1;
  assert.equal(manager.getSession(alice.token), null);
  const replacement = manager.login("alice", "secret");
  assert.ok(replacement);
  manager.updateUserPassword("alice", "new-secret");
  assert.equal(manager.getSession(replacement.token), null);
  assert.equal(manager.login("alice", "secret"), null);
  assert.ok(manager.login("alice", "new-secret"));
});

test("phone claim needs desktop approval; mobile cookie cannot access desktop APIs", async (t) => {
  const originalManager = sessionManager;
  const oldBase = process.env.MOBILE_PUBLIC_BASE_URL;
  const oldFallback = process.env.CROWNFORGE_PUBLIC_URL;
  const oldNodeEnv = process.env.NODE_ENV;
  const root = await mkdtemp(path.join(os.tmpdir(), "crewforge-mobile-pair-"));
  const workspace = path.join(root, "project");
  const teamWorkspace = path.join(root, "shared-project");
  await mkdir(workspace);
  await mkdir(teamWorkspace);
  const configPath = path.join(root, "users.json");
  await writeFile(configPath, JSON.stringify({
    allowedRoots: [root],
    users: [
      { username: "alice", password: "secret", defaultWorkspace: workspace },
      { username: "bob", password: "secret", defaultWorkspace: workspace },
    ],
  }));
  setCreateSessionSingletonsForTests(() => ({ taskManager: {} as any, messageBus: {} as any, teammateManager: {} as any }));
  const manager = new SessionManager(configPath);
  setSessionManagerForTests(manager);
  const teams = new TeamManager(path.join(root, "teams"));
  setTeamManagerForTests(teams);
  const team = teams.createTeam({ username: "bob", teamName: "Shared work", workspaceDir: teamWorkspace });
  const invite = teams.createInvite(team.id, "bob", "viewer");
  teams.joinTeamByInvite(invite.code, "alice");
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  app.use("/api/mobile/pairing", mobilePairingRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const base = `${origin}/api/mobile/pairing`;
  process.env.MOBILE_PUBLIC_BASE_URL = origin;
  delete process.env.CROWNFORGE_PUBLIC_URL;
  process.env.NODE_ENV = "test";
  t.after(async () => {
    setSessionManagerForTests(originalManager);
    setTeamManagerForTests(null);
    setCreateSessionSingletonsForTests();
    if (oldBase === undefined) delete process.env.MOBILE_PUBLIC_BASE_URL;
    else process.env.MOBILE_PUBLIC_BASE_URL = oldBase;
    if (oldFallback === undefined) delete process.env.CROWNFORGE_PUBLIC_URL;
    else process.env.CROWNFORGE_PUBLIC_URL = oldFallback;
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const alice = manager.login("alice", "secret");
  const bob = manager.login("bob", "secret");
  assert.ok(alice && bob);
  const auth = { Authorization: `Bearer ${alice.token}` };
  const phoneHeaders = { Origin: origin, "Content-Type": "application/json" };
  const post = (url: string, body: unknown, headers: Record<string, string> = phoneHeaders) => fetch(url, {
    method: "POST", headers, body: JSON.stringify(body),
  });

  assert.equal((await post(base, {}, {})).status, 401);
  process.env.MOBILE_PUBLIC_BASE_URL = "http://example.com";
  assert.equal((await post(base, {}, auth)).status, 503);
  process.env.MOBILE_PUBLIC_BASE_URL = origin;

  const createdResponse = await post(base, {}, auth);
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as { id: string; ticket: string; pairUrl: string };
  assert.match(created.pairUrl, /\/mobile\/pair#ticket=/);
  assert.equal(new URL(created.pairUrl).search, "");
  assert.equal((await post(`${base}/claim`, { ticket: created.ticket }, { ...phoneHeaders, Origin: "https://evil.example" })).status, 403);
  const claimedResponse = await post(`${base}/claim`, { ticket: created.ticket, deviceName: "Alice's phone" });
  assert.equal(claimedResponse.status, 200);
  const claim = await claimedResponse.json() as { claimToken: string; shortCode: string };
  assert.match(claim.shortCode, /^\d{6}$/);
  assert.equal((await post(`${base}/claim`, { ticket: created.ticket })).status, 409);

  const statusResponse = await fetch(`${base}/${created.id}`, { headers: auth });
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json() as { status: string; shortCode: string; deviceName: string; claimedAt: number };
  assert.equal(status.status, "claimed");
  assert.equal(status.shortCode, claim.shortCode);
  assert.equal(status.deviceName, "Alice's phone");
  assert.equal(typeof status.claimedAt, "number");
  assert.equal((await post(`${base}/${created.id}/approve`, {}, { Authorization: `Bearer ${bob.token}` })).status, 404);
  assert.equal((await post(`${base}/exchange`, { claimToken: claim.claimToken })).status, 409);
  assert.equal((await post(`${base}/${created.id}/approve`, {}, auth)).status, 200);
  const exchangeResponse = await post(`${base}/exchange`, { claimToken: claim.claimToken });
  assert.equal(exchangeResponse.status, 200);
  const cookie = exchangeResponse.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie?.startsWith("crewforge_mobile_dev="));
  if (!cookie) throw new Error("Mobile cookie missing");
  const exchanged = await exchangeResponse.json() as { session: { id: string; csrfToken: string; scopeKey: string } };
  assert.equal(exchanged.session.scopeKey, "personal");
  assert.equal((await post(`${base}/exchange`, { claimToken: claim.claimToken })).status, 409);
  const phone = { Cookie: cookie };
  const rawCookie = cookie.slice(cookie.indexOf("=") + 1);
  const mobileSession = mobilePairingManager.getSession(rawCookie);
  assert.ok(mobileSession);
  const idleBeforeWs = mobileSession.idleExpiresAt;
  const parentSeenBeforeWs = manager.getSession(alice.token, { touch: false })?.lastSeenAt;
  assert.equal(getMobileSessionFromUpgrade({ headers: { cookie, origin } } as any)?.id, mobileSession.id);
  assert.equal(mobileSession.idleExpiresAt, idleBeforeWs);
  assert.equal(manager.getSession(alice.token, { touch: false })?.lastSeenAt, parentSeenBeforeWs);
  assert.equal((await fetch(`${base}/me`, { headers: phone })).status, 200);
  const scopesResponse = await fetch(`${base}/scopes`, { headers: phone });
  assert.equal(scopesResponse.status, 200);
  const scopes = await scopesResponse.json() as { scopes: Array<{ key: string; name: string; role: string }> };
  assert.deepEqual(scopes.scopes.map((scope) => scope.key), ["personal", `team:${team.id}`]);
  assert.equal(scopes.scopes[1].role, "viewer");
  assert.equal((await post(`${base}/scope`, { key: `team:${team.id}` }, {
    ...phoneHeaders, ...phone, "X-CrewForge-Mobile-CSRF": exchanged.session.csrfToken,
  })).status, 200);
  manager.changeWorkspace(alice.token, workspace);
  const afterDesktopSwitch = await fetch(`${base}/me`, { headers: phone });
  assert.equal(afterDesktopSwitch.status, 200);
  assert.equal((await afterDesktopSwitch.json() as { session: { teamId: string } }).session.teamId, team.id);
  assert.equal((await fetch(`${origin}/api/auth/me`, { headers: phone })).status, 401);
  assert.equal((await fetch(`${base}/me`, { headers: auth })).status, 401);
  assert.equal((await post(`${base}/logout`, {}, { ...phoneHeaders, ...phone })).status, 403);
  assert.equal((await post(`${base}/logout`, {}, { ...phoneHeaders, ...phone, "X-CrewForge-Mobile-CSRF": "wrong" })).status, 403);
  assert.equal((await post(`${base}/logout`, {}, { ...phoneHeaders, ...phone, "X-CrewForge-Mobile-CSRF": exchanged.session.csrfToken })).status, 200);
  assert.equal((await fetch(`${base}/me`, { headers: phone })).status, 401);

  const next = await (await post(base, {}, auth)).json() as { id: string; ticket: string };
  const nextClaim = await (await post(`${base}/claim`, { ticket: next.ticket })).json() as { claimToken: string };
  assert.equal((await post(`${base}/${next.id}/approve`, {}, auth)).status, 200);
  const nextExchangeResponse = await post(`${base}/exchange`, { claimToken: nextClaim.claimToken });
  assert.equal(nextExchangeResponse.status, 200);
  const nextCookie = nextExchangeResponse.headers.get("set-cookie")?.split(";")[0];
  if (!nextCookie) throw new Error("Second mobile cookie missing");
  const nextSession = await nextExchangeResponse.json() as { session: { csrfToken: string } };
  assert.equal((await post(`${base}/scope`, { key: `team:${team.id}` }, {
    ...phoneHeaders, Cookie: nextCookie, "X-CrewForge-Mobile-CSRF": nextSession.session.csrfToken,
  })).status, 200);
  teams.removeMember(team.id, "bob", "alice");
  assert.equal((await fetch(`${base}/me`, { headers: { Cookie: nextCookie } })).status, 401);

  const third = await (await post(base, {}, auth)).json() as { id: string; ticket: string };
  const thirdClaim = await (await post(`${base}/claim`, { ticket: third.ticket })).json() as { claimToken: string };
  assert.equal((await post(`${base}/${third.id}/approve`, {}, auth)).status, 200);
  const thirdExchange = await post(`${base}/exchange`, { claimToken: thirdClaim.claimToken });
  assert.equal(thirdExchange.status, 200);
  const thirdCookie = thirdExchange.headers.get("set-cookie")?.split(";")[0];
  if (!thirdCookie) throw new Error("Third mobile cookie missing");
  manager.logout(alice.token);
  assert.equal((await fetch(`${base}/me`, { headers: { Cookie: thirdCookie } })).status, 401);
});
