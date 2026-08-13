import { TEAMMATE_CAPABILITY } from "../agent/types.js";
import { canManageActiveTeam, canWriteActiveWorkspace, resolveActiveTeam } from "./sessionBridge.js";

export function canSessionManageAgentBudget(session: any): boolean {
  const activeTeam = resolveActiveTeam(session);
  return Boolean(session.isAdmin || (!activeTeam ? canWriteActiveWorkspace(session) : canManageActiveTeam(session)));
}

/** Derive a transport-safe agent snapshot for one recipient. Never cache or
 * broadcast this result across recipients with different authorization. */
export function agentSnapshot(member: Record<string, any>, canManageBudget = false) {
  const id = typeof member.id === "string" && member.id ? member.id : `teammate:${member.name}`;
  const capabilities = Array.isArray(member.capabilities) ? [...member.capabilities] : [];
  const visibleCapabilities = canManageBudget
    ? capabilities
    : capabilities.filter((capability) => capability !== TEAMMATE_CAPABILITY.UPDATE_BUDGET);
  return {
    ...member,
    id,
    resource: { type: "agent", id, workspaceDir: member.worktreePath || null },
    version: typeof member.version === "number" ? member.version : 0,
    revision: typeof member.version === "number" ? member.version : 0,
    capabilities: visibleCapabilities,
    canManageBudget: canManageBudget && visibleCapabilities.includes(TEAMMATE_CAPABILITY.UPDATE_BUDGET),
  };
}
