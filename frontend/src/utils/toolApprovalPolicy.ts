import type { ToolApprovalRequest } from "../types";

/** Keep this predicate aligned with the server's explicit per-action boundary. */
export function canApproveToolInConversation(request: ToolApprovalRequest): boolean {
  return request.risk === "medium" && request.name !== "submit_plan" && request.input.allow_network !== true;
}

export interface ToolApprovalSnapshot {
  conversationId: string;
  runId: string;
  pendingApprovals: ToolApprovalRequest[];
}

/** Bulk approval is a request, not proof that any pending action was approved. */
export function applyToolApprovalSnapshot(
  previous: ToolApprovalRequest[],
  snapshot: ToolApprovalSnapshot,
  current: { conversationId: string | null; runId: string | null },
): ToolApprovalRequest[] {
  if (!current.conversationId || !current.runId
    || snapshot.conversationId !== current.conversationId || snapshot.runId !== current.runId
    || !Array.isArray(snapshot.pendingApprovals)
    || snapshot.pendingApprovals.some((request) => request.conversationId !== current.conversationId)) return previous;
  return snapshot.pendingApprovals;
}

export function approvalTaskAction(hasPendingApprovals: boolean, isStreaming: boolean, hasRecovery: boolean): "approval" | "stop" | "resume" | "idle" {
  return hasPendingApprovals ? "approval" : isStreaming ? "stop" : hasRecovery ? "resume" : "idle";
}
