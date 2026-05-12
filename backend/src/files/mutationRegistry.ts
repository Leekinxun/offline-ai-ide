import crypto from "crypto";
import path from "path";

export type KnownFileMutationSource = "user" | "assistant_tool";

export interface KnownFileMutationRecord {
  workspaceDir: string;
  path: string;
  source: KnownFileMutationSource;
  actor?: string;
  recordedAt: number;
  mtimeMs: number;
  version: string;
}

const mutationRegistry = new Map<string, KnownFileMutationRecord>();
const MAX_MUTATION_ENTRIES = 2000;

function buildMutationKey(workspaceDir: string, relativePath: string): string {
  return `${path.resolve(workspaceDir)}::${relativePath}`;
}

export function buildFileVersion(content: string): string {
  return crypto.createHash("sha1").update(content).digest("hex");
}

export function recordKnownFileMutation(input: {
  workspaceDir: string;
  path: string;
  source: KnownFileMutationSource;
  actor?: string;
  mtimeMs: number;
  version?: string;
  content?: string;
}): KnownFileMutationRecord {
  const record: KnownFileMutationRecord = {
    workspaceDir: path.resolve(input.workspaceDir),
    path: input.path,
    source: input.source,
    ...(input.actor ? { actor: input.actor } : {}),
    recordedAt: Date.now(),
    mtimeMs: input.mtimeMs,
    version:
      input.version ||
      buildFileVersion(typeof input.content === "string" ? input.content : ""),
  };

  mutationRegistry.set(
    buildMutationKey(record.workspaceDir, record.path),
    record
  );

  if (mutationRegistry.size > MAX_MUTATION_ENTRIES) {
    const oldestKey = mutationRegistry.keys().next().value;
    if (oldestKey) {
      mutationRegistry.delete(oldestKey);
    }
  }

  return record;
}

export function lookupKnownFileMutation(
  workspaceDir: string,
  relativePath: string,
  options?: {
    version?: string;
    mtimeMs?: number;
  }
): KnownFileMutationRecord | null {
  const record =
    mutationRegistry.get(buildMutationKey(workspaceDir, relativePath)) || null;

  if (!record) {
    return null;
  }

  if (typeof options?.version === "string" && options.version !== record.version) {
    return null;
  }

  if (
    typeof options?.mtimeMs === "number" &&
    Math.abs(options.mtimeMs - record.mtimeMs) > 5
  ) {
    return null;
  }

  return record;
}
