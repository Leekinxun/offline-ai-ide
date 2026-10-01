import type { GitDiffPayload } from "../types";

/** A run review must never silently fall back to the current Git workspace. */
export function changeDiffUrl(path: string, runId?: string | null): string {
  const query = `path=${encodeURIComponent(path)}`;
  return runId
    ? `/api/chat/runs/${encodeURIComponent(runId)}/changes?${query}`
    : `/api/files/git-diff?${query}`;
}

export function parseRunDiff(value: unknown, path: string): GitDiffPayload {
  if (!value || typeof value !== "object" || !("files" in value) || !Array.isArray(value.files)) {
    throw new Error("Run change evidence is unavailable");
  }
  const file = value.files.find((entry: unknown) => Boolean(entry && typeof entry === "object" && "path" in entry && entry.path === path));
  if (!file) throw new Error("This file has no recorded change in the selected run");
  if (file.unavailableReason) throw new Error(String(file.unavailableReason));
  if (typeof file.original !== "string" || typeof file.modified !== "string") {
    throw new Error("Run change content is unavailable");
  }
  return {
    path,
    original: file.original,
    modified: file.modified,
    diff: typeof file.diff === "string" ? file.diff : "",
    hasChanges: file.original !== file.modified,
    isBinary: Boolean(file.isBinary),
    isTooLarge: Boolean(file.isTooLarge),
    updatedAt: typeof file.updatedAt === "number" ? file.updatedAt : 0,
    revision: typeof file.revision === "string" ? file.revision : undefined,
  };
}
