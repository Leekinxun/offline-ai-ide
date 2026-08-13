import { WebSocket } from "ws";
import { wsSend } from "../agent/types.js";
import type { AgentMode } from "../agent/types.js";
import { runAgentLoop } from "../agent/loop.js";
import type { UserSession } from "../auth/sessionManager.js";
import {
  appendConversationMessage,
  conversationExists,
  createConversationId,
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
import { config } from "../config.js";
import { resolveSelectableModelName } from "../agent/agentProfiles.js";
import {
  PLAN_CODE_HANDOFF_PROMPT,
  resolvePlanCodeHandoff,
} from "../chat/planHandoff.js";
import { changeSetsContainEvidenceGaps, collectAuthoritativeChangeEvidence, deriveCompletionEvidence, type CompletionEvidence } from "../chat/completionEvidence.js";
import { CollaborationStore } from "../collaboration/collaborationStore.js";
import { listChangeSets } from "../chat/changeSets.js";
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
  ) || changeSets.filter((changeSet) => relevantChangeSets.has(changeSet.id) && changeSet.changedFiles.length > 0).some((changeSet) =>
    collaboration.integrationConflicts(changeSet).length > 0
  );
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

export function handleChatWs(ws: WebSocket, session: UserSession): void {
  const steeringQueue: PendingUserMessage[] = [];
  const controlState = createRunControlState();
  const approvals = new ToolApprovalSession((request) => {
    wsSend(ws, { type: "tool_approval_request", ...request });
  });
  let activeRun: Promise<void> | null = null;

  ws.on("close", () => {
    controlState.stop();
    approvals.cancelAll();
  });

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type === "tool_approval_all") {
        const conversationId = typeof data.conversationId === "string"
          ? data.conversationId.trim()
          : "";
        if (!conversationId || !conversationExists(session.workspaceDir, conversationId)) {
          wsSend(ws, { type: "error", content: "Conversation not found for approval" });
          return;
        }
        approvals.allowConversation(conversationId);
        return;
      }
      if (data.type === "tool_approval") {
        const approvalId = typeof data.approvalId === "string" ? data.approvalId : "";
        const decision: ToolApprovalDecision =
          data.decision === "allow_once" || data.decision === "allow_session"
            ? data.decision
            : "deny";
        if (!approvalId || !approvals.resolve(approvalId, decision)) {
          wsSend(ws, { type: "error", content: "Tool approval request is no longer active" });
        }
        return;
      }
      if (data.type === "stop") {
        const requestId =
          typeof data.requestId === "string" ? data.requestId.trim() : "";
        controlState.stop(requestId || undefined);
        approvals.cancelAll();
        steeringQueue.splice(0, steeringQueue.length);
        wsSend(ws, {
          type: "stopped",
          ...(requestId ? { requestId } : {}),
          content: "Stopping current AI run...",
        });
        return;
      }

      if (data.type === "resume") {
        if (activeRun) {
          wsSend(ws, { type: "error", content: "An AI run is already active" });
          return;
        }

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
        if (executionPlan && !ensureApprovedPlanFresh(session.workspaceDir, executionPlan, ws)) {
          return;
        }
        const resumeMode = resumableRun.mode;
        const resumeModelName = resolveSelectableModelName(
          resumeMode,
          resumableRun.modelName,
          config.agentProfiles,
          config.modelName
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
        wsSend(ws, { type: "conversation", conversationId, created: false });
        wsSend(ws, {
          type: "conversation_state",
          conversationId,
          mode: resumeMode,
          status: "running",
        });
        wsSend(ws, {
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

        controlState.reset();
        activeRun = processConversationQueue(
          ws,
          session,
          {
            requestId,
            message: RESUME_PROMPT,
            conversationId,
            mode: resumeMode,
            modelName: resumeModelName,
            executionPlan,
          },
          steeringQueue,
          controlState,
          recorder,
          approvals
        ).finally(() => {
          activeRun = null;
        });
        await activeRun;
        return;
      }

      const userMessage: string = data.message || "";
      const context = data.context as
        | { path: string; content: string; language: string; selection?: string }
        | undefined;
      const requestedConversationId =
        typeof data.conversationId === "string" ? data.conversationId.trim() : "";
      const requestedRequestId =
        typeof data.requestId === "string" ? data.requestId.trim() : "";
      let mode = normalizeAgentMode(data.mode);
      const modelName = resolveSelectableModelName(
        mode,
        data.modelName,
        config.agentProfiles,
        config.modelName
      );

      if (!userMessage.trim()) {
        wsSend(ws, { type: "error", content: "Empty message" });
        return;
      }
      try {
        const index = await getContextIndexAdapter().status(session.workspaceDir);
        wsSend(ws, { type: "context_index_state", requestId: requestedRequestId || undefined, ...index });
      } catch (error) {
        wsSend(ws, { type: "context_index_state", requestId: requestedRequestId || undefined, status: "error", error: error instanceof Error ? error.message : "Context index status failed" });
      }

      let conversationId = requestedConversationId;
      let created = false;

      if (conversationId) {
        if (!conversationExists(session.workspaceDir, conversationId)) {
          wsSend(ws, { type: "error", content: "Conversation not found" });
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
        if (executionPlan && !ensureApprovedPlanFresh(session.workspaceDir, executionPlan, ws)) {
          return;
        }
      }

      await updateConversationState(session.workspaceDir, conversationId, {
        mode,
        status: "running",
      });
      wsSend(ws, { type: "conversation_state", conversationId, mode, status: "running" });

      const userEntry: PersistedChatMessage = {
        role: "user",
        content: userMessage.trim(),
        timestamp: Date.now(),
      };

      await appendConversationMessage(session.workspaceDir, conversationId, userEntry);
      wsSend(ws, { type: "conversation", conversationId, created });

      if (created) {
        void generateConversationTitle(userEntry.content, {
          workspaceDir: session.workspaceDir,
          conversationId,
          requestId: requestedRequestId || undefined,
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
        requestId: requestedRequestId || createTurnRequestId(),
        message: userMessage.trim(),
        context,
        conversationId,
        mode,
        modelName,
        executionPlan,
      };

      if (activeRun) {
        steeringQueue.push(pendingMessage);
        wsSend(ws, {
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
      await recorder.start();
      await updateConversationState(session.workspaceDir, conversationId, {
        mode,
        status: "running",
        lastRunId: runId,
      });
      wsSend(ws, {
        type: "run_state",
        conversationId,
        runId,
        mode,
        modelName,
        status: "running",
        metrics: recorder.snapshot().metrics,
        event: recorder.snapshot().events.at(-1),
        sequence: recorder.snapshot().events.length,
        version: recorder.snapshot().updatedAt,
      });

      controlState.reset();
      activeRun = processConversationQueue(
        ws,
        session,
        pendingMessage,
        steeringQueue,
        controlState,
        recorder,
        approvals
      ).finally(() => {
        activeRun = null;
      });
      await activeRun;
    } catch (e: any) {
      wsSend(ws, { type: "error", content: e.message || String(e) });
    }
  });
}

interface PendingUserMessage {
  requestId: string;
  message: string;
  context?: { path: string; content: string; language: string; selection?: string };
  conversationId: string;
  mode: AgentMode;
  modelName: string;
  executionPlan?: ExecutionPlan;
}

async function processConversationQueue(
  ws: WebSocket,
  session: UserSession,
  initialTurn: PendingUserMessage,
  steeringQueue: PendingUserMessage[],
  controlState: RunControlState,
  recorder: AgentRunRecorder,
  approvals: ToolApprovalSession
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
      isStopped: () => controlState.stopped,
      createAbortSignal: () => controlState.createAbortSignal(),
      mode: initialTurn.mode,
      modelName: initialTurn.modelName,
      conversationId: activeConversationId,
      runRecorder: recorder,
      requestToolApproval: (input) => approvals.request({
        ...input,
        conversationId: activeConversationId,
      }),
      executionPlan: initialTurn.executionPlan,
    }
    );
  } catch (error) {
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
    baseError: summary.errorCount > 0 || ws.readyState !== WebSocket.OPEN,
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
          undefined,
          config.agentProfiles,
          config.modelName
        ),
        executionPlan: approvedPlan,
      }
    : steeringQueue.shift();
  if (nextTurn) {
    if (nextTurn.executionPlan && !ensureApprovedPlanFresh(session.workspaceDir, nextTurn.executionPlan, ws)) {
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
    await nextRecorder.start();
    await updateConversationState(session.workspaceDir, nextTurn.conversationId, {
      mode: nextTurn.mode,
      status: "running",
      lastRunId: nextRunId,
    });
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
    controlState.reset();
    await processConversationQueue(
      ws,
      session,
      nextTurn,
      steeringQueue,
      controlState,
      nextRecorder,
      approvals
    );
  }
}

/** Reject before recorder/conversation/checkpoint mutations begin a Code run. */
function ensureApprovedPlanFresh(
  workspaceDir: string,
  plan: ExecutionPlan,
  ws: WebSocket
): boolean {
  if (
    plan.status === "needs_revision" ||
    plan.amendmentRequests?.some((entry) => entry.status === "pending")
  ) {
    wsSend(ws, {
      type: "error",
      content: "Approved execution plan requires revision: a plan amendment is pending",
    });
    return false;
  }
  if (plan.status !== "approved" && plan.status !== "in_progress") {
    wsSend(ws, { type: "error", content: "Execution plan is not available to run" });
    return false;
  }
  const result = checkExecutionPlanFreshness(workspaceDir, plan);
  if (result.fresh) return true;
  const revised = updateExecutionPlanStatus(workspaceDir, plan.id, "needs_revision");
  wsSend(ws, {
    type: "error",
    content: `Approved execution plan requires revision: ${result.reason} (${revised.id})`,
  });
  return false;
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
): { role: string; content: string }[] {
  const messages = readConversationMessages(workspaceDir, conversationId);
  const endIndex = Math.max(0, messages.length - trailingPendingCount);

  return messages
    .slice(0, endIndex)
    .filter((entry) => entry.role === "user" || entry.role === "assistant")
    .map((entry) => ({
      role: entry.role,
      content: entry.content,
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

interface RunControlState {
  stopped: boolean;
  requestId?: string;
  stop: (requestId?: string) => void;
  reset: () => void;
  createAbortSignal: () => AbortSignal | undefined;
}

function createRunControlState(): RunControlState {
  let activeAbortController = new AbortController();

  return {
    stopped: false,
    requestId: undefined,
    stop(requestId?: string) {
      this.stopped = true;
      this.requestId = requestId;
      activeAbortController?.abort();
    },
    reset() {
      activeAbortController.abort();
      this.stopped = false;
      this.requestId = undefined;
      activeAbortController = new AbortController();
    },
    createAbortSignal() {
      if (this.stopped) {
        activeAbortController.abort();
      }
      return activeAbortController.signal;
    },
  };
}
