import type { AgentRunState, ChatMessage, ToolApprovalRequest, ToolCallStep } from "../types";

export function updateAssistantMessage(messages: ChatMessage[], requestId: string | undefined, update: (message: ChatMessage) => ChatMessage, now = Date.now()): ChatMessage[] {
  if (!requestId) return messages;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "assistant" && messages[index].requestId === requestId) {
      const result = [...messages]; result[index] = update(messages[index]); return result;
    }
  }
  return [...messages, update({ role: "assistant", requestId, content: "", timestamp: now })];
}

export function isAssistantMessageVisible(message: ChatMessage): boolean {
  return Boolean(message.content.trim() || message.thinking?.trim() || message.toolCalls?.length || message.attachments?.length || message.contextReferences?.length);
}

export function activeAssistantMessage(messages: readonly ChatMessage[], activeRequestIds?: readonly string[], runState?: AgentRunState | null): ChatMessage | undefined {
  const active = activeRequestIds?.length ? new Set(activeRequestIds) : undefined;
  const eventRequestId = runState?.status === "running" ? runState.event?.requestId : undefined;
  if (eventRequestId && (!active || active.has(eventRequestId))) {
    const current = [...messages].reverse().find((message) => message.role === "assistant" && message.requestId === eventRequestId);
    if (current) return current;
  }
  return [...messages].reverse().find((message) => message.role === "assistant" && (!active || Boolean(message.requestId && active.has(message.requestId))));
}

export type AssistantActivityPhase = "waiting" | "reasoning" | "responding" | "tool" | "approval";
export interface AssistantActivityView {
  phase: AssistantActivityPhase;
  labelKey: string;
  detailKey?: string;
  detail?: string;
}
export function selectAssistantActivity(input: {
  messages: readonly ChatMessage[]; isStreaming: boolean; connected: boolean;
  runState?: AgentRunState | null; activeRequestIds?: readonly string[]; pendingApprovals: readonly ToolApprovalRequest[];
}): AssistantActivityView | null {
  if (!input.isStreaming) return null;
  if (!input.connected) return { phase: "waiting", labelKey: "assistantActivity.reconnecting", detailKey: "assistantActivity.reconnectingDetail" };
  const message = activeAssistantMessage(input.messages, input.activeRequestIds, input.runState);
  const approval = input.pendingApprovals.find((item) => !message?.requestId || item.requestId === message.requestId) || input.pendingApprovals[0];
  if (approval) return { phase: "approval", labelKey: "assistantActivity.approval", detail: approval.name };
  const activity = message?.activity;
  if (activity?.phase === "reasoning" && message?.thinking?.trim()) return { phase: "reasoning", labelKey: "assistantActivity.reasoning", detailKey: "assistantActivity.reasoningDetail" };
  if (activity?.phase === "responding") return { phase: "responding", labelKey: "assistantActivity.responding", detailKey: "assistantActivity.respondingDetail" };
  if (activity?.phase === "waiting") return { phase: "waiting", labelKey: "assistantActivity.waiting", detailKey: activity.waitingFor === "acceptance" ? "assistantActivity.requestSent" : "assistantActivity.modelWaiting" };
  const tool = message?.toolCalls?.find((item) => item.toolCallId === activity?.toolCallId)
    || [...(message?.toolCalls || [])].reverse().find((item) => item.result === undefined);
  if (tool) return { phase: "tool", labelKey: tool.result === undefined ? "assistantActivity.tool" : "assistantActivity.toolFinished", detail: `${tool.name}${typeof tool.input.path === "string" ? ` · ${tool.input.path}` : ""}` };
  const event = input.runState?.status === "running" ? input.runState.event : undefined;
  if (event?.kind === "model_call") return { phase: "waiting", labelKey: "assistantActivity.waiting", detailKey: "assistantActivity.modelWaiting" };
  if (message?.thinking?.trim() && !message.content.trim()) return { phase: "reasoning", labelKey: "assistantActivity.reasoning", detailKey: "assistantActivity.reasoningDetail" };
  if (message?.content.trim()) return { phase: "responding", labelKey: "assistantActivity.responding", detailKey: "assistantActivity.respondingDetail" };
  return { phase: "waiting", labelKey: "assistantActivity.waiting", ...(event?.label ? { detail: event.label } : { detailKey: "assistantActivity.requestSent" }) };
}

export function assistantToolStatus(step: ToolCallStep, active: boolean, approvals: readonly ToolApprovalRequest[]): "awaiting_permission" | "running" | "completed" | "failed" | "interrupted" {
  if (step.isError) return "failed";
  if (step.result !== undefined) return "completed";
  if (approvals.some((item) => item.toolCallId === step.toolCallId)) return "awaiting_permission";
  return active ? "running" : "interrupted";
}
