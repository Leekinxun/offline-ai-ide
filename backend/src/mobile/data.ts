import path from "node:path";
import type { UserSession } from "../auth/sessionManager.js";
import { sessionManager } from "../auth/sessionManager.js";
import { redactSecrets } from "../agent/secretRedaction.js";
import { listConversationSummaries, readConversationMessages } from "../chat/history.js";
import { listRunSummaries, readRunRecord } from "../chat/runHistory.js";
import { getActiveRun, listActiveRuns, listPendingApprovals } from "../chat/runCoordinator.js";
import { mobilePairingManager, type MobileScope, type MobileSession } from "./pairing.js";
import { getTeamManager, setActiveTeamId } from "../team/sessionBridge.js";
import type { TeamRole } from "../team/teamManager.js";

export class MobileDataError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

export interface MobileWorkspace {
  id: string;
  name: string;
  role: TeamRole | "personal";
  canWrite: boolean;
  canControlAgents: boolean;
}

export interface MobileContext {
  mobile: MobileSession;
  parent: UserSession;
  scope: MobileScope;
  workspace: MobileWorkspace;
}

function scopeView(mobile: MobileSession, parent: UserSession, scope: MobileScope): MobileWorkspace | null {
  if (!scope.teamId) {
    if (path.resolve(scope.workspaceDir) !== path.resolve(mobile.workspaceRoot)) return null;
    // A directory that becomes collaborative cannot keep its old personal
    // alias. A new team scope requires fresh authorization and pairing.
    if (getTeamManager(parent).hasTeamAtWorkspace(scope.workspaceDir)) return null;
    return {
      id: scope.key,
      name: path.basename(scope.workspaceDir) || "个人工作区",
      role: "personal",
      canWrite: true,
      canControlAgents: true,
    };
  }
  try {
    const team = getTeamManager(parent).getTeamDetails(scope.teamId, mobile.username);
    if (path.resolve(team.workspaceDir) !== path.resolve(scope.workspaceDir)) return null;
    return {
      id: scope.key,
      name: team.name,
      role: team.role || "viewer",
      canWrite: team.role !== "viewer",
      canControlAgents: team.role === "owner" || team.role === "admin",
    };
  } catch { return null; }
}

export function getMobileContext(mobile: MobileSession): MobileContext {
  const parent = sessionManager.getSession(mobile.parentSessionToken, { touch: false });
  if (!parent || parent.username !== mobile.username) throw new MobileDataError("Session expired", 401);
  const scope = mobilePairingManager.availableScopes(mobile).find((candidate) => candidate.key === mobile.scopeKey);
  if (!scope || path.resolve(scope.workspaceDir) !== path.resolve(mobile.workspaceDir)) {
    throw new MobileDataError("Workspace access was revoked", 403);
  }
  const workspace = scopeView(mobile, parent, scope);
  if (!workspace) throw new MobileDataError("Workspace access was revoked", 403);
  return { mobile, parent, scope, workspace };
}

export function listMobileWorkspaces(context: MobileContext): MobileWorkspace[] {
  return mobilePairingManager.availableScopes(context.mobile)
    .map((scope) => scopeView(context.mobile, context.parent, scope))
    .filter((scope): scope is MobileWorkspace => scope !== null);
}

/** This synthetic session is scoped to the mobile device, without changing the
 * parent browser's selected workspace or team. Chat control only consumes the
 * identity/workspace fields; manager references remain owned by the parent. */
export function commandUserSession(context: MobileContext, commandId: string): UserSession {
  const scoped: UserSession = {
    ...context.parent,
    token: `mobile:${context.mobile.id}:${commandId}`,
    workspaceDir: context.scope.workspaceDir,
    workspaceRoot: context.mobile.workspaceRoot,
  };
  setActiveTeamId(scoped, context.scope.teamId);
  return scoped;
}

function titleForTool(name: string): string {
  if (name === "bash") return "运行命令";
  if (name === "write_file") return "写入文件";
  if (name === "edit_file") return "修改文件";
  if (name === "submit_plan") return "确认计划";
  if (name === "spawn_teammate" || name === "task") return "启动智能体";
  return "确认工具操作";
}

function projectActiveRun(run: ReturnType<typeof listActiveRuns>[number], context: MobileContext) {
  return {
    runId: run.runId,
    conversationId: run.conversationId,
    status: run.status,
    sequence: run.sequence,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    canControl: context.workspace.canWrite && run.ownerUsername === context.mobile.username,
  };
}

export function buildMobileSnapshot(context: MobileContext, sequence: number) {
  const workspaceDir = context.scope.workspaceDir;
  const activeRuns = listActiveRuns(workspaceDir);
  const activeByConversation = new Map(activeRuns.map((run) => [run.conversationId, run]));
  const runSummaries = listRunSummaries(workspaceDir);
  const runsById = new Map(runSummaries.map((run) => [run.runId, run]));
  const tasks = listConversationSummaries(workspaceDir).slice(0, 50).map((conversation) => {
    const active = activeByConversation.get(conversation.id);
    const lastRun = conversation.lastRunId ? runsById.get(conversation.lastRunId) : undefined;
    return {
      id: conversation.id,
      workspaceId: context.workspace.id,
      title: redactSecrets(conversation.title),
      preview: redactSecrets(conversation.preview),
      status: active?.status || conversation.status,
      updatedAt: Math.max(conversation.updatedAt, active?.updatedAt || 0),
      mode: conversation.mode,
      ...(conversation.lastRunId ? { lastRunId: conversation.lastRunId } : {}),
      ...(lastRun ? { runStatus: lastRun.status } : {}),
      version: active?.sequence ?? conversation.updatedAt,
    };
  });
  const approvals = context.workspace.role === "viewer" ? [] : listPendingApprovals(workspaceDir).map((approval) => {
    const owner = activeByConversation.get(approval.conversationId)?.ownerUsername;
    const canDecide = context.workspace.canWrite && owner === context.mobile.username && approval.risk === "medium";
    return {
      id: approval.approvalId,
      taskId: approval.conversationId,
      runId: approval.runId,
      workspaceId: context.workspace.id,
      title: titleForTool(approval.name),
      summary: approval.risk === "high" ? "此操作需要在网页端处理" : approval.summary,
      risk: approval.risk,
      createdAt: approval.createdAt,
      canDecide,
    };
  });
  return {
    sequence,
    now: Date.now(),
    user: { username: context.mobile.username },
    workspace: context.workspace,
    workspaces: listMobileWorkspaces(context),
    tasks,
    approvals,
    activeRuns: activeRuns.map((run) => projectActiveRun(run, context)),
  };
}

export function buildMobileTaskDetail(context: MobileContext, taskId: string) {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(taskId)) throw new MobileDataError("Invalid task", 400);
  const workspaceDir = context.scope.workspaceDir;
  const conversation = listConversationSummaries(workspaceDir).find((item) => item.id === taskId);
  if (!conversation) throw new MobileDataError("Task not found", 404);
  const active = getActiveRun(workspaceDir, taskId);
  const task = {
    id: conversation.id,
    workspaceId: context.workspace.id,
    title: redactSecrets(conversation.title),
    preview: redactSecrets(conversation.preview),
    status: active?.status || conversation.status,
    updatedAt: Math.max(conversation.updatedAt, active?.updatedAt || 0),
    mode: conversation.mode,
    ...(conversation.lastRunId ? { lastRunId: conversation.lastRunId } : {}),
    version: active?.sequence ?? conversation.updatedAt,
  };
  const messages = readConversationMessages(workspaceDir, taskId).slice(-100).map((message) => ({
    role: message.role,
    content: redactSecrets(message.content).slice(0, 12_000),
    timestamp: message.timestamp,
  }));
  const runs = listRunSummaries(workspaceDir, taskId).slice(0, 8).map((summary) => {
    const record = readRunRecord(workspaceDir, summary.runId);
    return {
      runId: summary.runId,
      status: summary.status,
      updatedAt: summary.updatedAt,
      mode: summary.mode,
      events: record.events.slice(-40).map((event) => ({
        id: event.id,
        kind: event.kind,
        label: redactSecrets(event.label).slice(0, 500),
        timestamp: event.timestamp,
        ...(event.isError ? { isError: true } : {}),
      })),
    };
  });
  const lastRun = conversation.lastRunId ? runs.find((run) => run.runId === conversation.lastRunId) : runs[0];
  const lastRecord = lastRun ? readRunRecord(workspaceDir, lastRun.runId) : null;
  const changes = (lastRecord?.summary?.changedFiles || conversation.summary?.changedFiles || [])
    .filter((file) => typeof file === "string" && !path.isAbsolute(file) && !file.split(/[\\/]/).includes(".."))
    .slice(0, 100)
    .map((file) => ({ path: redactSecrets(file), operation: "modified" }));
  return {
    task,
    messages,
    runs,
    changes,
    activeRun: active ? projectActiveRun(active, context) : null,
  };
}
