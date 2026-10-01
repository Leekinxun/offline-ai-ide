import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyToolApproval } from "../agent/toolApproval.js";
import { SessionManager, sessionManager, setSessionManagerForTests, type UserSession } from "../auth/sessionManager.js";
import { TeamManager } from "../team/teamManager.js";
import { setTeamManagerForTests } from "../team/sessionBridge.js";
import { AgentRunRecorder } from "./runHistory.js";
import { createActiveRun, stopRunsForSession } from "./runCoordinator.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-grants-"));
  const a = path.join(root, "a"); const b = path.join(root, "b"); fs.mkdirSync(a); fs.mkdirSync(b);
  const users = path.join(root, "users.json");
  fs.writeFileSync(users, JSON.stringify({ allowedRoots: [root], users: [{ username: "tester", password: "secret", defaultWorkspace: a, isAdmin: true }] }));
  const manager = new SessionManager(users); const previous = sessionManager;
  setSessionManagerForTests(manager);
  const teams = new TeamManager(path.join(root, "store")); setTeamManagerForTests(teams);
  const unsubscribe = manager.onSessionRevoked(stopRunsForSession);
  const active: ReturnType<typeof createActiveRun>[] = [];
  let count = 0;
  const run = (session: UserSession, conversation = "chat", ownerSessionToken?: string) => {
    const current = createActiveRun({ session: { ...session }, ownerSessionToken,
      recorder: new AgentRunRecorder(session.workspaceDir, `run-${++count}`, conversation, "code"),
      queueSteering: async () => ({ ok: true, code: "accepted" }),
    });
    active.push(current); return current;
  };
  t.after(() => {
    for (const current of active) { current.forceStop(); current.finish(); }
    unsubscribe(); setSessionManagerForTests(previous); setTeamManagerForTests(null); fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, a, b, manager, teams, run };
}

function request(active: ReturnType<typeof createActiveRun>, name = "edit_file", input: Record<string, unknown> = { path: "calc.py" }) {
  const requirement = classifyToolApproval(name, input, { workspaceDir: active.workspaceDir });
  assert.equal(requirement.kind, "approval");
  if (requirement.kind !== "approval") throw new Error("expected approval");
  return active.approvals.requestDetailed({ ...requirement, conversationId: active.conversationId,
    requestId: "req", toolCallId: "tool", name, input });
}

async function pendingThenDeny(active: ReturnType<typeof createActiveRun>) {
  const pending = request(active);
  assert.equal(active.approvals.pendingCount(), 1);
  active.approvals.cancelAll(); assert.equal((await pending).decision, "deny"); active.finish();
}

test("bulk grants survive a fresh window token, continuation, and child logout within the same login", async (t) => {
  const { manager, run } = fixture(t);
  const login = manager.login("tester", "secret")!;
  const firstWindow = manager.createWindowSession(login.token);
  const first = run(manager.getSession(firstWindow.token)!);
  const initial = request(first);
  assert.equal(first.approvals.allowConversation("chat"), 1);
  assert.equal((await initial).decision, "allow_once"); first.finish();
  const refreshedWindow = manager.createWindowSession(login.token);
  assert.notEqual(firstWindow.token, refreshedWindow.token);
  const continued = run(manager.getSession(refreshedWindow.token)!);
  assert.equal(continued.ownerSessionToken, refreshedWindow.token);
  assert.equal((await request(continued)).decision, "allow_once");
  assert.equal((await request(continued, "bash", { command: "python -m unittest -v" })).decision, "allow_once");
  manager.logout(refreshedWindow.token);
  assert.equal(continued.controlState.stopped, true); continued.finish();
  const thirdWindow = manager.createWindowSession(login.token);
  const afterChildLogout = run(manager.getSession(thirdWindow.token)!);
  assert.equal((await request(afterChildLogout)).decision, "allow_once");
  const snapshot = { ...manager.getSession(thirdWindow.token)! };
  manager.logout(login.token);
  assert.equal(afterChildLogout.controlState.stopped, true); afterChildLogout.finish();
  assert.equal(manager.getApprovalScopeToken(snapshot), null);
  assert.throws(() => run(snapshot), /expired/);
  const nextLogin = manager.login("tester", "secret")!;
  const nextWindow = manager.createWindowSession(nextLogin.token);
  await pendingThenDeny(run(manager.getSession(nextWindow.token)!));
});

test("scope grants retain exact command limits and cannot cross workspaces, conversations, logins or isolated windows", async (t) => {
  const { root, a, b, manager, run } = fixture(t);
  const login = manager.login("tester", "secret")!;
  const window = manager.createWindowSession(login.token);
  const first = run(manager.getSession(window.token)!);
  const initial = request(first, "bash", { command: "npm test" });
  first.approvals.resolve(first.approvals.listPending()[0].approvalId, "allow_session");
  assert.equal((await initial).decision, "allow_session"); first.finish();
  const refreshed = manager.createWindowSession(login.token);
  const continued = run(manager.getSession(refreshed.token)!);
  assert.equal((await request(continued, "bash", { command: "npm test" })).decision, "allow_session");
  const differentCommand = request(continued, "bash", { command: "npm run build" });
  assert.equal(continued.approvals.pendingCount(), 1); continued.approvals.cancelAll(); await differentCommand;
  continued.approvals.allowConversation("chat"); continued.finish();
  const otherWorkspace = manager.createWindowSession(login.token, b);
  await pendingThenDeny(run(manager.getSession(otherWorkspace.token)!));
  await pendingThenDeny(run(manager.getSession(refreshed.token)!, "another-chat"));
  const otherLogin = manager.login("tester", "secret")!;
  const otherWindow = manager.createWindowSession(otherLogin.token, a);
  await pendingThenDeny(run(manager.getSession(otherWindow.token)!));
  const worktree = path.join(root, ".crownforge-worktrees", "project", "vibe"); fs.mkdirSync(worktree, { recursive: true });
  const ordinaryWorktree = manager.createWindowSession(login.token, worktree);
  const ordinary = run(manager.getSession(ordinaryWorktree.token)!); ordinary.approvals.allowConversation("chat"); ordinary.finish();
  const isolated = manager.createIsolatedSession(login.token, worktree);
  await pendingThenDeny(run(manager.getSession(isolated.token)!));
  assert.equal(manager.getApprovalScopeToken(manager.getSession(isolated.token)!), isolated.token);
});

test("registered identities cannot borrow a parent's cache through fake sessions or an owner-token override", async (t) => {
  const { manager, run } = fixture(t);
  const login = manager.login("tester", "secret")!;
  const window = manager.createWindowSession(login.token);
  const session = manager.getSession(window.token)!;
  const first = run(session); first.approvals.allowConversation("chat"); first.finish();
  assert.equal(manager.getApprovalScopeToken({ ...session, username: "someone-else" }), null);
  assert.throws(() => run({ ...session, username: "someone-else" }), /does not match/);
  const other = manager.login("tester", "secret")!;
  assert.throws(() => run(session, "chat", other.token), /token does not match/);
  const fake = { ...session, token: "unregistered-test-session", createdAt: undefined, lastSeenAt: undefined, expiresAt: undefined };
  assert.equal(manager.getApprovalScopeToken(fake), null);
  const fakeRun = run(fake); fakeRun.approvals.allowConversation("chat"); fakeRun.finish();
  await pendingThenDeny(run(fake));
});

test("fresh viewer and removed-member runs do not reuse cached parent grants", async (t) => {
  const { a, manager, teams, run } = fixture(t);
  const login = manager.login("tester", "secret")!;
  const team = teams.createTeam({ username: "owner", teamName: "Shared", workspaceDir: a });
  const invite = teams.createInvite(team.id, "owner", "member"); teams.joinTeamByInvite(invite.code, "tester");
  const window = manager.createWindowSession(login.token);
  const first = run(manager.getSession(window.token)!); first.approvals.allowConversation("chat"); first.finish();
  teams.updateMemberRole(team.id, "owner", "tester", "viewer");
  const viewer = manager.createWindowSession(login.token);
  const viewerSession = manager.getSession(viewer.token)!;
  assert.equal(manager.getApprovalScopeToken(viewerSession), null);
  const viewerRun = run(viewerSession);
  const viewerPending = request(viewerRun); assert.equal(viewerRun.approvals.pendingCount(), 1);
  viewerRun.stopIfAccessRevoked(); assert.equal(viewerRun.controlState.stopped, true);
  assert.equal((await viewerPending).decision, "deny"); viewerRun.finish();
  teams.removeMember(team.id, "owner", "tester");
  const removed = manager.createWindowSession(login.token);
  assert.equal(manager.getApprovalScopeToken(manager.getSession(removed.token)!), null);
  const removedRun = run(manager.getSession(removed.token)!);
  const removedPending = request(removedRun); assert.equal(removedRun.approvals.pendingCount(), 1);
  removedRun.stopIfAccessRevoked(); assert.equal(removedRun.controlState.stopped, true);
  assert.equal((await removedPending).decision, "deny"); removedRun.finish();
});

test("absolute expiry and password reset revoke parent-scoped grants and their child runs", async (t) => {
  const { manager, run } = fixture(t);
  for (const revoke of ["expiry", "password"] as const) {
    const login = manager.login("tester", "secret")!;
    const window = manager.createWindowSession(login.token);
    const snapshot = { ...manager.getSession(window.token)! };
    const active = run(snapshot); active.approvals.allowConversation("chat");
    if (revoke === "expiry") {
      manager.getSession(login.token)!.expiresAt = Date.now() - 1;
      assert.equal(manager.getApprovalScopeToken(snapshot), null);
    } else manager.updateUserPassword("tester", "new-secret");
    assert.equal(active.controlState.stopped, true); active.finish();
    assert.throws(() => run(snapshot), /expired/);
    const next = manager.login("tester", revoke === "password" ? "new-secret" : "secret")!;
    const nextWindow = manager.createWindowSession(next.token);
    await pendingThenDeny(run(manager.getSession(nextWindow.token)!));
    manager.logout(next.token);
  }
});
