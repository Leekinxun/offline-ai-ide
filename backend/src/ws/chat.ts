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

function normalizeAgentMode(value: unknown): AgentMode {
  return value === "ask" || value === "review" || value === "plan" ? value : "code";
}

export function handleChatWs(ws: WebSocket, session: UserSession): void {
  const steeringQueue: PendingUserMessage[] = [];
  const controlState = createRunControlState();
  let activeRun: Promise<void> | null = null;

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type === "stop") {
        const requestId =
          typeof data.requestId === "string" ? data.requestId.trim() : "";
        controlState.stop(requestId || undefined);
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
        if (
          resumableRun.status !== "running" &&
          resumableRun.status !== "stopped" &&
          resumableRun.status !== "failed"
        ) {
          wsSend(ws, { type: "error", content: "Only interrupted runs can be resumed" });
          return;
        }

        const conversationId = resumableRun.conversationId;
        const requestId =
          typeof data.requestId === "string" && data.requestId.trim()
            ? data.requestId.trim()
            : createTurnRequestId();
        const runId = createRunId();
        const recorder = new AgentRunRecorder(
          session.workspaceDir,
          runId,
          conversationId,
          resumableRun.mode,
          resumableRun.runId
        );
        await recorder.start();
        await updateConversationState(session.workspaceDir, conversationId, {
          mode: resumableRun.mode,
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
          mode: resumableRun.mode,
          status: "running",
        });
        wsSend(ws, {
          type: "run_state",
          conversationId,
          runId,
          mode: resumableRun.mode,
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
            mode: resumableRun.mode,
          },
          steeringQueue,
          controlState,
          recorder
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
      const mode = normalizeAgentMode(data.mode);

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
        mode
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
        recorder
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
}

async function processConversationQueue(
  ws: WebSocket,
  session: UserSession,
  initialTurn: PendingUserMessage,
  steeringQueue: PendingUserMessage[],
  controlState: RunControlState,
  recorder: AgentRunRecorder
): Promise<void> {
  let activeConversationId = initialTurn.conversationId;

  let assistantMessages: PersistedChatMessage[];
  try {
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
      }
    );
  } catch (error) {
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

  const summary = summarizeAssistantMessages(assistantMessages);
  const finalStatus = controlState.stopped
    ? "stopped"
    : summary.errorCount > 0 || ws.readyState !== WebSocket.OPEN
      ? "failed"
      : "completed";
  const finishedRecord = await recorder.finish(finalStatus, {}, summary);
  await updateConversationState(session.workspaceDir, activeConversationId, {
    mode: initialTurn.mode,
    status: finalStatus,
    summary,
    lastRunId: recorder.runId,
  });
  wsSend(ws, {
    type: "run_state",
    conversationId: activeConversationId,
    runId: recorder.runId,
    mode: initialTurn.mode,
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
    mode: initialTurn.mode,
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
      nextTurn.mode
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
      nextRecorder
    );
  }
}

function summarizeAssistantMessages(messages: PersistedChatMessage[]) {
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

  return {
    changedFiles: Array.from(changedFiles).sort(),
    toolCallCount,
    errorCount,
    commandCount,
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
  let activeAbortController: AbortController | null = null;

  return {
    stopped: false,
    requestId: undefined,
    stop(requestId?: string) {
      this.stopped = true;
      this.requestId = requestId;
      activeAbortController?.abort();
    },
    reset() {
      this.stopped = false;
      this.requestId = undefined;
      activeAbortController = null;
    },
    createAbortSignal() {
      activeAbortController = new AbortController();
      if (this.stopped) {
        activeAbortController.abort();
      }
      return activeAbortController.signal;
    },
  };
}
