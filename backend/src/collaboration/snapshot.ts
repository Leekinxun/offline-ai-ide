import type { UserSession } from "../auth/sessionManager.js";
import { listChangeSets } from "../chat/changeSets.js";
import type { TeamDetails } from "../team/teamManager.js";
import { CollaborationStore } from "./collaborationStore.js";

export function buildCollaborationSnapshot(session: UserSession, team: TeamDetails | null) {
  const durable = new CollaborationStore(session.workspaceDir).snapshot();
  const humanClaims = team?.claims.map((claim) => ({ source: "team" as const, path: claim.path, subject: { kind: "human" as const, id: claim.username }, updatedAt: claim.updatedAt })) || [];
  const agentClaims = session.teammateManager.listDetails().flatMap((agent: any) => {
    const subject = { kind: "agent" as const, id: typeof agent.id === "string" ? agent.id : `teammate:${agent.name}` };
    const paths = Array.isArray(agent.writeScope) ? agent.writeScope : Array.isArray(agent.files) ? agent.files : [];
    return paths.filter((item: unknown): item is string => typeof item === "string").map((path: string) => ({ source: "agent" as const, path, subject, updatedAt: typeof agent.updatedAt === "number" ? agent.updatedAt : Date.now() }));
  });
  const changeOwnership = listChangeSets(session.workspaceDir).map((changeSet) => ({ changeSetId: changeSet.id, revision: changeSet.patchSha256, worktreeId: changeSet.worktreeId, subject: { kind: "agent" as const, id: changeSet.ownerId || changeSet.childRunId || "unassigned-agent" }, paths: changeSet.changedFiles, status: changeSet.status }));
  const taskOwnership = session.taskManager.listTasks().filter((task) => task.owner).map((task) => ({ taskId: task.id, subject: { kind: String(task.owner).startsWith("agent") || String(task.owner).startsWith("teammate:") ? "agent" as const : "human" as const, id: task.owner! }, status: task.status, version: task.version }));
  return { ...durable, ownership: { claims: [...humanClaims, ...agentClaims, ...durable.claims.map((claim) => ({ source: "collaboration" as const, path: claim.anchor.path, subject: claim.subject, updatedAt: claim.updatedAt, range: { startLine: claim.anchor.startLine, endLine: claim.anchor.endLine }, status: claim.anchor.status }))], changeSets: changeOwnership, tasks: taskOwnership } };
}
