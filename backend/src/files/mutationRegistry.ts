import crypto from "crypto";
import fs from "fs";
import path from "path";
import { CHECKPOINT_EXCLUDED_NAMES } from "../chat/checkpoints.js";
import { safePath } from "../utils/safePath.js";
import { CollaborationStore } from "../collaboration/collaborationStore.js";

export type KnownFileMutationSource = "user" | "assistant_tool";
export interface MutationHunk {
  id: string; preimage: string; postimage: string; preimageHash: string; postimageHash: string;
  anchor?: { version: 1; beforeOffset: number; afterOffset: number; beforeContext: string; afterContext: string };
}
export interface KnownFileMutationRecord { workspaceDir: string; path: string; source: KnownFileMutationSource; actor?: string; recordedAt: number; mtimeMs: number; version: string; }
export interface FileMutationRecord extends KnownFileMutationRecord { id: string; sequence?: number; runId?: string; requestId?: string; toolCallId?: string; operation: "create" | "modify" | "delete"; preimageHash: string; postimageHash: string; preimageContent?: string; preimageBlob?: string; postimageBlob?: string; rollbackScope: "whole-file" | "hunks"; rollbackUnavailableReason?: "binary" | "oversized"; hunks?: MutationHunk[]; hunkSelections?: Array<{ start: number; end: number; label?: string }>; revertedAt?: number; revertedHunkIds?: string[]; keptAt?: number; keptHunkIds?: string[]; }
export interface MutationRollbackResult { applied: string[]; alreadyReverted: string[]; conflicts: Array<{ id: string; path: string; expectedPostimageHash: string; actualHash: string }>; unavailable: Array<{ id: string; path: string; reason: string }>; }
export interface MutationCaptureResult { records: FileMutationRecord[]; skipped: Array<{ path: string; reason: "binary" | "oversized" | "unreadable" }>; }
export interface MutationEvidenceGap { workspaceDir: string; path: string; runId: string; requestId?: string; toolCallId: string; reason: MutationCaptureResult["skipped"][number]["reason"]; recordedAt: number; }
export class MutationJournalEvidenceError extends Error {
  readonly code = "mutation_journal_evidence_invalid";
  constructor(readonly journalPath: string, reason: string, cause?: unknown) {
    super(`Mutation journal evidence is invalid or unreadable: ${reason}`, { cause });
    this.name = "MutationJournalEvidenceError";
  }
}
export interface WorkspaceMutationEvent { workspaceDir: string; path: string; operation: "create" | "modify" | "delete" | "rename"; previousPath?: string; scope?: "file" | "prefix"; recordedAt: number; }
interface MutationJournal { schemaVersion: 1; records: FileMutationRecord[]; skipped?: MutationEvidenceGap[]; }
interface CapturedFile { content?: string; hash?: string; reason?: MutationCaptureResult["skipped"][number]["reason"]; }
const mutationRegistry = new Map<string, KnownFileMutationRecord>();
const mutationHistory = new Map<string, FileMutationRecord>();
const mutationEvidenceGaps = new Map<string, MutationEvidenceGap>();
const loadedWorkspaces = new Set<string>();
const mutationListeners = new Set<(event: WorkspaceMutationEvent) => void>();
const MAX_MUTATION_ENTRIES = 2000;
const JOURNAL_DIR = ".checkpoints";
const JOURNAL_FILE = "mutations.json";
const MAX_CAPTURE_FILE_BYTES = 2 * 1024 * 1024;
const key = (workspaceDir: string, relativePath: string) => `${path.resolve(workspaceDir)}::${relativePath}`;
const journalPath = (workspaceDir: string) => path.join(path.resolve(workspaceDir), JOURNAL_DIR, JOURNAL_FILE);
const blobPath = (workspaceDir: string, hash: string) => path.join(path.resolve(workspaceDir), JOURNAL_DIR, "blobs", hash);
export function buildFileVersion(content: string): string { return crypto.createHash("sha1").update(content).digest("hex"); }
export function buildFileHash(content: string | Buffer): string { return crypto.createHash("sha256").update(content).digest("hex"); }

interface TextChange { start: number; end: number; text: string; afterStart: number; }

/** Exact line alignment, bounded to avoid quadratic work on large documents. */
function textChanges(beforeText: string, afterText: string): TextChange[] {
  if (beforeText === afterText) return [];
  const before = beforeText ? beforeText.split(/(?<=\n)/) : [];
  const after = afterText ? afterText.split(/(?<=\n)/) : [];
  const beforeOffsets = [0]; const afterOffsets = [0];
  for (const line of before) beforeOffsets.push(beforeOffsets[beforeOffsets.length - 1] + line.length);
  for (const line of after) afterOffsets.push(afterOffsets[afterOffsets.length - 1] + line.length);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let beforeEnd = before.length; let afterEnd = after.length;
  while (beforeEnd > prefix && afterEnd > prefix && before[beforeEnd - 1] === after[afterEnd - 1]) { beforeEnd--; afterEnd--; }
  const oldCount = beforeEnd - prefix; const newCount = afterEnd - prefix;
  if (!oldCount || !newCount || oldCount * newCount > 1_000_000) {
    return [{ start: beforeOffsets[prefix], end: beforeOffsets[beforeEnd], text: after.slice(prefix, afterEnd).join(""), afterStart: afterOffsets[prefix] }];
  }
  const width = newCount + 1;
  const matrix = new Uint32Array((oldCount + 1) * width);
  for (let i = oldCount - 1; i >= 0; i--) for (let j = newCount - 1; j >= 0; j--) {
    matrix[i * width + j] = before[prefix + i] === after[prefix + j]
      ? matrix[(i + 1) * width + j + 1] + 1
      : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1]);
  }
  const changes: TextChange[] = [];
  let i = 0; let j = 0; let start: [number, number] | undefined;
  const flush = () => {
    if (!start) return;
    changes.push({ start: beforeOffsets[prefix + start[0]], end: beforeOffsets[prefix + i], text: after.slice(prefix + start[1], prefix + j).join(""), afterStart: afterOffsets[prefix + start[1]] });
    start = undefined;
  };
  while (i < oldCount || j < newCount) {
    if (i < oldCount && j < newCount && before[prefix + i] === after[prefix + j]) { flush(); i++; j++; }
    else {
      start ??= [i, j];
      if (j === newCount || (i < oldCount && matrix[(i + 1) * width + j] >= matrix[i * width + j + 1])) i++;
      else j++;
    }
  }
  flush();
  return changes;
}

function generateTextHunks(relativePath: string, preimage: string, postimage: string): MutationHunk[] {
  if (preimage.includes("\0") || postimage.includes("\0") || Buffer.byteLength(preimage) > MAX_CAPTURE_FILE_BYTES || Buffer.byteLength(postimage) > MAX_CAPTURE_FILE_BYTES) return [];
  const changes = textChanges(preimage, postimage);
  return changes.map((change, index) => {
    const before = preimage.slice(change.start, change.end);
    const end = change.afterStart + change.text.length;
    // Context is drawn only from unchanged gaps, never from another hunk.
    const gapStart = index ? changes[index - 1].afterStart + changes[index - 1].text.length : 0;
    const gapEnd = changes[index + 1]?.afterStart ?? postimage.length;
    const prefix = postimage.slice(gapStart, change.afterStart).split(/(?<=\n)/).slice(-1).join("");
    const suffix = postimage.slice(end, gapEnd).split(/(?<=\n)/).slice(0, 1).join("");
    return {
      id: buildFileHash(`${relativePath}\0${index}\0${before}\0${change.text}`).slice(0, 24),
      preimage: before, postimage: change.text, preimageHash: buildFileHash(before), postimageHash: buildFileHash(change.text),
      anchor: { version: 1, beforeOffset: change.start, afterOffset: change.afterStart, beforeContext: prefix, afterContext: suffix },
    };
  });
}

export function safeMutationRelativePath(value: string): string | null {
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (!normalized || normalized.includes("\0") || path.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || parts.some((part) => !part || part === "." || part === "..") || CHECKPOINT_EXCLUDED_NAMES.has(parts[0])) return null;
  return normalized;
}
const safeRelativePath = safeMutationRelativePath;

/** Journal evidence must never follow a symlink, including inside the workspace. */
function inspectJournalTarget(workspaceDir: string, relativePath: string): string {
  const workspace = path.resolve(workspaceDir);
  const target = safePath(relativePath, workspace);
  let cursor = workspace;
  for (const part of relativePath.split("/")) {
    cursor = path.join(cursor, part);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("Mutation evidence contains a symbolic link"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; break; }
  }
  return target;
}

/** Read only hash-verified, bounded text evidence. Absent and empty files are distinct. */
export function readMutationImage(workspaceDir: string, mutation: FileMutationRecord, side: "preimage" | "postimage"): string | undefined {
  if (mutation.workspaceDir !== path.resolve(workspaceDir) || !safeRelativePath(mutation.path)) throw new Error("Mutation evidence does not belong to this workspace");
  if (mutation.rollbackUnavailableReason) throw new Error(mutation.rollbackUnavailableReason);
  const absent = side === "preimage" ? mutation.operation === "create" : mutation.operation === "delete";
  const expectedHash = side === "preimage" ? mutation.preimageHash : mutation.postimageHash;
  if (absent) {
    if (expectedHash !== buildFileHash("")) throw new Error("Absent mutation image hash is invalid");
    return undefined;
  }
  const blob = side === "preimage" ? mutation.preimageBlob : mutation.postimageBlob;
  let content: string;
  if (blob) {
    if (!/^[a-f0-9]{64}$/.test(blob) || blob !== expectedHash) throw new Error("Mutation blob reference is invalid");
    const target = inspectJournalTarget(workspaceDir, `${JOURNAL_DIR}/blobs/${blob}`);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.size > MAX_CAPTURE_FILE_BYTES) throw new Error("Mutation blob is not bounded text");
    const bytes = fs.readFileSync(target);
    if (bytes.includes(0)) throw new Error("Mutation blob is binary");
    content = bytes.toString("utf8");
  } else if (side === "preimage" && typeof mutation.preimageContent === "string") content = mutation.preimageContent;
  else throw new Error("Mutation image was not recorded");
  if (Buffer.byteLength(content) > MAX_CAPTURE_FILE_BYTES || content.includes("\0") || buildFileHash(content) !== expectedHash) throw new Error("Mutation image hash does not match recorded evidence");
  return content;
}
function inspectWorkspaceTarget(workspaceDir: string, relativePath: string): { target: string; exists: boolean } {
  const safe = safeRelativePath(relativePath); if (!safe) throw new Error("unsafe workspace path");
  const workspace = path.resolve(workspaceDir); const target = safePath(safe, workspace); let cursor = workspace;
  for (const [index, part] of safe.split("/").entries()) { cursor = path.join(cursor, part); if (!fs.existsSync(cursor)) break; const stat = fs.lstatSync(cursor); if (stat.isSymbolicLink()) throw new Error("workspace path contains a symbolic link"); const final = index === safe.split("/").length - 1; if (!final && !stat.isDirectory()) throw new Error("workspace path parent is not a directory"); if (final && !stat.isFile()) throw new Error("workspace target is not a regular file"); }
  return { target, exists: fs.existsSync(target) };
}
function atomicSafeWrite(workspaceDir: string, relativePath: string, content: string, expectedHash: string, expectedExists: boolean): void {
  const inspected = inspectWorkspaceTarget(workspaceDir, relativePath); const initial = inspected.exists ? fs.readFileSync(inspected.target) : Buffer.alloc(0); if (inspected.exists !== expectedExists || buildFileHash(initial) !== expectedHash) throw new Error("rollback target changed before write"); fs.mkdirSync(path.dirname(inspected.target), { recursive: true }); inspectWorkspaceTarget(workspaceDir, relativePath);
  const temporary = `${inspected.target}.rollback-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  try { fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" }); const revalidated = inspectWorkspaceTarget(workspaceDir, relativePath); const live = revalidated.exists ? fs.readFileSync(revalidated.target) : Buffer.alloc(0); if (revalidated.exists !== expectedExists || buildFileHash(live) !== expectedHash) throw new Error("rollback target changed before commit"); fs.renameSync(temporary, inspected.target); } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
}
function isMutation(value: unknown, workspaceDir: string): value is FileMutationRecord {
  if (!value || typeof value !== "object") return false; const x = value as Partial<FileMutationRecord>;
  if (x.requestId !== undefined && (typeof x.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(x.requestId))) return false;
  if (x.sequence !== undefined && (!Number.isSafeInteger(x.sequence) || x.sequence < 1)) return false;
  if (x.revertedAt !== undefined && (typeof x.revertedAt !== "number" || !Number.isFinite(x.revertedAt))) return false;
  if (x.keptAt !== undefined && (typeof x.keptAt !== "number" || !Number.isFinite(x.keptAt))) return false;
  if (x.keptHunkIds !== undefined && (!Array.isArray(x.keptHunkIds) || !x.keptHunkIds.every((id) => typeof id === "string" && x.hunks?.some((hunk) => hunk.id === id)))) return false;
  if (x.revertedHunkIds !== undefined && (!Array.isArray(x.revertedHunkIds) || !x.revertedHunkIds.every((id) => typeof id === "string" && x.hunks?.some((hunk) => hunk.id === id)))) return false;
  return typeof x.id === "string" && typeof x.path === "string" && safeRelativePath(x.path) !== null && path.resolve(x.workspaceDir || "") === workspaceDir && (x.source === "user" || x.source === "assistant_tool") && typeof x.recordedAt === "number" && typeof x.mtimeMs === "number" && typeof x.version === "string" && typeof x.preimageHash === "string" && typeof x.postimageHash === "string" && (x.operation === "create" || x.operation === "modify" || x.operation === "delete") && (x.rollbackScope === "whole-file" || x.rollbackScope === "hunks");
}
function atomicWrite(target: string, content: string): void { fs.mkdirSync(path.dirname(target), { recursive: true }); const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(3).toString("hex")}`; fs.writeFileSync(temporary, content, "utf8"); fs.renameSync(temporary, target); }
function storeBlob(workspaceDir: string, content: string): string { const hash = buildFileHash(content); const target = inspectJournalTarget(workspaceDir, `${JOURNAL_DIR}/blobs/${hash}`); if (!fs.existsSync(target)) atomicWrite(target, content); return hash; }
function workspaceRecords(workspaceDir: string): FileMutationRecord[] { const target = path.resolve(workspaceDir); return [...mutationHistory.values()].filter((x) => x.workspaceDir === target); }
function workspaceEvidenceGaps(workspaceDir: string): MutationEvidenceGap[] { const target = path.resolve(workspaceDir); return [...mutationEvidenceGaps.values()].filter((x) => x.workspaceDir === target); }
function evidenceGapKey(gap: Pick<MutationEvidenceGap, "workspaceDir" | "runId" | "toolCallId" | "path">): string { return `${gap.workspaceDir}::${gap.runId}::${gap.toolCallId}::${gap.path}`; }
function isEvidenceGap(value: unknown, workspaceDir: string): value is MutationEvidenceGap {
  if (!value || typeof value !== "object") return false;
  const gap = value as Partial<MutationEvidenceGap>;
  if (gap.requestId !== undefined && (typeof gap.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(gap.requestId))) return false;
  return path.resolve(gap.workspaceDir || "") === workspaceDir && safeRelativePath(gap.path || "") !== null && typeof gap.runId === "string" && Boolean(gap.runId.trim()) && typeof gap.toolCallId === "string" && Boolean(gap.toolCallId.trim()) && ["binary", "oversized", "unreadable"].includes(String(gap.reason)) && typeof gap.recordedAt === "number" && Number.isFinite(gap.recordedAt);
}
function loadJournal(workspaceDir: string, force = false): void {
  const workspace = path.resolve(workspaceDir); if (loadedWorkspaces.has(workspace) && !force) return;
  if (force) {
    loadedWorkspaces.delete(workspace);
    for (const [id, record] of mutationHistory) if (record.workspaceDir === workspace) mutationHistory.delete(id);
    for (const [id, gap] of mutationEvidenceGaps) if (gap.workspaceDir === workspace) mutationEvidenceGaps.delete(id);
  }
  let target: string;
  try { target = inspectJournalTarget(workspace, `${JOURNAL_DIR}/${JOURNAL_FILE}`); }
  catch (error) { throw new MutationJournalEvidenceError(journalPath(workspace), "unsafe persisted source", error); }
  let source: string;
  try { source = fs.readFileSync(target, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") { loadedWorkspaces.add(workspace); return; }
    throw new MutationJournalEvidenceError(target, "persisted source cannot be read", error);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(source); }
  catch (error) { throw new MutationJournalEvidenceError(target, "persisted source is not valid JSON", error); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new MutationJournalEvidenceError(target, "persisted root must be an object");
  const journal = parsed as Partial<MutationJournal>;
  if (journal.schemaVersion !== 1) throw new MutationJournalEvidenceError(target, "unsupported schema version");
  if (!Array.isArray(journal.records) || !journal.records.every((record) => isMutation(record, workspace))) throw new MutationJournalEvidenceError(target, "invalid mutation records");
  if (journal.skipped !== undefined && (!Array.isArray(journal.skipped) || !journal.skipped.every((gap) => isEvidenceGap(gap, workspace)))) throw new MutationJournalEvidenceError(target, "invalid skipped evidence records");
  for (const record of journal.records) mutationHistory.set(record.id, record);
  for (const gap of journal.skipped || []) mutationEvidenceGaps.set(evidenceGapKey(gap), gap);
  loadedWorkspaces.add(workspace);
}
function persistJournal(workspaceDir: string): void { const workspace = path.resolve(workspaceDir); const records = workspaceRecords(workspace).slice(-MAX_MUTATION_ENTRIES); const skipped = workspaceEvidenceGaps(workspace).sort((a, b) => a.recordedAt - b.recordedAt).slice(-MAX_MUTATION_ENTRIES); atomicWrite(inspectJournalTarget(workspace, `${JOURNAL_DIR}/${JOURNAL_FILE}`), JSON.stringify({ schemaVersion: 1, records, ...(skipped.length ? { skipped } : {}) } satisfies MutationJournal, null, 2)); }
function trimHistory(): void { while (mutationHistory.size > MAX_MUTATION_ENTRIES) { const oldest = mutationHistory.keys().next().value; if (oldest) mutationHistory.delete(oldest); } }
/** Allows a process restart or a test harness to reload a workspace journal from disk. */
export function reloadMutationJournal(workspaceDir: string): void { loadJournal(workspaceDir, true); }

export function subscribeWorkspaceMutations(listener: (event: WorkspaceMutationEvent) => void): () => void {
  mutationListeners.add(listener);
  return () => mutationListeners.delete(listener);
}

export function notifyWorkspaceMutation(event: Omit<WorkspaceMutationEvent, "workspaceDir" | "recordedAt"> & { workspaceDir: string; recordedAt?: number }): void {
  const relativePath = safeRelativePath(event.path);
  if (!relativePath) throw new Error("Mutation path must be a workspace-relative file path");
  const normalized: WorkspaceMutationEvent = {
    workspaceDir: path.resolve(event.workspaceDir), path: relativePath, operation: event.operation,
    ...(event.previousPath ? { previousPath: safeRelativePath(event.previousPath) || undefined } : {}),
    ...(event.scope === "prefix" ? { scope: "prefix" as const } : {}),
    recordedAt: event.recordedAt || Date.now(),
  };
  for (const listener of mutationListeners) {
    try { listener(normalized); } catch { /* mutation persistence remains authoritative */ }
  }
}

export function recordKnownFileMutation(input: { workspaceDir: string; path: string; source: KnownFileMutationSource; actor?: string; mtimeMs: number; version?: string; content?: string; runId?: string; requestId?: string; toolCallId?: string; preimageContent?: string; preimageHash?: string; hunkSelections?: FileMutationRecord["hunkSelections"]; hunks?: Array<{ id: string; preimage: string; postimage: string }>; }): KnownFileMutationRecord {
  if (input.requestId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input.requestId)) throw new Error("Invalid mutation request id");
  const relativePath = safeRelativePath(input.path); if (!relativePath) throw new Error("Mutation path must be a workspace-relative file path");
  const workspaceDir = path.resolve(input.workspaceDir); loadJournal(workspaceDir, true);
  const record: KnownFileMutationRecord = { workspaceDir, path: relativePath, source: input.source, ...(input.actor ? { actor: input.actor } : {}), recordedAt: Date.now(), mtimeMs: input.mtimeMs, version: input.version || buildFileVersion(typeof input.content === "string" ? input.content : "") };
  mutationRegistry.set(key(record.workspaceDir, record.path), record);
  const postContent = typeof input.content === "string" ? input.content : undefined;
  if (input.runId || input.toolCallId || input.preimageContent !== undefined || input.preimageHash) {
    const preimage = input.preimageContent || ""; const postimage = postContent || "";
    const unavailable = preimage.includes("\0") || postimage.includes("\0") ? "binary" : Buffer.byteLength(preimage) > MAX_CAPTURE_FILE_BYTES || Buffer.byteLength(postimage) > MAX_CAPTURE_FILE_BYTES ? "oversized" : undefined;
    const hunks = unavailable ? [] : (input.hunks?.map((hunk) => ({ ...hunk, preimageHash: buildFileHash(hunk.preimage), postimageHash: buildFileHash(hunk.postimage) })) || (input.preimageContent !== undefined && postContent !== undefined ? generateTextHunks(relativePath, input.preimageContent, postContent) : []));
    const mutation: FileMutationRecord = { ...record, id: `${record.recordedAt}-${crypto.randomBytes(4).toString("hex")}`, ...(input.runId?.trim() ? { runId: input.runId.trim() } : {}), ...(input.requestId?.trim() ? { requestId: input.requestId.trim() } : {}), ...(input.toolCallId?.trim() ? { toolCallId: input.toolCallId.trim() } : {}), operation: input.preimageContent === undefined ? "create" : postContent === undefined ? "delete" : "modify", preimageHash: input.preimageHash || buildFileHash(preimage), postimageHash: buildFileHash(postimage), ...(!unavailable && input.preimageContent !== undefined ? { preimageContent: input.preimageContent, preimageBlob: storeBlob(workspaceDir, preimage) } : {}), ...(!unavailable && postContent !== undefined ? { postimageBlob: storeBlob(workspaceDir, postimage) } : {}), rollbackScope: hunks?.length ? "hunks" : "whole-file", ...(unavailable ? { rollbackUnavailableReason: unavailable } : {}), ...(hunks?.length ? { hunks } : {}), ...(input.hunkSelections?.length ? { hunkSelections: input.hunkSelections } : {}) };
    mutation.sequence = workspaceRecords(workspaceDir).reduce((maximum, entry, index) => Math.max(maximum, entry.sequence ?? index + 1), 0) + 1;
    mutationHistory.set(mutation.id, mutation); trimHistory(); persistJournal(workspaceDir);
  }
  while (mutationRegistry.size > MAX_MUTATION_ENTRIES) { const oldest = mutationRegistry.keys().next().value; if (oldest) mutationRegistry.delete(oldest); }
  notifyWorkspaceMutation({
    workspaceDir,
    path: relativePath,
    operation: input.preimageContent === undefined && postContent !== undefined
      ? "create"
      : input.preimageContent !== undefined && postContent === undefined
        ? "delete"
        : "modify",
    recordedAt: record.recordedAt,
  });
  try { new CollaborationStore(workspaceDir).recordMutation(relativePath, input.actor || "system"); } catch { /* collaboration reconciliation is durable best-effort; integration guards re-check on read */ }
  return record;
}
export function lookupKnownFileMutation(workspaceDir: string, relativePath: string, options?: { version?: string; mtimeMs?: number; }): KnownFileMutationRecord | null { const record = mutationRegistry.get(key(workspaceDir, relativePath)) || null; if (!record) return null; if (typeof options?.version === "string" && options.version !== record.version) return null; if (typeof options?.mtimeMs === "number" && Math.abs(options.mtimeMs - record.mtimeMs) > 5) return null; return record; }
export function listFileMutations(workspaceDir: string, selection: { runId?: string; requestId?: string; toolCallId?: string; path?: string } = {}): FileMutationRecord[] { const target = path.resolve(workspaceDir); loadJournal(target, true); const selectedPath = selection.path === undefined ? undefined : safeRelativePath(selection.path); if (selection.path !== undefined && !selectedPath) return []; return workspaceRecords(target).filter((x) => (!selection.runId || x.runId === selection.runId) && (!selection.requestId || x.requestId === selection.requestId) && (!selection.toolCallId || x.toolCallId === selection.toolCallId) && (!selectedPath || x.path === selectedPath)).reverse(); }
export function listMutationEvidenceGaps(workspaceDir: string, selection: { runId?: string; requestId?: string; toolCallId?: string; path?: string } = {}): MutationEvidenceGap[] { const target = path.resolve(workspaceDir); loadJournal(target, true); const selectedPath = selection.path === undefined ? undefined : safeRelativePath(selection.path); if (selection.path !== undefined && !selectedPath) return []; return workspaceEvidenceGaps(target).filter((x) => (!selection.runId || x.runId === selection.runId) && (!selection.requestId || x.requestId === selection.requestId) && (!selection.toolCallId || x.toolCallId === selection.toolCallId) && (!selectedPath || x.path === selectedPath)).sort((a, b) => b.recordedAt - a.recordedAt); }
/** Records exact pre/post images for durable, whole-file-only rollback. */
export function recordFileMutation(input: Omit<FileMutationRecord, "id" | "recordedAt" | "version" | "workspaceDir" | "mtimeMs" | "postimageHash" | "preimageHash" | "rollbackScope" | "operation" | "preimageBlob" | "postimageBlob" | "hunks"> & { workspaceDir: string; mtimeMs?: number; postimageContent?: string; preimageContent?: string; hunks?: Array<{ id: string; preimage: string; postimage: string }>; }): FileMutationRecord { const known = recordKnownFileMutation({ workspaceDir: input.workspaceDir, path: input.path, source: input.source, actor: input.actor, mtimeMs: input.mtimeMs || Date.now(), content: input.postimageContent, runId: input.runId, requestId: input.requestId, toolCallId: input.toolCallId, preimageContent: input.preimageContent, hunkSelections: input.hunkSelections, hunks: input.hunks }); return listFileMutations(input.workspaceDir, { path: known.path }).find((x) => x.recordedAt === known.recordedAt)!; }
/** Review decisions belong to the existing immutable mutation evidence, not current disk text. */
export function keepFileMutations(workspaceDir: string, selection: { runId: string; requestId?: string; path: string; ids?: string[]; hunkIds?: string[] }): string[] {
  const records = listFileMutations(workspaceDir, selection).filter((record) => !selection.ids || selection.ids.includes(record.id));
  if (!records.length || selection.ids?.some((id) => !records.some((record) => record.id === id))) throw new Error("Invalid review mutation selection");
  if (selection.hunkIds?.some((id) => !records.some((record) => record.hunks?.some((hunk) => hunk.id === id)))) throw new Error("Invalid review hunk selection");
  const kept: string[] = [];
  for (const record of records) {
    if (record.revertedAt !== undefined) continue;
    if (selection.hunkIds?.length) {
      const ids = (record.hunks || []).filter((hunk) => selection.hunkIds!.includes(hunk.id) && !record.revertedHunkIds?.includes(hunk.id)).map((hunk) => hunk.id);
      if (!ids.length) continue;
      record.keptHunkIds = [...new Set([...(record.keptHunkIds || []), ...ids])];
    } else record.keptAt = record.keptAt ?? Date.now();
    kept.push(record.id);
  }
  if (kept.length) persistJournal(workspaceDir);
  return kept;
}

/** Refuses diverged files by default. Every file is simulated backwards before any write. */
export function rollbackFileMutations(workspaceDir: string, selection: { runId?: string; requestId?: string; toolCallId?: string; path?: string; ids?: string[]; hunkIds?: string[] }, options: { strategy?: "refuse" | "skip-conflicts" } = {}): MutationRollbackResult {
  // Journal insertion order is authoritative, including for legacy records with equal timestamps.
  const allRecords = listFileMutations(workspaceDir);
  const selectedPath = selection.path === undefined ? undefined : safeRelativePath(selection.path);
  const candidates = allRecords.filter((entry) => selectedPath !== null
    && (!selection.runId || entry.runId === selection.runId)
    && (!selection.requestId || entry.requestId === selection.requestId)
    && (!selection.toolCallId || entry.toolCallId === selection.toolCallId)
    && (!selectedPath || entry.path === selectedPath)
    && (!selection.ids || selection.ids.includes(entry.id)));
  const result: MutationRollbackResult = { applied: [], alreadyReverted: [], conflicts: [], unavailable: [] };
  const effectiveImages = new Map<string, EffectiveMutationImages | Error>();
  for (const filePath of new Set(candidates.map((mutation) => mutation.path))) {
    for (const [id, images] of buildEffectiveMutationImages(workspaceDir, allRecords.filter((record) => record.path === filePath).reverse())) effectiveImages.set(id, images);
  }
  interface PendingFile {
    path: string; initialContent: string; initialExists: boolean; content: string; exists: boolean;
    mutations: Array<{ mutation: FileMutationRecord; hunkIds?: string[] }>;
  }
  const pending = new Map<string, PendingFile>();
  const invalidPaths = new Set<string>();
  for (const mutation of candidates) {
    const selectedHunks = selection.hunkIds?.length ? mutation.hunks?.filter((hunk) => selection.hunkIds!.includes(hunk.id)) || [] : undefined;
    if (mutation.revertedAt !== undefined || (selectedHunks?.length && selectedHunks.every((hunk) => mutation.revertedHunkIds?.includes(hunk.id)))) {
      result.alreadyReverted.push(mutation.id);
      continue;
    }
    if (invalidPaths.has(mutation.path)) continue;
    if (mutation.rollbackUnavailableReason) {
      result.unavailable.push({ id: mutation.id, path: mutation.path, reason: mutation.rollbackUnavailableReason });
      invalidPaths.add(mutation.path);
      continue;
    }
    let file = pending.get(mutation.path);
    try {
      if (!file) {
        const inspected = inspectWorkspaceTarget(workspaceDir, mutation.path);
        let current = "";
        if (inspected.exists) {
          const stat = fs.lstatSync(inspected.target);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CAPTURE_FILE_BYTES) throw new Error("target is not a bounded regular file");
          const bytes = fs.readFileSync(inspected.target);
          if (bytes.includes(0)) throw new Error("target is binary");
          current = bytes.toString("utf8");
        }
        file = { path: mutation.path, initialContent: current, initialExists: inspected.exists, content: current, exists: inspected.exists, mutations: [] };
        pending.set(mutation.path, file);
      }
      const currentHash = buildFileHash(file.content);
      const images = effectiveImages.get(mutation.id);
      if (!images || images instanceof Error) throw images || new Error("Mutation image evidence is unavailable");
      if (selectedHunks) {
        if (!file.exists || !selectedHunks.length) throw new Error("selected hunk is unavailable");
        const remaining = selectedHunks.filter((hunk) => !mutation.revertedHunkIds?.includes(hunk.id));
        // Legacy snippets have no position evidence. Only a verified, complete
        // effective postimage authorizes them; never search a diverged file.
        if (remaining.some((hunk) => !hunk.anchor) && file.content !== images.after) throw new MutationHunkConflictError(mutation.postimageHash);
        file.content = reverseMutationHunks(images.originalBefore, images.originalAfter, file.content, remaining, true);
        file.mutations.push({ mutation, hunkIds: remaining.map((hunk) => hunk.id) });
      } else {
        const { before, after } = images;
        if (file.exists !== (after !== undefined) || currentHash !== buildFileHash(after ?? "")) {
          result.conflicts.push({ id: mutation.id, path: mutation.path, expectedPostimageHash: buildFileHash(after ?? ""), actualHash: currentHash });
          invalidPaths.add(mutation.path);
          continue;
        }
        file.content = before ?? "";
        file.exists = before !== undefined;
        file.mutations.push({ mutation });
      }
    } catch (error) {
      if (error instanceof MutationHunkConflictError) result.conflicts.push({ id: mutation.id, path: mutation.path, expectedPostimageHash: error.expectedHash, actualHash: buildFileHash(file?.content ?? "") });
      else result.unavailable.push({ id: mutation.id, path: mutation.path, reason: safeRollbackReason(error) });
      invalidPaths.add(mutation.path);
    }
  }
  if ((result.conflicts.length || result.unavailable.length) && options.strategy !== "skip-conflicts") return result;
  const valid = [...pending.values()].filter((file) => file.mutations.length && !invalidPaths.has(file.path));
  // Revalidate the complete batch before the first mutation. Each commit checks again.
  // Cross-file atomicity against an external process still requires filesystem transactions.
  for (const file of valid) {
    try { assertRollbackTarget(workspaceDir, file.path, file.initialExists, buildFileHash(file.initialContent)); }
    catch (error) {
      invalidPaths.add(file.path);
      result.unavailable.push({ id: file.mutations[0].mutation.id, path: file.path, reason: safeRollbackReason(error) });
    }
  }
  if (result.unavailable.length && options.strategy !== "skip-conflicts") return result;
  for (const file of valid) {
    if (invalidPaths.has(file.path)) continue;
    try {
      const expectedHash = buildFileHash(file.initialContent);
      if (!file.exists) {
        const inspected = assertRollbackTarget(workspaceDir, file.path, file.initialExists, expectedHash);
        if (inspected.exists) fs.unlinkSync(inspected.target);
      } else atomicSafeWrite(workspaceDir, file.path, file.content, expectedHash, file.initialExists);
      const revertedAt = Date.now();
      for (const { mutation, hunkIds } of file.mutations) {
        if (hunkIds) mutation.revertedHunkIds = [...new Set([...(mutation.revertedHunkIds || []), ...hunkIds])];
        else mutation.revertedAt = revertedAt;
        result.applied.push(mutation.id);
      }
      // Store state in the existing journal so repeats after a restart are no-ops.
      persistJournal(workspaceDir);
      mutationRegistry.delete(key(workspaceDir, file.path));
      notifyWorkspaceMutation({ workspaceDir, path: file.path, operation: file.exists ? file.initialExists ? "modify" : "create" : "delete" });
    } catch (error) {
      result.unavailable.push({ id: file.mutations[0].mutation.id, path: file.path, reason: safeRollbackReason(error) });
      if (options.strategy !== "skip-conflicts") break;
    }
  }
  return result;
}

class MutationHunkConflictError extends Error {
  constructor(readonly expectedHash: string) { super("Selected hunk no longer has a proven, intact location"); }
}

function editsOverlap(left: Pick<TextChange, "start" | "end">, right: Pick<TextChange, "start" | "end">): boolean {
  if (left.start === left.end || right.start === right.end) return left.start <= right.end && right.start <= left.end;
  return left.start < right.end && right.start < left.end;
}

/** Map exact offsets through disjoint edits; changed/ambiguous target ranges fail closed. */
function mapTextChanges(base: string, current: string, edits: TextChange[]): TextChange[] {
  const intervening = textChanges(base, current);
  return edits.map((edit) => {
    if (intervening.some((change) => editsOverlap(edit, change))) throw new MutationHunkConflictError(buildFileHash(base));
    const shift = intervening.filter((change) => change.end <= edit.start).reduce((sum, change) => sum + change.text.length - (change.end - change.start), 0);
    const mapped = { ...edit, start: edit.start + shift, end: edit.end + shift };
    if (current.slice(mapped.start, mapped.end) !== base.slice(edit.start, edit.end)) throw new MutationHunkConflictError(buildFileHash(base));
    return mapped;
  });
}

function applyTextChanges(content: string, edits: TextChange[]): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  for (let index = 1; index < ordered.length; index++) {
    if (editsOverlap(ordered[index - 1], ordered[index])) throw new MutationHunkConflictError(buildFileHash(content));
  }
  for (const edit of ordered) content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
  return content;
}

function reverseMutationHunks(
  before: string | undefined,
  after: string | undefined,
  current: string,
  hunks: MutationHunk[],
  checkContext: boolean,
): string {
  if (before === undefined || after === undefined) throw new Error("Hunk images are unavailable");
  const edits = hunks.map((hunk): TextChange => {
    if (buildFileHash(hunk.preimage) !== hunk.preimageHash || buildFileHash(hunk.postimage) !== hunk.postimageHash) throw new Error("Hunk image hash mismatch");
    const anchor = hunk.anchor;
    if (anchor) {
      if (anchor.version !== 1 || !Number.isSafeInteger(anchor.beforeOffset) || !Number.isSafeInteger(anchor.afterOffset)
        || anchor.beforeOffset < 0 || anchor.afterOffset < 0
        || anchor.beforeOffset + hunk.preimage.length > before.length || anchor.afterOffset + hunk.postimage.length > after.length
        || typeof anchor.beforeContext !== "string" || typeof anchor.afterContext !== "string"
        || before.slice(anchor.beforeOffset, anchor.beforeOffset + hunk.preimage.length) !== hunk.preimage
        || after.slice(anchor.afterOffset, anchor.afterOffset + hunk.postimage.length) !== hunk.postimage
        || after.slice(Math.max(0, anchor.afterOffset - anchor.beforeContext.length), anchor.afterOffset) !== anchor.beforeContext
        || after.slice(anchor.afterOffset + hunk.postimage.length, anchor.afterOffset + hunk.postimage.length + anchor.afterContext.length) !== anchor.afterContext) {
        throw new Error("Hunk anchor does not match the recorded images");
      }
      return { start: anchor.afterOffset, end: anchor.afterOffset + hunk.postimage.length, text: hunk.preimage, afterStart: anchor.beforeOffset };
    }
    const offset = hunk.postimage ? after.indexOf(hunk.postimage) : -1;
    if (offset < 0 || after.lastIndexOf(hunk.postimage) !== offset) throw new MutationHunkConflictError(hunk.postimageHash);
    return { start: offset, end: offset + hunk.postimage.length, text: hunk.preimage, afterStart: 0 };
  });
  const mapped = mapTextChanges(after, current, edits);
  if (checkContext) for (const [index, hunk] of hunks.entries()) {
    const anchor = hunk.anchor;
    if (!anchor) continue;
    const edit = mapped[index];
    const start = edit.start - anchor.beforeContext.length;
    const end = edit.end + anchor.afterContext.length;
    const expected = anchor.beforeContext + hunk.postimage + anchor.afterContext;
    if (start < 0 || current.slice(start, end) !== expected
      || (!anchor.beforeContext && edit.start !== 0)
      || (!anchor.afterContext && edit.end !== current.length)
      || current.indexOf(expected) !== start || current.lastIndexOf(expected) !== start) {
      throw new MutationHunkConflictError(hunk.postimageHash);
    }
  }
  return applyTextChanges(current, mapped);
}

interface EffectiveMutationImages {
  originalBefore: string | undefined; originalAfter: string | undefined;
  before: string | undefined; after: string | undefined;
}

/** Reconstruct recorded reversions across the complete file history before comparing live data. */
function buildEffectiveMutationImages(workspaceDir: string, records: FileMutationRecord[]): Map<string, EffectiveMutationImages | Error> {
  const result = new Map<string, EffectiveMutationImages | Error>();
  let previous: EffectiveMutationImages | undefined;
  for (const mutation of records) {
    try {
      const originalBefore = readMutationImage(workspaceDir, mutation, "preimage");
      const originalAfter = readMutationImage(workspaceDir, mutation, "postimage");
      const before = previous && originalBefore === previous.originalAfter ? previous.after : originalBefore;
      let after = originalAfter;
      if (before !== originalBefore) {
        if (before === undefined || originalBefore === undefined || originalAfter === undefined) throw new MutationHunkConflictError(mutation.postimageHash);
        // Prior undone hunks and this mutation must be disjoint. This applies
        // changes by their recorded offsets rather than finding snippets.
        after = applyTextChanges(before, mapTextChanges(originalBefore, before, textChanges(originalBefore, originalAfter)));
      }
      if (mutation.revertedAt !== undefined) after = before;
      else if (mutation.revertedHunkIds?.length) {
        const hunks = mutation.revertedHunkIds.map((id) => {
          const hunk = mutation.hunks?.find((candidate) => candidate.id === id);
          if (!hunk) throw new Error("Reverted hunk evidence is unavailable");
          return hunk;
        });
        if (after === undefined) throw new Error("Reverted hunk image is unavailable");
        after = reverseMutationHunks(originalBefore, originalAfter, after, hunks, false);
      }
      previous = { originalBefore, originalAfter, before, after };
      result.set(mutation.id, previous);
    } catch (error) {
      result.set(mutation.id, error instanceof Error ? error : new Error("Invalid mutation history"));
      previous = undefined;
    }
  }
  return result;
}
function safeRollbackReason(error: unknown): string {
  // Filesystem errors include absolute storage paths; they are not API data.
  return (error as NodeJS.ErrnoException)?.code ? "Rollback evidence or target could not be read" : error instanceof Error ? error.message : "Rollback failed";
}
function assertRollbackTarget(workspaceDir: string, relativePath: string, expectedExists: boolean, expectedHash: string): { target: string; exists: boolean } {
  const inspected = inspectWorkspaceTarget(workspaceDir, relativePath);
  const current = inspected.exists ? fs.readFileSync(inspected.target) : Buffer.alloc(0);
  if (inspected.exists !== expectedExists || buildFileHash(current) !== expectedHash) throw new Error("rollback target changed during preflight");
  return inspected;
}
function readCapturedFile(target: string, knownSize?: number, knownHash?: string): CapturedFile {
  try { const size = knownSize ?? fs.statSync(target).size; if (size > MAX_CAPTURE_FILE_BYTES) return { hash: knownHash, reason: "oversized" }; const buffer = fs.readFileSync(target); if (buffer.includes(0)) return { hash: knownHash || buildFileHash(buffer), reason: "binary" }; return { content: buffer.toString("utf8"), hash: knownHash || buildFileHash(buffer) }; } catch { return { reason: "unreadable" }; }
}
function checkpointFiles(workspaceDir: string, checkpointId: string): Map<string, CapturedFile> {
  const index = JSON.parse(fs.readFileSync(path.join(workspaceDir, JOURNAL_DIR, "index.json"), "utf8")) as Array<{ id?: string; storageVersion?: number; manifest?: string; files?: string[] }>;
  const checkpoint = index.find((entry) => entry.id === checkpointId);
  if (!checkpoint) throw new Error("Checkpoint not found");
  const result = new Map<string, CapturedFile>();
  if (checkpoint.storageVersion === 2 || checkpoint.storageVersion === 3) {
    const resolve = (id: string, visiting = new Set<string>()): Map<string, { path: string; sha256: string; size?: number }> => { if (visiting.has(id)) throw new Error("Checkpoint parent cycle detected"); const item = index.find((entry) => entry.id === id); if (!item) throw new Error("Checkpoint parent missing"); visiting.add(id); const manifest = JSON.parse(fs.readFileSync(item.manifest || path.join(workspaceDir, JOURNAL_DIR, "manifests", `${id}.json`), "utf8")) as any; const files = new Map<string, { path: string; sha256: string; size?: number }>(); if (manifest.version === 2) for (const file of manifest.files || []) if (safeRelativePath(file.path) && /^[a-f0-9]{64}$/.test(file.sha256)) files.set(file.path, file); else throw new Error("Invalid checkpoint entry"); else if (manifest.version === 3) { if (manifest.parentId) for (const [relative, file] of resolve(manifest.parentId, visiting)) files.set(relative, file); for (const change of manifest.changes || []) { const relative = safeRelativePath(change.path); if (!relative) throw new Error("Invalid checkpoint entry"); if (change.operation === "delete") files.delete(relative); else if (change.operation === "upsert" && /^[a-f0-9]{64}$/.test(change.sha256)) files.set(relative, change); else throw new Error("Invalid checkpoint entry"); } } else throw new Error("Invalid checkpoint manifest"); visiting.delete(id); return files; };
    for (const file of resolve(checkpointId).values()) result.set(file.path, readCapturedFile(blobPath(workspaceDir, file.sha256), file.size, file.sha256));
    return result;
  }
  for (const relative of checkpoint.files || []) if (safeRelativePath(relative)) result.set(relative, readCapturedFile(path.join(workspaceDir, JOURNAL_DIR, checkpointId, "files", ...relative.split("/"))));
  return result;
}
function currentWorkspaceFiles(workspaceDir: string): Map<string, CapturedFile> {
  const result = new Map<string, CapturedFile>();
  const visit = (directory: string, prefix = "") => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { if (CHECKPOINT_EXCLUDED_NAMES.has(entry.name) || entry.isSymbolicLink()) continue; const relative = prefix ? `${prefix}/${entry.name}` : entry.name; const absolute = path.join(directory, entry.name); if (entry.isDirectory()) visit(absolute, relative); else if (entry.isFile()) result.set(relative, readCapturedFile(absolute)); } };
  visit(path.resolve(workspaceDir)); return result;
}
/** Compare the workspace against a checkpoint and persist exact create/modify/delete mutation records. */
export function captureCheckpointMutationsDetailed(workspaceDir: string, input: { checkpointId: string; runId: string; requestId?: string; toolCallId: string; actor?: string }): MutationCaptureResult {
  const before = checkpointFiles(workspaceDir, input.checkpointId); const after = currentWorkspaceFiles(workspaceDir); const paths = new Set([...before.keys(), ...after.keys()]); const result: MutationCaptureResult = { records: [], skipped: [] };
  for (const relative of [...paths].sort()) { const preimage = before.get(relative); const postimage = after.get(relative); if (preimage?.reason || postimage?.reason) { if (preimage?.reason === "unreadable" || postimage?.reason === "unreadable" || preimage?.hash !== postimage?.hash || preimage?.reason !== postimage?.reason) result.skipped.push({ path: relative, reason: postimage?.reason || preimage?.reason || "unreadable" }); continue; } const preimageContent = preimage?.content; const postimageContent = postimage?.content; if (preimageContent === postimageContent) continue; result.records.push(recordFileMutation({ workspaceDir, path: relative, source: "assistant_tool", actor: input.actor, runId: input.runId, requestId: input.requestId, toolCallId: input.toolCallId, preimageContent, postimageContent })); }
  if (result.skipped.length) {
    const workspace = path.resolve(workspaceDir); loadJournal(workspace, true); const recordedAt = Date.now();
    for (const skipped of result.skipped) { const gap: MutationEvidenceGap = { workspaceDir: workspace, path: skipped.path, runId: input.runId, ...(input.requestId ? { requestId: input.requestId } : {}), toolCallId: input.toolCallId, reason: skipped.reason, recordedAt }; mutationEvidenceGaps.set(evidenceGapKey(gap), gap); }
    persistJournal(workspace);
  }
  return result;
}
