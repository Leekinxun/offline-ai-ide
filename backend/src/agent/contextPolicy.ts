import fs from "node:fs";
import path from "node:path";

export type ContextPolicyReason =
  | "invalid_path"
  | "protected"
  | "secret"
  | "generated"
  | "symlink"
  | "not_file"
  | "binary"
  | "oversized"
  | "unreadable";

export interface ContextPolicyDecision {
  allowed: boolean;
  normalizedPath?: string;
  generated: boolean;
  reason?: ContextPolicyReason;
}

export interface AuthorizedWorkspaceFile {
  path: string;
  fullPath: string;
  generated: boolean;
  size: number;
  mtimeMs: number;
  content: string;
}
export interface AuthorizedWorkspaceBytes {
  path: string;
  fullPath: string;
  generated: boolean;
  size: number;
  mtimeMs: number;
  buffer: Buffer;
}

export const DEFAULT_CONTEXT_FILE_LIMIT = 1024 * 1024;
export const DEFAULT_BINARY_VERSION_FILE_LIMIT = 2 * 1024 * 1024;

export function isExpectedTextPath(filePath: string): boolean {
  return /\.(?:md|mdx|markdown|txt|rst|adoc|json|csv|ya?ml|toml|xml|html?|css|[cm]?jsx?|tsx?|py|sh|sql|ini|log)$/i.test(filePath);
}

export const NUL_TEXT_RECOVERY = "Text contains NUL bytes; regenerate the text from its source through the normal approved command tool, using repr or hex for binary headers. Text edit tools cannot overwrite binary files. Reread the repaired text and rerun relevant checks.";

const PROTECTED_SEGMENTS = new Set([
  ".git", ".history", ".checkpoints", ".team", ".tasks", ".transcripts", ".codex", ".omx", ".crewforge",
]);
const GENERATED_SEGMENTS = new Set([
  "node_modules", "dist", "build", "coverage", "out", "target", "vendor", "venv", ".venv",
  "__pycache__", ".next", ".nuxt",
]);
const PROTECTED_FILES = new Set(["users.json", "app-settings.json"]);
const SECRET_FILE = /(?:^|\/)(?:\.env(?:\..*)?|[^/]*(?:credentials|secrets?)[^/]*\.(?:json|ya?ml|toml|ini))$/i;
const SECRET_CONTENT_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\s*["']?\s*[:=]\s*["'`]([^\s"'`]{8,})["'`]/i,
] as const;
const PLACEHOLDER_SECRET = /^(?:example|placeholder|changeme|dummy|fake|test|your[_-]|<|\$\{|process\.env)/i;

export function normalizeContextPath(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  const parts = normalized.split("/");
  if (!normalized || path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) return null;
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return normalized;
}

export function evaluateContextPath(value: string): ContextPolicyDecision {
  const normalizedPath = normalizeContextPath(value);
  if (!normalizedPath) return { allowed: false, generated: false, reason: "invalid_path" };
  const segments = normalizedPath.split("/");
  if (segments.some((segment) => PROTECTED_SEGMENTS.has(segment)) || PROTECTED_FILES.has(segments.at(-1) || "")) {
    return { allowed: false, normalizedPath, generated: false, reason: "protected" };
  }
  if (SECRET_FILE.test(normalizedPath)) {
    return { allowed: false, normalizedPath, generated: false, reason: "secret" };
  }
  const generated = segments.some((segment) => GENERATED_SEGMENTS.has(segment)) ||
    /(?:^|\/)(?:.*\.min\.(?:js|css)|.*\.(?:map|lock))$/i.test(normalizedPath);
  if (generated) return { allowed: false, normalizedPath, generated: true, reason: "generated" };
  return { allowed: true, normalizedPath, generated: false };
}

export function containsContextSecret(content: string): boolean {
  for (const pattern of SECRET_CONTENT_PATTERNS) {
    const match = content.match(pattern);
    if (!match) continue;
    if (match[1] && PLACEHOLDER_SECRET.test(match[1])) continue;
    return true;
  }
  return false;
}

export function decodeAuthorizedUtf8Content(buffer: Buffer): string | null {
  if (buffer.includes(0)) return null;
  const content = buffer.toString("utf8");
  return Buffer.from(content, "utf8").equals(buffer) ? content : null;
}

export function isBinaryContextBuffer(buffer: Buffer): boolean {
  return decodeAuthorizedUtf8Content(buffer) === null;
}

/** Scan content restrictions only; this does not authorize bytes as text context. */
export function assertAuthorizedContextTextPolicy(content: string): void {
  if (/^(?:\/\/|#|\/\*)\s*@generated\b/im.test(content.slice(0, 4096)) || /\bDO NOT EDIT\b/i.test(content.slice(0, 4096))) {
    throw new Error("Context file is not authorized: generated");
  }
  if (containsContextSecret(content)) throw new Error("Context file is not authorized: secret");
}

/** Shared content policy for workspace context and explicitly granted external reads. */
export function assertAuthorizedContextContent(buffer: Buffer): string {
  const content = decodeAuthorizedUtf8Content(buffer);
  if (content === null) throw new Error("Context file is not authorized: binary");
  assertAuthorizedContextTextPolicy(content);
  return content;
}

function contained(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function resolveAuthorizedWorkspaceFile(
  workspaceDir: string,
  candidatePath: string,
  maxBytes = DEFAULT_CONTEXT_FILE_LIMIT
): Omit<AuthorizedWorkspaceBytes, "buffer"> {
  const decision = evaluateContextPath(candidatePath);
  if (!decision.allowed || !decision.normalizedPath) {
    throw new Error(`Context file is not authorized: ${decision.reason || "invalid_path"}`);
  }
  const root = fs.realpathSync.native(path.resolve(workspaceDir));
  let cursor = root;
  for (const segment of decision.normalizedPath.split("/")) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) throw new Error("Context file is unavailable");
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error("Context file is not authorized: symlink");
  }
  const fullPath = path.resolve(root, ...decision.normalizedPath.split("/"));
  if (!contained(fullPath, root)) throw new Error("Context file is not authorized: invalid_path");
  const stat = fs.lstatSync(fullPath);
  if (!stat.isFile()) throw new Error("Context file is not authorized: not_file");
  if (stat.size > Math.max(1, maxBytes)) throw new Error("Context file is not authorized: oversized");
  return {
    path: decision.normalizedPath,
    fullPath,
    generated: decision.generated,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

/** Authorize and read raw bytes without making them model context. */
export function readAuthorizedWorkspaceBytes(
  workspaceDir: string,
  candidatePath: string,
  maxBytes = DEFAULT_CONTEXT_FILE_LIMIT
): AuthorizedWorkspaceBytes {
  const authorized = resolveAuthorizedWorkspaceFile(workspaceDir, candidatePath, maxBytes);
  const buffer = fs.readFileSync(authorized.fullPath);
  if (!isBinaryContextBuffer(buffer)) assertAuthorizedContextContent(buffer);
  return { ...authorized, buffer };
}

/**
 * Authorize and read a context file using the same fail-closed checks used by
 * indexing, indexed retrieval, definition lookup, and pinned context.
 */
export function readAuthorizedWorkspaceFile(
  workspaceDir: string,
  candidatePath: string,
  maxBytes = DEFAULT_CONTEXT_FILE_LIMIT
): AuthorizedWorkspaceFile {
  const authorized = readAuthorizedWorkspaceBytes(workspaceDir, candidatePath, maxBytes);
  const content = assertAuthorizedContextContent(authorized.buffer);
  const { buffer: _buffer, ...metadata } = authorized;
  return { ...metadata, content };
}
