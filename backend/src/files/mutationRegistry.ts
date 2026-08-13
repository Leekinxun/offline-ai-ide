import crypto from "crypto";
import fs from "fs";
import path from "path";
import { CHECKPOINT_EXCLUDED_NAMES } from "../chat/checkpoints.js";
import { safePath } from "../utils/safePath.js";
import { CollaborationStore } from "../collaboration/collaborationStore.js";

export type KnownFileMutationSource = "user" | "assistant_tool";
export interface MutationHunk { id: string; preimage: string; postimage: string; preimageHash: string; postimageHash: string; }
export interface KnownFileMutationRecord { workspaceDir: string; path: string; source: KnownFileMutationSource; actor?: string; recordedAt: number; mtimeMs: number; version: string; }
export interface FileMutationRecord extends KnownFileMutationRecord { id: string; runId?: string; toolCallId?: string; operation: "create" | "modify" | "delete"; preimageHash: string; postimageHash: string; preimageContent?: string; preimageBlob?: string; postimageBlob?: string; rollbackScope: "whole-file" | "hunks"; rollbackUnavailableReason?: "binary" | "oversized"; hunks?: MutationHunk[]; hunkSelections?: Array<{ start: number; end: number; label?: string }>; }
export interface MutationRollbackResult { applied: string[]; conflicts: Array<{ id: string; path: string; expectedPostimageHash: string; actualHash: string }>; unavailable: Array<{ id: string; path: string; reason: string }>; }
export interface MutationCaptureResult { records: FileMutationRecord[]; skipped: Array<{ path: string; reason: "binary" | "oversized" | "unreadable" }>; }
export interface MutationEvidenceGap { workspaceDir: string; path: string; runId: string; toolCallId: string; reason: MutationCaptureResult["skipped"][number]["reason"]; recordedAt: number; }
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

function generateTextHunks(relativePath: string, preimage: string, postimage: string): MutationHunk[] {
  if (!preimage || !postimage || preimage.includes("\0") || postimage.includes("\0") || Buffer.byteLength(preimage) > MAX_CAPTURE_FILE_BYTES || Buffer.byteLength(postimage) > MAX_CAPTURE_FILE_BYTES) return [];
  const before = preimage.split(/(?<=\n)/); const after = postimage.split(/(?<=\n)/); const changes: Array<{ preimage: string; postimage: string }> = [];
  if (before.length === after.length) { let start = -1; for (let index = 0; index <= before.length; index += 1) { const changed = index < before.length && before[index] !== after[index]; if (changed && start < 0) start = index; if (!changed && start >= 0) { changes.push({ preimage: before.slice(start, index).join(""), postimage: after.slice(start, index).join("") }); start = -1; } } }
  else changes.push({ preimage, postimage });
  return changes.filter((change) => Boolean(change.preimage && change.postimage)).map((change, index) => ({ id: buildFileHash(`${relativePath}\0${index}\0${change.preimage}\0${change.postimage}`).slice(0, 24), ...change, preimageHash: buildFileHash(change.preimage), postimageHash: buildFileHash(change.postimage) }));
}

function safeRelativePath(value: string): string | null {
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (!normalized || path.isAbsolute(normalized) || parts.some((part) => !part || part === "." || part === "..") || CHECKPOINT_EXCLUDED_NAMES.has(parts[0])) return null;
  return normalized;
}
function inspectWorkspaceTarget(workspaceDir: string, relativePath: string): { target: string; exists: boolean } {
  const safe = safeRelativePath(relativePath); if (!safe) throw new Error("unsafe workspace path");
  const workspace = path.resolve(workspaceDir); const target = safePath(safe, workspace); let cursor = workspace;
  for (const [index, part] of safe.split("/").entries()) { cursor = path.join(cursor, part); if (!fs.existsSync(cursor)) break; const stat = fs.lstatSync(cursor); if (stat.isSymbolicLink()) throw new Error("workspace path contains a symbolic link"); const final = index === safe.split("/").length - 1; if (!final && !stat.isDirectory()) throw new Error("workspace path parent is not a directory"); if (final && !stat.isFile()) throw new Error("workspace target is not a regular file"); }
  return { target, exists: fs.existsSync(target) };
}
function atomicSafeWrite(workspaceDir: string, relativePath: string, content: string, expectedHash: string): void {
  const inspected = inspectWorkspaceTarget(workspaceDir, relativePath); const initial = inspected.exists ? fs.readFileSync(inspected.target) : Buffer.alloc(0); if (buildFileHash(initial) !== expectedHash) throw new Error("rollback target changed before write"); fs.mkdirSync(path.dirname(inspected.target), { recursive: true }); inspectWorkspaceTarget(workspaceDir, relativePath);
  const temporary = `${inspected.target}.rollback-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  try { fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" }); const revalidated = inspectWorkspaceTarget(workspaceDir, relativePath); const live = revalidated.exists ? fs.readFileSync(revalidated.target) : Buffer.alloc(0); if (buildFileHash(live) !== expectedHash) throw new Error("rollback target changed before commit"); fs.renameSync(temporary, inspected.target); } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
}
function isMutation(value: unknown, workspaceDir: string): value is FileMutationRecord {
  if (!value || typeof value !== "object") return false; const x = value as Partial<FileMutationRecord>;
  return typeof x.id === "string" && typeof x.path === "string" && safeRelativePath(x.path) !== null && path.resolve(x.workspaceDir || "") === workspaceDir && (x.source === "user" || x.source === "assistant_tool") && typeof x.recordedAt === "number" && typeof x.mtimeMs === "number" && typeof x.version === "string" && typeof x.preimageHash === "string" && typeof x.postimageHash === "string" && (x.operation === "create" || x.operation === "modify" || x.operation === "delete") && (x.rollbackScope === "whole-file" || x.rollbackScope === "hunks");
}
function atomicWrite(target: string, content: string): void { fs.mkdirSync(path.dirname(target), { recursive: true }); const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(3).toString("hex")}`; fs.writeFileSync(temporary, content, "utf8"); fs.renameSync(temporary, target); }
function storeBlob(workspaceDir: string, content: string): string { const hash = buildFileHash(content); const target = blobPath(workspaceDir, hash); if (!fs.existsSync(target)) atomicWrite(target, content); return hash; }
function workspaceRecords(workspaceDir: string): FileMutationRecord[] { const target = path.resolve(workspaceDir); return [...mutationHistory.values()].filter((x) => x.workspaceDir === target); }
function workspaceEvidenceGaps(workspaceDir: string): MutationEvidenceGap[] { const target = path.resolve(workspaceDir); return [...mutationEvidenceGaps.values()].filter((x) => x.workspaceDir === target); }
function evidenceGapKey(gap: Pick<MutationEvidenceGap, "workspaceDir" | "runId" | "toolCallId" | "path">): string { return `${gap.workspaceDir}::${gap.runId}::${gap.toolCallId}::${gap.path}`; }
function isEvidenceGap(value: unknown, workspaceDir: string): value is MutationEvidenceGap {
  if (!value || typeof value !== "object") return false;
  const gap = value as Partial<MutationEvidenceGap>;
  return path.resolve(gap.workspaceDir || "") === workspaceDir && safeRelativePath(gap.path || "") !== null && typeof gap.runId === "string" && Boolean(gap.runId.trim()) && typeof gap.toolCallId === "string" && Boolean(gap.toolCallId.trim()) && ["binary", "oversized", "unreadable"].includes(String(gap.reason)) && typeof gap.recordedAt === "number" && Number.isFinite(gap.recordedAt);
}
function loadJournal(workspaceDir: string, force = false): void {
  const workspace = path.resolve(workspaceDir); if (loadedWorkspaces.has(workspace) && !force) return;
  if (force) {
    loadedWorkspaces.delete(workspace);
    for (const [id, record] of mutationHistory) if (record.workspaceDir === workspace) mutationHistory.delete(id);
    for (const [id, gap] of mutationEvidenceGaps) if (gap.workspaceDir === workspace) mutationEvidenceGaps.delete(id);
  }
  const target = journalPath(workspace);
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
function persistJournal(workspaceDir: string): void { const workspace = path.resolve(workspaceDir); const records = workspaceRecords(workspace).sort((a, b) => a.recordedAt - b.recordedAt).slice(-MAX_MUTATION_ENTRIES); const skipped = workspaceEvidenceGaps(workspace).sort((a, b) => a.recordedAt - b.recordedAt).slice(-MAX_MUTATION_ENTRIES); atomicWrite(journalPath(workspace), JSON.stringify({ schemaVersion: 1, records, ...(skipped.length ? { skipped } : {}) } satisfies MutationJournal, null, 2)); }
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

export function recordKnownFileMutation(input: { workspaceDir: string; path: string; source: KnownFileMutationSource; actor?: string; mtimeMs: number; version?: string; content?: string; runId?: string; toolCallId?: string; preimageContent?: string; preimageHash?: string; hunkSelections?: FileMutationRecord["hunkSelections"]; hunks?: Array<{ id: string; preimage: string; postimage: string }>; }): KnownFileMutationRecord {
  const relativePath = safeRelativePath(input.path); if (!relativePath) throw new Error("Mutation path must be a workspace-relative file path");
  const workspaceDir = path.resolve(input.workspaceDir); loadJournal(workspaceDir, true);
  const record: KnownFileMutationRecord = { workspaceDir, path: relativePath, source: input.source, ...(input.actor ? { actor: input.actor } : {}), recordedAt: Date.now(), mtimeMs: input.mtimeMs, version: input.version || buildFileVersion(typeof input.content === "string" ? input.content : "") };
  mutationRegistry.set(key(record.workspaceDir, record.path), record);
  const postContent = typeof input.content === "string" ? input.content : undefined;
  if (input.runId || input.toolCallId || input.preimageContent !== undefined || input.preimageHash) {
    const preimage = input.preimageContent || ""; const postimage = postContent || "";
    const unavailable = preimage.includes("\0") || postimage.includes("\0") ? "binary" : Buffer.byteLength(preimage) > MAX_CAPTURE_FILE_BYTES || Buffer.byteLength(postimage) > MAX_CAPTURE_FILE_BYTES ? "oversized" : undefined;
    const hunks = unavailable ? [] : (input.hunks?.map((hunk) => ({ ...hunk, preimageHash: buildFileHash(hunk.preimage), postimageHash: buildFileHash(hunk.postimage) })) || (input.preimageContent !== undefined && postContent !== undefined ? generateTextHunks(relativePath, input.preimageContent, postContent) : []));
    const mutation: FileMutationRecord = { ...record, id: `${record.recordedAt}-${crypto.randomBytes(4).toString("hex")}`, ...(input.runId?.trim() ? { runId: input.runId.trim() } : {}), ...(input.toolCallId?.trim() ? { toolCallId: input.toolCallId.trim() } : {}), operation: input.preimageContent === undefined ? "create" : postContent === undefined ? "delete" : "modify", preimageHash: input.preimageHash || buildFileHash(preimage), postimageHash: buildFileHash(postimage), ...(!unavailable && input.preimageContent !== undefined ? { preimageContent: input.preimageContent, preimageBlob: storeBlob(workspaceDir, preimage) } : {}), ...(!unavailable && postContent !== undefined ? { postimageBlob: storeBlob(workspaceDir, postimage) } : {}), rollbackScope: hunks?.length ? "hunks" : "whole-file", ...(unavailable ? { rollbackUnavailableReason: unavailable } : {}), ...(hunks?.length ? { hunks } : {}), ...(input.hunkSelections?.length ? { hunkSelections: input.hunkSelections } : {}) };
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
export function listFileMutations(workspaceDir: string, selection: { runId?: string; toolCallId?: string; path?: string } = {}): FileMutationRecord[] { const target = path.resolve(workspaceDir); loadJournal(target, true); const selectedPath = selection.path === undefined ? undefined : safeRelativePath(selection.path); if (selection.path !== undefined && !selectedPath) return []; return workspaceRecords(target).filter((x) => (!selection.runId || x.runId === selection.runId) && (!selection.toolCallId || x.toolCallId === selection.toolCallId) && (!selectedPath || x.path === selectedPath)).sort((a, b) => b.recordedAt - a.recordedAt); }
export function listMutationEvidenceGaps(workspaceDir: string, selection: { runId?: string; toolCallId?: string; path?: string } = {}): MutationEvidenceGap[] { const target = path.resolve(workspaceDir); loadJournal(target, true); const selectedPath = selection.path === undefined ? undefined : safeRelativePath(selection.path); if (selection.path !== undefined && !selectedPath) return []; return workspaceEvidenceGaps(target).filter((x) => (!selection.runId || x.runId === selection.runId) && (!selection.toolCallId || x.toolCallId === selection.toolCallId) && (!selectedPath || x.path === selectedPath)).sort((a, b) => b.recordedAt - a.recordedAt); }
/** Records exact pre/post images for durable, whole-file-only rollback. */
export function recordFileMutation(input: Omit<FileMutationRecord, "id" | "recordedAt" | "version" | "workspaceDir" | "mtimeMs" | "postimageHash" | "preimageHash" | "rollbackScope" | "operation" | "preimageBlob" | "postimageBlob" | "hunks"> & { workspaceDir: string; mtimeMs?: number; postimageContent?: string; preimageContent?: string; hunks?: Array<{ id: string; preimage: string; postimage: string }>; }): FileMutationRecord { const known = recordKnownFileMutation({ workspaceDir: input.workspaceDir, path: input.path, source: input.source, actor: input.actor, mtimeMs: input.mtimeMs || Date.now(), content: input.postimageContent, runId: input.runId, toolCallId: input.toolCallId, preimageContent: input.preimageContent, hunkSelections: input.hunkSelections, hunks: input.hunks }); return listFileMutations(input.workspaceDir, { path: known.path }).find((x) => x.recordedAt === known.recordedAt)!; }
/** Refuses diverged files by default. `skip-conflicts` applies only exact-postimage matches. */
export function rollbackFileMutations(workspaceDir: string, selection: { runId?: string; toolCallId?: string; path?: string; ids?: string[]; hunkIds?: string[] }, options: { strategy?: "refuse" | "skip-conflicts" } = {}): MutationRollbackResult {
  const candidates = selection.ids ? (loadJournal(workspaceDir), selection.ids.map((id) => mutationHistory.get(id)).filter((x): x is FileMutationRecord => x !== undefined && x.workspaceDir === path.resolve(workspaceDir))) : listFileMutations(workspaceDir, selection);
  const result: MutationRollbackResult = { applied: [], conflicts: [], unavailable: [] };
  const pending: Array<{ mutation: FileMutationRecord; expectedHash: string; content?: string; action: "write" | "delete" }> = [];
  for (const mutation of candidates) {
    if (mutation.rollbackUnavailableReason) { result.unavailable.push({ id: mutation.id, path: mutation.path, reason: mutation.rollbackUnavailableReason }); continue; }
    let inspected: { target: string; exists: boolean }; let current = "";
    try { inspected = inspectWorkspaceTarget(workspaceDir, mutation.path); if (inspected.exists) { const stat = fs.lstatSync(inspected.target); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CAPTURE_FILE_BYTES) throw new Error("target is not a bounded regular file"); current = fs.readFileSync(inspected.target, "utf8"); } } catch (error) { result.unavailable.push({ id: mutation.id, path: mutation.path, reason: error instanceof Error ? error.message : "unsafe workspace path" }); continue; }
    const currentHash = buildFileHash(current);
    if (selection.hunkIds?.length) {
      const hunks = mutation.hunks?.filter((hunk) => selection.hunkIds!.includes(hunk.id)) || [];
      if (!inspected.exists || !hunks.length) { result.unavailable.push({ id: mutation.id, path: mutation.path, reason: "selected hunk is unavailable" }); continue; }
      let updated = current; let conflicted = false;
      for (const hunk of hunks) { const first = hunk.postimage ? updated.indexOf(hunk.postimage) : -1; if (first < 0 || first !== updated.lastIndexOf(hunk.postimage) || buildFileHash(hunk.postimage) !== hunk.postimageHash || buildFileHash(hunk.preimage) !== hunk.preimageHash) { result.conflicts.push({ id: mutation.id, path: mutation.path, expectedPostimageHash: hunk.postimageHash, actualHash: currentHash }); conflicted = true; break; } updated = `${updated.slice(0, first)}${hunk.preimage}${updated.slice(first + hunk.postimage.length)}`; }
      if (!conflicted) pending.push({ mutation, expectedHash: currentHash, content: updated, action: "write" });
      continue;
    }
    if (currentHash !== mutation.postimageHash) { result.conflicts.push({ id: mutation.id, path: mutation.path, expectedPostimageHash: mutation.postimageHash, actualHash: currentHash }); continue; }
    if (mutation.operation === "create") { if (!inspected.exists) { result.conflicts.push({ id: mutation.id, path: mutation.path, expectedPostimageHash: mutation.postimageHash, actualHash: currentHash }); continue; } pending.push({ mutation, expectedHash: currentHash, action: "delete" }); }
    else if (mutation.preimageContent === undefined) result.unavailable.push({ id: mutation.id, path: mutation.path, reason: "preimage content was not recorded" });
    else pending.push({ mutation, expectedHash: currentHash, content: mutation.preimageContent, action: "write" });
  }
  if ((result.conflicts.length || result.unavailable.length) && options.strategy !== "skip-conflicts") return result;
  const valid = pending.filter((item) => !result.conflicts.some((entry) => entry.id === item.mutation.id) && !result.unavailable.some((entry) => entry.id === item.mutation.id));
  // Revalidate the entire batch immediately before the first mutation. A microscopic
  // TOCTOU remains on platforms without an openat2-style beneath/no-symlink API.
  for (const item of valid) { try { const inspected = inspectWorkspaceTarget(workspaceDir, item.mutation.path); if (item.action === "delete" && !inspected.exists) throw new Error("rollback target disappeared"); const current = inspected.exists ? fs.readFileSync(inspected.target, "utf8") : ""; if (buildFileHash(current) !== item.expectedHash) throw new Error("rollback target changed during preflight"); } catch (error) { result.unavailable.push({ id: item.mutation.id, path: item.mutation.path, reason: error instanceof Error ? error.message : "rollback revalidation failed" }); } }
  if (result.unavailable.length && options.strategy !== "skip-conflicts") return result;
  for (const item of valid) { if (result.unavailable.some((entry) => entry.id === item.mutation.id)) continue; try { if (item.action === "delete") { const inspected = inspectWorkspaceTarget(workspaceDir, item.mutation.path); const stat = fs.lstatSync(inspected.target); if (!stat.isFile() || stat.isSymbolicLink() || buildFileHash(fs.readFileSync(inspected.target)) !== item.expectedHash) throw new Error("unsafe create rollback target"); fs.unlinkSync(inspected.target); } else atomicSafeWrite(workspaceDir, item.mutation.path, item.content!, item.expectedHash); result.applied.push(item.mutation.id); } catch (error) { result.unavailable.push({ id: item.mutation.id, path: item.mutation.path, reason: error instanceof Error ? error.message : "rollback write failed" }); if (options.strategy !== "skip-conflicts") break; } }
  return result;
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
export function captureCheckpointMutationsDetailed(workspaceDir: string, input: { checkpointId: string; runId: string; toolCallId: string; actor?: string }): MutationCaptureResult {
  const before = checkpointFiles(workspaceDir, input.checkpointId); const after = currentWorkspaceFiles(workspaceDir); const paths = new Set([...before.keys(), ...after.keys()]); const result: MutationCaptureResult = { records: [], skipped: [] };
  for (const relative of [...paths].sort()) { const preimage = before.get(relative); const postimage = after.get(relative); if (preimage?.reason || postimage?.reason) { if (preimage?.reason === "unreadable" || postimage?.reason === "unreadable" || preimage?.hash !== postimage?.hash || preimage?.reason !== postimage?.reason) result.skipped.push({ path: relative, reason: postimage?.reason || preimage?.reason || "unreadable" }); continue; } const preimageContent = preimage?.content; const postimageContent = postimage?.content; if (preimageContent === postimageContent) continue; result.records.push(recordFileMutation({ workspaceDir, path: relative, source: "assistant_tool", actor: input.actor, runId: input.runId, toolCallId: input.toolCallId, preimageContent, postimageContent })); }
  if (result.skipped.length) {
    const workspace = path.resolve(workspaceDir); loadJournal(workspace, true); const recordedAt = Date.now();
    for (const skipped of result.skipped) { const gap: MutationEvidenceGap = { workspaceDir: workspace, path: skipped.path, runId: input.runId, toolCallId: input.toolCallId, reason: skipped.reason, recordedAt }; mutationEvidenceGaps.set(evidenceGapKey(gap), gap); }
    persistJournal(workspace);
  }
  return result;
}
