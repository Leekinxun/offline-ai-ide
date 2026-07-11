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
  });
});

teamRouter.get("/agents", (req, res) => {
  const session = getSession(req);
  res.json({
    agents: session.teammateManager.listDetails(),
    updatedAt: Date.now(),
  });
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
