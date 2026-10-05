import fs from "node:fs";
import path from "node:path";
import {
  buildFileHash, listFileMutations, listMutationEvidenceGaps, readMutationImage, readMutationBytes,
  safeMutationRelativePath, type FileMutationRecord,
  fileMutationRevision, isMutationReviewComplete, keepRunMutationBatch, keepRunMutationBatchAsync,
} from "../files/mutationRegistry.js";
import { safePath } from "../utils/safePath.js";
import { withDesktopWorkspaceWriter } from "../desktop/nativeWorkspaceMutation.js";
import { desktopNativeIdeEnabled } from "../desktop/nativeIdeClient.js";
import { listDesktopExternalToolEffects, type DesktopExternalToolEffects } from "../desktop/nativeExternalEffects.js";
import { readRunRecord } from "./runHistory.js";

export interface RunChangeHunk {
  id: string; mutationId: string; preimageHash: string; postimageHash: string;
  reverted: boolean; kept: boolean; preimage?: string; postimage?: string; truncated?: boolean;
}
export interface RunFileChange {
  path: string; operation: "create" | "modify" | "delete";
  original?: string; modified?: string; originalExists: boolean; modifiedExists: boolean;
  originalHash: string; modifiedHash: string; revision: string; mutationIds: string[];
  originalSize?: number; modifiedSize?: number;
  hunks: RunChangeHunk[]; additions: number | null; deletions: number | null;
  hasChanges: boolean; isBinary: boolean; isTooLarge: boolean; updatedAt: number;
  rollbackState: "applied" | "partially_reverted" | "reverted";
  reviewState: "pending" | "partially_kept" | "kept";
  unavailableReason?: string; statisticsUnavailableReason?: string;
}
export interface RunChanges {
  runId: string; requestId?: string; revision: string; files: RunFileChange[];
  externalToolEffects?: DesktopExternalToolEffects[];
  unavailableReason?: string;
}

export class RunChangesKeepError extends Error {
  constructor(readonly reason: "stale" | "unavailable", readonly changes: RunChanges, readonly paths: string[] = []) {
    super(reason === "stale" ? "Run changes changed; reload the review before keeping" : "Change evidence is unavailable for batch review");
  }
}

/** Check ownership within the authenticated workspace without recovering or writing run state. */
export function assertRunChangesOwner(workspaceDir: string, runId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error("Invalid run id");
  const relative = `.history/runs/${runId}.json`;
  const target = safePath(relative, workspaceDir);
  let cursor = path.resolve(workspaceDir);
  for (const part of relative.split("/")) {
    cursor = path.join(cursor, part);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("Unsafe run evidence"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Run not found"); throw error; }
  }
  const stat = fs.statSync(target);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error("Invalid run evidence");
  let run: { runId?: unknown; conversationId?: unknown };
  try { run = JSON.parse(fs.readFileSync(target, "utf8")); } catch { throw new Error("Invalid run evidence"); }
  if (!run || run.runId !== runId || typeof run.conversationId !== "string") throw new Error("Run evidence does not belong to this run");
}

/** Immutable images come only from journal blobs; current HEAD and workspace files are never diff inputs. */
export function readRunChanges(workspaceDir: string, runId: string, requestedPath?: string, requestId?: string): RunChanges {
  assertRunChangesOwner(workspaceDir, runId);
  if (requestId === "") requestId = undefined;
  if (requestId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(requestId)) throw new Error("Invalid chat request id");
  const externalToolEffects = desktopNativeIdeEnabled()
    ? listDesktopExternalToolEffects(workspaceDir, { runId, requestId, expectedExecutions: expectedExternalToolEffectExecutions(workspaceDir, runId, requestId) })
    : [];
  const selectedPath = requestedPath === undefined ? undefined : safeMutationRelativePath(requestedPath);
  if (requestedPath !== undefined && !selectedPath) throw new Error("Invalid change path");
  const records = listFileMutations(workspaceDir, { runId, requestId }).reverse();
  const gaps = listMutationEvidenceGaps(workspaceDir, { runId, requestId });
  const grouped = new Map<string, FileMutationRecord[]>();
  for (const record of records) grouped.set(record.path, [...(grouped.get(record.path) || []), record]);
  const files = [...grouped].map(([filePath, mutations]) => buildRunFile(workspaceDir, filePath, mutations, selectedPath === filePath));
  for (const gap of gaps) {
    const existing = files.find((file) => file.path === gap.path);
    if (existing) {
      existing.unavailableReason = `incomplete_evidence:${gap.reason}`;
      existing.reviewState = "pending";
      existing.rollbackState = "applied";
      existing.hasChanges = true;
      delete existing.original; delete existing.modified;
    } else {
      files.push({
        path: gap.path, operation: "modify", originalExists: false, modifiedExists: false,
        originalHash: "", modifiedHash: "", revision: buildFileHash(JSON.stringify(gap)),
        mutationIds: [], hunks: [], additions: null, deletions: null, hasChanges: true,
        isBinary: gap.reason === "binary", isTooLarge: gap.reason === "oversized",
        updatedAt: gap.recordedAt, rollbackState: "applied", reviewState: "pending", unavailableReason: `incomplete_evidence:${gap.reason}`,
      });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const revisionParts: unknown[] = [runId, requestId, files.map((file) => [file.path, file.revision, file.unavailableReason])];
  if (desktopNativeIdeEnabled()) revisionParts.push(externalToolEffects.map((effect) => [
    effect.toolCallId,
    effect.requestId,
    effect.toolName,
    effect.startedAt,
    effect.finishedAt,
    effect.rollbackCoverage,
    effect.observationComplete,
    effect.observedPaths,
  ]));
  const revision = buildFileHash(JSON.stringify(revisionParts));
  if (selectedPath && !files.some((file) => file.path === selectedPath)) throw new Error("Run file change not found");
  return {
    runId,
    ...(requestId ? { requestId } : {}),
    revision,
    files: selectedPath ? files.filter((file) => file.path === selectedPath) : files,
    ...(externalToolEffects.length ? { externalToolEffects } : {}),
    ...(!files.length && !externalToolEffects.length ? { unavailableReason: "mutation_evidence_unavailable" } : {}),
  };
}

export interface ExpectedExternalToolExecution { toolCallId: string; requestId?: string; }

export function expectedExternalToolEffectExecutions(workspaceDir: string, runId: string, requestId?: string): ExpectedExternalToolExecution[] {
  const run = readRunRecord(workspaceDir, runId);
  const executions = new Map<string, ExpectedExternalToolExecution>();
  for (const tool of run.toolExecutions) {
    if ((requestId !== undefined && tool.requestId !== requestId) || (tool as { rollbackCoverage?: string }).rollbackCoverage !== "untracked") continue;
    const execution = { toolCallId: tool.toolCallId, ...(tool.requestId !== undefined ? { requestId: tool.requestId } : {}) };
    executions.set(`${execution.requestId ?? ""}\0${execution.toolCallId}`, execution);
  }
  return [...executions.values()];
}

function prepareKeepAllRunChanges(workspaceDir: string, runId: string, expectedRevision: string, requestId?: string) {
  const changes = readRunChanges(workspaceDir, runId, undefined, requestId);
  if (changes.revision !== expectedRevision) throw new RunChangesKeepError("stale", changes);
  const pending = changes.files.filter((file) => file.reviewState !== "kept" && file.rollbackState !== "reverted");
  const unavailable = pending.filter((file) => file.unavailableReason || file.isTooLarge);
  if (changes.unavailableReason || unavailable.length) throw new RunChangesKeepError("unavailable", changes, unavailable.map((file) => file.path));
  return { changes, selection: !pending.length ? undefined : {
    runId, requestId,
    ids: pending.flatMap((file) => file.mutationIds),
    expectedFileRevisions: Object.fromEntries(changes.files.filter((file) => file.mutationIds.length).map((file) => [file.path, file.revision])),
  } };
}

export function keepAllRunChanges(workspaceDir: string, runId: string, expectedRevision: string, requestId?: string): { kept: string[] } & RunChanges {
  const { changes, selection } = prepareKeepAllRunChanges(workspaceDir, runId, expectedRevision, requestId);
  if (!selection) return { kept: [], ...changes };
  const kept = keepRunMutationBatch(workspaceDir, selection);
  return { kept, ...readRunChanges(workspaceDir, runId, undefined, requestId) };
}

export async function keepAllRunChangesAsync(workspaceDir: string, runId: string, expectedRevision: string, requestId?: string): Promise<{ kept: string[] } & RunChanges> {
  return withDesktopWorkspaceWriter(workspaceDir, "rollback", async () => {
    const { changes, selection } = prepareKeepAllRunChanges(workspaceDir, runId, expectedRevision, requestId);
    if (!selection) return { kept: [], ...changes };
    const kept = await keepRunMutationBatchAsync(workspaceDir, selection);
    return { kept, ...readRunChanges(workspaceDir, runId, undefined, requestId) };
  });
}

function buildRunFile(workspaceDir: string, filePath: string, mutations: FileMutationRecord[], includeContent: boolean): RunFileChange {
  const first = mutations[0]; const last = mutations[mutations.length - 1];
  const originalExists = first.operation !== "create"; const modifiedExists = last.operation !== "delete";
  const allReverted = mutations.every((mutation) => mutation.revertedAt !== undefined);
  const someReverted = mutations.some((mutation) => mutation.revertedAt !== undefined || mutation.revertedHunkIds?.length);
  const file: RunFileChange = {
    path: filePath, operation: !originalExists ? "create" : !modifiedExists ? "delete" : "modify",
    originalExists, modifiedExists, originalHash: first.preimageHash, modifiedHash: last.postimageHash,
    revision: fileMutationRevision(mutations),
    mutationIds: mutations.map((mutation) => mutation.id),
    hunks: mutations.flatMap((mutation) => (mutation.hunks || []).map((hunk) => ({
      id: hunk.id, mutationId: mutation.id, preimageHash: hunk.preimageHash, postimageHash: hunk.postimageHash,
      reverted: mutation.revertedAt !== undefined || Boolean(mutation.revertedHunkIds?.includes(hunk.id)),
      kept: mutation.keptAt !== undefined || Boolean(mutation.keptHunkIds?.includes(hunk.id)),
      ...(includeContent ? { preimage: hunk.preimage.slice(0, 4000), postimage: hunk.postimage.slice(0, 4000), truncated: hunk.preimage.length > 4000 || hunk.postimage.length > 4000 } : {}),
    }))),
    additions: null, deletions: null, hasChanges: originalExists !== modifiedExists || first.preimageHash !== last.postimageHash,
    isBinary: mutations.some((mutation) => mutation.preimageBinary || mutation.postimageBinary || mutation.rollbackUnavailableReason === "binary"),
    isTooLarge: mutations.some((mutation) => mutation.rollbackUnavailableReason === "oversized"),
    updatedAt: last.recordedAt, rollbackState: allReverted ? "reverted" : someReverted ? "partially_reverted" : "applied",
    reviewState: mutations.every(isMutationReviewComplete)
      ? "kept" : mutations.some((mutation) => mutation.keptAt !== undefined || mutation.keptHunkIds?.length) ? "partially_kept" : "pending",
  };
  try {
    // A run with another actor's mutation between its edits cannot claim their combined diff.
    for (let index = 1; index < mutations.length; index += 1) {
      const previous = mutations[index - 1]; const current = mutations[index];
      if (previous.postimageHash !== current.preimageHash || (previous.operation !== "delete") !== (current.operation !== "create")) throw new Error("interleaved_changes");
    }
    // Validate every image, so a missing intermediate blob is reported instead of silently hidden.
    if (file.isBinary) {
      const images = mutations.map((mutation) => ({ before: readMutationBytes(workspaceDir, mutation, "preimage"), after: readMutationBytes(workspaceDir, mutation, "postimage") }));
      file.originalSize = images[0].before?.byteLength ?? 0;
      file.modifiedSize = images[images.length - 1].after?.byteLength ?? 0;
      file.statisticsUnavailableReason = "binary";
      return file;
    }
    const images = mutations.map((mutation) => ({ before: readMutationImage(workspaceDir, mutation, "preimage"), after: readMutationImage(workspaceDir, mutation, "postimage") }));
    const original = images[0].before ?? ""; const modified = images[images.length - 1].after ?? "";
    if (includeContent) { file.original = original; file.modified = modified; }
    const statistics = lineStatistics(original, modified);
    if (statistics) Object.assign(file, statistics);
    else file.statisticsUnavailableReason = "line_diff_budget_exceeded";
  } catch (error) {
    file.unavailableReason = (error as NodeJS.ErrnoException)?.code ? "mutation_blob_unavailable" : error instanceof Error ? error.message : "mutation_evidence_unavailable";
  }
  return file;
}

function lines(content: string): string[] { return content ? content.match(/[^\n]*\n|[^\n]+$/g) || [] : []; }
function lineStatistics(original: string, modified: string): { additions: number; deletions: number } | undefined {
  let before = lines(original); let after = lines(modified);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  before = before.slice(prefix); after = after.slice(prefix);
  while (before.length && after.length && before[before.length - 1] === after[after.length - 1]) { before.pop(); after.pop(); }
  if (!before.length || !after.length) return { additions: after.length, deletions: before.length };
  if (before.length * after.length > 4_000_000) return undefined;
  const row = new Uint32Array(after.length + 1);
  for (const line of before) {
    let diagonal = 0;
    for (let index = 1; index <= after.length; index += 1) {
      const old = row[index];
      row[index] = line === after[index - 1] ? diagonal + 1 : Math.max(row[index], row[index - 1]);
      diagonal = old;
    }
  }
  return { additions: after.length - row[after.length], deletions: before.length - row[after.length] };
}
