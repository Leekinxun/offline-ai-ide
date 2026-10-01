export interface ReviewHunk {
  id: string; mutationId: string; preimageHash: string; postimageHash: string;
  reverted: boolean; kept: boolean; preimage?: string; postimage?: string; truncated?: boolean;
}
export interface ReviewFile {
  path: string; operation: "create" | "modify" | "delete";
  original?: string; modified?: string; originalExists: boolean; modifiedExists: boolean;
  originalHash: string; modifiedHash: string; revision: string; mutationIds: string[];
  hunks: ReviewHunk[]; additions: number | null; deletions: number | null; hasChanges: boolean;
  isBinary: boolean; isTooLarge: boolean; updatedAt: number;
  rollbackState: "applied" | "partially_reverted" | "reverted";
  reviewState: "pending" | "partially_kept" | "kept"; unavailableReason?: string;
}
export interface ReviewChanges { runId: string; requestId?: string; revision: string; files: ReviewFile[]; unavailableReason?: string; }
export interface RunReviewComment { path: string; revision: string; startLine: number; endLine: number; text: string; side?: "original" | "modified"; }

export function bulkReviewPolicy(changes: ReviewChanges | null, state: { readOnly: boolean; busy: boolean; loading: boolean }): { count: number; allowed: boolean; unavailable: boolean } {
  const pending = changes?.files.filter((file) => file.reviewState !== "kept" && file.rollbackState !== "reverted") || [];
  const unavailable = Boolean(changes?.unavailableReason || pending.some((file) => file.unavailableReason || file.isBinary || file.isTooLarge || !file.mutationIds.length));
  return { count: pending.length, unavailable, allowed: Boolean(changes && pending.length && !unavailable && !state.readOnly && !state.busy && !state.loading) };
}

export function runChangesUrl(runId: string, requestId?: string, path?: string): string {
  const query = new URLSearchParams();
  if (requestId) query.set("requestId", requestId);
  if (path) query.set("path", path);
  return `/api/chat/runs/${encodeURIComponent(runId)}/changes${query.size ? `?${query}` : ""}`;
}
export function parseReviewChanges(value: unknown, runId: string, requestId?: string): ReviewChanges {
  if (!value || typeof value !== "object") throw new Error("Change evidence is unavailable");
  const payload = value as Partial<ReviewChanges>;
  if (payload.runId !== runId || typeof payload.revision !== "string" || !Array.isArray(payload.files)) throw new Error("Change evidence does not belong to this run");
  if ((payload.requestId || undefined) !== (requestId || undefined)) throw new Error("Change evidence does not belong to this request");
  for (const file of payload.files) {
    if (!file || typeof file.path !== "string" || typeof file.revision !== "string" || !Array.isArray(file.mutationIds) || !Array.isArray(file.hunks)) throw new Error("Change evidence is incomplete");
  }
  return payload as ReviewChanges;
}
export function reviewStatus(file: ReviewFile, hunk?: ReviewHunk): "pending" | "kept" | "reverted" | "partial" {
  if (hunk) return hunk.reverted ? "reverted" : hunk.kept ? "kept" : "pending";
  if (file.rollbackState === "reverted") return "reverted";
  if (file.rollbackState === "partially_reverted" || file.reviewState === "partially_kept") return "partial";
  return file.reviewState === "kept" ? "kept" : "pending";
}
export function reviewActionPolicy(file: ReviewFile, input: { readOnly: boolean; running: boolean; busy: boolean; stale: boolean }, hunk?: ReviewHunk): { keep: boolean; revert: boolean; comment: boolean } {
  const available = !file.unavailableReason && !file.isBinary && !file.isTooLarge && !input.readOnly && !input.busy && !input.stale;
  const status = reviewStatus(file, hunk);
  return { keep: available && status !== "kept" && status !== "reverted", revert: available && !input.running && status !== "reverted", comment: available && typeof file.original === "string" && typeof file.modified === "string" };
}
export function reviewSelection(file: ReviewFile, requestId?: string, hunk?: ReviewHunk): Record<string, unknown> {
  return { path: file.path, expectedRevision: file.revision, ...(requestId ? { requestId } : {}), ...(hunk ? { ids: [hunk.mutationId], hunkIds: [hunk.id] } : { ids: file.mutationIds }) };
}
export function validReviewComment(file: ReviewFile, comment: RunReviewComment): boolean {
  const content = comment.side === "original" ? file.original : file.modified;
  const lines = typeof content === "string" ? content.split("\n").length : 0;
  return comment.path === file.path && comment.revision === file.revision && Boolean(comment.text.trim()) && Number.isInteger(comment.startLine) && Number.isInteger(comment.endLine) && comment.startLine >= 1 && comment.endLine >= comment.startLine && comment.endLine <= lines;
}
