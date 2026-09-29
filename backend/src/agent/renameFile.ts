import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  buildFileVersion,
  notifyWorkspaceMutation,
  prepareFileMutationBatch,
} from "../files/mutationRegistry.js";
import { safePath } from "../utils/safePath.js";
import { evaluateContextPath } from "./contextPolicy.js";
import { assertFileVersion, normalizeEditablePath, readEditableFile, rememberFileWrite } from "./fileEditSafety.js";
import { evaluateWorkspaceWrite } from "./toolPolicy.js";
import type { ToolContext } from "./types.js";

export type RenameFileContext = Pick<ToolContext, "actorName" | "runId" | "requestId" | "agentProfileId" | "toolCallId">;

export interface RenameFileInput {
  workspaceDir: string;
  source_path: unknown;
  target_path: unknown;
  expected_version?: unknown;
}

export interface RenameFileResult {
  sourcePath: string;
  path: string;
  content: string;
  version: string;
  mtimeMs: number;
  changed: boolean;
  mutationIds: string[];
}

function authorizePath(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error("Rename paths must be safe relative workspace paths");
  const normalized = normalizeEditablePath(value);
  const policy = evaluateWorkspaceWrite(normalized);
  if (!policy.allowed) throw new Error(`Rename blocked by workspace policy: ${policy.reason}`);
  const contextPolicy = evaluateContextPath(normalized);
  if (!contextPolicy.allowed) throw new Error(`Rename path is not authorized: ${contextPolicy.reason}`);
  return normalized;
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino;
}

function statIfPresent(target: string): fs.Stats | undefined {
  try { return fs.lstatSync(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function existingParent(workspaceDir: string, relativePath: string): string {
  const target = safePath(relativePath, workspaceDir);
  let cursor = workspaceDir;
  for (const part of relativePath.split("/").slice(0, -1)) {
    cursor = path.join(cursor, part);
    const stat = statIfPresent(cursor);
    if (!stat) throw new Error("Rename target parent directory does not exist");
    if (stat.isSymbolicLink()) throw new Error("Agent file renames cannot follow symbolic links");
    if (!stat.isDirectory()) throw new Error("Rename parent is not a directory");
  }
  return target;
}

/** Rename one observed text file without copying, rewriting, or overwriting a destination. */
export function renameWorkspaceFile(input: RenameFileInput, context: RenameFileContext): RenameFileResult {
  // Preserve the session's workspace identity in the journal, like edit_file.
  // Path authorization resolves the root internally, including a legitimate root alias.
  const workspaceDir = path.resolve(input.workspaceDir);
  const sourcePath = authorizePath(input.source_path);
  const targetPath = authorizePath(input.target_path);
  const content = readEditableFile(workspaceDir, sourcePath);
  if (content === undefined) throw new Error(`File not found: ${sourcePath}`);
  assertFileVersion(workspaceDir, sourcePath, content, input.expected_version, true, context);
  const source = existingParent(workspaceDir, sourcePath);
  const initial = fs.lstatSync(source);
  const bytes = fs.readFileSync(source);
  // The journal restores text. Refuse inputs it could not restore byte-for-byte.
  if (!bytes.equals(Buffer.from(content, "utf8"))) throw new Error("Rename requires lossless UTF-8 text evidence");
  const result = { sourcePath, path: targetPath, content, version: buildFileVersion(content), mtimeMs: initial.mtimeMs };
  if (sourcePath === targetPath) return { ...result, changed: false, mutationIds: [] };
  const target = existingParent(workspaceDir, targetPath);
  if (statIfPresent(target)) throw new Error(`Rename target already exists: ${targetPath}`);
  // Both blobs and the complete journal are prepared before either entry changes.
  const shared = {
    workspaceDir, source: "assistant_tool" as const, actor: context.actorName,
    runId: context.runId, requestId: context.requestId, toolCallId: context.toolCallId,
    mtimeMs: initial.mtimeMs,
  };
  const batch = prepareFileMutationBatch([
    { ...shared, path: sourcePath, preimageContent: content },
    { ...shared, path: targetPath, postimageContent: content },
  ], { notify: false });

  const assertCurrentSource = (links: number): void => {
    existingParent(workspaceDir, sourcePath);
    const current = fs.lstatSync(source);
    if (!sameFile(initial, current) || current.nlink !== links || !fs.readFileSync(source).equals(bytes)) {
      throw new Error(`File changed before renaming: ${sourcePath}`);
    }
  };
  let linked = false;
  let sourceRemoved = false;
  let backupCreated = false;
  let committed = false;
  const backupPath = path.posix.join(path.posix.dirname(sourcePath), `.${path.posix.basename(sourcePath)}.rename-${crypto.randomUUID()}.tmp`);
  const backup = path.join(workspaceDir, backupPath);
  let mutationIds: string[];
  try {
    assertCurrentSource(1);
    existingParent(workspaceDir, targetPath);
    // Retain our own name until the journal commits, even if another writer
    // replaces the destination between the move and a failed journal commit.
    fs.linkSync(source, backup);
    backupCreated = true;
    if (!sameFile(initial, fs.lstatSync(backup))) throw new Error("Rename source changed while preparing recovery");
    assertCurrentSource(2);
    // link is exclusive: a concurrent file, directory, or symlink is never replaced.
    // Removing the original name afterwards preserves the file's bytes and permissions.
    fs.linkSync(backup, target);
    linked = true;
    existingParent(workspaceDir, targetPath);
    if (!sameFile(initial, fs.lstatSync(target))) throw new Error("Rename source changed while reserving the destination");
    assertCurrentSource(3);
    fs.unlinkSync(source);
    sourceRemoved = true;
    existingParent(workspaceDir, targetPath);
    if (statIfPresent(source) || !sameFile(initial, fs.lstatSync(target)) || !fs.readFileSync(target).equals(bytes)) {
      throw new Error("Rename paths changed before committing the operation");
    }
    mutationIds = batch.commit().map((record) => record.id);
    committed = true;
  } catch (error) {
    if (backupCreated) {
      try {
        const retained = statIfPresent(backup);
        if (retained && sameFile(initial, retained)) {
          // Restore only into a still-empty source slot; never replace a concurrent edit.
          if (sourceRemoved && !statIfPresent(source)) {
            existingParent(workspaceDir, sourcePath);
            fs.linkSync(backup, source);
          }
          const restored = statIfPresent(source);
          const destination = statIfPresent(target);
          if (linked && restored && sameFile(initial, restored) && destination && sameFile(initial, destination)) fs.unlinkSync(target);
          if (restored && sameFile(initial, restored)) { fs.unlinkSync(backup); backupCreated = false; }
        }
      } catch {
        throw new Error(`Rename failed; recovery data is retained at ${backupPath}. Inspect both paths before retrying.`, { cause: error });
      }
      if (backupCreated) {
        throw new Error(`Rename failed; recovery data is retained at ${backupPath}. Inspect both paths before retrying.`, { cause: error });
      }
    }
    throw error;
  } finally {
    batch.cancel();
    if (committed && backupCreated) {
      // The committed journal also contains the full preimage. A cleanup failure
      // must not turn a successful, auditable rename into an apparent tool failure.
      try { if (sameFile(initial, fs.lstatSync(backup))) fs.unlinkSync(backup); } catch { /* preserve recovery data */ }
    }
  }
  // Cache knowledge is only an optimization; a lost observation requires a reread.
  try { rememberFileWrite(workspaceDir, targetPath, content, context, true); } catch { /* workspace may have disappeared after commit */ }
  notifyWorkspaceMutation({ workspaceDir, path: targetPath, previousPath: sourcePath, operation: "rename" });
  return { ...result, changed: true, mutationIds };
}
