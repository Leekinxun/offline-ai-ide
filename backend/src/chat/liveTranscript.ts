import type { WsServerMessage } from "../agent/types.js";
import type { PersistedChatMessage } from "./history.js";

/** Retains the in-flight assistant text that has not reached conversation storage yet. */
export class LiveTranscript {
  private readonly messages = new Map<string, PersistedChatMessage>();
  private readonly active = new Set<string>();
  private readonly stateEvents = new Map<string, WsServerMessage>();

  accept(event: WsServerMessage): void {
    if (["context_state", "mcp_state", "knowledge_state"].includes(event.type)) this.stateEvents.set(event.type, structuredClone(event));
    const requestId = "requestId" in event ? event.requestId : undefined;
    if (event.type === "stopped") { this.active.clear(); return; }
    if (!requestId) return;
    if (event.type === "done" || event.type === "error") {
      this.active.delete(requestId);
      // Completion can precede the awaited history flush. Keep the live image
      // until the enclosing run is retired so reconnect never sees that gap.
      return;
    }
    if (event.type === "steering" || (event.type === "run_state" && event.status === "running")) this.active.add(requestId);
    if (!["token", "thinking", "tool_call", "tool_result"].includes(event.type)) return;
    this.active.add(requestId);
    const message = this.messages.get(requestId) || { role: "assistant", requestId, content: "", timestamp: Date.now() };
    if (event.type === "token") message.content += event.content;
    if (event.type === "thinking") message.thinking = (message.thinking || "") + event.content;
    if (event.type === "tool_call") message.toolCalls = [...(message.toolCalls || []).filter((tool) => tool.toolCallId !== event.toolCallId), {
      toolCallId: event.toolCallId, name: event.name, input: event.input,
    }];
    if (event.type === "tool_result") message.toolCalls = (message.toolCalls || []).map((tool) => tool.toolCallId === event.toolCallId ? {
      ...tool, result: event.result, isError: event.isError, fileUpdate: event.fileUpdate,
    } : tool);
    this.messages.set(requestId, message);
  }

  currentStateEvents(): WsServerMessage[] { return [...this.stateEvents.values()].map((event) => structuredClone(event)); }

  snapshot(history: PersistedChatMessage[]): { messages: PersistedChatMessage[]; activeRequestIds: string[] } {
    const messages = history.filter((message) => message.role !== "assistant" || !message.requestId || !this.messages.has(message.requestId));
    return {
      messages: [...messages, ...this.messages.values()].sort((a, b) => a.timestamp - b.timestamp).map((message) => structuredClone(message)),
      activeRequestIds: [...this.active],
    };
  }
}
