import { WebSocket } from "ws";
import { wsSend } from "../agent/types.js";
import type { AgentMode } from "../agent/types.js";
import { runAgentLoop } from "../agent/loop.js";
import { TaskManager } from "../agent/taskManager.js";
import { MessageBus } from "../agent/messageBus.js";
import { TeammateManager } from "../agent/teammateManager.js";
import type { UserSession } from "../auth/sessionManager.js";
import {
  appendConversationMessage,
  beginChatRequest,
  completeChatRequest,
  conversationExists,
  createConversationId,
  failChatRequest,
  getChatRequestStatus,
  listConversationSummaries,
  updateConversationTitle,
  updateConversationState,
  readConversationMessages,
  type PersistedChatMessage,
} from "../chat/history.js";
import { generateConversationTitle } from "../chat/title.js";
import {
  AgentRunRecorder,
  createRunId,
  findLatestResumableRun,
  listDescendantRuns,
  isTerminalRunStatus,
  readRunRecord,
  RESUME_PROMPT,
} from "../chat/runHistory.js";
import { createCheckpoint } from "../chat/checkpoints.js";
import { ToolApprovalSession, type ToolApprovalDecision } from "../agent/toolApproval.js";
import { sessionManager } from "../auth/sessionManager.js";
import { canWriteActiveWorkspace, getTeamManager, resolveActiveTeam } from "../team/sessionBridge.js";
import {
  ActiveChatRun,
  createActiveRun,
  dispatchRunCommand,
  findActiveRunForApproval,
  getActiveRunContext,
  listActiveRuns,
  subscribeRunEvents,
  type PendingUserMessage,
  type RunCommand,
  type RunCommandResult,
  type RunControlState,
} from "../chat/runCoordinator.js";
import { normalizeReviewFinding, parseReviewFindings, type StructuredReviewFinding } from "../chat/reviewFindings.js";
import { ReviewFindingStore } from "../chat/reviewFindingStore.js";
import { TraceStore } from "../chat/traceStore.js";
import { readGitStatus } from "../files/gitStatus.js";
import {
  findLatestBoundExecutionPlan,
  readExecutionPlan,
  requestExecutionPlanAmendment,
  updateExecutionPlanStatus,
  type ExecutionPlan,
} from "../chat/executionPlans.js";
import { checkExecutionPlanFreshness } from "../chat/planFreshness.js";
import { config, resolveModelInputCapabilities } from "../config.js";
import { resolveChatAttachments, type ChatAttachmentRef } from "../chat/attachments.js";
import { resolveSelectableModelName } from "../agent/agentProfiles.js";
import {
  PLAN_CODE_HANDOFF_PROMPT,
  resolvePlanCodeHandoff,
} from "../chat/planHandoff.js";
import { changeSetsContainEvidenceGaps, collectAuthoritativeChangeEvidence, deriveCompletionEvidence, type CompletionEvidence } from "../chat/completionEvidence.js";
import { CollaborationStore } from "../collaboration/collaborationStore.js";
import { isProtectedChangedPath, listChangeSets } from "../chat/changeSets.js";
import { getContextIndexAdapter } from "../agent/contextManifestIndex.js";
import { CompletionQualityGateError } from "../extensions/policy/completionGate.js";
import { MutationJournalEvidenceError } from "../files/mutationRegistry.js";
import { listManagedWorktrees } from "../chat/worktrees.js";

function normalizeAgentMode(value: unknown): AgentMode {
  return value === "ask" || value === "review" || value === "plan" ? value : "code";
}

function hasPendingCheck(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasPendingCheck);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.status === "string" && ["pending", "queued", "running", "in_progress"].includes(record.status)) return true;
  return Object.values(record).some(hasPendingCheck);
}

function runtimeCompletionState(session: UserSession, approvals: ToolApprovalSession, runId: string, conversationId: string) {
  const descendants = listDescendantRuns(session.workspaceDir, runId);
  const descendantIds = descendants.map((run) => run.runId);
  let changeSets: ReturnType<typeof listChangeSets> = [];
  try { changeSets = listChangeSets(session.workspaceDir); }
  catch (error) { if (!/not a git repository/i.test(error instanceof Error ? error.message : String(error))) throw error; }
  const relevantChangeSets = new Set(changeSets
    .filter((changeSet) => changeSet.parentRunId === runId || Boolean(changeSet.childRunId && descendantIds.includes(changeSet.childRunId)))
    .map((changeSet) => changeSet.id));
  const teammateBlocked = session.teammateManager.listDetails().some((member) =>
    member.parentRunId === runId && !["idle", "stopped", "failed", "shutdown"].includes(member.status)
  );
  const collaboration = new CollaborationStore(session.workspaceDir);
  const pendingConflict = collaboration.snapshot().mergeDecisions.some((decision) =>
    relevantChangeSets.has(decision.changeSetId) && decision.status !== "resolved"
  ) || changeSets.filter((changeSet) => relevantChangeSets.has(changeSet.id)).some((changeSet) => {
    // ChangeSet manifests may include control metadata from older captures. These
    // paths are outside collaboration conflict tracking and must not make the
    // completion state calculation fail during run finalization.
    const collaborationFiles = changeSet.changedFiles.filter((relative) => !isProtectedChangedPath(relative));
    return collaborationFiles.length > 0 && collaboration.integrationConflicts({ ...changeSet, changedFiles: collaborationFiles }).length > 0;
  });
  let changedFiles: string[] = [];
  let changeEvidence = false;
  try {
    const evidence = collectAuthoritativeChangeEvidence(session.workspaceDir, runId, descendantIds);
    changedFiles = evidence.changedFiles;
    changeEvidence = evidence.mutationEvidenceGaps.length > 0;
  } catch (error) {
    if (!(error instanceof MutationJournalEvidenceError)) throw error;
    changeEvidence = true;
  }
  changeEvidence ||= changeSetsContainEvidenceGaps(changeSets.filter((changeSet) => relevantChangeSets.has(changeSet.id)));
  try {
    changeEvidence ||= listManagedWorktrees(session.workspaceDir).some((worktree) =>
      worktree.parentRunId === runId && worktree.status === "needs_attention"
    );
  } catch (error) {
    if (!/not a git repository/i.test(error instanceof Error ? error.message : String(error))) throw error;
  }
  return {
    changedFiles,
    childRun: teammateBlocked || descendants.some((run) => !isTerminalRunStatus(run.status)),
    approval: approvals.pendingCount(conversationId) > 0,
    conflict: pendingConflict,
    check: changeSets.filter((changeSet) => relevantChangeSets.has(changeSet.id)).some((changeSet) => hasPendingCheck(changeSet.checks)),
    changeEvidence,
    conversationId,
  };
}

export function finalStatusFromCompletionEvidence(
  evidence: CompletionEvidence
): "completed" | "stopped" | "failed" {
  if (evidence.outcome === "stopped") return "stopped";
  return evidence.outcome === "completed" ? "completed" : "failed";
}

function requestedAmendmentsFromMessages(messages: PersistedChatMessage[]): Array<{
  reason: string;
  requestedFiles?: string[];
  requestedVerificationCommands?: string[];
}> {
  const amendments: Array<{
    reason: string;
    requestedFiles?: string[];
    requestedVerificationCommands?: string[];
  }> = [];
  for (const message of messages) {
    for (const tool of message.toolCalls || []) {
      const input = tool.input;
      if (tool.name === "request_plan_amendment" && !tool.isError) {
        amendments.push({
          reason: typeof input.reason === "string" ? input.reason : "Plan amendment requested by agent",
          ...(Array.isArray(input.requestedFiles) ? { requestedFiles: input.requestedFiles.filter((value): value is string => typeof value === "string") } : {}),
          ...(Array.isArray(input.requestedVerificationCommands)
            ? { requestedVerificationCommands: input.requestedVerificationCommands.filter((value): value is string => typeof value === "string") }
            : {}),
        });
      }
      if (tool.isError && tool.result?.includes("Execution plan scope violation")) {
        amendments.push({
          reason: tool.result,
          ...(typeof input.path === "string" ? { requestedFiles: [input.path] } : {}),
          ...(tool.name === "bash" && typeof input.command === "string"
            ? { requestedVerificationCommands: [input.command] }
            : {}),
        });
      }
    }
  }
  return amendments;
}

function persistPlanAmendments(
  workspaceDir: string,
  plan: ExecutionPlan | undefined,
  messages: PersistedChatMessage[],
  runId: string
): ExecutionPlan | undefined {
  if (!plan) return undefined;
  let currentPlan = plan;
  const seen = new Set<string>();
  for (const amendment of requestedAmendmentsFromMessages(messages)) {
    const files = Array.from(new Set(amendment.requestedFiles || [])).sort();
    const commands = Array.from(new Set(amendment.requestedVerificationCommands || [])).sort();
    const signature = `${files.join("\u0000")}|${commands.join("\u0000")}`;
    const alreadyPending = (currentPlan.amendmentRequests || []).some((entry) =>
      entry.status === "pending" &&
      entry.requestedByRunId === runId &&
      entry.requestedFiles.slice().sort().join("\u0000") === files.join("\u0000") &&
      entry.requestedVerificationCommands.slice().sort().join("\u0000") === commands.join("\u0000")
    );
    if (seen.has(signature) || alreadyPending) continue;
    seen.add(signature);
    try {
      currentPlan = requestExecutionPlanAmendment(workspaceDir, currentPlan.id, amendment, runId);
    } catch {
      // Invalid tool-supplied amendment details must not mask the original tool outcome.
    }
  }
  return currentPlan;
}

export interface StartMobileRunInput {
  ownerSessionToken: string;
  conversationId?: string;
  message: string;
  mode?: AgentMode;
  requestId: string;
}

export type StartMobileRunResult =
  | { ok: true; conversationId: string; runId?: string; created: boolean; replayed?: true }
  | { ok: false; code: "invalid" | "forbidden" | "not_found" | "conflict" | "error"; message: string };

/** Accepts a mobile prompt and starts the same durable run path as Web chat. */
export async function startMobileRun(
  session: UserSession,
  input: StartMobileRunInput,
  options: { resolveOwnerSession?: (token: string) => UserSession | null } = {}
): Promise<StartMobileRunResult> {
  const message = typeof input.message === "string" ? input.message.trim() : "";
  const requestId = typeof input.requestId === "string" ? input.requestId.trim() : "";
  const requestedConversationId = typeof input.conversationId === "string" ? input.conversationId.trim() : "";
  if (!message || message.length > 4_000 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(requestId)) {
    return { ok: false, code: "invalid", message: "A valid request ID and message are required" };
  }
  const parent = options.resolveOwnerSession
    ? options.resolveOwnerSession(input.ownerSessionToken)
    : sessionManager.getSession(input.ownerSessionToken, { touch: false });
  if (!parent || parent.username !== session.username || !canWriteActiveWorkspace(session)) {
    return { ok: false, code: "forbidden", message: "Current session cannot start a run in this workspace" };
  }
  const priorConversation = requestedConversationId
    ? listConversationSummaries(session.workspaceDir).find((item) => item.id === requestedConversationId)
    : undefined;
  if (requestedConversationId && !priorConversation) {
    return { ok: false, code: "not_found", message: "Conversation not found" };
  }

  const replay = (conversationId: string): StartMobileRunResult => {
    const original = readConversationMessages(session.workspaceDir, conversationId).find((item) =>
      item.role === "user" && item.requestId === requestId
    );
    if (!original || original.content !== message || original.attachments?.length ||
        (requestedConversationId && requestedConversationId !== conversationId)) {
      return { ok: false, code: "conflict", message: "Request ID belongs to a different message" };
    }
    const active = getActiveRunContext(session.workspaceDir, conversationId);
    const summary = listConversationSummaries(session.workspaceDir).find((item) => item.id === conversationId);
    return {
      ok: true, conversationId, ...(active?.runId || summary?.lastRunId ? { runId: active?.runId || summary?.lastRunId } : {}),
      created: false, replayed: true,
    };
  };
  const reservation = beginChatRequest(session.workspaceDir, requestId);
  if (reservation.kind === "accepted") return replay(reservation.conversationId);
  if (reservation.kind === "processing") {
    const accepted = await reservation.completion;
    return accepted ? replay(accepted) : { ok: false, code: "conflict", message: "Earlier request was not accepted" };
  }

  try {
  const conversationId = requestedConversationId || createConversationId();
  const created = !requestedConversationId;
  if (getActiveRunContext(session.workspaceDir, conversationId)) {
    failChatRequest(session.workspaceDir, requestId);
    return { ok: false, code: "conflict", message: "This conversation already has an active run" };
  }
  const mode = input.mode ? normalizeAgentMode(input.mode) : priorConversation?.mode || "code";
  const modelName = resolveSelectableModelName(
    mode, undefined, config.agentProfiles, config.modelName,
    config.models.map((model) => model.modelName)
  );
  const executionPlan = mode === "code"
    ? findLatestBoundExecutionPlan(session.workspaceDir, conversationId) || undefined
    : undefined;
  if (executionPlan) {
    const error = approvedPlanFreshnessError(session.workspaceDir, executionPlan);
    if (error) {
      failChatRequest(session.workspaceDir, requestId);
      return { ok: false, code: "conflict", message: error };
    }
  }
  const taskManager = parent.workspaceDir === session.workspaceDir ? parent.taskManager : new TaskManager(session.workspaceDir);
  const messageBus = parent.workspaceDir === session.workspaceDir ? parent.messageBus : new MessageBus(session.workspaceDir);
  const teammateManager = parent.workspaceDir === session.workspaceDir
    ? parent.teammateManager
    : new TeammateManager(session.workspaceDir, messageBus, taskManager);
  const executionSession: UserSession = { ...session, taskManager, messageBus, teammateManager };
  const turn: PendingUserMessage = {
    requestId, message, conversationId, mode, modelName, executionPlan,
  };
  const recorder = new AgentRunRecorder(
    session.workspaceDir, createRunId(), conversationId, mode, undefined, undefined,
    executionPlan?.id, modelName, executionPlan ? "approved_plan" : "direct_code"
  );
  let run: ActiveChatRun;
  try {
    run = createRunContext(executionSession, recorder, input.ownerSessionToken);
  } catch {
    failChatRequest(session.workspaceDir, requestId);
    return { ok: false, code: "conflict", message: "This conversation already has an active run" };
  }
  let accepted = false;
  try {
    await beginRecordedRun(executionSession, turn, run, recorder);
    await appendConversationMessage(session.workspaceDir, conversationId, {
      role: "user", requestId, content: message, timestamp: Date.now(),
    });
    completeChatRequest(session.workspaceDir, requestId, conversationId);
    accepted = true;
    wsSend(run.transport, { type: "request_accepted", requestId, conversationId });
    wsSend(run.transport, { type: "conversation", conversationId, created });
    if (created) {
      void generateConversationTitle(message, { workspaceDir: session.workspaceDir, conversationId, modelName })
        .then((title) => {
          if (!title) return;
          void updateConversationTitle(session.workspaceDir, conversationId, title);
          wsSend(run.transport, { type: "conversation_updated", conversationId, title });
        }).catch(() => { /* Title generation is best effort. */ });
    }
    void executeRecordedRun(executionSession, turn, run, recorder);
    return { ok: true, conversationId, runId: recorder.runId, created };
  } catch (error) {
    if (!accepted) failChatRequest(session.workspaceDir, requestId);
    await failPreparedRun(executionSession, run);
    return { ok: false, code: "error", message: error instanceof Error ? error.message : "Could not start run" };
  }
  } catch (error) {
    failChatRequest(session.workspaceDir, requestId);
    return { ok: false, code: "error", message: error instanceof Error ? error.message : "Could not prepare run" };
  }
}

export function handleChatWs(
  ws: WebSocket,
  liveSession: UserSession,
  options: { validateSession?: () => boolean } = {}
): void {
  // Workspace switches mutate the live session in place. An in-flight turn must
  // retain the workspace and managers it started with through persistence/ACK.
  const session: UserSession = { ...liveSession };
  const connectedTeamId = resolveActiveTeam(liveSession)?.id || null;
  const validateSession = options.validateSession || (() => sessionManager.getSession(liveSession.token) === liveSession);
  let unsubscribeFollowed: (() => void) | null = null;
  let latestConversationId = "";

  const connectedTeamRole = (): "owner" | "admin" | "member" | "viewer" | null => {
    if (!connectedTeamId) return null;
    try {
      const team = getTeamManager(liveSession).getTeamDetails(connectedTeamId, liveSession.username);
      return team.workspaceDir === session.workspaceDir ? team.role : null;
    } catch { return null; }
  };

  const followRun = (conversationId: string): void => {
    if (latestConversationId === conversationId && unsubscribeFollowed) return;
    unsubscribeFollowed?.();
    unsubscribeFollowed = subscribeRunEvents(session.workspaceDir, (event) => {
      if (event.conversationId === conversationId && validateSession() && liveSession.workspaceDir === session.workspaceDir && (!connectedTeamId || connectedTeamRole())) {
        wsSend(ws, event.payload);
      }
    });
    latestConversationId = conversationId;
  };

  ws.on("close", () => {
    unsubscribeFollowed?.();
    unsubscribeFollowed = null;
  });

  ws.on("message", async (raw) => {
    let requestIdForError: string | undefined;
    let requestAccepted = false;
    let processingRequestId: string | undefined;
    try {
      const data = JSON.parse(raw.toString());
      requestIdForError = typeof data.requestId === "string" && data.requestId.trim()
        ? data.requestId.trim() : undefined;
      if (!validateSession()) {
        wsSend(ws, { type: "error", requestId: requestIdForError, content: "Session expired; reconnect after signing in" });
        ws.close();
        return;
      }
      if (liveSession.workspaceDir !== session.workspaceDir) {
        wsSend(ws, { type: "error", requestId: requestIdForError, content: "Workspace changed; reconnect chat before sending" });
        ws.close();
        return;
      }
      if (connectedTeamId && !connectedTeamRole()) {
        wsSend(ws, { type: "error", requestId: requestIdForError, content: "Team access was revoked" });
        ws.close();
        return;
      }
      if (data.type === "subscribe_run") {
        const conversationId = typeof data.conversationId === "string" ? data.conversationId.trim() : "";
        if (!conversationId || !conversationExists(session.workspaceDir, conversationId)) {
          wsSend(ws, { type: "error", content: "Conversation not found" });
          return;
        }
        followRun(conversationId);
        const run = getActiveRunContext(session.workspaceDir, conversationId);
        if (run) {
          const record = readRunRecord(session.workspaceDir, run.runId);
          if (record) wsSend(ws, {
            type: "run_state", conversationId, runId: run.runId, mode: record.mode,
            modelName: record.modelName, status: "running", metrics: record.metrics,
            event: record.events.at(-1), sequence: record.events.length, version: record.updatedAt,
          });
          for (const approval of run.approvals.listPending(conversationId)) {
            wsSend(ws, { type: "tool_approval_request", ...approval });
          }
        }
        return;
      }
      const canMutate = canWriteActiveWorkspace(liveSession) && (!connectedTeamId || connectedTeamRole() !== "viewer");
      if (!canMutate) {
        wsSend(ws, { type: "error", requestId: requestIdForError, content: "Active team role is read-only" });
        return;
      }
      if (data.type === "tool_approval_all") {
        const conversationId = typeof data.conversationId === "string"
          ? data.conversationId.trim()
          : "";
        if (!conversationId || !conversationExists(session.workspaceDir, conversationId)) {
          wsSend(ws, { type: "error", content: "Conversation not found for approval" });
          return;
        }
        const run = getActiveRunContext(session.workspaceDir, conversationId);
        if (!run) { wsSend(ws, { type: "error", content: "No active run for approval" }); return; }
        const result = await dispatchRunCommand(liveSession, { source: "web", type: "tool_approval_all", conversationId, runId: run.runId });
        if (!result.ok) wsSend(ws, { type: "error", content: result.message || "Approval rejected" });
        return;
      }
      if (data.type === "tool_approval") {
        const approvalId = typeof data.approvalId === "string" ? data.approvalId : "";
        const decision: ToolApprovalDecision =
          data.decision === "allow_once" || data.decision === "allow_session"
            ? data.decision
            : "deny";
        const run = findActiveRunForApproval(session.workspaceDir, approvalId);
        const result = run
          ? await dispatchRunCommand(liveSession, { source: "web", type: "tool_approval", conversationId: run.conversationId, runId: run.runId, approvalId, decision })
          : { ok: false, message: "Tool approval request is no longer active" };
        if (!result.ok) wsSend(ws, { type: "error", content: result.message || "Approval rejected" });
        return;
      }
      if (data.type === "stop") {
        const requestId =
          typeof data.requestId === "string" ? data.requestId.trim() : "";
        const conversationId = typeof data.conversationId === "string" && data.conversationId.trim()
          ? data.conversationId.trim() : latestConversationId;
        const run = conversationId ? getActiveRunContext(session.workspaceDir, conversationId) :
          listActiveRuns(session.workspaceDir).filter((item) => item.ownerUsername === session.username).length === 1
            ? getActiveRunContext(session.workspaceDir, listActiveRuns(session.workspaceDir).find((item) => item.ownerUsername === session.username)!.conversationId)
            : null;
        if (!run) { wsSend(ws, { type: "error", requestId, content: "No active run to stop" }); return; }
        const result = await dispatchRunCommand(liveSession, { source: "web", type: "stop", conversationId: run.conversationId, runId: run.runId, requestId: requestId || undefined });
        if (!result.ok) wsSend(ws, { type: "error", requestId, content: result.message || "Stop rejected" });
        return;
      }

      if (data.type === "resume") {
        const requestedConversationId =
          typeof data.conversationId === "string" ? data.conversationId.trim() : "";
        const requestedRunId =
          typeof data.runId === "string" ? data.runId.trim() : "";
        const resumableRun = requestedRunId
          ? readRunRecord(session.workspaceDir, requestedRunId)
          : requestedConversationId
            ? findLatestResumableRun(session.workspaceDir, requestedConversationId)
            : null;
        if (!resumableRun) {
          wsSend(ws, { type: "error", content: "No interrupted run is available to resume" });
          return;
        }
        if (
          requestedConversationId &&
          resumableRun.conversationId !== requestedConversationId
        ) {
          wsSend(ws, { type: "error", content: "Run does not belong to this conversation" });
          return;
        }
        if (resumableRun.parentRunId) {
          wsSend(ws, {
            type: "error",
            content: "Child agent runs cannot be resumed directly; resume the parent run instead",
          });
          return;
        }
        if (
          resumableRun.status !== "running" &&
          resumableRun.status !== "stopped" &&
          resumableRun.status !== "failed"
        ) {
          wsSend(ws, { type: "error", content: "Only interrupted runs can be resumed" });
          return;
        }

        const conversationId = resumableRun.conversationId;
        if (getActiveRunContext(session.workspaceDir, conversationId)) {
          wsSend(ws, { type: "error", content: "An AI run is already active" });
          return;
        }
        let executionPlan: ExecutionPlan | undefined;
        if (resumableRun.executionPlanId) {
          try {
            executionPlan = readExecutionPlan(
              session.workspaceDir,
              resumableRun.executionPlanId
            );
          } catch {
            executionPlan = undefined;
          }
        }
        if (executionPlan && !ensureApprovedPlanFresh(session.workspaceDir, executionPlan, ws, requestIdForError)) {
          return;
        }
        const resumeMode = resumableRun.mode;
        const resumeModelName = resolveSelectableModelName(
          resumeMode,
          resumableRun.modelName,
          config.agentProfiles,
          config.modelName,
          config.models.map((model) => model.modelName)
        );
        const requestId =
          typeof data.requestId === "string" && data.requestId.trim()
            ? data.requestId.trim()
            : createTurnRequestId();
        const runId = createRunId();
        const recorder = new AgentRunRecorder(
          session.workspaceDir,
          runId,
          conversationId,
          resumeMode,
          resumableRun.runId,
          undefined,
          executionPlan?.id,
          resumeModelName,
          executionPlan ? "approved_plan" : "direct_code"
        );
        const run = createRunContext(session, recorder);
        followRun(conversationId);
        try {
        await recorder.start();
        await updateConversationState(session.workspaceDir, conversationId, {
          mode: resumeMode,
          status: "running",
          lastRunId: runId,
        });
        await appendConversationMessage(session.workspaceDir, conversationId, {
          role: "user",
          content: RESUME_PROMPT,
          timestamp: Date.now(),
        });
        requestAccepted = true;
        wsSend(ws, { type: "request_accepted", requestId, conversationId });
        wsSend(ws, { type: "conversation", conversationId, created: false });
        wsSend(run.transport, {
          type: "conversation_state",
          conversationId,
          mode: resumeMode,
          status: "running",
        });
        wsSend(run.transport, {
          type: "run_state",
          conversationId,
          runId,
          mode: resumeMode,
          modelName: resumeModelName,
          status: "running",
          metrics: recorder.snapshot().metrics,
          event: recorder.snapshot().events.at(-1),
          sequence: recorder.snapshot().events.length,
          version: recorder.snapshot().updatedAt,
        });

        await processConversationQueue(
          run.transport,
          session,
          {
            requestId,
            message: RESUME_PROMPT,
            conversationId,
            mode: resumeMode,
            modelName: resumeModelName,
            selectedModelName: resumeModelName,
            executionPlan,
          },
          run.steeringQueue,
          run.controlState,
          recorder,
          run.approvals,
          run
        );
        } catch (error) {
          await failPreparedRun(session, run);
          throw error;
        } finally { run.finish(); }
        return;
      }

      const userMessage = typeof data.message === "string" ? data.message : "";
      const context = data.context as
        | { path: string; content: string; language: string; selection?: string }
        | undefined;
      const requestedConversationId =
        typeof data.conversationId === "string" ? data.conversationId.trim() : "";
      const requestedRequestId =
        typeof data.requestId === "string" ? data.requestId.trim() : "";
      const pendingRequestId = requestedRequestId || createTurnRequestId();
      const replayAcceptedRequest = (conversationId: string): void => {
        const original = readConversationMessages(session.workspaceDir, conversationId).find((message) =>
          message.role === "user" && message.requestId === pendingRequestId
        );
        const attachmentIds = data.attachments === undefined ? [] : data.attachments;
        const originalAttachmentIds = original?.attachments?.map((attachment) => attachment.id) || [];
        if (
          (requestedConversationId && requestedConversationId !== conversationId) ||
          !original || original.content !== userMessage.trim() ||
          !Array.isArray(attachmentIds) ||
          attachmentIds.length !== originalAttachmentIds.length ||
          attachmentIds.some((id: unknown, index: number) => id !== originalAttachmentIds[index])
        ) {
          wsSend(ws, { type: "error", requestId: pendingRequestId, content: "This request ID belongs to a different message" });
          return;
        }
        wsSend(ws, { type: "request_accepted", requestId: pendingRequestId, conversationId, replayed: true });
        wsSend(ws, { type: "conversation", conversationId, created: false });
        wsSend(ws, { type: "done", requestId: pendingRequestId });
      };
      if (requestedRequestId) {
        const previous = getChatRequestStatus(session.workspaceDir, pendingRequestId);
        if (previous.status === "accepted") {
          replayAcceptedRequest(previous.conversationId);
          return;
        }
        if (previous.status === "processing") {
          const inProgress = beginChatRequest(session.workspaceDir, pendingRequestId);
          if (inProgress.kind === "accepted") {
            replayAcceptedRequest(inProgress.conversationId);
            return;
          }
          if (inProgress.kind === "processing") {
            const acceptedConversationId = await inProgress.completion;
            if (acceptedConversationId) replayAcceptedRequest(acceptedConversationId);
            else wsSend(ws, { type: "error", requestId: pendingRequestId, content: "The earlier request was not accepted; please retry" });
            return;
          }
          // The first request failed between the status check and reservation.
          failChatRequest(session.workspaceDir, pendingRequestId);
        }
      }
      let mode = normalizeAgentMode(data.mode);
      const modelName = resolveSelectableModelName(
        mode,
        data.modelName,
        config.agentProfiles,
        config.modelName,
        config.models.map((model) => model.modelName)
      );

      const attachments = resolveChatAttachments(session.workspaceDir, data.attachments === undefined ? [] : data.attachments);
      const inputCapabilities = resolveModelInputCapabilities(modelName);
      if (attachments.some((attachment) => attachment.kind === "image") && !inputCapabilities.image_input) {
        wsSend(ws, { type: "error", requestId: requestedRequestId || undefined, content: `Model ${modelName} is not configured for image input` });
        return;
      }
      if (attachments.some((attachment) => attachment.kind === "pdf") && !inputCapabilities.pdf_input) {
        wsSend(ws, { type: "error", requestId: requestedRequestId || undefined, content: `Model ${modelName} is not configured for PDF input` });
        return;
      }

      if (!userMessage.trim() && attachments.length === 0) {
        wsSend(ws, { type: "error", requestId: requestedRequestId || undefined, content: "Empty message" });
        return;
      }

      let conversationId = requestedConversationId;
      let created = false;

      if (conversationId) {
        if (!conversationExists(session.workspaceDir, conversationId)) {
          wsSend(ws, { type: "error", requestId: requestedRequestId || undefined, content: "Conversation not found" });
          return;
        }
      } else {
        conversationId = createConversationId();
        created = true;
      }

      let executionPlan: ExecutionPlan | undefined;
      if (mode === "code") {
        executionPlan = findLatestBoundExecutionPlan(
          session.workspaceDir,
          conversationId
        ) || undefined;
        if (executionPlan && !ensureApprovedPlanFresh(session.workspaceDir, executionPlan, ws, pendingRequestId)) {
          return;
        }
      }

      const requestStatus = beginChatRequest(session.workspaceDir, pendingRequestId);
      if (requestStatus.kind === "accepted") {
        replayAcceptedRequest(requestStatus.conversationId);
        return;
      }
      if (requestStatus.kind === "processing") {
        const existingConversationId = await requestStatus.completion;
        if (existingConversationId) {
          replayAcceptedRequest(existingConversationId);
        } else {
          wsSend(ws, { type: "error", requestId: pendingRequestId, content: "The earlier request was not accepted; please retry" });
        }
        return;
      }
      processingRequestId = pendingRequestId;
      const existingRun = getActiveRunContext(session.workspaceDir, conversationId);
      if (existingRun && attachments.length > 0) {
        failChatRequest(session.workspaceDir, pendingRequestId);
        processingRequestId = undefined;
        wsSend(ws, { type: "error", requestId: pendingRequestId, content: "Wait for the current run to finish before sending attachments" });
        return;
      }
      try {
        const index = await getContextIndexAdapter().status(session.workspaceDir);
        wsSend(ws, { type: "context_index_state", requestId: requestedRequestId || undefined, ...index });
      } catch (error) {
        wsSend(ws, { type: "context_index_state", requestId: requestedRequestId || undefined, status: "error", error: error instanceof Error ? error.message : "Context index status failed" });
      }

      await updateConversationState(session.workspaceDir, conversationId, {
        mode,
        status: "running",
      });
      wsSend(ws, { type: "conversation_state", conversationId, mode, status: "running" });

      const userEntry: PersistedChatMessage = {
        role: "user",
        requestId: pendingRequestId,
        content: userMessage.trim(),
        timestamp: Date.now(),
        ...(attachments.length ? { attachments } : {}),
      };

      await appendConversationMessage(session.workspaceDir, conversationId, userEntry);
      requestAccepted = true;
      completeChatRequest(session.workspaceDir, pendingRequestId, conversationId);
      processingRequestId = undefined;
      wsSend(ws, { type: "request_accepted", requestId: requestedRequestId || pendingRequestId, conversationId });
      wsSend(ws, { type: "conversation", conversationId, created });

      if (created) {
        void generateConversationTitle(userEntry.content, {
          workspaceDir: session.workspaceDir,
          conversationId,
          requestId: requestedRequestId || undefined,
          modelName,
        })
          .then((title) => {
            if (!title) {
              return;
            }

            void updateConversationTitle(session.workspaceDir, conversationId, title);
            wsSend(ws, {
              type: "conversation_updated",
              conversationId,
              title,
            });
          })
          .catch(() => {
            // Best-effort title generation only.
          });
      }

      const pendingMessage: PendingUserMessage = {
        requestId: pendingRequestId,
        message: userMessage.trim(),
        attachments,
        context,
        conversationId,
        mode,
        modelName,
        selectedModelName: typeof data.modelName === "string" && data.modelName.trim() ? modelName : undefined,
        executionPlan,
      };

      const currentRun = getActiveRunContext(session.workspaceDir, conversationId);
      if (currentRun) {
        currentRun.steeringQueue.push(pendingMessage);
        followRun(conversationId);
        wsSend(currentRun.transport, {
          type: "steering",
          requestId: pendingMessage.requestId,
          content:
            data.type === "steer"
              ? "Correction queued for the current run"
              : "Message queued for the current run",
        });
        return;
      }

      const runId = createRunId();
      const recorder = new AgentRunRecorder(
        session.workspaceDir,
        runId,
        conversationId,
        mode,
        undefined,
        undefined,
        executionPlan?.id,
        modelName,
        executionPlan ? "approved_plan" : "direct_code"
      );
      const run = createRunContext(session, recorder);
      followRun(conversationId);
      try {
        await beginRecordedRun(session, pendingMessage, run, recorder);
        await executeRecordedRun(session, pendingMessage, run, recorder);
      } catch (error) {
        await failPreparedRun(session, run);
        throw error;
      }
    } catch (e: any) {
      if (processingRequestId && !requestAccepted) failChatRequest(session.workspaceDir, processingRequestId);
      wsSend(ws, { type: "error", requestId: requestAccepted ? undefined : requestIdForError, content: e.message || String(e) });
    }
  });
}

function createRunContext(session: UserSession, recorder: AgentRunRecorder, ownerSessionToken?: string): ActiveChatRun {
  let run!: ActiveChatRun;
  run = createActiveRun({
    session,
    ownerSessionToken,
    recorder,
    queueSteering: (actor, command) => queueRemoteSteering(run, actor, command),
  });
  return run;
}

async function beginRecordedRun(
  session: UserSession,
  turn: PendingUserMessage,
  run: ActiveChatRun,
  recorder: AgentRunRecorder
): Promise<void> {
  await recorder.start();
  await updateConversationState(session.workspaceDir, turn.conversationId, {
    mode: turn.mode,
    status: "running",
    lastRunId: recorder.runId,
  });
  const record = recorder.snapshot();
  wsSend(run.transport, {
    type: "run_state", conversationId: turn.conversationId, runId: recorder.runId,
    mode: turn.mode, modelName: turn.modelName, status: "running",
    metrics: record.metrics, event: record.events.at(-1),
    sequence: record.events.length, version: record.updatedAt,
  });
}

async function failPreparedRun(session: UserSession, run: ActiveChatRun): Promise<void> {
  const recorder = run.currentRecorder;
  if (recorder.snapshot().status === "running") {
    try {
      const failed = await recorder.finish(run.controlState.stopped ? "stopped" : "failed");
      await updateConversationState(session.workspaceDir, failed.conversationId, {
        mode: failed.mode, status: failed.status === "stopped" ? "stopped" : "failed", lastRunId: failed.runId,
      });
    } catch { /* Preserve the original startup failure. */ }
  }
  run.finish();
}

async function executeRecordedRun(
  session: UserSession,
  turn: PendingUserMessage,
  run: ActiveChatRun,
  recorder: AgentRunRecorder
): Promise<void> {
  try {
    await processConversationQueue(
      run.transport, session, turn, run.steeringQueue, run.controlState,
      recorder, run.approvals, run
    );
  } catch (error) {
    const current = run.currentRecorder;
    const record = current.snapshot();
    if (record.status === "running") {
      try {
        const failed = await current.finish("failed");
        await updateConversationState(session.workspaceDir, current.conversationId, {
          mode: failed.mode, status: "failed", lastRunId: failed.runId,
        });
        wsSend(run.transport, {
          type: "run_state", conversationId: failed.conversationId,
          runId: failed.runId, mode: failed.mode, modelName: failed.modelName,
          status: "failed", metrics: failed.metrics, event: failed.events.at(-1),
          sequence: failed.events.length, version: failed.updatedAt,
        });
      } catch { /* Report the original failure below. */ }
    }
    wsSend(run.transport, { type: "error", requestId: turn.requestId, content: error instanceof Error ? error.message : String(error) });
  } finally {
    run.finish();
  }
}

async function queueRemoteSteering(
  run: ActiveChatRun,
  session: UserSession,
  command: Extract<RunCommand, { type: "steer" }>
): Promise<RunCommandResult> {
  const message = command.message.trim();
  const requestId = command.requestId.trim();
  if (!message || message.length > 32_000 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(requestId)) {
    return { ok: false, code: "invalid", message: "A valid request ID and message are required" };
  }
  if (run.runId !== command.runId || run.controlState.stopped) {
    return { ok: false, code: "conflict", message: "Run is no longer accepting corrections" };
  }
  const reservation = beginChatRequest(session.workspaceDir, requestId);
  if (reservation.kind === "processing") {
    const accepted = await reservation.completion;
    const original = accepted ? readConversationMessages(session.workspaceDir, accepted).find((entry) => entry.role === "user" && entry.requestId === requestId) : undefined;
    return accepted === run.conversationId && original?.content === message
      ? { ok: true, code: "accepted", requestId }
      : { ok: false, code: "conflict", message: "Request ID is already in use" };
  }
  if (reservation.kind === "accepted") {
    const original = readConversationMessages(session.workspaceDir, reservation.conversationId).find((entry) => entry.role === "user" && entry.requestId === requestId);
    return reservation.conversationId === run.conversationId && original?.content === message
      ? { ok: true, code: "accepted", requestId }
      : { ok: false, code: "conflict", message: "Request ID belongs to a different message" };
  }
  try {
    await appendConversationMessage(session.workspaceDir, run.conversationId, {
      role: "user", requestId, content: message, timestamp: Date.now(),
    });
    completeChatRequest(session.workspaceDir, requestId, run.conversationId);
    const current = run.snapshot();
    run.steeringQueue.push({
      requestId, message, conversationId: run.conversationId,
      mode: current.mode, modelName: current.modelName || config.modelName,
    });
    run.emit({ type: "request_accepted", requestId, conversationId: run.conversationId });
    run.emit({ type: "steering", requestId, content: "Correction queued for the current run" });
    return { ok: true, code: "accepted", requestId };
  } catch (error) {
    failChatRequest(session.workspaceDir, requestId);
    return { ok: false, code: "conflict", message: error instanceof Error ? error.message : "Could not queue correction" };
  }
}

async function processConversationQueue(
  ws: WebSocket,
  session: UserSession,
  initialTurn: PendingUserMessage,
  steeringQueue: PendingUserMessage[],
  controlState: RunControlState,
  recorder: AgentRunRecorder,
  approvals: ToolApprovalSession,
  run: ActiveChatRun
): Promise<void> {
  let activeConversationId = initialTurn.conversationId;

  let assistantMessages: PersistedChatMessage[] = [];
  const executionContractKind = initialTurn.executionPlan ? "approved_plan" as const : "direct_code" as const;
  try {
    if (initialTurn.mode === "code") {
      if (initialTurn.executionPlan) {
        updateExecutionPlanStatus(
          session.workspaceDir,
          initialTurn.executionPlan.id,
          "in_progress",
          recorder.runId
        );
      }
      const checkpoint = createCheckpoint(session.workspaceDir, {
        label: `Before agent task · ${initialTurn.message.slice(0, 72)}`,
        conversationId: initialTurn.conversationId,
        runId: recorder.runId,
        kind: "run",
      });
      new TraceStore(session.workspaceDir).append({
        kind: "checkpoint",
        action: "Run checkpoint created",
        correlationId: recorder.runId,
        runId: recorder.runId,
        conversationId: initialTurn.conversationId,
        metadata: { checkpointId: checkpoint.id, kind: checkpoint.kind, fileCount: checkpoint.fileCount },
      });
      await recorder.event({
        kind: "tool_result",
        label: "Workspace checkpoint created",
        requestId: initialTurn.requestId,
        toolName: "workspace_checkpoint",
        detail: `${checkpoint.id} · ${checkpoint.fileCount} files`,
      });
    }
    assistantMessages = await runAgentLoop(
    ws,
    initialTurn.message,
    initialTurn.requestId,
    session,
    initialTurn.context,
    buildModelHistoryForTurn(
      session.workspaceDir,
      initialTurn.conversationId,
      1 + countQueuedForConversation(steeringQueue, initialTurn.conversationId)
    ),
    undefined,
    () => drainConversationQueue(steeringQueue, activeConversationId),
    (turn) => {
      activeConversationId = turn.conversationId || activeConversationId;
    },
    async (assistantEntry, _assistantRequestId) => {
      await appendConversationMessage(
        session.workspaceDir,
        activeConversationId,
        assistantEntry
      );
    },
    {
      isStopped: () => {
        run.stopIfAccessRevoked();
        return controlState.stopped;
      },
      createAbortSignal: () => {
        run.stopIfAccessRevoked();
        return controlState.createAbortSignal();
      },
      mode: initialTurn.mode,
      modelName: initialTurn.modelName,
      attachments: initialTurn.attachments,
      conversationId: activeConversationId,
      runRecorder: recorder,
      requestToolApproval: (input) => {
        run.stopIfAccessRevoked();
        return controlState.stopped ? Promise.resolve("deny") : approvals.request({
          ...input,
          conversationId: activeConversationId,
        });
      },
      executionPlan: initialTurn.executionPlan,
    }
    );
    await run.closeSteeringGate();
  } catch (error) {
    await run.closeSteeringGate();
    const qualityGate = error instanceof CompletionQualityGateError ? error.evidence : undefined;
    if (initialTurn.executionPlan) {
      const currentPlan = readExecutionPlan(session.workspaceDir, initialTurn.executionPlan.id);
      // A crash must not silently revive a stale plan or one awaiting amendment approval.
      if (
        currentPlan.status !== "needs_revision" &&
        !currentPlan.amendmentRequests?.some((entry) => entry.status === "pending")
      ) {
        updateExecutionPlanStatus(session.workspaceDir, currentPlan.id, "approved", recorder.runId);
      }
    }
    const currentMetrics = recorder.snapshot().metrics;
    await recorder.event(
      {
        kind: "error",
        label: "Agent run crashed",
        isError: true,
        detail: error instanceof Error ? error.message : String(error),
      },
      { modelErrors: currentMetrics.modelErrors + 1 }
    );
    const runtimeState = runtimeCompletionState(session, approvals, recorder.runId, activeConversationId);
    const failedSummary = {
      changedFiles: runtimeState.changedFiles,
      toolCallCount: currentMetrics.toolCalls,
      errorCount: currentMetrics.toolErrors + currentMetrics.modelErrors + 1,
      commandCount: 0,
      executionContractKind,
    };
    const completionEvidence = deriveCompletionEvidence({
      plan: initialTurn.executionPlan,
      messages: assistantMessages,
      baseError: true,
      changedFiles: runtimeState.changedFiles,
      blockers: { childRun: runtimeState.childRun, approval: runtimeState.approval, conflict: runtimeState.conflict, check: runtimeState.check, changeEvidence: runtimeState.changeEvidence, quality: Boolean(qualityGate) },
    });
    const completedFailedSummary = { ...failedSummary, completionEvidence, ...(qualityGate ? { qualityGate } : {}) };
    const finishedRecord = await recorder.finish("failed", {}, completedFailedSummary, completionEvidence, qualityGate);
    await updateConversationState(session.workspaceDir, activeConversationId, {
      mode: initialTurn.mode,
      status: "failed",
      summary: completedFailedSummary,
      lastRunId: recorder.runId,
    });
    wsSend(ws, {
      type: "run_state",
      conversationId: activeConversationId,
      runId: recorder.runId,
      mode: initialTurn.mode,
      modelName: initialTurn.modelName,
      status: "failed",
      metrics: finishedRecord.metrics,
      event: finishedRecord.events.at(-1),
      sequence: finishedRecord.events.length,
      version: finishedRecord.updatedAt,
      executionContractKind,
      completionEvidence,
      qualityGate,
    });
    wsSend(ws, {
      type: "summary",
      conversationId: activeConversationId,
      requestId: initialTurn.requestId,
      runId: recorder.runId,
      metrics: finishedRecord.metrics,
      ...completedFailedSummary,
      qualityGate,
    });
    wsSend(ws, {
      type: "error",
      requestId: initialTurn.requestId,
      content: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const summary = summarizeAssistantMessages(assistantMessages, initialTurn.mode, session.workspaceDir);
  const runtimeState = runtimeCompletionState(session, approvals, recorder.runId, activeConversationId);
  summary.changedFiles = Array.from(new Set([...summary.changedFiles, ...runtimeState.changedFiles])).sort();
  if (summary.changedFiles.length) {
    new TraceStore(session.workspaceDir).append({
      kind: "git",
      action: "Workspace changes observed",
      correlationId: recorder.runId,
      runId: recorder.runId,
      conversationId: activeConversationId,
      metadata: { changedFiles: summary.changedFiles.slice(0, 200), changedFileCount: summary.changedFiles.length },
    });
  }
  if (initialTurn.mode === "review" && summary.reviewFindings) {
    const findings = new ReviewFindingStore(session.workspaceDir);
    const reviewer = { id: session.username, modelName: initialTurn.modelName, profile: "review" };
    for (const finding of summary.reviewFindings) {
      const stored = findings.ingest(finding, {
        ...reviewer,
        ...(finding.reviewedRevision ? { revision: finding.reviewedRevision } : {}),
      }, {
        runId: recorder.runId,
        conversationId: activeConversationId,
      });
      if (stored) {
        new TraceStore(session.workspaceDir).append({
          kind: "review",
          action: "Review finding recorded",
          correlationId: recorder.runId,
          runId: recorder.runId,
          conversationId: activeConversationId,
          agentId: reviewer.id,
          decision: stored.lifecycle,
          metadata: { findingId: stored.id, severity: stored.severity, path: stored.path, line: stored.line, version: stored.version },
        });
      }
    }
  }
  const requiresReplan = assistantMessages.some((message) =>
    (message.toolCalls || []).some((tool) =>
      tool.isError && tool.result?.includes("Execution plan scope violation")
    )
  );
  let currentExecutionPlan = persistPlanAmendments(
    session.workspaceDir,
    initialTurn.executionPlan,
    assistantMessages,
    recorder.runId
  );
  const amendmentBlocked = Boolean(
    requiresReplan || currentExecutionPlan?.amendmentRequests?.some((entry) => entry.status === "pending")
  );
  const completionEvidence = deriveCompletionEvidence({
    plan: initialTurn.executionPlan,
    messages: assistantMessages,
    changedFiles: runtimeState.changedFiles,
    stopped: controlState.stopped,
    // Individual tool failures are part of normal agent exploration. They are
    // represented in verification evidence (and required commands become
    // validation_failed) rather than poisoning an otherwise successful run.
    // Reserve the base error signal for an interrupted transport; explicit
    // fatal agent errors take the outer catch path above.
    baseError: ws.readyState !== WebSocket.OPEN,
    blockers: { childRun: runtimeState.childRun, approval: runtimeState.approval, amendment: amendmentBlocked, conflict: runtimeState.conflict, check: runtimeState.check, changeEvidence: runtimeState.changeEvidence },
  });
  let finalStatus = finalStatusFromCompletionEvidence(completionEvidence);
  let completedSummary = { ...summary, executionContractKind, completionEvidence };
  const finishedRecord = await recorder.finish(finalStatus, {}, completedSummary, completionEvidence);
  if (finishedRecord.status === "failed") finalStatus = "failed";
  const effectiveCompletionEvidence = finishedRecord.completionEvidence || completionEvidence;
  completedSummary = (finishedRecord.summary || { ...completedSummary, completionEvidence: effectiveCompletionEvidence }) as typeof completedSummary;
  const finalMode = initialTurn.mode;
  if (currentExecutionPlan) {
    if (amendmentBlocked) {
      currentExecutionPlan = updateExecutionPlanStatus(
        session.workspaceDir,
        currentExecutionPlan.id,
        "needs_revision",
        recorder.runId
      );
    } else if (finalStatus === "completed") {
      currentExecutionPlan = updateExecutionPlanStatus(
        session.workspaceDir,
        currentExecutionPlan.id,
        "completed",
        recorder.runId
      );
    } else {
      currentExecutionPlan = updateExecutionPlanStatus(
        session.workspaceDir,
        currentExecutionPlan.id,
        "approved",
        recorder.runId
      );
    }
  }
  await updateConversationState(session.workspaceDir, activeConversationId, {
    mode: finalMode,
    status: finalStatus,
    summary: completedSummary,
    lastRunId: recorder.runId,
  });
  wsSend(ws, {
    type: "run_state",
    conversationId: activeConversationId,
    runId: recorder.runId,
    mode: finalMode,
    modelName: initialTurn.modelName,
    status: finalStatus,
    metrics: finishedRecord.metrics,
    event: finishedRecord.events.at(-1),
    sequence: finishedRecord.events.length,
    version: finishedRecord.updatedAt,
    executionContractKind,
    completionEvidence: effectiveCompletionEvidence,
    qualityGate: finishedRecord.qualityGate,
    ...(currentExecutionPlan ? { executionPlan: currentExecutionPlan } : {}),
  });
  wsSend(ws, {
    type: "summary",
    conversationId: activeConversationId,
    requestId: initialTurn.requestId,
    runId: recorder.runId,
    metrics: finishedRecord.metrics,
    ...completedSummary,
    qualityGate: finishedRecord.qualityGate,
    ...(currentExecutionPlan ? { executionPlan: currentExecutionPlan } : {}),
  });
  wsSend(ws, {
    type: "conversation_state",
    conversationId: activeConversationId,
    mode: finalMode,
    status: finalStatus,
  });

  if (controlState.stopped) {
    controlState.reset();
    return;
  }

  const approvedPlan = initialTurn.mode === "plan"
    ? resolvePlanCodeHandoff({
        workspaceDir: session.workspaceDir,
        conversationId: activeConversationId,
        planRunId: recorder.runId,
        finalStatus,
      })
    : null;
  const nextTurn: PendingUserMessage | undefined = approvedPlan
    ? {
        requestId: createTurnRequestId(),
        message: PLAN_CODE_HANDOFF_PROMPT,
        conversationId: activeConversationId,
        mode: "code",
        modelName: resolveSelectableModelName(
          "code",
          initialTurn.selectedModelName,
          config.agentProfiles,
          config.modelName,
          config.models.map((model) => model.modelName)
        ),
        selectedModelName: initialTurn.selectedModelName,
        executionPlan: approvedPlan,
      }
    : steeringQueue.shift();
  if (nextTurn) {
    if (nextTurn.executionPlan && !ensureApprovedPlanFresh(session.workspaceDir, nextTurn.executionPlan, ws, nextTurn.requestId)) {
      return;
    }
    const nextRunId = createRunId();
    const nextRecorder = new AgentRunRecorder(
      session.workspaceDir,
      nextRunId,
      nextTurn.conversationId,
      nextTurn.mode,
      undefined,
      undefined,
      nextTurn.executionPlan?.id,
      nextTurn.modelName,
      nextTurn.executionPlan ? "approved_plan" : "direct_code"
    );
    const finishStoppedFollowUp = async (): Promise<void> => {
      const stoppedRecord = await nextRecorder.finish("stopped");
      await updateConversationState(session.workspaceDir, nextTurn.conversationId, {
        mode: nextTurn.mode, status: "stopped", lastRunId: nextRunId,
      });
      wsSend(ws, {
        type: "run_state", conversationId: nextTurn.conversationId,
        runId: nextRunId, requestId: nextTurn.requestId, mode: nextTurn.mode,
        modelName: nextTurn.modelName, status: "stopped",
        metrics: stoppedRecord.metrics, event: stoppedRecord.events.at(-1),
        sequence: stoppedRecord.events.length, version: stoppedRecord.updatedAt,
      });
    };
    await nextRecorder.start();
    if (controlState.stopped) { await finishStoppedFollowUp(); return; }
    await updateConversationState(session.workspaceDir, nextTurn.conversationId, {
      mode: nextTurn.mode,
      status: "running",
      lastRunId: nextRunId,
    });
    if (!run.setRecorder(nextRecorder)) { await finishStoppedFollowUp(); return; }
    wsSend(ws, {
      type: "conversation_state",
      conversationId: nextTurn.conversationId,
      mode: nextTurn.mode,
      status: "running",
    });
    wsSend(ws, {
      type: "run_state",
      conversationId: nextTurn.conversationId,
      runId: nextRunId,
      requestId: nextTurn.requestId,
      mode: nextTurn.mode,
      modelName: nextTurn.modelName,
      status: "running",
      metrics: nextRecorder.snapshot().metrics,
      event: nextRecorder.snapshot().events.at(-1),
      sequence: nextRecorder.snapshot().events.length,
      version: nextRecorder.snapshot().updatedAt,
    });
    await processConversationQueue(
      ws,
      session,
      nextTurn,
      steeringQueue,
      controlState,
      nextRecorder,
      approvals,
      run
    );
  }
}

/** Reject before recorder/conversation/checkpoint mutations begin a Code run. */
function ensureApprovedPlanFresh(
  workspaceDir: string,
  plan: ExecutionPlan,
  ws: WebSocket,
  requestId?: string
): boolean {
  const error = approvedPlanFreshnessError(workspaceDir, plan);
  if (!error) return true;
  wsSend(ws, { type: "error", requestId, content: error });
  return false;
}

function approvedPlanFreshnessError(workspaceDir: string, plan: ExecutionPlan): string | null {
  if (
    plan.status === "needs_revision" ||
    plan.amendmentRequests?.some((entry) => entry.status === "pending")
  ) {
    return "Approved execution plan requires revision: a plan amendment is pending";
  }
  if (plan.status !== "approved" && plan.status !== "in_progress") {
    return "Execution plan is not available to run";
  }
  const result = checkExecutionPlanFreshness(workspaceDir, plan);
  if (result.fresh) return null;
  const revised = updateExecutionPlanStatus(workspaceDir, plan.id, "needs_revision");
  return `Approved execution plan requires revision: ${result.reason} (${revised.id})`;
}

export type SummarizedReviewFinding = StructuredReviewFinding & { reviewedRevision?: string };

function parseToolResult(result: string | undefined): unknown | undefined {
  if (!result) return undefined;
  try { return JSON.parse(result); } catch { return undefined; }
}

function structuredReviewFinding(raw: unknown, fallbackId: string): SummarizedReviewFinding | null {
  const finding = normalizeReviewFinding(raw, fallbackId);
  if (!finding) return null;
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : undefined;
  const revision = typeof record?.reviewedRevision === "string"
    ? record.reviewedRevision.trim().slice(0, 160)
    : "";
  return { ...finding, ...(revision ? { reviewedRevision: revision } : {}) };
}

export interface AssistantMessageSummary {
  changedFiles: string[];
  toolCallCount: number;
  errorCount: number;
  commandCount: number;
  reviewFindings?: SummarizedReviewFinding[];
}

/** Build a persisted summary without letting legacy prose override structured review tool calls. */
export function summarizeAssistantMessages(messages: PersistedChatMessage[], mode: AgentMode, workspaceDir: string): AssistantMessageSummary {
  const changedFiles = new Set<string>();
  let toolCallCount = 0;
  let errorCount = 0;
  let commandCount = 0;

  for (const message of messages) {
    for (const toolCall of message.toolCalls || []) {
      toolCallCount += 1;
      if (toolCall.isError) errorCount += 1;
      if (toolCall.name === "bash") commandCount += 1;
      if (toolCall.fileUpdate?.path) changedFiles.add(toolCall.fileUpdate.path);
    }
  }

  // A successful review tool result is canonical because its handler has
  // validated path and size constraints. Fall back to the input only for an
  // interrupted call that has no result yet; this keeps streamed messages
  // useful without treating an explicit tool error as a finding.
  const toolFindings = messages.flatMap((message, messageIndex) =>
    (message.toolCalls || []).flatMap((toolCall, toolIndex) => {
      if (toolCall.name !== "report_review_finding" || toolCall.isError) return [];
      const result = parseToolResult(toolCall.result);
      const raw = result === undefined && toolCall.result === undefined ? toolCall.input : result;
      const finding = structuredReviewFinding(raw, `review-tool-${messageIndex + 1}-${toolIndex + 1}`);
      return finding ? [finding] : [];
    })
  );
  // Older persisted structured output remains supported, but never takes
  // precedence over the dedicated reporting tool.
  const messageFindings = messages.flatMap((message, messageIndex) => {
    const value = (message as PersistedChatMessage & { reviewFindings?: unknown }).reviewFindings;
    return Array.isArray(value) ? value.flatMap((entry, index) => {
      const finding = structuredReviewFinding(entry, `review-message-${messageIndex + 1}-${index + 1}`);
      return finding ? [finding] : [];
    }) : [];
  });
  const structured = toolFindings.length ? toolFindings : messageFindings;
  const reviewFindings = mode === "review"
    ? (structured.length
      ? structured
      : parseReviewFindings(messages.map((message) => message.content).join("\n"))
        .flatMap((finding, index) => {
          const normalized = normalizeReviewFinding(finding, `review-prose-${index + 1}`);
          return normalized ? [normalized] : [];
        }))
    : [];
  if (mode === "review") {
    try {
      for (const entry of readGitStatus(workspaceDir).entries) changedFiles.add(entry.path);
    } catch {
      for (const finding of reviewFindings) changedFiles.add(finding.path);
    }
  }

  return {
    changedFiles: Array.from(changedFiles).sort(),
    toolCallCount,
    errorCount,
    commandCount,
    ...(mode === "review" ? { reviewFindings } : {}),
  };
}

function buildModelHistoryForTurn(
  workspaceDir: string,
  conversationId: string,
  trailingPendingCount: number
): { role: string; content: string; attachments?: ChatAttachmentRef[] }[] {
  const messages = readConversationMessages(workspaceDir, conversationId);
  const endIndex = Math.max(0, messages.length - trailingPendingCount);

  return messages
    .slice(0, endIndex)
    .filter((entry) => entry.role === "user" || entry.role === "assistant")
    .map((entry) => ({
      role: entry.role,
      content: entry.content,
      ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
    }));
}

function countQueuedForConversation(
  steeringQueue: PendingUserMessage[],
  conversationId: string
): number {
  return steeringQueue.reduce(
    (count, item) => (item.conversationId === conversationId ? count + 1 : count),
    0
  );
}

function drainConversationQueue(
  steeringQueue: PendingUserMessage[],
  conversationId: string
): PendingUserMessage[] {
  if (steeringQueue.length === 0) {
    return [];
  }

  const matching: PendingUserMessage[] = [];
  const rest: PendingUserMessage[] = [];

  for (const item of steeringQueue) {
    if (item.conversationId === conversationId) {
      matching.push(item);
    } else {
      rest.push(item);
    }
  }

  steeringQueue.splice(0, steeringQueue.length, ...rest);
  return matching;
}

function createTurnRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
