export interface ChatRequestScope { conversationId: string | null; viewEpoch: number; runId?: string; }
export interface ConversationActivity { running: boolean; waiting: boolean; unread: boolean; updatedAt: number; runId?: string; }

/** Unscoped compatibility events may only refer to a request sent from this exact view. */
export function acceptsConversationEvent(
  event: { type: string; conversationId?: string; runId?: string; requestId?: string; status?: string },
  current: { conversationId: string | null; runId?: string | null; viewEpoch: number },
  request?: ChatRequestScope,
): boolean {
  if (event.conversationId) {
    if (event.conversationId !== current.conversationId) {
      // Admission can fail after the server allocates a conversation ID but
      // before ACK. Surface that error only in the originating, still-new draft.
      return event.type === "error" && current.conversationId === null
        && request?.conversationId === null && request.viewEpoch === current.viewEpoch;
    }
    if (event.runId && current.runId && event.runId !== current.runId
      && event.type !== "conversation_snapshot"
      && !(event.type === "run_state" && event.status === "running" && request?.viewEpoch === current.viewEpoch)) return false;
    return true;
  }
  return Boolean(event.requestId && request && request.viewEpoch === current.viewEpoch && request.conversationId === current.conversationId);
}

export function canBindAcceptedRequest(request: ChatRequestScope | undefined, currentConversationId: string | null, viewEpoch: number): boolean {
  return Boolean(request && request.viewEpoch === viewEpoch && request.conversationId === currentConversationId);
}
