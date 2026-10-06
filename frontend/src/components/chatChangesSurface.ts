import type { ReviewChanges } from "./runReviewPolicy";
import { isExternalOnlyReview } from "./runReviewPolicy";

export interface ChatChangesRunEffectsLoadInput {
  changesOpen: boolean;
  isStreaming: boolean;
  changedFileCount: number;
  runId?: string | null;
}

export type ChatChangesEmptyState = "loading" | "externalOnly" | "error" | "default";

export interface ChatChangesEmptyStateInput {
  shouldReadRunEffects: boolean;
  loading: boolean;
  error?: string | null;
  changes?: ReviewChanges | null;
}

export function shouldLoadChatRunEffects(input: ChatChangesRunEffectsLoadInput): boolean {
  return Boolean(input.changesOpen && !input.isStreaming && input.changedFileCount === 0 && input.runId);
}

export function hasCommandOnlyExternalEffects(changes: ReviewChanges | null | undefined): boolean {
  return isExternalOnlyReview(changes);
}

export function chatChangesEmptyState(input: ChatChangesEmptyStateInput): ChatChangesEmptyState {
  if (input.shouldReadRunEffects && input.loading) return "loading";
  if (input.shouldReadRunEffects && input.error) return "error";
  if (hasCommandOnlyExternalEffects(input.changes)) return "externalOnly";
  return "default";
}
