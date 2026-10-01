import path from "path";
import type { UserSession } from "../auth/sessionManager.js";
import { TeamManager, TeamDetails, TeamRole, teamWorkspaceContains } from "./teamManager.js";

export { teamWorkspaceContains };

const ACTIVE_TEAM_BY_TOKEN = new Map<string, string>();
let teamManagerInstance: TeamManager | null = null;

export function resolveTeamStoreRoot(cwd: string, configuredRoot?: string): string {
  const explicitRoot = configuredRoot?.trim();
  if (explicitRoot) return path.resolve(explicitRoot);
  return cwd.endsWith(`${path.sep}backend`)
    ? path.resolve(cwd, "..")
    : path.resolve(cwd);
}

const TEAM_STORE_ROOT = resolveTeamStoreRoot(process.cwd(), process.env.TEAM_STORE_ROOT);

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
  const inferred = manager.getTeamCoveringWorkspace(session.username, session.workspaceDir);
  const explicitId = getActiveTeamId(session);
  if (explicitId) {
    try {
      const team = manager.getTeamDetails(explicitId, session.username);
      if (inferred && teamWorkspaceContains(team.workspaceDir, session.workspaceDir)
        && teamWorkspaceContains(team.workspaceDir, inferred.workspaceDir)
        && teamWorkspaceContains(inferred.workspaceDir, team.workspaceDir)) return team;
    } catch {
      // Membership and the closest authorized team root are checked afresh.
    }
    ACTIVE_TEAM_BY_TOKEN.delete(session.token);
  }
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
  const team = resolveActiveTeam(session);
  if (team) return team.role !== "viewer";
  return !getManager().hasTeamCoveringWorkspace(session.workspaceDir);
}

export function canManageActiveTeam(session: UserSession): boolean {
  const role = getActiveTeamRole(session);
  return role === "owner" || role === "admin";
}
