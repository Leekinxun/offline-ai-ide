import path from "path";
import type { UserSession } from "../auth/sessionManager.js";
import { TeamManager, TeamDetails, TeamRole } from "./teamManager.js";

const ACTIVE_TEAM_BY_TOKEN = new Map<string, string>();
let teamManagerInstance: TeamManager | null = null;
const TEAM_STORE_ROOT = process.cwd().endsWith(`${path.sep}backend`)
  ? path.resolve(process.cwd(), "..")
  : path.resolve(process.cwd());

function getManager(): TeamManager {
  if (!teamManagerInstance) {
    teamManagerInstance = new TeamManager(TEAM_STORE_ROOT);
  }
  return teamManagerInstance;
}

/** Test-only dependency seam; production callers never replace the singleton. */
export function setTeamManagerForTests(manager: TeamManager | null): void { teamManagerInstance = manager; ACTIVE_TEAM_BY_TOKEN.clear(); }

export function getTeamManager(_session: UserSession): TeamManager {
  return getManager();
}

export function setActiveTeamId(session: UserSession, teamId: string | null): void {
  if (!teamId) {
    ACTIVE_TEAM_BY_TOKEN.delete(session.token);
    return;
  }
  ACTIVE_TEAM_BY_TOKEN.set(session.token, teamId);
}

export function getActiveTeamId(session: UserSession): string | null {
  return ACTIVE_TEAM_BY_TOKEN.get(session.token) || null;
}

export function resolveActiveTeam(session: UserSession): TeamDetails | null {
  const manager = getManager();
  const explicitId = getActiveTeamId(session);
  if (explicitId) {
    try {
      return manager.getTeamDetails(explicitId, session.username);
    } catch {
      ACTIVE_TEAM_BY_TOKEN.delete(session.token);
    }
  }
  const inferred = manager.getTeamByWorkspace(session.username, session.workspaceDir);
  if (inferred) {
    ACTIVE_TEAM_BY_TOKEN.set(session.token, inferred.id);
    return inferred;
  }
  return null;
}

export function getActiveTeamRole(session: UserSession): TeamRole | null {
  return resolveActiveTeam(session)?.role || null;
}

export function canWriteActiveWorkspace(session: UserSession): boolean {
  return getActiveTeamRole(session) !== "viewer";
}

export function canManageActiveTeam(session: UserSession): boolean {
  const role = getActiveTeamRole(session);
  return role === "owner" || role === "admin";
}
