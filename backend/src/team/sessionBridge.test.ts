import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveTeamStoreRoot } from "./sessionBridge.js";

test("team store root honors the configured persistent deployment directory", () => {
  assert.equal(resolveTeamStoreRoot("/app", " /app/config "), path.resolve("/app/config"));
});

test("team store root preserves the local development defaults", () => {
  const repositoryRoot = path.resolve("session-bridge-fixture");
  assert.equal(resolveTeamStoreRoot(path.join(repositoryRoot, "backend")), repositoryRoot);
  assert.equal(resolveTeamStoreRoot(repositoryRoot, "  "), repositoryRoot);
});

test("team containment respects canonical paths and does not confuse prefix siblings", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const { teamWorkspaceContains } = await import("./sessionBridge.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-team-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const team = path.join(root, "team"); const nested = path.join(team, "nested"); const sibling = path.join(root, "team-other");
  fs.mkdirSync(nested, { recursive: true }); fs.mkdirSync(sibling);
  assert.equal(teamWorkspaceContains(team, nested), true);
  assert.equal(teamWorkspaceContains(team, team), true);
  assert.equal(teamWorkspaceContains(team, sibling), false);
  assert.equal(teamWorkspaceContains(nested, team), false);
  if (process.platform !== "win32") {
    const alias = path.join(root, "alias"); fs.symlinkSync(team, alias, "dir");
    assert.equal(teamWorkspaceContains(alias, nested), true);
  }
});

test("nested team workspaces retain live viewer and removed-member write restrictions", async (t) => {
  const fs = await import("node:fs"); const os = await import("node:os");
  const { TeamManager } = await import("./teamManager.js");
  const { canWriteActiveWorkspace, resolveActiveTeam, setActiveTeamId, setTeamManagerForTests } = await import("./sessionBridge.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-team-role-scope-"));
  const workspace = path.join(root, "workspace"); const nested = path.join(workspace, "nested");
  fs.mkdirSync(nested, { recursive: true });
  const manager = new TeamManager(path.join(root, "store")); setTeamManagerForTests(manager);
  t.after(() => { setTeamManagerForTests(null); fs.rmSync(root, { recursive: true, force: true }); });
  const team = manager.createTeam({ username: "owner", teamName: "Parent", workspaceDir: workspace });
  const invite = manager.createInvite(team.id, "owner", "viewer"); manager.joinTeamByInvite(invite.code, "alice");
  const session = { token: "scoped-viewer", username: "alice", workspaceDir: nested } as import("../auth/sessionManager.js").UserSession;
  assert.equal(resolveActiveTeam(session)?.id, team.id);
  assert.equal(canWriteActiveWorkspace(session), false);
  manager.updateMemberRole(team.id, "owner", "alice", "member");
  assert.equal(canWriteActiveWorkspace(session), true);
  const nearer = manager.createTeam({ username: "other-owner", teamName: "Nested", workspaceDir: nested });
  setActiveTeamId(session, team.id);
  assert.equal(resolveActiveTeam(session), null);
  assert.equal(canWriteActiveWorkspace(session), false, "cached parent team cannot override a closer team's membership");
  const nestedInvite = manager.createInvite(nearer.id, "other-owner", "viewer"); manager.joinTeamByInvite(nestedInvite.code, "alice");
  assert.equal(resolveActiveTeam(session)?.id, nearer.id);
  assert.equal(canWriteActiveWorkspace(session), false);
  manager.removeMember(nearer.id, "other-owner", "alice");
  assert.equal(canWriteActiveWorkspace(session), false);
});
