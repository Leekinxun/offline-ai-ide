import { Router } from "express";
import { sessionManager } from "../auth/sessionManager.js";
import {
  canManageActiveTeam,
  canWriteActiveWorkspace,
  getActiveTeamId,
  getTeamManager,
  resolveActiveTeam,
  setActiveTeamId,
} from "../team/sessionBridge.js";
import type { TeamRole } from "../team/teamManager.js";
import { pushTeamSnapshot } from "../ws/team.js";
import { pushAgentUpdate } from "../ws/team.js";
import { TEAMMATE_CAPABILITY } from "../agent/types.js";
import { agentExecutionGraphSnapshot, agentSnapshot, canSessionManageAgentBudget } from "../team/agentSnapshot.js";
import { CollaborationStore, CollaborationVersionConflictError, type CollaborationMergeChoice, type CollaborationSubject } from "../collaboration/collaborationStore.js";
import { buildCollaborationSnapshot } from "../collaboration/snapshot.js";
import { createChangeSetMergePreview } from "../collaboration/changeSetCollaboration.js";

export { agentSnapshot } from "../team/agentSnapshot.js";

export const teamRouter = Router();

function getSession(req: any) {
  return req.userSession;
}

teamRouter.get("/state", (req, res) => {
  const session = getSession(req);
  const manager = getTeamManager(session);
  const teams = manager.listTeams(session.username);
  const activeTeam = resolveActiveTeam(session);
  res.json({
    teams,
    activeTeam,
    activeTeamId: activeTeam?.id || getActiveTeamId(session),
    collaboration: buildCollaborationSnapshot(session, activeTeam),
  });
});

teamRouter.get("/collaboration", (req, res) => {
  const session = getSession(req); const team = resolveActiveTeam(session);
  res.json({ collaboration: buildCollaborationSnapshot(session, team) });
});

function collaborationWritable(session: any, res: any): boolean { if (!canWriteActiveWorkspace(session)) { res.status(403).json({ error: "Active team role is read-only" }); return false; } return true; }
function collaborationExpectedVersion(req: any): number | null { const value = req.body?.expectedVersion ?? req.body?.expected_version; return Number.isSafeInteger(value) ? value : null; }
function collaborationError(res: any, error: unknown) { if (error instanceof CollaborationVersionConflictError) return res.status(409).json({ error: error.message, expectedVersion: error.expectedVersion, currentVersion: error.actualVersion }); const message = error instanceof Error ? error.message : "Collaboration action failed"; return res.status(/not found/i.test(message) ? 404 : 400).json({ error: message }); }
function human(session: any): CollaborationSubject { return { kind: "human", id: session.username }; }

teamRouter.post("/collaboration/claims", (req, res) => {
  const session = getSession(req); if (!collaborationWritable(session, res)) return; const expectedVersion = collaborationExpectedVersion(req); if (expectedVersion === null) return res.status(428).json({ error: "expectedVersion required" });
  try { const collaboration = new CollaborationStore(session.workspaceDir).upsertClaim({ subject: req.body?.subject?.kind === "agent" && canManageActiveTeam(session) ? { kind: "agent", id: req.body.subject.id } : human(session), path: req.body?.path, claimed: Boolean(req.body?.claimed), startLine: req.body?.startLine, endLine: req.body?.endLine, selectedText: req.body?.selectedText, contextBefore: req.body?.contextBefore, contextAfter: req.body?.contextAfter }, expectedVersion); const team = resolveActiveTeam(session); if (team) pushTeamSnapshot(session, team.id); res.json({ collaboration }); } catch (error) { collaborationError(res, error); }
});

teamRouter.post("/collaboration/comments", (req, res) => {
  const session = getSession(req); if (!collaborationWritable(session, res)) return; const expectedVersion = collaborationExpectedVersion(req); if (expectedVersion === null) return res.status(428).json({ error: "expectedVersion required" });
  try { const team = resolveActiveTeam(session); const agents = session.teammateManager.listDetails().map((item: any) => typeof item.id === "string" ? item.id : item.name); const comment = new CollaborationStore(session.workspaceDir).addComment({ author: human(session), body: req.body?.body, path: req.body?.path, startLine: req.body?.startLine, endLine: req.body?.endLine, selectedText: req.body?.selectedText, contextBefore: req.body?.contextBefore, contextAfter: req.body?.contextAfter, evidenceLinks: req.body?.evidenceLinks, humanIds: team?.members.map((item) => item.username), agentIds: agents }, expectedVersion); if (team) pushTeamSnapshot(session, team.id); res.json({ comment }); } catch (error) { collaborationError(res, error); }
});

teamRouter.post("/collaboration/review-requests", (req, res) => {
  const session = getSession(req); if (!collaborationWritable(session, res)) return; const expectedVersion = collaborationExpectedVersion(req); if (expectedVersion === null) return res.status(428).json({ error: "expectedVersion required" });
  try { const assignees = Array.isArray(req.body?.assignees) ? req.body.assignees as CollaborationSubject[] : []; const team = resolveActiveTeam(session); const humanIds = new Set(team?.members.map((item) => item.username) || [session.username]); const agents = session.teammateManager.listDetails(); const agentIds = new Set(agents.flatMap((item: any) => [item.id, item.name].filter((value): value is string => typeof value === "string"))); if (assignees.some((item) => item?.kind === "human" ? !humanIds.has(item.id) : item?.kind === "agent" ? !agentIds.has(item.id) : true)) return res.status(400).json({ error: "Review assignee is outside the active human/agent team" }); const request = new CollaborationStore(session.workspaceDir).createReviewRequest({ createdBy: human(session), assignees, path: req.body?.path, startLine: req.body?.startLine, endLine: req.body?.endLine, selectedText: req.body?.selectedText, contextBefore: req.body?.contextBefore, contextAfter: req.body?.contextAfter, message: req.body?.message }, expectedVersion); if (team) pushTeamSnapshot(session, team.id); res.json({ request }); } catch (error) { collaborationError(res, error); }
});

teamRouter.post("/collaboration/merge-previews", (req, res) => {
  const session = getSession(req); if (!collaborationWritable(session, res)) return;
  try { const preview = createChangeSetMergePreview(session.workspaceDir, { changeSetId: req.body?.changeSetId, path: req.body?.path, actorId: session.username }); const team = resolveActiveTeam(session); if (team) pushTeamSnapshot(session, team.id); res.json({ preview }); } catch (error) { collaborationError(res, error); }
});

teamRouter.post("/collaboration/merge-decisions", (req, res) => {
  const session = getSession(req); if (!collaborationWritable(session, res)) return;
  try { const decision = new CollaborationStore(session.workspaceDir).decideMerge({ previewId: req.body?.previewId, expectedPreviewVersion: req.body?.expectedPreviewVersion, actorId: session.username, choice: req.body?.choice as CollaborationMergeChoice, revision: req.body?.revision, baseDigest: req.body?.baseDigest, humanDigest: req.body?.humanDigest, upstreamDigest: req.body?.upstreamDigest, agentDigest: req.body?.agentDigest, reason: req.body?.reason, resolvedDigest: req.body?.resolvedDigest, supersedesDecisionId: req.body?.supersedesDecisionId }); const team = resolveActiveTeam(session); if (team) pushTeamSnapshot(session, team.id); res.json({ decision }); } catch (error) { collaborationError(res, error); }
});

teamRouter.get("/agents", (req, res) => {
  const session = getSession(req);
  session.teammateManager.reconcile();
  if (req.query.view === "graph") {
    return res.json(agentExecutionGraphSnapshot(session));
  }
  const canManageBudget = canManageAgentBudget(session);
  res.json({
    agents: session.teammateManager.listDetails().map((member: Record<string, any>) => agentSnapshot(member, canManageBudget)),
    updatedAt: Date.now(),
  });
});

function canManageAgentBudget(session: any): boolean {
  return canSessionManageAgentBudget(session);
}

function controlTarget(session: any, req: any, res: any) {
  // A solo workspace is writable by its session owner. Once the workspace is
  // collaborative, only its owner/admin may control its isolated agents.
  const allowed = canManageAgentBudget(session);
  if (!allowed) {
    res.status(403).json({ error: "Only owners/admins can control agents" });
    return null;
  }
  const agentId = typeof req.params.agentId === "string" ? req.params.agentId.trim() : "";
  const name = agentId.startsWith("teammate:") ? agentId.slice("teammate:".length) : agentId;
  if (!/^[A-Za-z0-9_.@-]{1,160}$/.test(name)) {
    res.status(400).json({ error: "invalid agentId" });
    return null;
  }
  const member = session.teammateManager.listDetails().find((candidate: any) => candidate.name === name || candidate.id === agentId);
  if (!member) {
    res.status(404).json({ error: "agent not found" });
    return null;
  }
  return { name, member };
}

function expectedAgentVersion(req: any): number | null {
  const bodyVersion = req.body?.expectedVersion ?? req.body?.expected_version;
  const header = req.get?.("If-Match");
  const raw = bodyVersion ?? (typeof header === "string" ? header.replace(/^W\//, "").replace(/^"|"$/g, "") : undefined);
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function pushAgents(session: any) {
  // WS derives recipient-specific capability snapshots per socket.
  pushAgentUpdate(session, session.teammateManager.listDetails());
}

async function controlAgent(req: any, res: any, action: unknown) {
  const session = getSession(req);
  const target = controlTarget(session, req, res);
  if (!target) return;
  const expectedVersion = expectedAgentVersion(req);
  if (expectedVersion === null) return res.status(428).json({ error: "expectedVersion or If-Match required" });
  if ((typeof target.member.version === "number" ? target.member.version : 0) !== expectedVersion) return res.status(409).json({ error: "agent version conflict", agent: agentSnapshot(target.member, true) });
  if (typeof action !== "string" || !["stop", "steer", "pause", "resume", "retry", "reassign", "replace"].includes(action)) {
    return res.status(404).json({ error: "unknown agent control" });
  }
  const manager = session.teammateManager;
  const content = typeof req.body?.content === "string" ? req.body.content.trim() : typeof req.body?.instruction === "string" ? req.body.instruction.trim() : "";
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : content;
  try {
    let result: unknown;
    switch (action) {
      case "stop": result = manager.stop(target.name); break;
      case "steer": if (!content) return res.status(400).json({ error: "content required" }); result = manager.steer(target.name, content); break;
      case "pause": result = manager.pause(target.name); break;
      case "resume": result = manager.resume(target.name); break;
      case "retry": result = await manager.retry(target.name); break;
      case "reassign": if (!prompt) return res.status(400).json({ error: "prompt required" }); result = manager.reassign(target.name, prompt); break;
      case "replace": {
        const role = typeof req.body?.role === "string" ? req.body.role.trim() : target.member.role;
        if (!role || !prompt) return res.status(400).json({ error: "role and prompt required" });
        result = await manager.replace(target.name, role, prompt);
        break;
      }
    }
    if (result === false) return res.status(409).json({ error: "agent cannot perform requested control" });
    pushAgents(session);
    res.json({ ok: true, result, agent: agentSnapshot(manager.listDetails().find((item: any) => item.name === target.name) || target.member, true) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "agent control failed";
    res.status(/version|conflict/i.test(message) ? 409 : 400).json({ error: message });
  }
}

teamRouter.post("/agents/:agentId/control", (req, res) => controlAgent(req, res, req.body?.action));
// Compatibility with the original action-in-path transport.
teamRouter.post("/agents/:agentId/:action", (req, res) => controlAgent(req, res, req.params.action));

teamRouter.patch("/agents/:agentId/budget", (req, res) => {
  const session = getSession(req);
  const target = controlTarget(session, req, res);
  if (!target) return;
  const expectedVersion = expectedAgentVersion(req);
  if (expectedVersion === null) return res.status(428).json({ error: "expectedVersion or If-Match required" });
  const budget = req.body?.budget;
  if (!budget || typeof budget !== "object") return res.status(400).json({ error: "budget required" });
  if (!target.member.capabilities?.includes(TEAMMATE_CAPABILITY.UPDATE_BUDGET)) return res.status(403).json({ error: "agent does not permit budget updates" });
  const updateBudget = (session.teammateManager as any).updateBudget;
  if (typeof updateBudget !== "function") return res.status(501).json({ error: "agent budget updates are unavailable" });
  try {
    const updated = updateBudget.call(session.teammateManager, target.name, budget, expectedVersion);
    if (!updated) return res.status(409).json({ error: "agent budget version conflict" });
    pushAgents(session);
    res.json({ ok: true, agent: agentSnapshot(updated, true) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "agent budget update failed";
    res.status(/version|conflict/i.test(message) ? 409 : 400).json({ error: message });
  }
});

teamRouter.post("/create", (req, res) => {
  const session = getSession(req);
  const teamName =
    typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const workspaceDir =
    typeof req.body?.workspaceDir === "string" && req.body.workspaceDir.trim()
      ? req.body.workspaceDir.trim()
      : session.workspaceDir;

  if (!teamName) {
    return res.status(400).json({ error: "name required" });
  }
  if (!sessionManager.isAllowedPath(workspaceDir)) {
    return res.status(403).json({ error: "workspace not allowed" });
  }

  const manager = getTeamManager(session);
  const team = manager.createTeam({
    username: session.username,
    teamName,
    workspaceDir,
  });
  setActiveTeamId(session, team.id);
  res.json(team);
});

teamRouter.post("/join", (req, res) => {
  const session = getSession(req);
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";

  if (!code) {
    return res.status(400).json({ error: "code required" });
  }

  try {
    const team = getTeamManager(session).joinTeamByInvite(code, session.username);
    const switched = sessionManager.changeWorkspace(session.token, team.workspaceDir);
    if (!switched) {
      return res.status(403).json({ error: "Failed to switch workspace" });
    }
    setActiveTeamId(session, team.id);
    pushTeamSnapshot(session, team.id);
    res.json({
      team,
      workspaceDir: switched.workspaceDir,
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Failed to join team",
    });
  }
});

teamRouter.post("/switch", (req, res) => {
  const session = getSession(req);
  const teamId = typeof req.body?.teamId === "string" ? req.body.teamId.trim() : "";
  if (!teamId) {
    return res.status(400).json({ error: "teamId required" });
  }

  try {
    const team = getTeamManager(session).getTeamDetails(teamId, session.username);
    const switched = sessionManager.changeWorkspace(session.token, team.workspaceDir);
    if (!switched) {
      return res.status(403).json({ error: "Failed to switch workspace" });
    }
    setActiveTeamId(session, team.id);
    pushTeamSnapshot(session, team.id);
    res.json({
      team,
      workspaceDir: switched.workspaceDir,
    });
  } catch (error) {
    res.status(403).json({
      error: error instanceof Error ? error.message : "Failed to switch team",
    });
  }
});

teamRouter.post("/invite", (req, res) => {
  const session = getSession(req);
  const teamId = typeof req.body?.teamId === "string" ? req.body.teamId.trim() : "";
  const role = (typeof req.body?.role === "string" ? req.body.role : "member") as TeamRole;
  if (!teamId) {
    return res.status(400).json({ error: "teamId required" });
  }
  const activeTeam = resolveActiveTeam(session);
  if (activeTeam?.id === teamId && !canManageActiveTeam(session)) {
    return res.status(403).json({ error: "Only owners/admins can invite members" });
  }
  try {
    const invite = getTeamManager(session).createInvite(teamId, session.username, role);
    res.json(invite);
  } catch (error) {
    res.status(403).json({
      error: error instanceof Error ? error.message : "Failed to create invite",
    });
  }
});

teamRouter.post("/claim", (req, res) => {
  const session = getSession(req);
  const teamId = typeof req.body?.teamId === "string" ? req.body.teamId.trim() : "";
  const filePath = typeof req.body?.path === "string" ? req.body.path.trim() : "";
  const claimed = Boolean(req.body?.claimed);
  if (!teamId || !filePath) {
    return res.status(400).json({ error: "teamId and path required" });
  }
  if (!canWriteActiveWorkspace(session)) {
    return res.status(403).json({ error: "Active team role is read-only" });
  }
  try {
    const team = getTeamManager(session).updateClaim(teamId, session.username, filePath, claimed);
    res.json(team);
  } catch (error) {
    res.status(403).json({
      error: error instanceof Error ? error.message : "Failed to update claim",
    });
  }
});

teamRouter.post("/members/role", (req, res) => {
  const session = getSession(req);
  const teamId = typeof req.body?.teamId === "string" ? req.body.teamId.trim() : "";
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const role = (typeof req.body?.role === "string" ? req.body.role : "member") as TeamRole;
  if (!teamId || !username) {
    return res.status(400).json({ error: "teamId, username and role required" });
  }
  try {
    const team = getTeamManager(session).updateMemberRole(teamId, session.username, username, role);
    pushTeamSnapshot(session, teamId);
    res.json(team);
  } catch (error) {
    res.status(403).json({
      error: error instanceof Error ? error.message : "Failed to update member role",
    });
  }
});

teamRouter.post("/members/transfer-owner", (req, res) => {
  const session = getSession(req);
  const teamId = typeof req.body?.teamId === "string" ? req.body.teamId.trim() : "";
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  if (!teamId || !username) {
    return res.status(400).json({ error: "teamId and username required" });
  }
  try {
    const team = getTeamManager(session).transferOwnership(teamId, session.username, username);
    pushTeamSnapshot(session, teamId);
    res.json(team);
  } catch (error) {
    res.status(403).json({
      error: error instanceof Error ? error.message : "Failed to transfer ownership",
    });
  }
});

teamRouter.post("/members/remove", (req, res) => {
  const session = getSession(req);
  const teamId = typeof req.body?.teamId === "string" ? req.body.teamId.trim() : "";
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  if (!teamId || !username) {
    return res.status(400).json({ error: "teamId and username required" });
  }
  try {
    getTeamManager(session).removeMember(teamId, session.username, username);
    pushTeamSnapshot(session, teamId);
    res.json({ status: "ok" });
  } catch (error) {
    res.status(403).json({
      error: error instanceof Error ? error.message : "Failed to remove member",
    });
  }
});

teamRouter.post("/leave", (req, res) => {
  const session = getSession(req);
  const teamId = typeof req.body?.teamId === "string" ? req.body.teamId.trim() : "";
  if (!teamId) {
    return res.status(400).json({ error: "teamId required" });
  }
  try {
    getTeamManager(session).leaveTeam(teamId, session.username);
    if (getActiveTeamId(session) === teamId) {
      setActiveTeamId(session, null);
    }
    pushTeamSnapshot(session, teamId);
    res.json({ status: "ok" });
  } catch (error) {
    res.status(403).json({
      error: error instanceof Error ? error.message : "Failed to leave team",
    });
  }
});
