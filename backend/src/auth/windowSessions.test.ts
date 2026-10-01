import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { authMiddleware, getWsSession } from "./middleware.js";
import { SessionManager, sessionManager, setSessionManagerForTests } from "./sessionManager.js";
import { authRouter } from "../routes/auth.js";
import { filesRouter } from "../routes/files.js";
import { teamRouter } from "../routes/team.js";
import { runRouter } from "../routes/run.js";
import { TeamManager } from "../team/teamManager.js";
import { getActiveTeamId, setTeamManagerForTests } from "../team/sessionBridge.js";
import { getDiagnostics, startDiagnosticsSession, stopDiagnosticsSession } from "../diagnostics/service.js";
import { handleChatWs } from "../ws/chat.js";
import { handleTerminalWs } from "../ws/terminal.js";
import { appendConversationMessage } from "../chat/history.js";
import { AgentRunRecorder } from "../chat/runHistory.js";
import { createActiveRun, stopRunsForSession } from "../chat/runCoordinator.js";

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for isolated workspace event");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function fixture(t: test.TestContext, admin = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-window-http-"));
  const a = path.join(root, "a"); const b = path.join(root, "b");
  fs.mkdirSync(a); fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, "marker.txt"), "workspace-a");
  fs.writeFileSync(path.join(b, "marker.txt"), "workspace-b");
  const users = path.join(root, "users.json");
  fs.writeFileSync(users, JSON.stringify({ allowedRoots: [root], users: [{ username: "alice", password: "secret", defaultWorkspace: a, isAdmin: admin }] }));
  const manager = new SessionManager(users);
  const prior = sessionManager;
  setSessionManagerForTests(manager);
  const teams = new TeamManager(path.join(root, "team-store"));
  setTeamManagerForTests(teams);
  t.after(() => { setSessionManagerForTests(prior); setTeamManagerForTests(null); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, a: fs.realpathSync(a), b: fs.realpathSync(b), manager, teams };
}

async function serve(t: test.TestContext) {
  const app = express(); app.use(express.json());
  app.use("/api/auth", authRouter);
  app.use("/api/files", authMiddleware, filesRouter);
  app.use("/api/team", authMiddleware, teamRouter);
  app.use("/api/run", authMiddleware, runRouter);
  const server = http.createServer(app);
  const wsServer = new WebSocketServer({ server });
  const clients: WebSocket[] = [];
  wsServer.on("connection", (ws, req) => {
    const session = getWsSession(req);
    if (!session) { ws.close(1008); return; }
    if (req.url?.startsWith("/ws/terminal")) handleTerminalWs(ws, session);
    else handleChatWs(ws, session);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  t.after(async () => {
    for (const client of clients) client.terminate();
    for (const socket of wsServer.clients) socket.terminate();
    await new Promise<void>((resolve) => wsServer.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${address.port}`;
  const request = (route: string, token: string, body?: unknown) => fetch(base + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const connect = async (route: string, token: string) => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}${route}?token=${encodeURIComponent(token)}`);
    const frames: any[] = []; const output: string[] = [];
    socket.on("message", (raw) => { output.push(raw.toString()); try { frames.push(JSON.parse(raw.toString())); } catch { /* PTY bytes */ } });
    clients.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    return { socket, frames, output };
  };
  return { request, connect };
}

test("window API tokens isolate files, chat subscriptions and terminal cwd during another tab's switch", async (t) => {
  const { a, b, manager } = fixture(t);
  const server = await serve(t);
  const login = manager.login("alice", "secret")!;
  const responseA = await server.request("/api/auth/session/window", login.token, {});
  const responseB = await server.request("/api/auth/session/window", login.token, {});
  assert.equal(responseA.status, 200); assert.equal(responseB.status, 200);
  const windowA = await responseA.json() as { token: string };
  const windowB = await responseB.json() as { token: string };
  assert.notEqual(windowA.token, windowB.token);
  await appendConversationMessage(a, "old-task", { role: "user", content: "seed", timestamp: Date.now() });
  const chat = await server.connect("/ws/chat", windowB.token);
  chat.socket.send(JSON.stringify({ type: "subscribe_run", conversationId: "old-task" }));
  await waitUntil(() => chat.frames.some((frame) => frame.type === "conversation_snapshot"));
  const terminal = await server.connect("/ws/terminal", windowB.token);
  const recorder = new AgentRunRecorder(a, "isolated-background-run", "old-task", "ask");
  await recorder.start();
  const run = createActiveRun({ session: { ...manager.getSession(windowB.token)! }, recorder, queueSteering: async () => ({ ok: true, code: "accepted" }) });
  t.after(() => { run.forceStop(); run.finish(); stopDiagnosticsSession(a); });
  await startDiagnosticsSession(a);
  const changed = await server.request("/api/auth/workspace/change", windowA.token, { path: b });
  assert.equal(changed.status, 200);
  assert.equal(manager.getSession(login.token)?.workspaceDir, a);
  assert.equal((await (await server.request("/api/files/read?path=marker.txt", windowA.token)).json() as { content: string }).content, "workspace-b");
  assert.equal((await (await server.request("/api/files/read?path=marker.txt", windowB.token)).json() as { content: string }).content, "workspace-a");
  assert.equal((await (await server.request("/api/files/read?path=marker.txt", login.token)).json() as { content: string }).content, "workspace-a");
  const write = await server.request("/api/files/write", windowB.token, { path: "from-b.txt", content: "kept in original workspace" });
  assert.equal(write.status, 200);
  assert.ok(fs.existsSync(path.join(a, "from-b.txt")));
  assert.equal(fs.existsSync(path.join(b, "from-b.txt")), false);
  assert.equal(getDiagnostics(a).session.status, "watching");
  assert.equal(run.workspaceDir, a); assert.equal(run.controlState.stopped, false);
  run.emit({ type: "token", requestId: "isolated-event", content: "still-original" });
  await waitUntil(() => chat.frames.some((frame) => frame.type === "token" && frame.content === "still-original"));
  terminal.socket.send(JSON.stringify({ type: "input", data: "printf '__CF_ISOLATED_CWD__'; pwd\n" }));
  await waitUntil(() => terminal.output.join("").includes(`__CF_ISOLATED_CWD__${a}`));
  const restored = await server.request("/api/auth/session/window", login.token, { path: b });
  assert.equal(restored.status, 200);
  assert.notEqual((await restored.json() as { token: string }).token, windowA.token);
  assert.equal((await server.request("/api/run", windowA.token)).status, 200);
  assert.equal((await server.request("/api/run", windowB.token)).status, 200);
  assert.equal((await server.request("/api/auth/session/window", login.token, { path: 42 })).status, 400);
  assert.equal((await server.request("/api/auth/session/window", "invalid", {})).status, 401);
});

test("team activation and authorized folder restoration belong to one window and recheck membership", async (t) => {
  const { root, a, b, manager, teams } = fixture(t, false);
  const server = await serve(t);
  const login = manager.login("alice", "secret")!;
  const windowA = manager.createWindowSession(login.token);
  const windowB = manager.createWindowSession(login.token);
  const team = teams.createTeam({ username: "owner", teamName: "Shared", workspaceDir: b });
  const invite = teams.createInvite(team.id, "owner", "member");
  const joined = await server.request("/api/team/join", windowA.token, { code: invite.code });
  assert.equal(joined.status, 200);
  assert.equal(manager.getSession(windowA.token)?.workspaceDir, b);
  assert.equal(manager.getSession(windowB.token)?.workspaceDir, a);
  assert.equal(getActiveTeamId(manager.getSession(windowA.token)!), team.id);
  assert.equal(getActiveTeamId(manager.getSession(windowB.token)!), null);
  const nested = path.join(b, "nested"); fs.mkdirSync(nested);
  const restore = await server.request("/api/auth/session/window", login.token, { path: nested });
  assert.equal(restore.status, 200);
  const restored = await restore.json() as { workspaceRoot: string };
  assert.equal(restored.workspaceRoot, b);
  const nestedWindow = manager.createWindowSession(login.token, nested);
  await appendConversationMessage(nested, "nested-task", { role: "user", content: "seed", timestamp: Date.now() });
  const nestedChat = await server.connect("/ws/chat", nestedWindow.token);
  nestedChat.socket.send(JSON.stringify({ type: "subscribe_run", conversationId: "nested-task" }));
  await waitUntil(() => nestedChat.frames.some((frame) => frame.type === "conversation_snapshot"));
  const recorder = new AgentRunRecorder(nested, "nested-run", "nested-task", "code");
  const run = createActiveRun({ session: { ...manager.getSession(nestedWindow.token)! }, recorder, queueSteering: async () => ({ ok: true, code: "accepted" }) });
  t.after(() => { run.forceStop(); run.finish(); });
  run.stopIfAccessRevoked();
  assert.equal(run.controlState.stopped, false);
  teams.updateMemberRole(team.id, "owner", "alice", "viewer");
  assert.equal((await server.request("/api/files/write", nestedWindow.token, { path: "viewer.txt", content: "blocked" })).status, 403);
  assert.equal(fs.existsSync(path.join(nested, "viewer.txt")), false);
  teams.removeMember(team.id, "owner", "alice");
  assert.equal((await server.request("/api/files/write", nestedWindow.token, { path: "removed.txt", content: "blocked" })).status, 403);
  assert.equal((await server.request("/api/auth/session/window", login.token, { path: nested })).status, 403);
  const worktree = path.join(root, ".crownforge-worktrees", "project", "isolated"); fs.mkdirSync(worktree, { recursive: true });
  const isolated = manager.createIsolatedSession(login.token, worktree);
  assert.equal((await server.request("/api/auth/session/window", isolated.token, {})).status, 403);
  assert.equal((await server.request("/api/team/switch", isolated.token, { teamId: team.id })).status, 403);
});

test("Code admission locks parent and child roots while preserving sibling and read-only concurrency", async (t) => {
  const { root, a, b, manager } = fixture(t);
  const login = manager.login("alice", "secret")!;
  const child = path.join(a, "nested"); fs.mkdirSync(child);
  const siblingPrefix = path.join(root, "a-other"); fs.mkdirSync(siblingPrefix);
  const active: ReturnType<typeof createActiveRun>[] = [];
  t.after(() => { for (const run of active) { run.forceStop(); run.finish(); } });
  const create = (workspaceDir: string, id: string, mode: "code" | "ask" | "review") => {
    const session = { ...manager.getSession(login.token)!, workspaceDir };
    const run = createActiveRun({ session, recorder: new AgentRunRecorder(workspaceDir, id, id, mode), queueSteering: async () => ({ ok: true, code: "accepted" }) });
    active.push(run); return run;
  };
  const parent = create(a, "parent", "code");
  assert.throws(() => create(child, "child", "code"), /Another Code task/);
  const reader = create(child, "reader", "ask");
  create(child, "reviewer", "review");
  assert.throws(() => reader.setRecorder(new AgentRunRecorder(child, "promote", "reader", "code")), /Another Code task/);
  create(b, "sibling", "code"); create(siblingPrefix, "prefix-sibling", "code");
  parent.finish();
  create(child, "child-writer", "code");
  assert.throws(() => create(a, "parent-again", "code"), /Another Code task/);
  if (process.platform !== "win32") {
    const alias = path.join(root, "alias"); fs.symlinkSync(a, alias, "dir");
    assert.throws(() => create(alias, "alias-parent", "code"), /Another Code task/);
  }
});

test("login revocation stops all derived window runs through the existing session lifecycle", async (t) => {
  const { a, b, manager } = fixture(t);
  const login = manager.login("alice", "secret")!;
  const windows = [manager.createWindowSession(login.token, a), manager.createWindowSession(login.token, b)];
  const runs = windows.map((window, index) => createActiveRun({ session: { ...manager.getSession(window.token)! }, recorder: new AgentRunRecorder(window.workspaceDir, `revoke-${index}`, `revoke-${index}`, "ask"), queueSteering: async () => ({ ok: true, code: "accepted" }) }));
  const unsubscribe = manager.onSessionRevoked((token) => stopRunsForSession(token));
  t.after(() => { unsubscribe(); for (const run of runs) { run.forceStop(); run.finish(); } });
  manager.logout(login.token);
  for (const run of runs) assert.equal(run.controlState.stopped, true);
});

test("real WS bulk approval continues after child token refresh but ends with the parent login", async (t) => {
  const { a, manager } = fixture(t);
  const server = await serve(t);
  const unsubscribe = manager.onSessionRevoked(stopRunsForSession);
  t.after(unsubscribe);
  const login = manager.login("alice", "secret")!;
  const firstResponse = await server.request("/api/auth/session/window", login.token, {});
  const firstWindow = await firstResponse.json() as { token: string };
  const conversation = "refresh-approved-task";
  await appendConversationMessage(a, conversation, { role: "user", content: "seed", timestamp: Date.now() });
  const active: ReturnType<typeof createActiveRun>[] = [];
  t.after(() => { for (const run of active) { run.forceStop(); run.finish(); } });
  let count = 0;
  const create = (token: string) => {
    const run = createActiveRun({ session: { ...manager.getSession(token)! },
      recorder: new AgentRunRecorder(a, `refresh-grants-${++count}`, conversation, "code"),
      queueSteering: async () => ({ ok: true, code: "accepted" }),
    });
    active.push(run); return run;
  };
  const edit = (run: ReturnType<typeof createActiveRun>) => run.approvals.requestDetailed({
    conversationId: conversation, requestId: "edit", toolCallId: "edit", name: "edit_file",
    input: { path: "calc.py" }, risk: "medium", reason: "Add docstring", scope: "calc.py", canAllowSession: true,
  });
  const clientA = await server.connect("/ws/chat", firstWindow.token);
  clientA.socket.send(JSON.stringify({ type: "subscribe_run", conversationId: conversation }));
  await waitUntil(() => clientA.frames.some((frame) => frame.type === "conversation_snapshot"));
  const first = create(firstWindow.token);
  const initial = edit(first);
  await waitUntil(() => clientA.frames.some((frame) => frame.type === "tool_approval_request"));
  clientA.socket.send(JSON.stringify({ type: "tool_approval_all", conversationId: conversation, runId: first.runId }));
  assert.equal((await initial).decision, "allow_once");
  await waitUntil(() => clientA.frames.some((frame) => frame.type === "tool_approval_all_result"));
  first.finish(); clientA.socket.terminate();
  const refreshResponse = await server.request("/api/auth/session/window", login.token, { path: a });
  const refreshedWindow = await refreshResponse.json() as { token: string; workspaceDir: string };
  assert.notEqual(refreshedWindow.token, firstWindow.token);
  assert.equal(refreshedWindow.workspaceDir, a);
  assert.equal(manager.getSession(login.token)?.token, login.token);
  const refreshedClient = await server.connect("/ws/chat", refreshedWindow.token);
  refreshedClient.socket.send(JSON.stringify({ type: "subscribe_run", conversationId: conversation }));
  await waitUntil(() => refreshedClient.frames.some((frame) => frame.type === "conversation_snapshot"));
  const continued = create(refreshedWindow.token);
  assert.equal(continued.ownerSessionToken, refreshedWindow.token);
  assert.equal((await edit(continued)).decision, "allow_once");
  assert.equal(continued.approvals.pendingCount(), 0);
  assert.equal(refreshedClient.frames.some((frame) => frame.type === "tool_approval_request"), false);
  assert.equal((await server.request("/api/auth/logout", refreshedWindow.token, {})).status, 200);
  assert.equal(continued.controlState.stopped, true); continued.finish();
  const afterChildLogout = await server.request("/api/auth/session/window", login.token, { path: a });
  const thirdWindow = await afterChildLogout.json() as { token: string };
  const third = create(thirdWindow.token);
  assert.equal((await edit(third)).decision, "allow_once");
  assert.equal((await server.request("/api/auth/logout", login.token, {})).status, 200);
  assert.equal(third.controlState.stopped, true); third.finish();
  assert.equal((await server.request("/api/auth/session/window", login.token, {})).status, 401);
  const nextLogin = manager.login("alice", "secret")!;
  const nextWindow = manager.createWindowSession(nextLogin.token);
  const next = create(nextWindow.token);
  const nextApproval = edit(next);
  assert.equal(next.approvals.pendingCount(), 1);
  next.approvals.cancelAll(); assert.equal((await nextApproval).decision, "deny"); next.finish();
});
