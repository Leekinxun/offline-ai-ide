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
  readRunRecord,
  RESUME_PROMPT,
} from "../chat/runHistory.js";
import { createCheckpoint } from "../chat/checkpoints.js";
import { ToolApprovalSession, type ToolApprovalDecision } from "../agent/toolApproval.js";
import { parseReviewFindings } from "../chat/reviewFindings.js";
import { readGitStatus } from "../files/gitStatus.js";
import {
  findLatestApprovedExecutionPlan,
  readExecutionPlan,
  updateExecutionPlanStatus,
  type ExecutionPlan,
} from "../chat/executionPlans.js";

function normalizeAgentMode(value: unknown): AgentMode {
  return value === "ask" || value === "review" || value === "plan" ? value : "code";
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
        const resumeMode = resumableRun.mode;
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
          executionPlan?.id
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
          status: "running",
          metrics: recorder.snapshot().metrics,
          event: recorder.snapshot().events.at(-1),
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

      if (!userMessage.trim()) {
        wsSend(ws, { type: "error", content: "Empty message" });
        return;
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
        executionPlan = findLatestApprovedExecutionPlan(
          session.workspaceDir,
          conversationId
        ) || undefined;
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
        void generateConversationTitle(userEntry.content)
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
        executionPlan?.id
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
        status: "running",
        metrics: recorder.snapshot().metrics,
        event: recorder.snapshot().events.at(-1),
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

  let assistantMessages: PersistedChatMessage[];
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
    if (initialTurn.executionPlan) {
      updateExecutionPlanStatus(
        session.workspaceDir,
        initialTurn.executionPlan.id,
        "approved",
        recorder.runId
      );
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
    const failedSummary = {
      changedFiles: [],
      toolCallCount: currentMetrics.toolCalls,
      errorCount: currentMetrics.toolErrors + currentMetrics.modelErrors + 1,
      commandCount: 0,
    };
    const finishedRecord = await recorder.finish("failed", {}, failedSummary);
    await updateConversationState(session.workspaceDir, activeConversationId, {
      mode: initialTurn.mode,
      status: "failed",
      summary: failedSummary,
      lastRunId: recorder.runId,
    });
    wsSend(ws, {
      type: "run_state",
      conversationId: activeConversationId,
      runId: recorder.runId,
      mode: initialTurn.mode,
      status: "failed",
      metrics: finishedRecord.metrics,
      event: finishedRecord.events.at(-1),
    });
    wsSend(ws, {
      type: "error",
      requestId: initialTurn.requestId,
      content: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const summary = summarizeAssistantMessages(assistantMessages, initialTurn.mode, session.workspaceDir);
  const requiresReplan = assistantMessages.some((message) =>
    (message.toolCalls || []).some((tool) =>
      tool.isError && tool.result?.includes("Execution plan scope violation")
    )
  );
  const finalStatus = controlState.stopped
    ? "stopped"
    : summary.errorCount > 0 || ws.readyState !== WebSocket.OPEN
      ? "failed"
      : "completed";
  const finishedRecord = await recorder.finish(finalStatus, {}, summary);
  const finalMode = initialTurn.mode;
  if (initialTurn.executionPlan) {
    if (requiresReplan) {
      updateExecutionPlanStatus(
        session.workspaceDir,
        initialTurn.executionPlan.id,
        "needs_revision",
        recorder.runId
      );
    } else if (finalStatus === "completed") {
      updateExecutionPlanStatus(
        session.workspaceDir,
        initialTurn.executionPlan.id,
        "completed",
        recorder.runId
      );
    } else {
      updateExecutionPlanStatus(
        session.workspaceDir,
        initialTurn.executionPlan.id,
        "approved",
        recorder.runId
      );
    }
  }
  await updateConversationState(session.workspaceDir, activeConversationId, {
    mode: finalMode,
    status: finalStatus,
    summary,
    lastRunId: recorder.runId,
  });
  wsSend(ws, {
    type: "run_state",
    conversationId: activeConversationId,
    runId: recorder.runId,
    mode: finalMode,
    status: finalStatus,
    metrics: finishedRecord.metrics,
    event: finishedRecord.events.at(-1),
  });
  wsSend(ws, {
    type: "summary",
    conversationId: activeConversationId,
    requestId: initialTurn.requestId,
    runId: recorder.runId,
    metrics: finishedRecord.metrics,
    ...summary,
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

  const nextTurn = steeringQueue.shift();
  if (nextTurn) {
    const nextRunId = createRunId();
    const nextRecorder = new AgentRunRecorder(
      session.workspaceDir,
      nextRunId,
      nextTurn.conversationId,
      nextTurn.mode,
      undefined,
      undefined,
      nextTurn.executionPlan?.id
    );
    await nextRecorder.start();
    await updateConversationState(session.workspaceDir, nextTurn.conversationId, {
      mode: nextTurn.mode,
      status: "running",
      lastRunId: nextRunId,
    });
    wsSend(ws, {
      type: "run_state",
      conversationId: nextTurn.conversationId,
      runId: nextRunId,
      mode: nextTurn.mode,
      status: "running",
      metrics: nextRecorder.snapshot().metrics,
      event: nextRecorder.snapshot().events.at(-1),
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

function summarizeAssistantMessages(messages: PersistedChatMessage[], mode: AgentMode, workspaceDir: string) {
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

  const reviewFindings = mode === "review"
    ? parseReviewFindings(messages.map((message) => message.content).join("\n"))
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
