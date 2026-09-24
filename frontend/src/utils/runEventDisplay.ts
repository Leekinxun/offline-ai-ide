import type { AgentRunEvent } from "../types";

const QUIET_COMPLETION_LABELS = new Set([
  "Repository quality gate passed",
  "Repository quality hook passed",
  "质量门禁已通过",
  "门禁质量已通过",
]);

export function isQuietCompletionEvent(event: AgentRunEvent): boolean {
  return event.kind === "tool_result"
    && event.isError !== true
    && !event.toolName
    && QUIET_COMPLETION_LABELS.has(event.label.trim());
}
