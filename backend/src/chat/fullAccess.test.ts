import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager, sessionManager, setSessionManagerForTests } from "../auth/sessionManager.js";
import { TeamManager } from "../team/teamManager.js";
import { setTeamManagerForTests } from "../team/sessionBridge.js";
import { FullAccessService, ApprovalModeError, getApprovalMode, getFullAccessGrant, updateApprovalMode } from "./fullAccess.js";
import { AgentRunRecorder } from "./runHistory.js";
import { createActiveRun } from "./runCoordinator.js";
import { classifyToolApproval } from "../agent/toolApproval.js";
import { PolicyAuditLog } from "../agent/policyAudit.js";

function fixture(t: test.TestContext) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-full-access-")));
  const a = path.join(root, "a"); const b = path.join(root, "b"); fs.mkdirSync(a); fs.mkdirSync(b);
  const users = path.join(root, "users.json");
  fs.writeFileSync(users, JSON.stringify({ allowedRoots: [root], users: [{ username: "tester", password: "secret", defaultWorkspace: a, isAdmin: true }] }));
  const manager = new SessionManager(users); const service = new FullAccessService(manager);
  const teams = new TeamManager(path.join(root, "store")); setTeamManagerForTests(teams);
  const login = manager.login("tester", "secret")!;
  const session = manager.getSession(login.token)!;
  t.after(() => { service.dispose(); setTeamManagerForTests(null); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, a, b, manager, service, teams, session };
}
const enable = { mode: "full_access" as const, expectedRevision: 0, acknowledgeRisk: true };

test("full access defaults to ask and requires explicit risk acknowledgement with revision CAS", (t) => {
  const { a, service, session } = fixture(t);
  assert.deepEqual(service.getState(session, "new-task"), { mode: "ask", workspaceDir: a, conversationId: "new-task", revision: 0, canEnable: true });
  assert.throws(() => service.update(session, "new-task", { ...enable, acknowledgeRisk: false }), (error) => error instanceof ApprovalModeError && error.status === 403);
  assert.throws(() => service.update(session, "new-task", { ...enable, expectedRevision: -1 }), /Invalid approval mode/);
  const enabled = service.update(session, "new-task", enable); assert.equal(enabled.mode, "full_access"); assert.equal(enabled.revision, 1);
  const grant = service.getGrant(session, "new-task")!; assert.ok(grant.grantId); assert.equal(grant.revision, 1);
  assert.throws(() => service.update(session, "new-task", enable), (error) => error instanceof ApprovalModeError && error.status === 409 && error.state?.revision === 1);
  const disabled = service.update(session, "new-task", { mode: "ask", expectedRevision: 1 });
  assert.equal(disabled.revision, 2); assert.equal(service.getGrant(session, "new-task"), null);
  assert.throws(() => service.update(session, "new-task", enable), /Approval mode changed/);
  const audit = new PolicyAuditLog(path.join(a, ".crewforge", "policy-audit.jsonl")); assert.deepEqual(audit.verify(), { valid: true, entries: 2 });
  const log = fs.readFileSync(audit.filePath, "utf8"); assert.match(log, /authenticated_user/); assert.match(log, new RegExp(grant.grantId)); assert.doesNotMatch(log, new RegExp(session.token));
});

test("verified login shares refresh state but separates workspace, task, login and isolated window", (t) => {
  const { root, a, b, manager, service, session } = fixture(t);
  service.update(session, "chat", enable);
  const refreshed = manager.createWindowSession(session.token, a);
  assert.equal(service.getState(manager.getSession(refreshed.token)!, "chat").mode, "full_access");
  assert.equal(service.getState(session, "another-chat").mode, "ask");
  const otherWorkspace = manager.createWindowSession(session.token, b);
  assert.equal(service.getState(manager.getSession(otherWorkspace.token)!, "chat").mode, "ask");
  const otherLogin = manager.login("tester", "secret")!;
  assert.equal(service.getState(manager.getSession(otherLogin.token)!, "chat").mode, "ask");
  const worktree = path.join(root, ".crownforge-worktrees", "project", "task"); fs.mkdirSync(worktree, { recursive: true });
  const normal = manager.createWindowSession(session.token, worktree); service.update(manager.getSession(normal.token)!, "chat", enable);
  const isolated = manager.createIsolatedSession(session.token, worktree);
  assert.equal(service.getState(manager.getSession(isolated.token)!, "chat").mode, "ask");
  assert.equal(service.getGrant({ ...session, username: "forged" }, "chat"), null);
  assert.equal(service.getGrant({ ...session, token: "forged" }, "chat"), null);
});

test("workspace switch invalidates old snapshots and never revives authorization when switching back", (t) => {
  const { a, b, manager, service, session } = fixture(t);
  const old = { ...session }; service.update(session, "chat", enable);
  assert.deepEqual(manager.changeWorkspace(session.token, b), { workspaceDir: b });
  assert.equal(service.getGrant(old, "chat"), null);
  assert.equal(service.getState(session, "chat").mode, "ask");
  manager.changeWorkspace(session.token, a);
  const restored = service.getState(session, "chat"); assert.equal(restored.mode, "ask"); assert.equal(restored.revision, 2);
  assert.throws(() => service.update(session, "chat", enable), /Approval mode changed/);
});

test("logout and expiry deny retained session snapshots and a new login requires explicit enabling", (t) => {
  const { manager, service, session } = fixture(t);
  service.update(session, "chat", enable); const old = { ...session };
  manager.logout(session.token); assert.equal(service.getGrant(old, "chat"), null);
  const second = manager.login("tester", "secret")!; const current = manager.getSession(second.token)!;
  assert.equal(service.getState(current, "chat").mode, "ask"); service.update(current, "chat", enable);
  current.expiresAt = Date.now() - 1; assert.equal(service.getGrant(current, "chat"), null);
});

test("losing workspace membership revokes access and restoring write role does not silently re-enable", (t) => {
  const { a, teams, service, session } = fixture(t);
  const team = teams.createTeam({ username: "owner", teamName: "Shared", workspaceDir: a });
  const invite = teams.createInvite(team.id, "owner", "member"); teams.joinTeamByInvite(invite.code, "tester");
  service.update(session, "chat", enable);
  teams.updateMemberRole(team.id, "owner", "tester", "viewer");
  assert.equal(service.getGrant(session, "chat"), null); assert.equal(service.getState(session, "chat").canEnable, false);
  teams.updateMemberRole(team.id, "owner", "tester", "member");
  assert.equal(service.getState(session, "chat").mode, "ask"); assert.equal(service.getState(session, "chat").canEnable, true);
});

test("Web-only mode cannot elevate through existing desktop bootstrap sessions", (t) => {
  const { service, session } = fixture(t); const before = process.env.CREWFORGE_DESKTOP;
  service.update(session, "chat", enable);
  try {
    process.env.CREWFORGE_DESKTOP = "1";
    assert.equal(service.getGrant(session, "chat"), null);
    const state = service.getState(session, "chat"); assert.equal(state.mode, "ask"); assert.equal(state.canEnable, false);
    assert.throws(() => service.update(session, "chat", { ...enable, expectedRevision: state.revision }), /only on the Web backend/);
  } finally { if (before === undefined) delete process.env.CREWFORGE_DESKTOP; else process.env.CREWFORGE_DESKTOP = before; }
});

test("a broken audit chain blocks elevation while disabling stays fail-closed", (t) => {
  const { a, service, session } = fixture(t);
  const auditPath = path.join(a, ".crewforge", "policy-audit.jsonl"); fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.writeFileSync(auditPath, "malformed\n");
  assert.throws(() => service.update(session, "chat", enable), /Policy audit/);
  assert.equal(service.getState(session, "chat").mode, "ask"); assert.equal(service.getGrant(session, "chat"), null);
  fs.rmSync(auditPath); service.update(session, "chat", enable); fs.appendFileSync(auditPath, "malformed\n");
  assert.equal(service.update(session, "chat", { mode: "ask", expectedRevision: 1 }).mode, "ask");
  assert.equal(service.getGrant(session, "chat"), null);
});

test("approval scope quotas preserve revisions and cannot exhaust another login's scopes", (t) => {
  const { manager, service, session } = fixture(t);
  for (let index = 0; index < 512; index += 1) service.update(session, `task-${index}`, { mode: "ask", expectedRevision: 0 });
  assert.throws(() => service.update(session, "overflow", enable), (error) => error instanceof ApprovalModeError && error.status === 429);
  assert.throws(() => service.update(session, "task-0", enable), /Approval mode changed/);
  assert.equal(service.update(session, "task-0", { ...enable, expectedRevision: 1 }).mode, "full_access");
  const otherLogin = manager.login("tester", "secret")!;
  assert.equal(service.update(manager.getSession(otherLogin.token)!, "chat", enable).mode, "full_access");
});

test("disable clears reusable medium approvals without resolving pending items or reviving stale allow_session grants", async (t) => {
  const { manager, session, a } = fixture(t); const previous = sessionManager; setSessionManagerForTests(manager);
  const active = createActiveRun({ session: { ...session }, recorder: new AgentRunRecorder(a, "run-race", "chat", "code"), queueSteering: async () => ({ ok: true, code: "accepted" }) });
  t.after(() => { active.forceStop(); active.finish(); setSessionManagerForTests(previous); });
  const pendingRequest = (toolCallId: string, input = { path: "src/a.ts" }) => {
    const requirement = classifyToolApproval("edit_file", input, { workspaceDir: a }); assert.equal(requirement.kind, "approval");
    if (requirement.kind !== "approval") throw new Error("Expected approval");
    return active.approvals.requestDetailed({ ...requirement, conversationId: "chat", name: "edit_file", input, requestId: "req", toolCallId });
  };
  const pending = pendingRequest("pending-before-enable"); assert.equal(active.approvals.pendingCount(), 1);
  updateApprovalMode(session, "chat", enable); assert.equal(getFullAccessGrant(session, "chat")?.revision, 1);
  assert.equal(active.approvals.pendingCount(), 1);
  updateApprovalMode(session, "chat", { mode: "ask", expectedRevision: 1 }); assert.equal(active.approvals.pendingCount(), 1);
  active.approvals.resolve(active.approvals.listPending()[0].approvalId, "allow_session"); assert.equal((await pending).decision, "allow_once");
  const next = pendingRequest("new-after-disable"); assert.equal(active.approvals.pendingCount(), 1);
  active.approvals.allowConversation("chat"); assert.equal((await next).decision, "allow_once");
  assert.equal((await pendingRequest("existing-bulk-grant")).decision, "allow_once");
  const current = getApprovalMode(session, "chat"); updateApprovalMode(session, "chat", { mode: "ask", expectedRevision: current.revision });
  const afterBulkClear = pendingRequest("after-bulk-clear"); assert.equal(active.approvals.pendingCount(), 1); active.approvals.cancelAll(); assert.equal((await afterBulkClear).decision, "deny");
});
