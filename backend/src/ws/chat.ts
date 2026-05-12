import { WebSocket } from "ws";
import { wsSend } from "../agent/types.js";
import { runAgentLoop } from "../agent/loop.js";
import type { UserSession } from "../auth/sessionManager.js";
import {
  appendConversationMessage,
  conversationExists,
  createConversationId,
  updateConversationTitle,
  readConversationMessages,
  type PersistedChatMessage,
} from "../chat/history.js";
import { generateConversationTitle } from "../chat/title.js";

export function handleChatWs(ws: WebSocket, session: UserSession): void {
  const steeringQueue: PendingUserMessage[] = [];
  let activeRun: Promise<void> | null = null;

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      const userMessage: string = data.message || "";
      const context = data.context as
        | { path: string; content: string; language: string; selection?: string }
        | undefined;
      const requestedConversationId =
        typeof data.conversationId === "string" ? data.conversationId.trim() : "";
      const requestedRequestId =
        typeof data.requestId === "string" ? data.requestId.trim() : "";

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
      };

      if (activeRun) {
        steeringQueue.push(pendingMessage);
        return;
      }

      activeRun = processConversationQueue(
        ws,
        session,
        pendingMessage,
        steeringQueue
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
}

async function processConversationQueue(
  ws: WebSocket,
  session: UserSession,
  initialTurn: PendingUserMessage,
  steeringQueue: PendingUserMessage[]
): Promise<void> {
  let activeConversationId = initialTurn.conversationId;

  await runAgentLoop(
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
    }
  );

  const nextTurn = steeringQueue.shift();
  if (nextTurn) {
    await processConversationQueue(ws, session, nextTurn, steeringQueue);
  }
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
