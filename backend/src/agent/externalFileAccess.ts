import fs from "node:fs";
import path from "node:path";
import {
  assertAuthorizedContextContent, DEFAULT_CONTEXT_FILE_LIMIT, evaluateContextPath,
  type AuthorizedWorkspaceFile,
} from "./contextPolicy.js";

// These remain private even when a caller intentionally grants a containing
// directory. The grant is a read ceiling, not consent to disclose credentials.
const CREDENTIAL_SEGMENTS = new Set([
  ".ssh", ".aws", ".kube", ".config", ".azure", ".gnupg", ".gcloud", ".docker",
  ".npmrc", ".pypirc", ".netrc", ".git-credentials", ".gitconfig",
  ".bash_history", ".zsh_history", ".python_history", "keychains",
]);

function denied(reason: string): never {
  throw new Error(`Context file is not authorized: ${reason}`);
}

function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function contextPath(candidate: string): string {
  return candidate.split(path.sep).join("/");
}

function assertPathPolicy(candidate: string): void {
  const decision = evaluateContextPath(candidate);
  if (!decision.allowed) denied(decision.reason || "invalid_path");
}

function assertExternalPathPolicy(candidate: string): void {
  const relativeToVolume = contextPath(path.relative(path.parse(candidate).root, candidate));
  const lower = relativeToVolume.toLowerCase();
  if (lower.split("/").some((segment) => CREDENTIAL_SEGMENTS.has(segment))) denied("protected");
  // Check the complete path, including the granted root itself, so granting a
  // protected directory cannot hide its name from the existing context policy.
  assertPathPolicy(lower);
}

function trustedDirectory(root: string): string | undefined {
  if (typeof root !== "string" || !path.isAbsolute(root) || root.includes("\0")) return undefined;
  try {
    const canonical = fs.realpathSync.native(root);
    return fs.statSync(canonical).isDirectory() ? canonical : undefined;
  } catch { return undefined; }
}

interface PathIdentity { path: string; dev: number; ino: number }

function inspectPath(root: string, target: string): PathIdentity[] {
  if (!within(target, root)) denied("invalid_path");
  const identities: PathIdentity[] = [];
  let cursor = root;
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  for (let index = -1; index < parts.length; index += 1) {
    if (index >= 0) cursor = path.join(cursor, parts[index]);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) denied("symlink");
    const final = index === parts.length - 1;
    if (final) {
      if (!stat.isFile()) denied("not_file");
      if (stat.nlink !== 1) denied("hardlink");
    } else if (!stat.isDirectory()) denied("not_file");
    identities.push({ path: cursor, dev: stat.dev, ino: stat.ino });
  }
  if (fs.realpathSync.native(target) !== target) denied("symlink");
  return identities;
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && right.isFile() && right.nlink === 1;
}

function readStableFile(root: string, target: string, maxBytes: number): { content: string; size: number; mtimeMs: number } {
  const identities = inspectPath(root, target);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(descriptor);
    const expected = identities.at(-1)!;
    if (!before.isFile()) denied("not_file");
    if (before.nlink !== 1) denied("hardlink");
    if (before.dev !== expected.dev || before.ino !== expected.ino) denied("changed_during_read");
    if (before.size > maxBytes) denied("oversized");
    // Reading at most one byte beyond the limit also bounds a file that grows
    // after fstat. O_NONBLOCK prevents a raced FIFO from hanging before fstat.
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = fs.readSync(descriptor, buffer, bytes, buffer.length - bytes, bytes);
      if (!count) break;
      bytes += count;
    }
    if (bytes > maxBytes) denied("oversized");
    const after = fs.fstatSync(descriptor);
    const current = inspectPath(root, target);
    if (!sameFile(before, after) || bytes !== after.size || identities.length !== current.length ||
      identities.some((entry, index) => entry.dev !== current[index].dev || entry.ino !== current[index].ino)) {
      denied("changed_during_read");
    }
    const content = assertAuthorizedContextContent(buffer.subarray(0, bytes));
    return { content, size: bytes, mtimeMs: after.mtimeMs };
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

/**
 * Reads a workspace file or an ordinary file under a trusted external read
 * root. The roots must come from server policy, never model/tool JSON. This
 * function grants no writes and does not populate file-edit observation caches.
 */
export function readAuthorizedAgentFile(
  workspaceDir: string,
  candidatePath: string,
  externalReadRoots: readonly string[],
  maxBytes = DEFAULT_CONTEXT_FILE_LIMIT
): AuthorizedWorkspaceFile & { external: boolean } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid context file byte limit");
  const limit = Math.min(maxBytes, DEFAULT_CONTEXT_FILE_LIMIT);
  if (typeof candidatePath !== "string" || !candidatePath.trim() || candidatePath.includes("\0")) denied("invalid_path");
  const candidate = candidatePath.trim().replace(/\\/g, "/");
  if (candidate.split("/").includes("..") || (process.platform !== "win32" && /^[A-Za-z]:\//.test(candidate))) denied("invalid_path");
  try {
    const workspace = fs.realpathSync.native(path.resolve(workspaceDir));
    const lexicalWorkspace = path.resolve(workspaceDir);
    const requested = path.resolve(lexicalWorkspace, candidate);
    let root = workspace;
    let target: string;
    let external = false;
    if (within(requested, lexicalWorkspace)) {
      target = path.resolve(workspace, path.relative(lexicalWorkspace, requested));
    } else if (within(requested, workspace)) {
      target = requested;
    } else {
      if (!path.isAbsolute(candidate)) denied("invalid_path");
      external = true;
      let matched: { root: string; target: string } | undefined;
      for (const trustedRoot of externalReadRoots) {
        const canonical = trustedDirectory(trustedRoot);
        if (!canonical) continue;
        const lexicalRoot = path.resolve(trustedRoot);
        if (within(requested, canonical)) matched = { root: canonical, target: requested };
        else if (within(requested, lexicalRoot)) matched = { root: canonical, target: path.resolve(canonical, path.relative(lexicalRoot, requested)) };
        if (matched) break;
      }
      if (!matched) denied("outside_read_scope");
      root = matched.root; target = matched.target;
      assertExternalPathPolicy(requested);
      assertExternalPathPolicy(target);
    }
    const relative = contextPath(path.relative(root, target));
    assertPathPolicy(relative);
    const file = readStableFile(root, target, limit);
    return { path: external ? target : relative, fullPath: target, generated: false, ...file, external };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Context file is not authorized:")) throw error;
    // Never include host filenames or content in denial/error messages.
    throw new Error("Context file is unavailable");
  }
}
