import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildFileVersion } from "../files/mutationRegistry.js";
import { safePath } from "../utils/safePath.js";
import { normalizeContextPath, readAuthorizedWorkspaceFile } from "./contextPolicy.js";
import type { ToolContext } from "./types.js";

type FileActor = Pick<ToolContext, "runId" | "requestId" | "actorName" | "agentProfileId">;
interface ObservedFile {
  version: string;
  ranges: Array<[number, number]>;
  complete: boolean;
}

// Losing an entry (including on restart) only requires another read. A read by
// another run or actor must never authorize an overwrite in the current run.
const observedFiles = new Map<string, ObservedFile>();
const MAX_OBSERVED_FILES = 10_000;

function observationKey(workspaceDir: string, filePath: string, actor?: FileActor): string | undefined {
  const run = actor?.runId || actor?.requestId;
  if (!run) return undefined;
  return JSON.stringify([
    fs.realpathSync.native(workspaceDir), run, actor?.actorName || "primary",
    actor?.agentProfileId || "primary", filePath,
  ]);
}

export function rememberFileRead(
  workspaceDir: string,
  filePath: string,
  content: string,
  start: number,
  end: number,
  actor?: FileActor
): void {
  const key = observationKey(workspaceDir, filePath, actor);
  if (!key) return;
  const version = buildFileVersion(content);
  const previous = observedFiles.get(key);
  const ranges: Array<[number, number]> = [...(previous?.version === version ? previous.ranges : []), [start, end]];
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  observedFiles.delete(key);
  observedFiles.set(key, { version, ranges: merged, complete: merged[0]?.[0] === 0 && merged[0][1] === content.length });
  if (observedFiles.size > MAX_OBSERVED_FILES) observedFiles.delete(observedFiles.keys().next().value!);
}

export function assertFileVersion(
  workspaceDir: string,
  filePath: string,
  content: string | undefined,
  expectedVersion: unknown,
  requireCompleteRead: boolean,
  actor: FileActor
): void {
  const key = observationKey(workspaceDir, filePath, actor);
  const observed = key ? observedFiles.get(key) : undefined;
  if (expectedVersion !== undefined && (typeof expectedVersion !== "string" || !/^(?:[a-f0-9]{40}|missing)$/.test(expectedVersion))) {
    throw new Error("expected_version must be the version returned by read_file, or 'missing' for a new file");
  }
  const expected = typeof expectedVersion === "string" ? expectedVersion : observed?.version;
  const actual = content === undefined ? "missing" : buildFileVersion(content);
  if (expected && expected !== actual) {
    throw new Error(`File changed since it was read: ${filePath}. Read the current file and reconcile the changes before retrying.`);
  }
  if (content !== undefined && !expected) {
    throw new Error(`Read ${filePath} before modifying an existing file, or supply its current expected_version.`);
  }
  if (content !== undefined && requireCompleteRead && expectedVersion === undefined && !observed?.complete) {
    throw new Error(`Only part of ${filePath} was read. Read the remaining pages before replacing the whole file, or use edit_file with the current version.`);
  }
}

export function rememberFileWrite(
  workspaceDir: string,
  filePath: string,
  content: string,
  actor: FileActor,
  wholeFile: boolean
): void {
  const key = observationKey(workspaceDir, filePath, actor);
  if (!key) return;
  const complete = wholeFile || observedFiles.get(key)?.complete === true;
  // An edit shifts offsets. Retain complete knowledge, otherwise invalidate the
  // old page ranges while recording the version produced by this actor.
  observedFiles.delete(key);
  observedFiles.set(key, { version: buildFileVersion(content), ranges: complete ? [[0, content.length]] : [], complete });
  if (observedFiles.size > MAX_OBSERVED_FILES) observedFiles.delete(observedFiles.keys().next().value!);
}

export function normalizeEditablePath(filePath: string): string {
  const normalized = typeof filePath === "string" ? normalizeContextPath(filePath) : null;
  if (!normalized) throw new Error("The target must be a safe relative workspace path");
  return normalized;
}

function inspectTarget(workspaceDir: string, filePath: string): { target: string; content?: string; stat?: fs.Stats } {
  const root = fs.realpathSync.native(workspaceDir);
  const target = safePath(filePath, root);
  let cursor = root;
  const segments = filePath.split("/");
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(cursor); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { target };
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("Agent file edits cannot follow symbolic links");
    if (index < segments.length - 1) {
      if (!stat.isDirectory()) throw new Error("File parent is not a directory");
    } else {
      if (!stat.isFile()) throw new Error("Edit target is not a regular file");
      if (stat.nlink > 1) throw new Error("Agent file edits cannot replace hard-linked files");
      // Explicit versions do not grant permission to inspect secret, generated,
      // binary or oversized files. Keep the same ceiling as read_file.
      const authorized = readAuthorizedWorkspaceFile(root, filePath);
      return { target, content: authorized.content, stat };
    }
  }
  throw new Error("Invalid edit target");
}

export function readEditableFile(workspaceDir: string, filePath: string): string | undefined {
  return inspectTarget(workspaceDir, filePath).content;
}

/** Keep the old file intact until a complete replacement is ready. */
export function atomicWriteFile(workspaceDir: string, filePath: string, content: string, preimage: string | undefined, options: { commit?: (stat: fs.Stats) => void } = {}): fs.Stats {
  if (content.includes("\0")) throw new Error("Text file writes cannot contain NUL bytes. Use escaped text (repr or hex) for binary headers, or an approved command tool to generate binary artifacts.");
  const initial = inspectTarget(workspaceDir, filePath);
  if (initial.content !== preimage) throw new Error(`File changed before writing: ${filePath}`);
  fs.mkdirSync(path.dirname(initial.target), { recursive: true });
  const parent = fs.realpathSync.native(path.dirname(initial.target));
  inspectTarget(workspaceDir, filePath);
  const temporary = path.join(parent, `.${path.basename(initial.target)}.agent-${crypto.randomUUID()}.tmp`);
  const backup = options.commit && initial.stat ? path.join(parent, `.${path.basename(initial.target)}.agent-backup-${crypto.randomUUID()}.tmp`) : undefined;
  let descriptor: number | undefined;
  let backupCreated = false;
  let wroteTarget = false;
  let stat: fs.Stats | undefined;
  let writtenIdentity: Pick<fs.Stats, "dev" | "ino"> | undefined;
  const sameIdentity = (left: Pick<fs.Stats, "dev" | "ino">, right: Pick<fs.Stats, "dev" | "ino">): boolean => left.dev === right.dev && left.ino === right.ino;
  const validateBackup = (): boolean => {
    if (!backup || !initial.stat || !fs.existsSync(backup)) return false;
    const backupStat = fs.lstatSync(backup);
    return backupStat.isFile()
      && !backupStat.isSymbolicLink()
      && sameIdentity(backupStat, initial.stat)
      && fs.readFileSync(backup, "utf8") === preimage;
  };
  const restoreAfterCommitFailure = (cause: unknown): never => {
    const recoveryPath = backup ? path.relative(fs.realpathSync.native(workspaceDir), backup).replace(/\\/g, "/") : undefined;
    try {
      if (preimage === undefined) {
        if (fs.realpathSync.native(path.dirname(initial.target)) !== parent) throw new Error("File parent changed before recovery");
        const currentStat = fs.lstatSync(initial.target);
        if (writtenIdentity && currentStat.isFile() && !currentStat.isSymbolicLink() && sameIdentity(currentStat, writtenIdentity)) {
          fs.unlinkSync(initial.target);
          throw cause;
        }
      } else {
        const current = inspectTarget(workspaceDir, filePath);
        if (backup && writtenIdentity && current.stat && sameIdentity(current.stat, writtenIdentity) && current.content === content && validateBackup()) {
          fs.renameSync(backup, current.target);
          backupCreated = false;
          throw cause;
        }
      }
    } catch (error) {
      if (error === cause) throw cause;
      throw new Error(
        recoveryPath
          ? `File write journal commit failed; recovery data is retained at ${recoveryPath}. Inspect the file before retrying.`
          : "File write journal commit failed after the file changed; inspect the file before retrying.",
        { cause }
      );
    }
    throw new Error(
      recoveryPath
        ? `File write journal commit failed; recovery data is retained at ${recoveryPath}. Inspect the file before retrying.`
        : "File write journal commit failed after a concurrent file change; inspect the file before retrying.",
      { cause }
    );
  };
  try {
    descriptor = fs.openSync(temporary, "wx", initial.stat ? initial.stat.mode & 0o777 : 0o666);
    fs.writeFileSync(descriptor, content, "utf8");
    const temporaryStat = fs.fstatSync(descriptor);
    const current = inspectTarget(workspaceDir, filePath);
    if (current.content !== preimage || fs.realpathSync.native(path.dirname(current.target)) !== parent) {
      throw new Error(`File changed before committing the edit: ${filePath}`);
    }
    if (current.stat) fs.fchmodSync(descriptor, current.stat.mode & 0o777);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (backup) {
      fs.linkSync(current.target, backup);
      backupCreated = true;
      if (!validateBackup()) throw new Error(`File changed before preparing recovery: ${filePath}`);
    }
    if (preimage === undefined) {
      // Unlike rename, link fails if another writer created the destination.
      fs.linkSync(temporary, current.target);
    } else {
      fs.renameSync(temporary, current.target);
    }
    wroteTarget = true;
    writtenIdentity = { dev: temporaryStat.dev, ino: temporaryStat.ino };
    try {
      stat = fs.statSync(current.target);
      if (!sameIdentity(stat, writtenIdentity)) throw new Error(`File changed after writing: ${filePath}`);
      options.commit?.(stat);
    }
    catch (error) { restoreAfterCommitFailure(error); }
    if (backupCreated && backup) {
      try { fs.unlinkSync(backup); } catch { /* the journal has the durable preimage */ }
      backupCreated = false;
    }
    if (!stat) throw new Error(`File status unavailable after writing: ${filePath}`);
    return stat;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
    if (!wroteTarget && backupCreated && backup) fs.rmSync(backup, { force: true });
  }
}

export function replaceUniqueText(content: string, oldText: string, newText: string): {
  content: string; offset: number; replacementLength: number;
} {
  if (typeof oldText !== "string" || !oldText.length) throw new Error("old_text must be non-empty");
  if (typeof newText !== "string") throw new Error("new_text must be a string");
  let needle = oldText;
  let offset = content.indexOf(needle);
  if (offset < 0) {
    // Only normalize newline encoding in uniformly terminated files. Indents,
    // whitespace and mixed newline files are never guessed or fuzzy-matched.
    const crlf = content.includes("\r\n");
    const uniform = crlf ? !content.replace(/\r\n/g, "").includes("\n") : !content.includes("\r");
    if (uniform) {
      needle = oldText.replace(/\r\n/g, "\n");
      if (crlf) needle = needle.replace(/\n/g, "\r\n");
      offset = content.indexOf(needle);
    }
  }
  if (offset < 0) throw new Error("Text not found. Read the current file and use an exact, unique old_text.");
  if (content.indexOf(needle, offset + 1) >= 0) throw new Error("old_text matches multiple locations. Include more surrounding context to identify one location.");
  let replacement = newText;
  if (content.includes("\r\n") && !content.replace(/\r\n/g, "").includes("\n")) {
    replacement = newText.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  } else if (!content.includes("\r")) {
    replacement = newText.replace(/\r\n/g, "\n");
  }
  return {
    // String.replace interprets $&, $' and $` inside replacement strings.
    content: content.slice(0, offset) + replacement + content.slice(offset + needle.length),
    offset,
    replacementLength: replacement.length,
  };
}
