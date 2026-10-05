import type { ReviewChanges } from "./runReviewPolicy";
import { isExternalOnlyReview } from "./runReviewPolicy";

export interface DesktopCommandEffectsLoadInput {
  changesOpen: boolean;
  desktopCursor: boolean;
  isStreaming: boolean;
  changedFileCount: number;
  runId?: string | null;
}

export type ChatChangesEmptyState = "loading" | "externalOnly" | "error" | "default";

export interface ChatChangesEmptyStateInput {
  shouldReadDesktopCommandEffects: boolean;
  loading: boolean;
  error?: string | null;
  changes?: ReviewChanges | null;
}

export function shouldLoadDesktopCommandEffects(input: DesktopCommandEffectsLoadInput): boolean {
  return Boolean(input.changesOpen && input.desktopCursor && !input.isStreaming && input.changedFileCount === 0 && input.runId);
}

export function hasCommandOnlyExternalEffects(changes: ReviewChanges | null | undefined): boolean {
  return isExternalOnlyReview(changes);
}

export function chatChangesEmptyState(input: ChatChangesEmptyStateInput): ChatChangesEmptyState {
  if (input.shouldReadDesktopCommandEffects && input.loading) return "loading";
  if (input.shouldReadDesktopCommandEffects && input.error) return "error";
  if (hasCommandOnlyExternalEffects(input.changes)) return "externalOnly";
  return "default";
}
