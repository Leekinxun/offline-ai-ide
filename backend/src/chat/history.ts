import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { ToolFileUpdate } from "../agent/types.js";
import type { AgentMode } from "../agent/types.js";
import type { ReviewFinding } from "./reviewFindings.js";
import type { CompletionEvidence } from "./completionEvidence.js";
import { deleteUnreferencedChatAttachments, isChatAttachmentRef, type ChatAttachmentRef } from "./attachments.js";

export type ExecutionContractKind = "direct_code" | "approved_plan";

const HISTORY_DIR_NAME = ".history";
const CONVERSATION_FILE_EXTENSION = ".jsonl";
const REQUEST_INDEX_FILE = "chat-request-index.json";
const REQUEST_INDEX_VERSION = 1;
const MAX_STORED_CONVERSATIONS = 30;
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const CHAT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const conversationMutationQueues = new Map<string, Promise<void>>();
const pendingChatRequests = new Map<string, { completion: Promise<string | null>; resolve: (conversationId: string | null) => void }>();
interface RequestIndexConversation {
  signature: string;
  requestIds: string[];
}
interface RequestIndex {
  schemaVersion: 1;
  conversations: Record<string, RequestIndexConversation>;
}
interface CachedRequestIndex {
  index: RequestIndex;
  lookup: Map<string, string>;
  directoryStamp: string;
}
const requestIndexCache = new Map<string, CachedRequestIndex>();

export interface PersistedToolCallStep {
  toolCallId: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  fileUpdate?: ToolFileUpdate;
}

export type PersistedMessagePart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool";
      toolCallId: string;
      name: string;
      input: Record<string, unknown>;
      status: "completed" | "failed";
      result?: string;
      isError?: boolean;
      fileUpdate?: ToolFileUpdate;
    };

export interface PersistedChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  requestId?: string;
  attachments?: ChatAttachmentRef[];
  toolCalls?: PersistedToolCallStep[];
  thinking?: string;
  parts?: PersistedMessagePart[];
}

interface ConversationMetaRecord {
  type: "meta";
  createdAt: number;
  updatedAt: number;
  title?: string;
  mode?: AgentMode;
  status?: ConversationStatus;
  summary?: ConversationRunSummary;
  lastRunId?: string;
}

export type ConversationStatus = "queued" | "running" | "completed" | "stopped" | "failed";

export interface ConversationRunSummary {
  changedFiles: string[];
  toolCallCount: number;
  errorCount: number;
  commandCount: number;
  reviewFindings?: ReviewFinding[];
  executionContractKind?: ExecutionContractKind;
  completionEvidence?: CompletionEvidence;
  qualityGate?: import("../extensions/policy/completionGate.js").CompletionGateEvidence;
}

export function normalizeConversationRunSummary(raw: unknown): ConversationRunSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<ConversationRunSummary>;
  const count = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const changedFiles = Array.isArray(candidate.changedFiles)
    ? candidate.changedFiles
        .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
        .map((value) => value.trim().slice(0, 1000))
        .slice(0, 500)
    : [];
  const severities = new Set(["critical", "error", "warning", "info"]);
  const reviewFindings = Array.isArray(candidate.reviewFindings)
    ? candidate.reviewFindings.flatMap((value, index) => {
        if (!value || typeof value !== "object") return [];
        const finding = value as Partial<ReviewFinding>;
        if (
          !severities.has(String(finding.severity)) ||
          typeof finding.path !== "string" ||
          !finding.path.trim() ||
          typeof finding.message !== "string" ||
          !finding.message.trim() ||
          typeof finding.line !== "number" ||
          !Number.isSafeInteger(finding.line) ||
          finding.line < 1
        ) return [];
        return [{
          id: typeof finding.id === "string" && finding.id ? finding.id.slice(0, 120) : `review-${index + 1}`,
          severity: finding.severity as ReviewFinding["severity"],
          path: finding.path.trim().slice(0, 1000),
          line: finding.line,
          ...(typeof finding.column === "number" && Number.isSafeInteger(finding.column) && finding.column > 0
            ? { column: finding.column }
            : {}),
          message: finding.message.trim().slice(0, 2000),
        }];
      }).slice(0, 100)
    : [];
  const completionEvidence = normalizeCompletionEvidence(candidate.completionEvidence);
  const qualityGate = candidate.qualityGate && typeof candidate.qualityGate === "object" && candidate.qualityGate.schemaVersion === 1 ? candidate.qualityGate : undefined;

  return {
    changedFiles,
    toolCallCount: count(candidate.toolCallCount),
    errorCount: count(candidate.errorCount),
    commandCount: count(candidate.commandCount),
    ...(reviewFindings.length > 0 || Array.isArray(candidate.reviewFindings) ? { reviewFindings } : {}),
    executionContractKind: candidate.executionContractKind === "approved_plan"
      ? "approved_plan"
      : "direct_code",
    ...(completionEvidence ? { completionEvidence } : {}),
    ...(qualityGate ? { qualityGate } : {}),
  };
}

export function normalizeCompletionEvidence(raw: unknown): CompletionEvidence | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<CompletionEvidence>;
  if (
    value.schemaVersion !== 1 ||
    !value.ledger || typeof value.ledger !== "object" ||
    !["completed", "validation_failed", "needs_attention", "failed", "stopped"].includes(value.outcome || "")
  ) return null;
  const ledger = value.ledger;
  if (
    !Array.isArray(ledger.changedFiles) ||
    !Array.isArray(ledger.verification) ||
    !Array.isArray(ledger.criteria) ||
    !Array.isArray(ledger.blockers)
  ) return null;
  if (!ledger.changedFiles.every((entry) => typeof entry === "string")) return null;
  if (!ledger.verification.every((entry) =>
    entry && typeof entry.command === "string" &&
    ["pending", "passed", "failed", "timed_out", "cancelled"].includes(entry.status)
  )) return null;
  if (!ledger.criteria.every((entry) =>
    entry && typeof entry.criterion === "string" &&
    ["pending", "passed", "failed"].includes(entry.state) &&
    Array.isArray(entry.evidenceRefs) && entry.evidenceRefs.every((reference) => typeof reference === "string")
  )) return null;
  if (!ledger.blockers.every((entry) => ["childRun", "approval", "amendment", "conflict", "check", "changeEvidence", "quality"].includes(entry))) return null;
  return value as CompletionEvidence;
}

export interface ConversationSummary {
  id: string;
  title: string;
  preview: string;
  updatedAt: number;
  messageCount: number;
  mode: AgentMode;
  status: ConversationStatus;
  lastRunId?: string;
  summary?: ConversationRunSummary;
}

interface ParsedConversationFile {
  meta: ConversationMetaRecord;
  messages: PersistedChatMessage[];
}

function truncateText(value: string, maxLength: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "";
  }

  return collapsed.length > maxLength
    ? `${collapsed.slice(0, maxLength - 1)}...`
    : collapsed;
}

function sanitizeConversationTitle(value: string): string {
  return truncateText(
    value
      .replace(/[`"#*_>~]+/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    48
  );
}

function normalizeToolCall(raw: unknown): PersistedToolCallStep | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as Partial<PersistedToolCallStep>;
  if (
    typeof candidate.toolCallId !== "string" ||
    typeof candidate.name !== "string" ||
    !candidate.toolCallId.trim() ||
    !candidate.name.trim()
  ) {
    return null;
  }

  return {
    toolCallId: candidate.toolCallId,
    name: candidate.name,
    input:
      candidate.input && typeof candidate.input === "object"
        ? candidate.input
        : {},
    result: typeof candidate.result === "string" ? candidate.result : undefined,
    isError: typeof candidate.isError === "boolean" ? candidate.isError : undefined,
    fileUpdate:
      candidate.fileUpdate &&
      typeof candidate.fileUpdate === "object" &&
      typeof candidate.fileUpdate.path === "string" &&
      typeof candidate.fileUpdate.content === "string"
        ? candidate.fileUpdate
        : undefined,
  };
}

function normalizeMessagePart(raw: unknown): PersistedMessagePart | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<PersistedMessagePart>;
  if (candidate.type === "text" && typeof candidate.text === "string" && candidate.text) {
    return { type: "text", text: candidate.text };
  }
  if (
    candidate.type === "thinking" &&
    typeof candidate.text === "string" &&
    candidate.text
  ) {
    return { type: "thinking", text: candidate.text };
  }
  if (candidate.type !== "tool") return null;
  const tool = normalizeToolCall(candidate);
  if (!tool) return null;
  const failed = candidate.status === "failed" || candidate.isError === true;
  return {
    type: "tool",
    ...tool,
    status: failed ? "failed" : "completed",
  };
}

function deriveMessageParts(message: Omit<PersistedChatMessage, "parts">): PersistedMessagePart[] {
  const parts: PersistedMessagePart[] = [];
  if (message.thinking) parts.push({ type: "thinking", text: message.thinking });
  if (message.content) parts.push({ type: "text", text: message.content });
  for (const tool of message.toolCalls || []) {
    parts.push({
      type: "tool",
      ...tool,
      status: tool.isError ? "failed" : "completed",
    });
  }
  return parts;
}

export function withStructuredParts(message: PersistedChatMessage): PersistedChatMessage {
  const normalizedParts = Array.isArray(message.parts)
    ? message.parts
        .map(normalizeMessagePart)
        .filter((part): part is PersistedMessagePart => part !== null)
    : [];
  return {
    ...message,
    parts: normalizedParts.length > 0
      ? normalizedParts
      : deriveMessageParts(message),
  };
}

function normalizePersistedMessage(raw: unknown): PersistedChatMessage | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as Partial<PersistedChatMessage>;
  if (
    (candidate.role !== "user" && candidate.role !== "assistant") ||
    typeof candidate.content !== "string"
  ) {
    return null;
  }

  const timestamp =
    typeof candidate.timestamp === "number" && Number.isFinite(candidate.timestamp)
      ? candidate.timestamp
      : Date.now();

  const toolCalls = Array.isArray(candidate.toolCalls)
    ? candidate.toolCalls
        .map((entry) => normalizeToolCall(entry))
        .filter((entry): entry is PersistedToolCallStep => entry !== null)
    : undefined;
  const attachments = candidate.role === "user" && Array.isArray(candidate.attachments)
    && candidate.attachments.length > 0 && candidate.attachments.length <= 4
    && candidate.attachments.every(isChatAttachmentRef)
    && new Set(candidate.attachments.map((entry) => entry.id)).size === candidate.attachments.length
    && candidate.attachments.reduce((sum, entry) => sum + entry.size, 0) <= 12 * 1024 * 1024
      ? candidate.attachments.map((entry) => ({
          id: entry.id,
          name: entry.name,
          mimeType: entry.mimeType,
          size: entry.size,
          kind: entry.kind,
        }))
      : undefined;

  return withStructuredParts({
    role: candidate.role,
    content: candidate.content,
    timestamp,
    ...(typeof candidate.requestId === "string" && isValidChatRequestId(candidate.requestId)
      ? { requestId: candidate.requestId }
      : {}),
    ...(attachments ? { attachments } : {}),
    ...(typeof candidate.thinking === "string" && candidate.thinking
      ? { thinking: candidate.thinking }
      : {}),
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    ...(Array.isArray(candidate.parts) ? { parts: candidate.parts } : {}),
  });
}

function normalizeConversationMeta(raw: unknown): ConversationMetaRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as Partial<ConversationMetaRecord>;
  if (candidate.type !== "meta") {
    return null;
  }
  const summary = normalizeConversationRunSummary(candidate.summary);

  return {
    type: "meta",
    createdAt:
      typeof candidate.createdAt === "number" && Number.isFinite(candidate.createdAt)
        ? candidate.createdAt
        : Date.now(),
    updatedAt:
      typeof candidate.updatedAt === "number" && Number.isFinite(candidate.updatedAt)
        ? candidate.updatedAt
        : Date.now(),
    ...(typeof candidate.title === "string" && sanitizeConversationTitle(candidate.title)
      ? { title: sanitizeConversationTitle(candidate.title) }
      : {}),
    ...(candidate.mode === "ask" || candidate.mode === "code" || candidate.mode === "review" || candidate.mode === "plan"
      ? { mode: candidate.mode }
      : {}),
    ...(candidate.status === "queued" || candidate.status === "running" || candidate.status === "completed" || candidate.status === "stopped" || candidate.status === "failed"
      ? { status: candidate.status }
      : {}),
    ...(summary ? { summary } : {}),
    ...(typeof candidate.lastRunId === "string" && candidate.lastRunId
      ? { lastRunId: candidate.lastRunId }
      : {}),
  };
}

function buildDefaultConversationMeta(): ConversationMetaRecord {
  const now = Date.now();
  return {
    type: "meta",
    createdAt: now,
    updatedAt: now,
  };
}

function parseConversationFile(raw: string): ParsedConversationFile {
  let meta: ConversationMetaRecord | null = null;
  const messages: PersistedChatMessage[] = [];

  for (const line of raw.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line);
      const normalizedMeta = normalizeConversationMeta(parsed);
      if (normalizedMeta) {
        meta = normalizedMeta;
        continue;
      }

      const normalizedMessage = normalizePersistedMessage(parsed);
      if (normalizedMessage) {
        messages.push(normalizedMessage);
      }
    } catch {
      continue;
    }
  }

  return {
    meta: meta || buildDefaultConversationMeta(),
    messages,
  };
}

function readConversationFile(
  workspaceDir: string,
  conversationId: string
): ParsedConversationFile {
  const conversationPath = getConversationPath(workspaceDir, conversationId);
  if (!fs.existsSync(conversationPath)) {
    return {
      meta: buildDefaultConversationMeta(),
      messages: [],
    };
  }

  return parseConversationFile(fs.readFileSync(conversationPath, "utf-8"));
}

function writeConversationFile(
  workspaceDir: string,
  conversationId: string,
  parsed: ParsedConversationFile
): void {
  const conversationPath = getConversationPath(workspaceDir, conversationId);
  const requestIndex = getRequestIndex(workspaceDir);
  const lines = [
    JSON.stringify(parsed.meta),
    ...parsed.messages.map((message) => JSON.stringify(message)),
  ];
  const tempPath = `${conversationPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${lines.join("\n")}\n`, "utf-8");
    fs.renameSync(tempPath, conversationPath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
  requestIndex.index.conversations = Object.fromEntries([
    ...Object.entries(requestIndex.index.conversations).filter(([id]) => id !== conversationId),
    [conversationId, {
      signature: conversationSignature(conversationPath),
      requestIds: requestIdsInMessages(parsed.messages),
    }],
  ]);
  try { persistRequestIndex(workspaceDir, requestIndex); }
  catch { requestIndexCache.delete(path.resolve(workspaceDir)); }
}

export function getHistoryDir(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), HISTORY_DIR_NAME);
}

export function ensureHistoryDir(workspaceDir: string): string {
  const historyDir = getHistoryDir(workspaceDir);
  fs.mkdirSync(historyDir, { recursive: true });
  return historyDir;
}

export function isValidConversationId(value: string): boolean {
  return CONVERSATION_ID_PATTERN.test(value);
}

export function isValidChatRequestId(value: unknown): value is string {
  return typeof value === "string" && CHAT_REQUEST_ID_PATTERN.test(value);
}

function chatRequestKey(workspaceDir: string, requestId: string): string {
  if (!isValidChatRequestId(requestId)) throw new Error("Invalid chat request id");
  return `${path.resolve(workspaceDir)}\u0000${requestId}`;
}

function conversationSignature(file: string): string {
  const stat = fs.statSync(file, { bigint: true });
  if (!stat.isFile()) throw new Error("Conversation history is not a regular file");
  return `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function directoryStamp(historyDir: string): string {
  return fs.statSync(historyDir, { bigint: true }).mtimeNs.toString();
}

function conversationFiles(historyDir: string): Map<string, { file: string; signature: string }> {
  const files = new Map<string, { file: string; signature: string }>();
  for (const entry of fs.readdirSync(historyDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(CONVERSATION_FILE_EXTENSION)) continue;
    const id = entry.name.slice(0, -CONVERSATION_FILE_EXTENSION.length);
    if (!isValidConversationId(id)) continue;
    const file = path.join(historyDir, entry.name);
    files.set(id, { file, signature: conversationSignature(file) });
  }
  return files;
}

function requestIdsInConversation(file: string): string[] {
  const ids = new Set<string>();
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.includes('"requestId"')) continue;
    try {
      const message = JSON.parse(line) as Partial<PersistedChatMessage>;
      if (message.role === "user" && typeof message.content === "string" && isValidChatRequestId(message.requestId)) {
        ids.add(message.requestId);
      }
    } catch { /* A malformed line does not invalidate other saved messages. */ }
  }
  return [...ids];
}

function requestIdsInMessages(messages: PersistedChatMessage[]): string[] {
  return [...new Set(messages.flatMap((message) =>
    message.role === "user" && isValidChatRequestId(message.requestId) ? [message.requestId] : []))];
}

function validRequestIndex(raw: unknown): raw is RequestIndex {
  if (!raw || typeof raw !== "object") return false;
  const index = raw as Partial<RequestIndex>;
  if (index.schemaVersion !== REQUEST_INDEX_VERSION || !index.conversations || typeof index.conversations !== "object"
    || Array.isArray(index.conversations)) return false;
  return Object.entries(index.conversations).every(([id, entry]) =>
    isValidConversationId(id) && entry && typeof entry === "object"
    && typeof entry.signature === "string" && /^\d+:\d+:\d+$/.test(entry.signature)
    && Array.isArray(entry.requestIds) && entry.requestIds.every(isValidChatRequestId));
}

function indexMatchesFiles(index: RequestIndex, files: Map<string, { file: string; signature: string }>): boolean {
  const entries = Object.entries(index.conversations);
  return entries.length === files.size && entries.every(([id, entry]) => files.get(id)?.signature === entry.signature);
}

function buildRequestLookup(index: RequestIndex): Map<string, string> {
  const lookup = new Map<string, string>();
  const entries = Object.entries(index.conversations).sort((left, right) => {
    const leftTime = BigInt(left[1].signature.split(":")[1]);
    const rightTime = BigInt(right[1].signature.split(":")[1]);
    return leftTime === rightTime ? left[0].localeCompare(right[0]) : leftTime > rightTime ? -1 : 1;
  });
  for (const [conversationId, entry] of entries) {
    for (const requestId of entry.requestIds) if (!lookup.has(requestId)) lookup.set(requestId, conversationId);
  }
  return lookup;
}

function readRequestIndex(historyDir: string): RequestIndex | null {
  const file = path.join(historyDir, REQUEST_INDEX_FILE);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10 * 1024 * 1024 || stat.size < 1) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return validRequestIndex(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function persistRequestIndex(workspaceDir: string, cache: CachedRequestIndex): void {
  const historyDir = ensureHistoryDir(workspaceDir);
  const target = path.join(historyDir, REQUEST_INDEX_FILE);
  const temporary = path.join(historyDir, `${REQUEST_INDEX_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(cache.index), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  cache.lookup = buildRequestLookup(cache.index);
  cache.directoryStamp = directoryStamp(historyDir);
  requestIndexCache.set(path.resolve(workspaceDir), cache);
}

function getRequestIndex(workspaceDir: string): CachedRequestIndex {
  const workspace = path.resolve(workspaceDir);
  const historyDir = ensureHistoryDir(workspace);
  const stamp = directoryStamp(historyDir);
  const cached = requestIndexCache.get(workspace);
  if (cached?.directoryStamp === stamp) return cached;
  const files = conversationFiles(historyDir);
  if (cached && indexMatchesFiles(cached.index, files)) {
    cached.directoryStamp = stamp;
    return cached;
  }
  const persisted = readRequestIndex(historyDir);
  const index: RequestIndex = persisted && indexMatchesFiles(persisted, files)
    ? persisted
    : {
        schemaVersion: 1,
        conversations: Object.fromEntries([...files].map(([id, entry]) => [id, {
          signature: entry.signature,
          requestIds: requestIdsInConversation(entry.file),
        }])),
      };
  const result: CachedRequestIndex = { index, lookup: buildRequestLookup(index), directoryStamp: stamp };
  requestIndexCache.set(workspace, result);
  if (index !== persisted) {
    try { persistRequestIndex(workspace, result); }
    catch { requestIndexCache.delete(workspace); }
  }
  return result;
}

function acceptedConversationForRequest(workspaceDir: string, requestId: string): string | null {
  return getRequestIndex(workspaceDir).lookup.get(requestId) || null;
}

export type ChatRequestStatus =
  | { status: "accepted"; conversationId: string }
  | { status: "processing" }
  | { status: "unknown" };

export type BeginChatRequestResult =
  | { kind: "new" }
  | { kind: "processing"; completion: Promise<string | null> }
  | { kind: "accepted"; conversationId: string };

export function getChatRequestStatus(workspaceDir: string, requestId: string): ChatRequestStatus {
  const key = chatRequestKey(workspaceDir, requestId);
  if (pendingChatRequests.has(key)) return { status: "processing" };
  const conversationId = acceptedConversationForRequest(workspaceDir, requestId);
  return conversationId ? { status: "accepted", conversationId } : { status: "unknown" };
}

/** Reserve one request ID until its user message has been durably appended. */
export function beginChatRequest(workspaceDir: string, requestId: string): BeginChatRequestResult {
  const key = chatRequestKey(workspaceDir, requestId);
  const pending = pendingChatRequests.get(key);
  if (pending) return { kind: "processing", completion: pending.completion };
  const conversationId = acceptedConversationForRequest(workspaceDir, requestId);
  if (conversationId) return { kind: "accepted", conversationId };
  let resolve!: (conversationId: string | null) => void;
  const completion = new Promise<string | null>((settle) => { resolve = settle; });
  pendingChatRequests.set(key, { completion, resolve });
  return { kind: "new" };
}

export function completeChatRequest(workspaceDir: string, requestId: string, conversationId: string): void {
  const key = chatRequestKey(workspaceDir, requestId);
  if (!isValidConversationId(conversationId)) throw new Error("Invalid conversation id");
  const pending = pendingChatRequests.get(key);
  pendingChatRequests.delete(key);
  pending?.resolve(conversationId);
}

export function failChatRequest(workspaceDir: string, requestId: string): void {
  const key = chatRequestKey(workspaceDir, requestId);
  const pending = pendingChatRequests.get(key);
  pendingChatRequests.delete(key);
  pending?.resolve(null);
}

export function createConversationId(): string {
  return `${Date.now()}-${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

function getConversationPath(workspaceDir: string, conversationId: string): string {
  const normalizedId = conversationId.trim();
  if (!isValidConversationId(normalizedId)) {
    throw new Error("Invalid conversation id");
  }

  return path.join(
    ensureHistoryDir(workspaceDir),
    `${normalizedId}${CONVERSATION_FILE_EXTENSION}`
  );
}

function queueConversationMutation(
  workspaceDir: string,
  conversationId: string,
  mutation: () => void
): Promise<void> {
  const conversationPath = getConversationPath(workspaceDir, conversationId);
  const previous = conversationMutationQueues.get(conversationPath) || Promise.resolve();
  const next = previous.catch(() => undefined).then(() => {
    mutation();
  });
  const wrapped = next.finally(() => {
    if (conversationMutationQueues.get(conversationPath) === wrapped) {
      conversationMutationQueues.delete(conversationPath);
    }
  });
  conversationMutationQueues.set(conversationPath, wrapped);
  return wrapped;
}

export function conversationExists(
  workspaceDir: string,
  conversationId: string
): boolean {
  try {
    return fs.existsSync(getConversationPath(workspaceDir, conversationId));
  } catch {
    return false;
  }
}

export function appendConversationMessage(
  workspaceDir: string,
  conversationId: string,
  message: PersistedChatMessage
): Promise<void> {
  const normalized = normalizePersistedMessage(message);
  if (!normalized) {
    throw new Error("Invalid conversation message");
  }

  return queueConversationMutation(workspaceDir, conversationId, () => {
    const parsed = readConversationFile(workspaceDir, conversationId);
    parsed.meta.updatedAt = normalized.timestamp;
    parsed.messages.push(normalized);
    writeConversationFile(workspaceDir, conversationId, parsed);

    pruneConversationHistory(workspaceDir);
  });
}

export function updateConversationTitle(
  workspaceDir: string,
  conversationId: string,
  title: string
): Promise<void> {
  const normalizedTitle = sanitizeConversationTitle(title);
  if (!normalizedTitle) {
    return Promise.resolve();
  }

  return queueConversationMutation(workspaceDir, conversationId, () => {
    const parsed = readConversationFile(workspaceDir, conversationId);
    parsed.meta = {
      ...parsed.meta,
      title: normalizedTitle,
      updatedAt: Date.now(),
    };
    writeConversationFile(workspaceDir, conversationId, parsed);
    pruneConversationHistory(workspaceDir);
  });
}

export function updateConversationState(
  workspaceDir: string,
  conversationId: string,
  state: {
    mode?: AgentMode;
    status?: ConversationStatus;
    summary?: ConversationRunSummary;
    lastRunId?: string;
  }
): Promise<void> {
  return queueConversationMutation(workspaceDir, conversationId, () => {
    const parsed = readConversationFile(workspaceDir, conversationId);
    parsed.meta = {
      ...parsed.meta,
      ...(state.mode ? { mode: state.mode } : {}),
      ...(state.status ? { status: state.status } : {}),
      ...(state.summary ? { summary: state.summary } : {}),
      ...(state.lastRunId ? { lastRunId: state.lastRunId } : {}),
      updatedAt: Date.now(),
    };
    writeConversationFile(workspaceDir, conversationId, parsed);
  });
}

export function readConversationMessages(
  workspaceDir: string,
  conversationId: string
): PersistedChatMessage[] {
  const conversationPath = getConversationPath(workspaceDir, conversationId);
  if (!fs.existsSync(conversationPath)) {
    throw new Error("Conversation not found");
  }

  return readConversationFile(workspaceDir, conversationId).messages;
}

export function deleteConversation(
  workspaceDir: string,
  conversationId: string
): Promise<void> {
  return queueConversationMutation(workspaceDir, conversationId, () => {
    const conversationPath = getConversationPath(workspaceDir, conversationId);
    if (!fs.existsSync(conversationPath)) {
      throw new Error("Conversation not found");
    }
    const requestIndex = getRequestIndex(workspaceDir);
    const attachmentIds = readConversationFile(workspaceDir, conversationId).messages
      .flatMap((message) => message.attachments?.map((attachment) => attachment.id) || []);
    fs.rmSync(conversationPath);
    requestIndex.index.conversations = Object.fromEntries(
      Object.entries(requestIndex.index.conversations).filter(([id]) => id !== conversationId)
    );
    try { persistRequestIndex(workspaceDir, requestIndex); }
    catch { requestIndexCache.delete(path.resolve(workspaceDir)); }
    deleteUnreferencedChatAttachments(workspaceDir, attachmentIds);
  });
}

export function forkConversation(
  workspaceDir: string,
  conversationId: string,
  input: { upToTimestamp?: number; title?: string } = {}
): ConversationSummary {
  const sourcePath = getConversationPath(workspaceDir, conversationId);
  if (!fs.existsSync(sourcePath)) throw new Error("Conversation not found");
  const source = readConversationFile(workspaceDir, conversationId);
  const messages = typeof input.upToTimestamp === "number" && Number.isFinite(input.upToTimestamp)
    ? source.messages.filter((message) => message.timestamp <= input.upToTimestamp!)
    : source.messages;
  const id = createConversationId();
  const now = Date.now();
  const requestedTitle = typeof input.title === "string" ? sanitizeConversationTitle(input.title) : "";
  const sourceTitle = source.meta.title || messages.find((message) => message.role === "user")?.content || conversationId;
  writeConversationFile(workspaceDir, id, {
    meta: {
      type: "meta",
      createdAt: now,
      updatedAt: now,
      title: requestedTitle || sanitizeConversationTitle(`Fork · ${sourceTitle}`),
      mode: source.meta.mode || "code",
      status: "completed",
    },
    // A fork copies conversation context, but the transport request was
    // accepted into the source conversation and must keep that ownership.
    messages: messages.map(({ requestId: _requestId, ...message }) => withStructuredParts(message)),
  });
  pruneConversationHistory(workspaceDir);
  const summary = listConversationSummaries(workspaceDir).find((entry) => entry.id === id);
  if (!summary) throw new Error("Failed to create conversation fork");
  return summary;
}

export function listConversationSummaries(
  workspaceDir: string
): ConversationSummary[] {
  const historyDir = ensureHistoryDir(workspaceDir);
  const entries = fs
    .readdirSync(historyDir)
    .filter((name) => name.endsWith(CONVERSATION_FILE_EXTENSION))
    .map((name) => {
      const fullPath = path.join(historyDir, name);
      const stats = fs.statSync(fullPath);
      const parsed = parseConversationFile(fs.readFileSync(fullPath, "utf-8"));
      const messages = parsed.messages;
      const firstUserMessage = messages.find((message) => message.role === "user");
      const lastMessage = [...messages].reverse().find((message) => message.content.trim());
      const id = name.slice(0, -CONVERSATION_FILE_EXTENSION.length);

      return {
        id,
        title:
          parsed.meta.title ||
          truncateText(firstUserMessage?.content || id, 48),
        preview: truncateText(lastMessage?.content || "", 80),
        updatedAt: parsed.meta.updatedAt || stats.mtimeMs,
        messageCount: messages.length,
        mode: parsed.meta.mode || "code",
        status: parsed.meta.status || "completed",
        ...(parsed.meta.lastRunId ? { lastRunId: parsed.meta.lastRunId } : {}),
        ...(parsed.meta.summary ? { summary: parsed.meta.summary } : {}),
      };
    });

  return entries.sort((left, right) => right.updatedAt - left.updatedAt);
}

export function pruneConversationHistory(workspaceDir: string): void {
  const historyDir = ensureHistoryDir(workspaceDir);
  const files = fs
    .readdirSync(historyDir)
    .filter((name) => name.endsWith(CONVERSATION_FILE_EXTENSION))
    .map((name) => {
      const fullPath = path.join(historyDir, name);
      return {
        fullPath,
        updatedAt: fs.statSync(fullPath).mtimeMs,
      };
    })
    .sort((left, right) => right.updatedAt - left.updatedAt);

  const expired = files.slice(MAX_STORED_CONVERSATIONS);
  if (expired.length === 0) return;
  const requestIndex = getRequestIndex(workspaceDir);
  const removedIds = new Set<string>();
  const removedAttachmentIds: string[] = [];
  for (const entry of expired) {
    removedIds.add(path.basename(entry.fullPath, CONVERSATION_FILE_EXTENSION));
    const conversation = parseConversationFile(fs.readFileSync(entry.fullPath, "utf8"));
    for (const message of conversation.messages) {
      for (const attachment of message.attachments || []) removedAttachmentIds.push(attachment.id);
    }
    fs.rmSync(entry.fullPath, { force: true });
  }
  requestIndex.index.conversations = Object.fromEntries(
    Object.entries(requestIndex.index.conversations).filter(([id]) => !removedIds.has(id))
  );
  try { persistRequestIndex(workspaceDir, requestIndex); }
  catch { requestIndexCache.delete(path.resolve(workspaceDir)); }
  deleteUnreferencedChatAttachments(workspaceDir, removedAttachmentIds);
}
