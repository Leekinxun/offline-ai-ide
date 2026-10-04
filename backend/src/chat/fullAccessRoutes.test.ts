import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { WebSocket, WebSocketServer } from "ws";

// Configure every module singleton before importing project code. These tests
// must never load a developer's credentials, workspace or team configuration.
const bootstrap = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-full-access-bootstrap-")));
const bootstrapWorkspace = path.join(bootstrap, "workspace");
fs.mkdirSync(bootstrapWorkspace);
const environment = {
  WORKSPACE_DIR: bootstrapWorkspace,
  USERS_CONFIG: path.join(bootstrap, "users.json"),
  APP_SETTINGS_CONFIG: path.join(bootstrap, "settings.json"),
  TEAM_STORE_ROOT: bootstrap,
};
const previousEnvironment = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
const previousDesktop = process.env.CREWFORGE_DESKTOP;
delete process.env.CREWFORGE_DESKTOP;
for (const [key, value] of Object.entries(environment)) process.env[key] = value;
fs.writeFileSync(environment.USERS_CONFIG, JSON.stringify({
  allowedRoots: [bootstrap],
  users: [{ username: "bootstrap", password: "synthetic-password", defaultWorkspace: bootstrapWorkspace }],
}));

const { authMiddleware, getWsSession } = await import("../auth/middleware.js");
const { SessionManager, sessionManager, setSessionManagerForTests } = await import("../auth/sessionManager.js");
const { authRouter } = await import("../routes/auth.js");
const { chatRouter } = await import("../routes/chat.js");
const { createPermissionAuthorizer } = await import("../agent/permissionService.js");
const { PolicyAuditLog } = await import("../agent/policyAudit.js");
const { TeamManager } = await import("../team/teamManager.js");
const { setTeamManagerForTests } = await import("../team/sessionBridge.js");
const { handleChatWs } = await import("../ws/chat.js");
const { appendConversationMessage } = await import("./history.js");
const { AgentRunRecorder } = await import("./runHistory.js");
const { createActiveRun, stopRunsForSession } = await import("./runCoordinator.js");
const { getFullAccessGrant } = await import("./fullAccess.js");

after(() => {
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (previousDesktop === undefined) delete process.env.CREWFORGE_DESKTOP;
  else process.env.CREWFORGE_DESKTOP = previousDesktop;
  fs.rmSync(bootstrap, { recursive: true, force: true });
});

interface ApprovalModeState {
  mode: "ask" | "full_access";
  workspaceDir: string;
  conversationId: string;
  revision: number;
  canEnable: boolean;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error("Timed out waiting for the synthetic approval event");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(t: test.TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-full-access-routes-")));
  const workspace = path.join(root, "workspace");
  const otherWorkspace = path.join(root, "other-workspace");
  fs.mkdirSync(workspace);
  fs.mkdirSync(otherWorkspace);
  const users = path.join(root, "users.json");
  fs.writeFileSync(users, JSON.stringify({
    allowedRoots: [root],
    users: [
      { username: "alice", password: "synthetic-password", defaultWorkspace: workspace, isAdmin: true },
      { username: "bob", password: "synthetic-password", defaultWorkspace: workspace, isAdmin: false },
      { username: "reader", password: "synthetic-password", defaultWorkspace: workspace, isAdmin: false },
    ],
  }));
  const manager = new SessionManager(users);
  const previousManager = sessionManager;
  setSessionManagerForTests(manager);
  const teams = new TeamManager(path.join(root, "team-store"));
  setTeamManagerForTests(teams);
  const unsubscribeRevoked = manager.onSessionRevoked(stopRunsForSession);
  const runs: Array<ReturnType<typeof createActiveRun>> = [];
  const clients: WebSocket[] = [];
  const loginTokens = new Set<string>();
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  app.use("/api/chat", authMiddleware, chatRouter);
  const server = http.createServer(app);
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const session = getWsSession(request);
    if (!session) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => handleChatWs(ws, session));
  });
  t.after(async () => {
    for (const run of runs) { run.forceStop(); run.finish(); }
    for (const client of clients) client.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    for (const token of loginTokens) manager.logout(token);
    unsubscribeRevoked();
    setSessionManagerForTests(previousManager);
    setTeamManagerForTests(null);
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  const request = (route: string, options: {
    token?: string;
    method?: string;
    body?: unknown;
    workspaceHeader?: string;
  } = {}) => fetch(`${base}${route}`, {
    method: options.method || "GET",
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.workspaceHeader !== undefined ? { "X-Workspace-Dir": options.workspaceHeader } : {}),
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const login = async (username = "alice") => {
    const response = await request("/api/auth/login", {
      method: "POST", body: { username, password: "synthetic-password" },
    });
    assert.equal(response.status, 200);
    const token = (await response.json() as { token: string }).token;
    loginTokens.add(token);
    return token;
  };
  const windowToken = async (token: string, selectedWorkspace?: string) => {
    const response = await request("/api/auth/session/window", {
      token, method: "POST", body: selectedWorkspace ? { path: selectedWorkspace } : {},
    });
    assert.equal(response.status, 200);
    return (await response.json() as { token: string }).token;
  };
  const readMode = async (token: string, conversationId = "task", selectedWorkspace = workspace) => {
    const response = await request(`/api/chat/conversations/${encodeURIComponent(conversationId)}/approval-mode`, {
      token, workspaceHeader: encodeURIComponent(selectedWorkspace),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") || "", /no-store/);
    return await response.json() as ApprovalModeState;
  };
  const writeMode = (token: string, body: unknown, conversationId = "task", selectedWorkspace = workspace) =>
    request(`/api/chat/conversations/${encodeURIComponent(conversationId)}/approval-mode`, {
      token, method: "PUT", body, workspaceHeader: encodeURIComponent(selectedWorkspace),
    });
  const enable = async (token: string, conversationId = "task", selectedWorkspace = workspace) => {
    const before = await readMode(token, conversationId, selectedWorkspace);
    const response = await writeMode(token, {
      mode: "full_access", expectedRevision: before.revision, acknowledgeRisk: true,
    }, conversationId, selectedWorkspace);
    assert.equal(response.status, 200);
    return await response.json() as ApprovalModeState;
  };
  const connect = async (token: string) => {
    const socket = new WebSocket(`${base.replace("http:", "ws:")}/ws/chat?token=${encodeURIComponent(token)}`);
    const frames: Array<Record<string, any>> = [];
    socket.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
    clients.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    return { socket, frames, send: (message: unknown) => socket.send(JSON.stringify(message)) };
  };
  const createRun = async (token: string, conversationId = "task") => {
    const session = manager.getSession(token);
    assert.ok(session);
    await appendConversationMessage(session.workspaceDir, conversationId, {
      role: "user", content: "Synthetic approval fixture", timestamp: Date.now(),
    });
    const recorder = new AgentRunRecorder(session.workspaceDir, `synthetic-run-${runs.length}`, conversationId, "code");
    await recorder.start();
    const run = createActiveRun({ session, recorder, queueSteering: async () => ({ ok: true, code: "accepted" }) });
    runs.push(run);
    return run;
  };
  return { root, workspace, otherWorkspace, manager, teams, request, login, windowToken, readMode, writeMode, enable, connect, createRun };
}

test("real HTTP defaults to individual approval and requires a user risk acknowledgment", async (t) => {
  const api = await fixture(t);
  const token = await api.login();
  const initial = await api.readMode(token);
  assert.deepEqual(initial, {
    mode: "ask", workspaceDir: api.workspace, conversationId: "task", revision: 0, canEnable: true,
  });
  for (const acknowledgeRisk of [undefined, false, "true"]) {
    const response = await api.writeMode(token, { mode: "full_access", expectedRevision: 0, acknowledgeRisk });
    assert.equal(response.status, 403);
    assert.deepEqual(await api.readMode(token), initial);
  }
  const enabled = await api.enable(token);
  assert.equal(enabled.mode, "full_access");
  assert.equal(enabled.revision, 1);
  assert.deepEqual(await api.readMode(token), enabled);
  const disabled = await api.writeMode(token, { mode: "ask", expectedRevision: enabled.revision });
  assert.equal(disabled.status, 200);
  const disabledState = await disabled.json() as ApprovalModeState;
  assert.equal(disabledState.mode, "ask");
  assert.equal(disabledState.revision, 2);
  assert.deepEqual(await api.readMode(token), disabledState);
});

test("real HTTP serializes concurrent mode changes and rejects stale re-enablement", async (t) => {
  const api = await fixture(t);
  const token = await api.login();
  const responses = await Promise.all([
    api.writeMode(token, { mode: "full_access", expectedRevision: 0, acknowledgeRisk: true }),
    api.writeMode(token, { mode: "full_access", expectedRevision: 0, acknowledgeRisk: true }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const enabled = await api.readMode(token);
  assert.equal(enabled.mode, "full_access");
  assert.equal(enabled.revision, 1);
  const conflict = await responses.find((response) => response.status === 409)!.json() as { state: ApprovalModeState };
  assert.deepEqual(conflict.state, enabled);
  assert.equal((await api.writeMode(token, { mode: "ask", expectedRevision: 1 })).status, 200);
  const staleEnable = await api.writeMode(token, { mode: "full_access", expectedRevision: 1, acknowledgeRisk: true });
  assert.equal(staleEnable.status, 409);
  const final = await api.readMode(token);
  assert.equal(final.mode, "ask");
  assert.equal(final.revision, 2);
});

test("real HTTP validates credentials, workspace binding and mode input before granting access", async (t) => {
  const api = await fixture(t);
  const token = await api.login();
  const route = "/api/chat/conversations/task/approval-mode";
  const grant = { mode: "full_access", expectedRevision: 0, acknowledgeRisk: true };
  assert.equal((await api.request(route)).status, 401);
  assert.equal((await api.request(route, { method: "PUT", body: grant, workspaceHeader: encodeURIComponent(api.workspace) })).status, 401);
  assert.equal((await api.writeMode("forged-session-token", grant)).status, 401);
  assert.equal((await api.request(route, { token, method: "PUT", body: grant })).status, 400);
  assert.equal((await api.writeMode(token, grant, "task", api.otherWorkspace)).status, 409);
  assert.equal((await api.request(route, { token, method: "PUT", body: grant, workspaceHeader: "%broken" })).status, 400);
  for (const body of [
    { mode: "full_access", acknowledgeRisk: true },
    { ...grant, expectedRevision: -1 },
    { ...grant, expectedRevision: 0.5 },
    { ...grant, expectedRevision: "0" },
    { ...grant, mode: "admin" },
  ]) assert.equal((await api.writeMode(token, body)).status, 400);
  assert.equal((await api.writeMode(token, grant, "../foreign")).status, 400);
  assert.equal((await api.readMode(token)).mode, "ask");
});

test("real HTTP refresh preserves the login scope while isolating other users, logins, tasks and workspaces", async (t) => {
  const api = await fixture(t);
  const loginToken = await api.login();
  const firstWindow = await api.windowToken(loginToken);
  const enabled = await api.enable(firstWindow);
  const refreshedWindow = await api.windowToken(loginToken);
  assert.notEqual(firstWindow, refreshedWindow);
  assert.deepEqual(await api.readMode(refreshedWindow), enabled);
  assert.equal((await api.readMode(refreshedWindow, "other-task")).mode, "ask");
  const otherWorkspaceWindow = await api.windowToken(loginToken, api.otherWorkspace);
  assert.equal((await api.readMode(otherWorkspaceWindow, "task", api.otherWorkspace)).mode, "ask");
  const secondLogin = await api.login();
  assert.equal((await api.readMode(secondLogin)).mode, "ask");
  const bob = await api.login("bob");
  assert.equal((await api.readMode(bob)).mode, "ask");
  const isolatedWorkspace = path.join(api.root, ".crownforge-worktrees", "project", "isolated");
  fs.mkdirSync(isolatedWorkspace, { recursive: true });
  const isolated = api.manager.createIsolatedSession(loginToken, isolatedWorkspace);
  assert.equal((await api.readMode(isolated.token, "task", isolatedWorkspace)).mode, "ask");
  assert.deepEqual(await api.readMode(firstWindow), enabled);
});

test("real HTTP refuses read-only roles and immediately loses a grant after role downgrade", async (t) => {
  const api = await fixture(t);
  const team = api.teams.createTeam({ username: "owner", teamName: "Synthetic team", workspaceDir: api.workspace });
  for (const username of ["alice", "reader"]) {
    const invite = api.teams.createInvite(team.id, "owner", "member");
    api.teams.joinTeamByInvite(invite.code, username);
  }
  api.teams.updateMemberRole(team.id, "owner", "reader", "viewer");
  const reader = await api.login("reader");
  const readOnly = await api.readMode(reader);
  assert.equal(readOnly.mode, "ask");
  assert.equal(readOnly.canEnable, false);
  assert.equal((await api.writeMode(reader, {
    mode: "full_access", expectedRevision: readOnly.revision, acknowledgeRisk: true, canEnable: true, isAdmin: true,
  })).status, 403);
  const alice = await api.login();
  await api.enable(alice);
  api.teams.updateMemberRole(team.id, "owner", "alice", "viewer");
  const downgraded = await api.readMode(alice);
  assert.equal(downgraded.mode, "ask");
  assert.equal(downgraded.canEnable, false);
  assert.equal((await api.writeMode(alice, {
    mode: "full_access", expectedRevision: downgraded.revision, acknowledgeRisk: true,
  })).status, 403);
});

test("real HTTP cannot enable Web full access in the desktop runtime even with an authenticated token", async (t) => {
  const api = await fixture(t);
  const token = await api.login();
  process.env.CREWFORGE_DESKTOP = "1";
  t.after(() => { delete process.env.CREWFORGE_DESKTOP; });
  const state = await api.readMode(token);
  assert.equal(state.mode, "ask");
  assert.equal(state.canEnable, false);
  assert.equal((await api.writeMode(token, {
    mode: "full_access", expectedRevision: state.revision, acknowledgeRisk: true,
  })).status, 403);
});

test("real HTTP logout revokes the parent login and refreshed window tokens", async (t) => {
  const api = await fixture(t);
  const parent = await api.login();
  const window = await api.windowToken(parent);
  await api.enable(window);
  assert.equal((await api.request("/api/auth/logout", { token: parent, method: "POST" })).status, 200);
  const route = "/api/chat/conversations/task/approval-mode";
  assert.equal((await api.request(route, { token: parent })).status, 401);
  assert.equal((await api.request(route, { token: window })).status, 401);
  assert.equal((await api.writeMode(window, { mode: "full_access", expectedRevision: 1, acknowledgeRisk: true })).status, 401);
  const nextLogin = await api.login();
  assert.equal((await api.readMode(nextLogin)).mode, "ask");
  api.manager.getSession(nextLogin)!.expiresAt = Date.now() - 1;
  assert.equal((await api.request(route, { token: nextLogin })).status, 401);
});

test("real WS client approval flags cannot elevate the server-owned mode or resolve pending requests", async (t) => {
  const api = await fixture(t);
  const token = await api.login();
  const run = await api.createRun(token);
  const pending = run.approvals.requestDetailed({
    conversationId: "task", requestId: "synthetic-request", toolCallId: "synthetic-call",
    name: "bash", input: { command: "echo synthetic" }, risk: "high", reason: "Synthetic approval", scope: "Synthetic action", canAllowSession: false,
  });
  const client = await api.connect(token);
  client.send({
    type: "subscribe_run", conversationId: "task", approvalMode: "full_access", full_access: true,
    acknowledgeRisk: true, ownerSessionToken: token, permissions: "full-access",
  });
  await waitUntil(() => client.frames.some((frame) => frame.type === "conversation_snapshot"));
  assert.equal((await api.readMode(token)).mode, "ask");
  assert.equal(run.approvals.pendingCount(), 1);
  assert.equal(client.frames.find((frame) => frame.type === "conversation_snapshot")!.pendingApprovals.length, 1);
  client.send({ type: "approval_mode", conversationId: "task", mode: "full_access", acknowledgeRisk: true });
  await waitUntil(() => client.frames.some((frame) => frame.type === "error"));
  assert.equal((await api.readMode(token)).mode, "ask");
  assert.equal(run.approvals.pendingCount(), 1);
  run.approvals.cancelAll();
  assert.equal((await pending).decision, "deny");
});

test("HTTP mode changes govern an active authorization gate without approving existing pending work", async (t) => {
  const api = await fixture(t);
  const token = await api.login();
  const session = api.manager.getSession(token)!;
  const run = await api.createRun(token);
  const authorizationOptions = {
    readOnly: false, workspace: api.workspace, runId: run.runId,
    getFullAccessGrant: () => getFullAccessGrant(session, "task"),
    requestApproval: (input: Parameters<typeof run.approvals.requestDetailed>[0]) =>
      run.approvals.requestDetailed({ ...input, conversationId: "task" }),
  };
  const authorize = createPermissionAuthorizer({ ...authorizationOptions, mode: "code" });
  const request = {
    requestId: "synthetic-permission-request", toolCallId: "before-enable", agentName: "primary",
    name: "bash", input: { command: "echo synthetic" },
  };
  const beforeEnable = authorize(request);
  await waitUntil(() => run.approvals.pendingCount() === 1);
  const existingApprovalId = run.approvals.listPending()[0].approvalId;
  const enabled = await api.enable(token);
  assert.equal(run.approvals.pendingCount(), 1);
  assert.equal(run.approvals.listPending()[0].approvalId, existingApprovalId);
  const automatic = await authorize({ ...request, toolCallId: "after-enable" });
  assert.equal(automatic.allowed, true);
  assert.equal(automatic.decision, "full_access");
  assert.deepEqual(automatic.fullAccessGrant, getFullAccessGrant(session, "task"));
  assert.equal(run.approvals.pendingCount(), 1);

  // Full access removes the prompt only. Existing filesystem, mode and role
  // policies still deny these synthetic actions before any tool is executed.
  for (const blockedPath of ["../escape.txt", "users.json", ".crewforge/forged-grant.json"]) {
    const blocked = await authorize({ ...request, name: "write_file", input: { path: blockedPath }, toolCallId: blockedPath });
    assert.equal(blocked.allowed, false);
  }
  const readOnly = createPermissionAuthorizer({ ...authorizationOptions, mode: "code", readOnly: true });
  assert.equal((await readOnly(request)).allowed, false);
  const ask = createPermissionAuthorizer({ ...authorizationOptions, mode: "ask" });
  assert.equal((await ask(request)).allowed, false);

  const plan = createPermissionAuthorizer({ ...authorizationOptions, mode: "plan" });
  const planDecision = plan({ ...request, name: "submit_plan", input: { goal: "Synthetic plan" }, toolCallId: "plan" });
  await waitUntil(() => run.approvals.pendingCount() === 2);
  const planApproval = run.approvals.listPending().find((approval) => approval.name === "submit_plan")!;
  assert.ok(planApproval);
  run.approvals.resolve(planApproval.approvalId, "deny");
  assert.equal((await planDecision).allowed, false);

  assert.equal((await api.writeMode(token, { mode: "ask", expectedRevision: enabled.revision })).status, 200);
  assert.equal(getFullAccessGrant(session, "task"), null);
  const afterDisable = authorize({ ...request, toolCallId: "after-disable" });
  await waitUntil(() => run.approvals.pendingCount() === 2);
  assert.ok(run.approvals.listPending().some((approval) => approval.toolCallId === "after-disable"));
  assert.ok(run.approvals.listPending().some((approval) => approval.approvalId === existingApprovalId));
  run.approvals.cancelAll();
  assert.equal((await beforeEnable).allowed, false);
  assert.equal((await afterDisable).allowed, false);

  const auditPath = path.join(api.workspace, ".crewforge", "policy-audit.jsonl");
  const audit = fs.readFileSync(auditPath, "utf8");
  assert.equal(new PolicyAuditLog(auditPath).verify().valid, true);
  const entries = audit.trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
  assert.ok(entries.some((entry) => entry.toolName === "user_approval_mode" && entry.allowed === true));
  assert.ok(entries.some((entry) => entry.toolName === "user_approval_mode" && entry.allowed === false));
  assert.ok(entries.some((entry) => entry.toolCallId === "after-enable" && entry.allowed === true));
  assert.ok(!audit.includes(token), "audit must not contain the bearer credential");
});
