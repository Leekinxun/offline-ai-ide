import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { ToolFileUpdate } from "../agent/types.js";
import type { AgentMode } from "../agent/types.js";
import type { ReviewFinding } from "./reviewFindings.js";

const HISTORY_DIR_NAME = ".history";
const CONVERSATION_FILE_EXTENSION = ".jsonl";
const MAX_STORED_CONVERSATIONS = 30;
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const conversationMutationQueues = new Map<string, Promise<void>>();

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

  return {
    changedFiles,
    toolCallCount: count(candidate.toolCallCount),
    errorCount: count(candidate.errorCount),
    commandCount: count(candidate.commandCount),
    ...(reviewFindings.length > 0 || Array.isArray(candidate.reviewFindings) ? { reviewFindings } : {}),
  };
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

  return withStructuredParts({
    role: candidate.role,
    content: candidate.content,
    timestamp,
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
    messages: messages.map((message) => withStructuredParts({ ...message })),
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

  for (const entry of files.slice(MAX_STORED_CONVERSATIONS)) {
    fs.rmSync(entry.fullPath, { force: true });
  }
}
