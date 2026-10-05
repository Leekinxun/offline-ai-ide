import type { ChatMessage } from "../types";
import { isAssistantMessageVisible } from "./assistantActivity";
import type { RunFailureNotice } from "./runFailureNotice";

const CHECKPOINT_FILE_LIMIT_PATTERN = /^Checkpoint exceeds (\d+) files$/i;
const MAX_FAILURE_REASON_LENGTH = 640;

export function isEditorAssistantMessageVisible(message: ChatMessage, includeErrorOnlyMessages: boolean): boolean {
  return isAssistantMessageVisible(message)
    || Boolean(includeErrorOnlyMessages && message.role === "assistant" && message.error?.trim());
}

export function boundedFailureReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length <= MAX_FAILURE_REASON_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_FAILURE_REASON_LENGTH - 3).trimEnd()}...`;
}

export function checkpointFileLimit(reason: string): number | null {
  const match = CHECKPOINT_FILE_LIMIT_PATTERN.exec(reason.trim());
  if (!match) return null;
  const limit = Number(match[1]);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : null;
}

export function formatEditorFailureReason(
  reason: string,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  const limit = checkpointFileLimit(reason);
  if (limit) return t("workbench.failure.checkpointFiles.body", { limit });
  return boundedFailureReason(reason);
}

export function editorRunFailureTitle(
  notice: RunFailureNotice,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  if (notice.kind === "max_iterations") return t("chat.failure.maxIterations.title", { limit: notice.limit || 0 });
  if (notice.reason && checkpointFileLimit(notice.reason)) return t("workbench.failure.checkpointFiles.title");
  return t("chat.failure.generic.title");
}

export function editorRunFailureBody(
  notice: RunFailureNotice,
  t: (key: string, values?: Record<string, string | number>) => string,
): string | null {
  if (notice.kind === "max_iterations") return t("chat.failure.maxIterations.body");
  if (!notice.reason) return null;
  return formatEditorFailureReason(notice.reason, t);
}
