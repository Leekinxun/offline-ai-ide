import type { AgentRunEvent, AgentRunState, ConversationRunSummary } from "../types";

const MAX_ITERATIONS_REASON_PATTERN = /^Agent loop exceeded maximum iterations \((\d+)\)$/;
const GENERIC_FAILURE_LABELS = new Set([
  "Agent run failed",
  "Run failed",
  "Task failed",
  "Failed",
]);

export type FailureNoticeKind = "max_iterations" | "generic";

export interface RunFailureNotice {
  kind: FailureNoticeKind;
  reason: string;
  limit?: number;
}

function cleanReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function failureReasonFromEvents(events?: readonly AgentRunEvent[]): string | null {
  if (!Array.isArray(events)) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== "error") continue;
    const detail = cleanReason(event.detail);
    if (detail) return detail;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== "error" && event.isError !== true) continue;
    const detail = cleanReason(event.detail);
    if (detail) return detail;
    const label = cleanReason(event.label);
    if (label && !GENERIC_FAILURE_LABELS.has(label)) return label;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== "error" && event.isError !== true) continue;
    const label = cleanReason(event.label);
    if (label) return label;
  }
  return null;
}

export function resolveRunFailureReason(
  runState: Pick<AgentRunState, "status" | "failureReason" | "summary" | "events"> | null | undefined,
  summary?: ConversationRunSummary | null,
): string | null {
  if (runState?.status !== "failed") return null;
  return cleanReason(runState.failureReason)
    || cleanReason(runState.summary?.failureReason)
    || cleanReason(summary?.failureReason)
    || failureReasonFromEvents(runState.events);
}

export function runFailureNotice(
  runState: Pick<AgentRunState, "status" | "failureReason" | "summary" | "events"> | null | undefined,
  summary?: ConversationRunSummary | null,
): RunFailureNotice | null {
  const reason = resolveRunFailureReason(runState, summary);
  if (!reason) return null;
  const match = MAX_ITERATIONS_REASON_PATTERN.exec(reason);
  const limit = match ? Number(match[1]) : 0;
  if (Number.isSafeInteger(limit) && limit > 0) {
    return {
      kind: "max_iterations",
      reason,
      limit,
    };
  }
  return {
    kind: "generic",
    reason,
  };
}

export function messageFailureText(existingContent: string, reason: string): { content: string; error: string } {
  const error = cleanReason(reason) || "Task failed";
  return {
    content: existingContent,
    error,
  };
}
