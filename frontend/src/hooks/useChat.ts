import { useState, useRef, useCallback, useEffect } from "react";
import {
  ChatMessage,
  ConversationSummary,
  FileContext,
  FileUpdate,
} from "../types";
import { useI18n } from "../i18n";

interface ConversationsResponse {
  conversations?: ConversationSummary[];
}

interface ConversationDetailResponse {
  id: string;
  messages?: ChatMessage[];
}

export function useChat(
  token: string,
  workspaceDir: string,
  onFileUpdate?: (update: FileUpdate) => void
) {
  const { t } = useI18n();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeRequestIds, setActiveRequestIds] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(
    null
  );
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadingId, setHistoryLoadingId] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const onFileUpdateRef = useRef(onFileUpdate);

  useEffect(() => {
    onFileUpdateRef.current = onFileUpdate;
  }, [onFileUpdate]);

  const refreshConversations = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);

    try {
      const response = await fetch("/api/chat/conversations", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Failed to load conversations");
      }

      const payload = (await response.json()) as ConversationsResponse;
      setConversations(
        Array.isArray(payload.conversations) ? payload.conversations : []
      );
    } catch (error) {
      setHistoryError(
        error instanceof Error
          ? error.message
          : t("chat.failedToLoadHistory")
      );
    } finally {
      setHistoryLoading(false);
    }
  }, [token]);

  const updateAssistantByRequestId = useCallback(
    (
      requestId: string | undefined,
      updater: (msg: ChatMessage) => ChatMessage
    ) => {
      setMessages((prev) => {
        const updated = [...prev];
        if (requestId) {
          for (let index = updated.length - 1; index >= 0; index -= 1) {
            const candidate = updated[index];
            if (
              candidate.role === "assistant" &&
              candidate.requestId === requestId
            ) {
              updated[index] = updater(candidate);
              return updated;
            }
          }
        }

        for (let index = updated.length - 1; index >= 0; index -= 1) {
          const candidate = updated[index];
          if (candidate.role === "assistant") {
            updated[index] = updater(candidate);
            return updated;
          }
        }
        return updated;
      });
    },
    []
  );

  const finishRequest = useCallback((requestId?: string) => {
    if (!requestId) return;
    setActiveRequestIds((prev) => prev.filter((value) => value !== requestId));
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/chat?token=${encodeURIComponent(token)}`);

    ws.onopen = () => {
      setConnected(true);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };

    ws.onclose = () => {
      // Only clear if this WebSocket is still the current one.
      // Prevents React StrictMode double-mount from wiping the new connection.
      if (wsRef.current === ws) {
        setConnected(false);
        wsRef.current = null;
        reconnectTimer.current = setTimeout(connect, 3000);
      }
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      switch (data.type) {
        case "conversation":
          setCurrentConversationId(data.conversationId);
          void refreshConversations();
          break;

        case "conversation_updated":
          void refreshConversations();
          break;

        case "token":
          updateAssistantByRequestId(data.requestId, (msg) => ({
            ...msg,
            content: msg.content + data.content,
          }));
          break;

        case "thinking":
          updateAssistantByRequestId(data.requestId, (msg) => ({
            ...msg,
            thinking: (msg.thinking || "") + data.content,
          }));
          break;

        case "tool_call":
          updateAssistantByRequestId(data.requestId, (msg) => ({
            ...msg,
            toolCalls: [
              ...(msg.toolCalls || []),
              {
                toolCallId: data.toolCallId,
                name: data.name,
                input: data.input,
              },
            ],
          }));
          break;

        case "tool_result":
          updateAssistantByRequestId(data.requestId, (msg) => ({
            ...msg,
            toolCalls: (msg.toolCalls || []).map((tc) =>
              tc.toolCallId === data.toolCallId
                ? {
                    ...tc,
                    result: data.result,
                    isError: data.isError,
                    fileUpdate: data.fileUpdate,
                  }
                : tc
            ),
          }));
          if (data.fileUpdate && !data.isError) {
            onFileUpdateRef.current?.(data.fileUpdate);
          }
          break;

        case "done":
          finishRequest(data.requestId);
          void refreshConversations();
          break;

        case "error":
          updateAssistantByRequestId(data.requestId, (msg) => ({
            ...msg,
            content: msg.content || `Error: ${data.content}`,
          }));
          finishRequest(data.requestId);
          void refreshConversations();
          break;
      }
    };

    wsRef.current = ws;
  }, [finishRequest, refreshConversations, updateAssistantByRequestId, token]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  useEffect(() => {
    setMessages([]);
    setCurrentConversationId(null);
    setHistoryError(null);
    setActiveRequestIds([]);
    void refreshConversations();
  }, [refreshConversations, workspaceDir]);

  const sendMessage = useCallback(
    (content: string, context?: FileContext) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      const requestId = createRequestId();

      const userMsg: ChatMessage = {
        requestId,
        role: "user",
        content,
        timestamp: Date.now(),
      };
      const assistantMsg: ChatMessage = {
        requestId,
        role: "assistant",
        content: "",
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setActiveRequestIds((prev) =>
        prev.includes(requestId) ? prev : [...prev, requestId]
      );

      const history = messages.slice(-10).map((m) => ({
        role: m.role,
        content: m.content,
      }));

      wsRef.current.send(
        JSON.stringify({
          requestId,
          message: content,
          context,
          history,
          conversationId: currentConversationId,
        })
      );
    },
    [currentConversationId, messages]
  );

  const clearMessages = useCallback(() => {
    setMessages([]);
    setCurrentConversationId(null);
    setActiveRequestIds([]);
  }, []);

  const loadConversation = useCallback(
    async (conversationId: string) => {
      setHistoryLoadingId(conversationId);
      setHistoryError(null);

      try {
        const response = await fetch(
          `/api/chat/conversations/${encodeURIComponent(conversationId)}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || "Failed to load conversation");
        }

        const payload = (await response.json()) as ConversationDetailResponse;
        setMessages(Array.isArray(payload.messages) ? payload.messages : []);
        setCurrentConversationId(payload.id || conversationId);
      } catch (error) {
        setHistoryError(
          error instanceof Error
            ? error.message
            : t("chat.failedToLoadConversation")
        );
      } finally {
        setHistoryLoadingId(null);
      }
    },
    [t, token]
  );

  return {
    messages,
    sendMessage,
    clearMessages,
    isStreaming: activeRequestIds.length > 0,
    activeRequestIds,
    connected,
    currentConversationId,
    conversations,
    historyLoading,
    historyLoadingId,
    historyError,
    refreshConversations,
    loadConversation,
  };
}

function createRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
