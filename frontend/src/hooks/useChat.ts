import { useState, useRef, useCallback, useEffect } from "react";
import { ChatMessage, FileContext } from "../types";

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();

  // Helper: update the last assistant message
  const updateLastAssistant = useCallback(
    (updater: (msg: ChatMessage) => ChatMessage) => {
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last && last.role === "assistant") {
          updated[updated.length - 1] = updater(last);
        }
        return updated;
      });
    },
    []
  );

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/chat`);

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
        case "token":
          updateLastAssistant((msg) => ({
            ...msg,
            content: msg.content + data.content,
          }));
          break;

        case "thinking":
          updateLastAssistant((msg) => ({
            ...msg,
            thinking: (msg.thinking || "") + data.content,
          }));
          break;

        case "tool_call":
          updateLastAssistant((msg) => ({
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
          updateLastAssistant((msg) => ({
            ...msg,
            toolCalls: (msg.toolCalls || []).map((tc) =>
              tc.toolCallId === data.toolCallId
                ? { ...tc, result: data.result, isError: data.isError }
                : tc
            ),
          }));
          break;

        case "done":
          setIsStreaming(false);
          break;

        case "error":
          updateLastAssistant((msg) => ({
            ...msg,
            content: msg.content || `Error: ${data.content}`,
          }));
          setIsStreaming(false);
          break;
      }
    };

    wsRef.current = ws;
  }, [updateLastAssistant]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const sendMessage = useCallback(
    (content: string, context?: FileContext) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

      const userMsg: ChatMessage = {
        role: "user",
        content,
        timestamp: Date.now(),
      };
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: "",
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);

      const history = messages.slice(-10).map((m) => ({
        role: m.role,
        content: m.content,
      }));

      wsRef.current.send(
        JSON.stringify({
          message: content,
          context,
          history,
        })
      );
    },
    [messages]
  );

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  return { messages, sendMessage, clearMessages, isStreaming, connected };
}
