import type { WsServerMessage } from "../agent/types.js";
import type { PersistedChatMessage } from "./history.js";

interface LiveAssistantMessage extends PersistedChatMessage {
  activity?: { phase: "waiting" | "reasoning" | "responding" | "tool"; updatedAt: number; toolCallId?: string; waitingFor?: "acceptance" | "model" };
}

/** Retains the in-flight assistant text that has not reached conversation storage yet. */
export class LiveTranscript {
  private readonly messages = new Map<string, LiveAssistantMessage>();
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
    if (event.type === "run_state" && event.status === "running" && (event.event?.kind === "model_call" || event.event?.kind === "run_started")) {
      const message: LiveAssistantMessage = this.messages.get(requestId) || { role: "assistant", requestId, content: "", timestamp: Date.now() };
      message.activity = { phase: "waiting", waitingFor: event.event.kind === "model_call" ? "model" : "acceptance", updatedAt: Date.now() };
      this.messages.set(requestId, message);
      return;
    }
    if (!["token", "thinking", "tool_call", "tool_result"].includes(event.type)) return;
    this.active.add(requestId);
    const message: LiveAssistantMessage = this.messages.get(requestId) || { role: "assistant", requestId, content: "", timestamp: Date.now() };
    if (event.type === "token") { message.content += event.content; message.activity = { phase: "responding", updatedAt: Date.now() }; }
    if (event.type === "thinking") { message.thinking = (message.thinking || "") + event.content; message.activity = { phase: "reasoning", updatedAt: Date.now() }; }
    if (event.type === "tool_call" || event.type === "tool_result") message.activity = { phase: "tool", toolCallId: event.toolCallId, updatedAt: Date.now() };
    if (event.type === "tool_call") message.toolCalls = [...(message.toolCalls || []).filter((tool) => tool.toolCallId !== event.toolCallId), {
      toolCallId: event.toolCallId, name: event.name, input: event.input,
    }];
    if (event.type === "tool_result") message.toolCalls = [...(message.toolCalls || []).filter((tool) => tool.toolCallId !== event.toolCallId), {
      ...(message.toolCalls || []).find((tool) => tool.toolCallId === event.toolCallId), toolCallId: event.toolCallId, name: event.name,
      input: (message.toolCalls || []).find((tool) => tool.toolCallId === event.toolCallId)?.input || {}, result: event.result, isError: event.isError, fileUpdate: event.fileUpdate,
    }];
    this.messages.set(requestId, message);
  }

  currentStateEvents(): WsServerMessage[] { return [...this.stateEvents.values()].map((event) => structuredClone(event)); }

  snapshot(history: PersistedChatMessage[]): { messages: LiveAssistantMessage[]; activeRequestIds: string[] } {
    const messages = history.filter((message) => message.role !== "assistant" || !message.requestId || !this.messages.has(message.requestId));
    return {
      messages: [...messages, ...this.messages.values()].sort((a, b) => a.timestamp - b.timestamp).map((message) => structuredClone(message)),
      activeRequestIds: [...this.active],
    };
  }
}
