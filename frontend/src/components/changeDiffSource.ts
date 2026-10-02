import type { GitDiffPayload } from "../types";
import { binaryEvidenceForFile, type BinaryReviewSubject } from "./runReviewPolicy";

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
  if (file.isBinary) {
    const evidence = binaryEvidenceForFile(file as BinaryReviewSubject);
    if (!evidence.complete) throw new Error("Run binary change evidence is unavailable");
    return {
      path,
      original: "",
      modified: "",
      diff: "",
      hasChanges: Boolean(file.hasChanges),
      isBinary: true,
      isTooLarge: Boolean(file.isTooLarge),
      updatedAt: typeof file.updatedAt === "number" ? file.updatedAt : 0,
      revision: typeof file.revision === "string" ? file.revision : undefined,
      originalHash: evidence.originalHash,
      modifiedHash: evidence.modifiedHash,
      originalSize: evidence.originalSize,
      modifiedSize: evidence.modifiedSize,
    };
  }
  if (typeof file.original !== "string" || typeof file.modified !== "string") {
    throw new Error("Run change content is unavailable");
  }
  return {
    path,
    original: file.original,
    modified: file.modified,
    diff: typeof file.diff === "string" ? file.diff : "",
    hasChanges: file.original !== file.modified,
    isBinary: false,
    isTooLarge: Boolean(file.isTooLarge),
    updatedAt: typeof file.updatedAt === "number" ? file.updatedAt : 0,
    revision: typeof file.revision === "string" ? file.revision : undefined,
    originalHash: typeof file.originalHash === "string" ? file.originalHash : undefined,
    modifiedHash: typeof file.modifiedHash === "string" ? file.modifiedHash : undefined,
    originalSize: typeof file.originalSize === "number" ? file.originalSize : undefined,
    modifiedSize: typeof file.modifiedSize === "number" ? file.modifiedSize : undefined,
  };
}
