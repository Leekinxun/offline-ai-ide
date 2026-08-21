import { TEAMMATE_CAPABILITY } from "../agent/types.js";
import { buildExecutionGraphSnapshot, type AgentExecutionGraphSnapshot } from "../agent/executionGraph.js";
import type { UserSession } from "../auth/sessionManager.js";
import { listChangeSets } from "../chat/changeSets.js";
import { listRunRecords } from "../chat/runHistory.js";
import { TraceStore } from "../chat/traceStore.js";
import { listManagedWorktrees } from "../chat/worktrees.js";
import { canManageActiveTeam, canWriteActiveWorkspace, resolveActiveTeam } from "./sessionBridge.js";

export function canSessionManageAgentBudget(session: any): boolean {
  const activeTeam = resolveActiveTeam(session);
  return Boolean(session.isAdmin || (!activeTeam ? canWriteActiveWorkspace(session) : canManageActiveTeam(session)));
}

/** Build a read-only projection from the workspace's existing durable stores.
 * The projection owns no state; its public shape is selected and sanitized by
 * buildExecutionGraphSnapshot rather than exposing source records directly. */
export function agentExecutionGraphSnapshot(
  session: Pick<UserSession, "workspaceDir" | "taskManager" | "teammateManager">,
): AgentExecutionGraphSnapshot {
  const workspaceDir = session.workspaceDir;
  return buildExecutionGraphSnapshot({
    runRecords: listRunRecords(workspaceDir),
    teammates: session.teammateManager.listDetails(),
    tasks: session.taskManager.listTasks(),
    traceEvents: new TraceStore(workspaceDir).list(),
    managedWorktrees: listManagedWorktrees(workspaceDir),
    changeSets: listChangeSets(workspaceDir),
  });
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
