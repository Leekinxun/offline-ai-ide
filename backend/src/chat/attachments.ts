import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { containsContextSecret, evaluateContextPath } from "../agent/contextPolicy.js";

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_ATTACHMENTS = 4;
const MAX_WORKSPACE_BYTES = 512 * 1024 * 1024;
const MAX_STAGED_BYTES = 24 * 1024 * 1024;
const MAX_STAGED_ATTACHMENTS = 32;
const UNUSED_RETENTION_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const ID_PATTERN = /^att-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const TEXT_MIME_TYPES = new Set([
  "application/json", "application/javascript", "application/typescript", "application/xml",
  "application/x-yaml", "application/yaml", "application/toml", "application/x-sh",
  "application/sql", "application/x-ndjson",
]);
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".rst", ".py", ".pyi", ".js", ".jsx", ".mjs",
  ".cjs", ".ts", ".tsx", ".mts", ".cts", ".json", ".jsonl", ".yaml",
  ".yml", ".toml", ".ini", ".cfg", ".conf", ".xml", ".html", ".htm",
  ".css", ".scss", ".sass", ".less", ".sh", ".bash", ".zsh", ".fish",
  ".sql", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".h", ".cc",
  ".cpp", ".hpp", ".cs", ".rb", ".php", ".vue", ".svelte", ".svg",
  ".csv", ".tsv", ".log", ".diff", ".patch", ".ipynb",
]);
const TEXT_FILENAMES = new Set(["readme", "license", "dockerfile", "makefile", ".gitignore"]);
const activeAttachmentWorkspaces = new Set<string>();
let cleanupTimer: NodeJS.Timeout | undefined;

export interface ChatAttachmentRef {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "text" | "pdf";
}

interface StoredChatAttachment extends ChatAttachmentRef {
  schemaVersion: 1;
  sha256: string;
  createdAt: number;
}

export interface ChatAttachmentUpload {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}

export class ChatAttachmentError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 413 = 400) {
    super(message);
    this.name = "ChatAttachmentError";
  }
}

export function isChatAttachmentRef(value: unknown): value is ChatAttachmentRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as Partial<ChatAttachmentRef>;
  return typeof ref.id === "string" && ID_PATTERN.test(ref.id)
    && typeof ref.name === "string" && ref.name.length > 0 && ref.name.length <= 200
    && !/[\\/\x00-\x1f\x7f]/.test(ref.name)
    && typeof ref.mimeType === "string" && ref.mimeType.length > 0 && ref.mimeType.length <= 100
    && typeof ref.size === "number" && Number.isSafeInteger(ref.size) && ref.size > 0 && ref.size <= MAX_ATTACHMENT_BYTES
    && ((ref.kind === "image" && IMAGE_MIME_TYPES.has(ref.mimeType))
      || (ref.kind === "text" && ref.mimeType === "text/plain" && ref.size <= MAX_TEXT_BYTES)
      || (ref.kind === "pdf" && ref.mimeType === "application/pdf"));
}

function assertPlainDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ChatAttachmentError("Unsafe attachment storage");
}

function ensurePrivateDirectory(directory: string): void {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  assertPlainDirectory(directory);
  fs.chmodSync(directory, 0o700);
}

/** The desktop host puts APP_SETTINGS_CONFIG inside its per-user data directory. */
export function resolveChatAttachmentStoragePath(
  workspaceDir: string,
  options: { platform?: string; desktop?: boolean; settingsConfigPath?: string } = {},
): string {
  const workspace = path.resolve(workspaceDir);
  const platform = options.platform ?? process.platform;
  const desktop = options.desktop ?? process.env.CREWFORGE_DESKTOP === "1";
  if (platform !== "win32" || !desktop) return path.join(workspace, ".history", "attachments");
  const settingsConfigPath = options.settingsConfigPath ?? process.env.APP_SETTINGS_CONFIG;
  if (!settingsConfigPath || !path.isAbsolute(settingsConfigPath)) {
    throw new ChatAttachmentError("Desktop attachment storage is unavailable");
  }
  const workspaceHash = crypto.createHash("sha256").update(workspace).digest("hex");
  return path.join(path.dirname(settingsConfigPath), "attachments", workspaceHash);
}

function attachmentDirectory(workspaceDir: string, create: boolean): string {
  const workspace = path.resolve(workspaceDir);
  assertPlainDirectory(workspace);
  const history = path.join(workspace, ".history");
  if (create) {
    ensurePrivateDirectory(history);
  } else {
    assertPlainDirectory(history);
  }
  const desktopWindows = process.platform === "win32" && process.env.CREWFORGE_DESKTOP === "1";
  const canonicalWorkspace = desktopWindows ? fs.realpathSync.native(workspace) : workspace;
  const attachments = resolveChatAttachmentStoragePath(canonicalWorkspace);
  if (desktopWindows) {
    const attachmentsRoot = path.dirname(attachments);
    const dataDirectory = path.dirname(attachmentsRoot);
    assertPlainDirectory(dataDirectory);
    if (create) ensurePrivateDirectory(attachmentsRoot);
    else assertPlainDirectory(attachmentsRoot);
  }
  if (create) ensurePrivateDirectory(attachments);
  else assertPlainDirectory(attachments);
  return attachments;
}

function attachmentPath(directory: string, id: string, extension: ".json" | ".bin"): string {
  if (!ID_PATTERN.test(id)) throw new ChatAttachmentError("Invalid attachment id");
  return path.join(directory, `${id}${extension}`);
}

function isSingleFrameGif(bytes: Buffer): boolean {
  if (bytes.length < 14) return false;
  let offset = 13;
  const globalColorTable = bytes[10];
  if (globalColorTable & 0x80) offset += 3 * (1 << ((globalColorTable & 0x07) + 1));
  let frames = 0;
  const skipSubBlocks = (): boolean => {
    while (offset < bytes.length) {
      const size = bytes[offset++];
      if (size === 0) return true;
      offset += size;
      if (offset > bytes.length) return false;
    }
    return false;
  };
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) return frames === 1;
    if (marker === 0x21) {
      if (offset >= bytes.length) return false;
      offset += 1;
      if (!skipSubBlocks()) return false;
      continue;
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) return false;
    frames += 1;
    if (frames > 1) return false;
    const localColorTable = bytes[offset + 8];
    offset += 9;
    if (localColorTable & 0x80) offset += 3 * (1 << ((localColorTable & 0x07) + 1));
    if (offset >= bytes.length) return false;
    offset += 1; // LZW minimum code size
    if (!skipSubBlocks()) return false;
  }
  return false;
}

function imageMimeType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 6 && (bytes.toString("ascii", 0, 6) === "GIF87a" || bytes.toString("ascii", 0, 6) === "GIF89a")) {
    if (!isSingleFrameGif(bytes)) throw new ChatAttachmentError("Animated or invalid GIF attachments are not supported");
    return "image/gif";
  }
  return null;
}

function normalizedName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 200 || /[\\/\x00-\x1f\x7f]/.test(name) || name === "." || name === "..") {
    throw new ChatAttachmentError("Invalid attachment name");
  }
  const policy = evaluateContextPath(name);
  if (!policy.allowed) throw new ChatAttachmentError("Attachment name is not authorized");
  return name;
}

function normalizeMimeType(value: string): string {
  const mime = value.split(";", 1)[0].trim().toLowerCase();
  return mime === "image/jpg" ? "image/jpeg" : mime;
}

function classify(name: string, suppliedMime: string, bytes: Buffer): Pick<ChatAttachmentRef, "kind" | "mimeType"> {
  if (bytes.length === 0) throw new ChatAttachmentError("Empty attachments are not supported");
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new ChatAttachmentError("Attachment exceeds 5 MiB", 413);
  const mime = normalizeMimeType(suppliedMime);
  const extension = path.extname(name).toLowerCase();
  const detectedImage = imageMimeType(bytes);
  if (detectedImage) {
    if (mime && mime !== "application/octet-stream" && mime !== detectedImage) throw new ChatAttachmentError("Attachment media type does not match its contents");
    return { kind: "image", mimeType: detectedImage };
  }
  const detectedPdf = bytes.toString("ascii", 0, 5) === "%PDF-"
    && bytes.subarray(Math.max(0, bytes.length - 1024)).includes(Buffer.from("%%EOF"));
  if (detectedPdf) {
    if (mime && mime !== "application/octet-stream" && mime !== "application/pdf") throw new ChatAttachmentError("Attachment media type does not match its contents");
    return { kind: "pdf", mimeType: "application/pdf" };
  }
  if (IMAGE_MIME_TYPES.has(mime) || mime === "application/pdf" || [".png", ".jpg", ".jpeg", ".webp", ".gif", ".pdf"].includes(extension)) {
    throw new ChatAttachmentError("Attachment media type does not match its contents");
  }
  const textName = TEXT_EXTENSIONS.has(extension) || TEXT_FILENAMES.has(name.toLowerCase());
  const textMime = mime.startsWith("text/") || TEXT_MIME_TYPES.has(mime);
  if (!textName && !textMime) throw new ChatAttachmentError("Unsupported attachment type");
  if (mime && mime !== "application/octet-stream" && !textMime) throw new ChatAttachmentError("Unsupported attachment media type");
  if (bytes.length > MAX_TEXT_BYTES) throw new ChatAttachmentError("Text attachment exceeds 256 KiB", 413);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new ChatAttachmentError("Text attachment must be valid UTF-8"); }
  if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text)) throw new ChatAttachmentError("Text attachment contains binary data");
  if (containsContextSecret(text)) throw new ChatAttachmentError("Text attachment contains a protected secret");
  return { kind: "text", mimeType: "text/plain" };
}

function assertOpenedFileStillStored(workspaceDir: string, directory: string, filePath: string, opened: fs.Stats): void {
  try {
    if (attachmentDirectory(workspaceDir, false) !== directory) throw new ChatAttachmentError("Attachment storage is invalid");
    const current = fs.lstatSync(filePath);
    if (!current.isFile() || current.isSymbolicLink()
      || (opened.ino !== 0 && current.ino !== 0 && (opened.dev !== current.dev || opened.ino !== current.ino))) {
      throw new ChatAttachmentError("Attachment storage is invalid");
    }
  } catch {
    throw new ChatAttachmentError("Attachment storage is invalid");
  }
}

function readPrivateFile(workspaceDir: string, directory: string, filePath: string, maxBytes: number): Buffer {
  let descriptor: number;
  let entry: fs.Stats;
  try {
    // O_NOFOLLOW is not available on every platform (notably Windows).
    // Reject a link explicitly before opening the stored file as well.
    entry = fs.lstatSync(filePath);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new ChatAttachmentError("Attachment storage is invalid");
    const flags = fs.constants.O_RDONLY | (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW);
    descriptor = fs.openSync(filePath, flags);
  } catch (error) {
    if (error instanceof ChatAttachmentError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ChatAttachmentError("Attachment not found", 404);
    throw new ChatAttachmentError("Attachment storage is invalid");
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes || stat.size < 1
      || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
      || (entry.ino !== 0 && stat.ino !== 0 && (entry.dev !== stat.dev || entry.ino !== stat.ino))) {
      throw new ChatAttachmentError("Attachment storage is invalid");
    }
    assertOpenedFileStillStored(workspaceDir, directory, filePath, stat);
    const bytes = fs.readFileSync(descriptor);
    if (bytes.length > maxBytes || bytes.length < 1) throw new ChatAttachmentError("Attachment storage is invalid");
    assertOpenedFileStillStored(workspaceDir, directory, filePath, stat);
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readStoredMetadata(workspaceDir: string, directory: string, id: string): StoredChatAttachment {
  let raw: unknown;
  try { raw = JSON.parse(readPrivateFile(workspaceDir, directory, attachmentPath(directory, id, ".json"), 4096).toString("utf8")); }
  catch (error) {
    if (error instanceof ChatAttachmentError) throw error;
    throw new ChatAttachmentError("Attachment metadata is invalid");
  }
  if (!isChatAttachmentRef(raw)) throw new ChatAttachmentError("Attachment metadata is invalid");
  const metadata = raw as StoredChatAttachment;
  if (metadata.schemaVersion !== 1 || metadata.id !== id || !SHA256_PATTERN.test(metadata.sha256)
    || !Number.isSafeInteger(metadata.createdAt) || metadata.createdAt < 1) {
    throw new ChatAttachmentError("Attachment metadata is invalid");
  }
  return metadata;
}

function referencedAttachmentIds(workspaceDir: string): Set<string> | null {
  const referenced = new Set<string>();
  try {
    for (const entry of fs.readdirSync(path.join(workspaceDir, ".history"))) {
      if (!entry.endsWith(".jsonl")) continue;
      for (const line of fs.readFileSync(path.join(workspaceDir, ".history", entry), "utf8").split("\n")) {
        if (!line.trim()) continue;
        const record = JSON.parse(line) as { attachments?: unknown };
        if (!Array.isArray(record.attachments)) continue;
        for (const attachment of record.attachments) {
          if (attachment && typeof attachment === "object" && typeof attachment.id === "string" && ID_PATTERN.test(attachment.id)) {
            referenced.add(attachment.id);
          }
        }
      }
    }
    return referenced;
  } catch {
    // An unreadable history must never cause an attachment to be removed.
    return null;
  }
}

function removeAttachmentPair(directory: string, id: string): void {
  fs.rmSync(attachmentPath(directory, id, ".json"), { force: true });
  fs.rmSync(attachmentPath(directory, id, ".bin"), { force: true });
}

function assertWorkspaceQuota(directory: string, workspaceDir: string, incomingBytes: number, incomingCount: number): void {
  const referenced = referencedAttachmentIds(workspaceDir);
  if (!referenced) throw new ChatAttachmentError("Attachment quota could not be verified", 413);
  let storedBytes = 0;
  let stagedBytes = 0;
  const stagedIds = new Set<string>();
  for (const entry of fs.readdirSync(directory)) {
    const filePath = path.join(directory, entry);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ChatAttachmentError("Attachment storage is invalid");
    storedBytes += stat.size;
    if (entry.endsWith(".bin")) {
      const id = entry.slice(0, -4);
      if (!referenced.has(id)) {
        stagedBytes += stat.size;
        stagedIds.add(id);
      }
    } else if (entry.endsWith(".json")) {
      const id = entry.slice(0, -5);
      if (!referenced.has(id)) stagedIds.add(id);
    } else {
      stagedBytes += stat.size;
      stagedIds.add(entry);
    }
  }
  // Metadata is small but included in the workspace ceiling so the check stays
  // conservative even when the upload consists of many small attachments.
  if (storedBytes + incomingBytes + incomingCount * 1024 > MAX_WORKSPACE_BYTES) {
    throw new ChatAttachmentError("Workspace attachment storage exceeds 512 MiB", 413);
  }
  if (stagedBytes + incomingBytes > MAX_STAGED_BYTES || stagedIds.size + incomingCount > MAX_STAGED_ATTACHMENTS) {
    throw new ChatAttachmentError("Unsent attachment storage exceeds its 24 MiB or 32 file limit", 413);
  }
}

/** Reclaim blobs from removed conversation messages only if no remaining history references them. */
export function deleteUnreferencedChatAttachments(workspaceDir: string, candidateIds: readonly string[]): number {
  if (candidateIds.length === 0) return 0;
  let directory: string;
  try { directory = attachmentDirectory(workspaceDir, false); }
  catch { return 0; }
  const referenced = referencedAttachmentIds(workspaceDir);
  if (!referenced) return 0;
  let removed = 0;
  for (const id of new Set(candidateIds)) {
    if (!ID_PATTERN.test(id) || referenced.has(id)) continue;
    try {
      readStoredMetadata(workspaceDir, directory, id);
      removeAttachmentPair(directory, id);
      removed += 1;
    } catch { /* Keep an invalid entry for inspection rather than risk deleting the wrong file. */ }
  }
  return removed;
}

/** Reclaim staged uploads that were never included in a persisted user turn. */
export function cleanupUnusedChatAttachments(workspaceDir: string, now = Date.now()): number {
  let directory: string;
  try { directory = attachmentDirectory(workspaceDir, false); }
  catch { return 0; }
  const referenced = referencedAttachmentIds(workspaceDir);
  if (!referenced) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(directory)) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -5);
    if (!ID_PATTERN.test(id) || referenced.has(id)) continue;
    try {
      const metadata = readStoredMetadata(workspaceDir, directory, id);
      if (now - metadata.createdAt < UNUSED_RETENTION_MS) continue;
      removeAttachmentPair(directory, id);
      removed += 1;
    } catch { /* An invalid entry is left untouched for manual inspection. */ }
  }
  for (const entry of fs.readdirSync(directory)) {
    if (!entry.endsWith(".bin")) continue;
    const id = entry.slice(0, -4);
    if (!ID_PATTERN.test(id) || referenced.has(id) || fs.existsSync(attachmentPath(directory, id, ".json"))) continue;
    const binaryPath = attachmentPath(directory, id, ".bin");
    try {
      const stat = fs.lstatSync(binaryPath);
      if (!stat.isFile() || stat.isSymbolicLink() || now - stat.mtimeMs < UNUSED_RETENTION_MS) continue;
      fs.rmSync(binaryPath);
      removed += 1;
    } catch { /* A changing entry can be checked during the next sweep. */ }
  }
  return removed;
}

function scheduleUnusedAttachmentCleanup(workspaceDir: string): void {
  activeAttachmentWorkspaces.add(path.resolve(workspaceDir));
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    for (const workspace of activeAttachmentWorkspaces) {
      if (!fs.existsSync(workspace)) {
        activeAttachmentWorkspaces.delete(workspace);
        continue;
      }
      try { cleanupUnusedChatAttachments(workspace); }
      catch { /* Cleanup must not interrupt active chats. */ }
    }
    if (activeAttachmentWorkspaces.size === 0 && cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = undefined;
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

export function storeChatAttachments(workspaceDir: string, uploads: readonly ChatAttachmentUpload[]): ChatAttachmentRef[] {
  if (!Array.isArray(uploads) || uploads.length < 1 || uploads.length > MAX_ATTACHMENTS) {
    throw new ChatAttachmentError("Provide 1 to 4 attachments");
  }
  const prepared = uploads.map((upload) => {
    const name = normalizedName(upload.originalname);
    if (!Buffer.isBuffer(upload.buffer)) throw new ChatAttachmentError("Invalid attachment data");
    return { name, bytes: upload.buffer, ...classify(name, upload.mimetype || "", upload.buffer) };
  });
  if (prepared.reduce((sum, item) => sum + item.bytes.length, 0) > MAX_TOTAL_BYTES) {
    throw new ChatAttachmentError("Attachments exceed 12 MiB in total", 413);
  }
  const directory = attachmentDirectory(workspaceDir, true);
  cleanupUnusedChatAttachments(workspaceDir);
  scheduleUnusedAttachmentCleanup(workspaceDir);
  assertWorkspaceQuota(directory, workspaceDir, prepared.reduce((sum, item) => sum + item.bytes.length, 0), prepared.length);
  const created: string[] = [];
  try {
    return prepared.map((item) => {
      const id = `att-${crypto.randomUUID()}`;
      const metadata: StoredChatAttachment = {
        schemaVersion: 1,
        id,
        name: item.name,
        mimeType: item.mimeType,
        size: item.bytes.length,
        kind: item.kind,
        sha256: crypto.createHash("sha256").update(item.bytes).digest("hex"),
        createdAt: Date.now(),
      };
      const binaryPath = attachmentPath(directory, id, ".bin");
      fs.writeFileSync(binaryPath, item.bytes, { flag: "wx", mode: 0o600 });
      created.push(binaryPath);
      const metadataPath = attachmentPath(directory, id, ".json");
      fs.writeFileSync(metadataPath, JSON.stringify(metadata), { flag: "wx", mode: 0o600 });
      created.push(metadataPath);
      const { schemaVersion: _version, sha256: _sha256, createdAt: _createdAt, ...attachment } = metadata;
      return attachment;
    });
  } catch (error) {
    for (const file of created) fs.rmSync(file, { force: true });
    throw error;
  }
}

export function readChatAttachment(workspaceDir: string, id: string): { attachment: ChatAttachmentRef; bytes: Buffer } {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new ChatAttachmentError("Invalid attachment id");
  let directory: string;
  try { directory = attachmentDirectory(workspaceDir, false); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ChatAttachmentError("Attachment not found", 404);
    throw error;
  }
  scheduleUnusedAttachmentCleanup(workspaceDir);
  const metadata = readStoredMetadata(workspaceDir, directory, id);
  const bytes = readPrivateFile(workspaceDir, directory, attachmentPath(directory, id, ".bin"), MAX_ATTACHMENT_BYTES);
  if (bytes.length !== metadata.size || crypto.createHash("sha256").update(bytes).digest("hex") !== metadata.sha256) {
    throw new ChatAttachmentError("Attachment integrity check failed");
  }
  const classification = classify(metadata.name, metadata.mimeType, bytes);
  if (classification.kind !== metadata.kind || classification.mimeType !== metadata.mimeType) {
    throw new ChatAttachmentError("Attachment integrity check failed");
  }
  const { schemaVersion: _version, sha256: _sha256, createdAt: _createdAt, ...attachment } = metadata;
  return { attachment, bytes };
}

export function resolveChatAttachments(workspaceDir: string, ids: string[]): ChatAttachmentRef[] {
  if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS || ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) {
    throw new ChatAttachmentError("Invalid attachment list");
  }
  const attachments = ids.map((id) => readChatAttachment(workspaceDir, id).attachment);
  if (attachments.reduce((sum, item) => sum + item.size, 0) > MAX_TOTAL_BYTES) {
    throw new ChatAttachmentError("Attachments exceed 12 MiB in total", 413);
  }
  return attachments;
}
