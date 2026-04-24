import { WebSocket } from "ws";
import { WsServerMessage, wsSend } from "../agent/types.js";
import { runAgentLoop } from "../agent/loop.js";
import type { UserSession } from "../auth/sessionManager.js";
import {
  appendConversationMessage,
  conversationExists,
  createConversationId,
  updateConversationTitle,
  type PersistedChatMessage,
} from "../chat/history.js";
import { generateConversationTitle } from "../chat/title.js";

function accumulateAssistantEvent(
  assistantMessage: PersistedChatMessage,
  event: WsServerMessage
): void {
  switch (event.type) {
    case "thinking":
      assistantMessage.thinking = `${assistantMessage.thinking || ""}${event.content}`;
      return;
    case "token":
      assistantMessage.content += event.content;
      return;
    case "tool_call":
      assistantMessage.toolCalls = [
        ...(assistantMessage.toolCalls || []),
        {
          toolCallId: event.toolCallId,
          name: event.name,
          input: event.input,
        },
      ];
      return;
    case "tool_result":
      assistantMessage.toolCalls = (assistantMessage.toolCalls || []).map((toolCall) =>
        toolCall.toolCallId === event.toolCallId
          ? {
              ...toolCall,
              result: event.result,
              isError: event.isError,
              fileUpdate: event.fileUpdate,
            }
          : toolCall
      );
      return;
    case "error":
      if (!assistantMessage.content) {
        assistantMessage.content = `Error: ${event.content}`;
      }
      return;
    default:
      return;
  }
}

export function handleChatWs(ws: WebSocket, session: UserSession): void {
  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      const userMessage: string = data.message || "";
      const context = data.context as
        | { path: string; content: string; language: string; selection?: string }
        | undefined;
      const history: { role: string; content: string }[] = data.history || [];
      const requestedConversationId =
        typeof data.conversationId === "string" ? data.conversationId.trim() : "";

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
      const assistantEntry: PersistedChatMessage = {
        role: "assistant",
        content: "",
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

      await runAgentLoop(
        ws,
        userMessage,
        session,
        context,
        history,
        (event) => accumulateAssistantEvent(assistantEntry, event)
      );

      if (
        assistantEntry.content ||
        assistantEntry.thinking ||
        (assistantEntry.toolCalls && assistantEntry.toolCalls.length > 0)
      ) {
        await appendConversationMessage(
          session.workspaceDir,
          conversationId,
          assistantEntry
        );
      }
    } catch (e: any) {
      wsSend(ws, { type: "error", content: e.message || String(e) });
    }
  });
}
