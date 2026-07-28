import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { processModelTurn } from "./modelProcessor.js";
import { OpenAIMessage } from "./types.js";

export type ContextStatus = "ready" | "compacting" | "warning";

export interface ContextState {
  estimatedTokens: number;
  estimatedTokensAfter?: number;
  threshold: number;
  status: ContextStatus;
  compactionCount: number;
  lastCompactedAt?: number;
  transcriptPath?: string;
  preview?: ContextCompactionPreview;
  message?: string;
}

export interface ContextCompactionPreview {
  strategy: "summary";
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  transcriptPath: string;
  protectedMessageCount: number;
  compactedMessageCount: number;
  preservedMessageCount: number;
}

export interface ContextCompactionResult {
  messages: OpenAIMessage[];
  transcriptPath: string;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  preview: ContextCompactionPreview;
}

const TRANSCRIPT_LIMIT = 80_000;
const DEFAULT_RECENT_USER_TURNS = 2;
const DEFAULT_TAIL_MESSAGE_LIMIT = 16;

function truncateForSummary(value: string): string {
  if (value.length <= TRANSCRIPT_LIMIT) return value;
  const marker = "\n...[middle of context omitted for summary]...\n";
  const available = TRANSCRIPT_LIMIT - marker.length;
  const headLength = Math.floor(available / 2);
  return `${value.slice(0, headLength)}${marker}${value.slice(-available + headLength)}`;
}

/** A deliberately conservative heuristic that works without a tokenizer. */
export function estimateMessageTokens(messages: OpenAIMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

/** Keep recent tool output useful while removing stale, high-volume payloads. */
export function microcompactMessages(
  messages: OpenAIMessage[],
  keepRecentToolResults = 3
): OpenAIMessage[] {
  const toolIndexes = messages.reduce<number[]>((indexes, message, index) => {
    if (message.role === "tool") indexes.push(index);
    return indexes;
  }, []);

  if (toolIndexes.length <= keepRecentToolResults) {
    return messages.map((message) => ({ ...message }));
  }

  const clearedIndexes = new Set(toolIndexes.slice(0, -keepRecentToolResults));
  return messages.map((message, index) =>
    clearedIndexes.has(index) && !isImportantToolOutput(message)
      ? { ...message, content: "[cleared]" }
      : { ...message }
  );
}

/** Last-resort loss reduction if the summarization request itself fails. */
export function safeTrimMessages(messages: OpenAIMessage[], keepRecent = 8): OpenAIMessage[] {
  const firstUser = messages.find((message) => message.role === "user");
  const recentSource = messages.filter(
    (message) => message.role === "user" || message.role === "assistant"
  );
  const recent = recentSource
    .slice(-keepRecent)
    .map((message) => ({
      ...message,
      tool_calls: undefined,
      tool_call_id: undefined,
    }));
  const firstUserInRecent = firstUser ? recentSource.slice(-keepRecent).some((message) => message === firstUser) : false;
  const combined = firstUser && !firstUserInRecent
    ? [firstUser, ...recent]
    : recent;
  return combined.map((message) => ({
    ...message,
    tool_calls: undefined,
    tool_call_id: undefined,
  }));
}

function isImportantToolOutput(message: OpenAIMessage): boolean {
  return /\b(error|failed|exception|warning|conflict|not found)\b/i.test(message.content || "");
}

function transcriptName(): string {
  return `transcript_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jsonl`;
}

async function persistTranscript(
  workspaceDir: string,
  messages: OpenAIMessage[]
): Promise<string> {
  const relativePath = path.join(".transcripts", transcriptName());
  const fullPath = path.join(workspaceDir, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(
    fullPath,
    messages.map((message) => JSON.stringify(message)).join("\n") + "\n",
    "utf-8"
  );
  return relativePath;
}

export function splitCompactionMessages(
  messages: OpenAIMessage[],
  recentUserTurns = DEFAULT_RECENT_USER_TURNS,
  tailMessageLimit = DEFAULT_TAIL_MESSAGE_LIMIT
): { head: OpenAIMessage[]; tail: OpenAIMessage[] } {
  const userIndexes = messages
    .map((message, index) => message.role === "user" ? index : -1)
    .filter((index) => index >= 0);
  if (userIndexes.length < 2) return { head: [...messages], tail: [] };

  const desiredIndex = userIndexes[Math.max(0, userIndexes.length - recentUserTurns)];
  const lastUserIndex = userIndexes[userIndexes.length - 1];
  const boundedDesiredIndex = desiredIndex > 0 ? desiredIndex : lastUserIndex;
  const splitIndex = messages.length - boundedDesiredIndex <= tailMessageLimit
    ? boundedDesiredIndex
    : lastUserIndex;
  if (splitIndex <= 0) return { head: [...messages], tail: [] };
  return {
    head: messages.slice(0, splitIndex).map((message) => ({ ...message })),
    tail: messages.slice(splitIndex).map((message) => ({ ...message })),
  };
}

export async function compactMessages(options: {
  workspaceDir: string;
  messages: OpenAIMessage[];
  apiUrl: string;
  apiKey?: string;
  model: string;
  signal?: AbortSignal;
}): Promise<ContextCompactionResult> {
  const estimatedTokensBefore = estimateMessageTokens(options.messages);
  const transcriptPath = await persistTranscript(options.workspaceDir, options.messages);
  const { head, tail } = splitCompactionMessages(options.messages);
  const serialized = truncateForSummary(JSON.stringify(head));
  const prompt = [
    "Summarize the following coding-agent conversation context for continuation.",
    "Use these headings: Objective; Constraints; Facts and decisions; Files and changes; Tests and validation; Permissions and safety; Failures; Current state; Remaining work; Evidence, inference, and unknowns.",
    "Preserve goals, decisions, constraints, files changed, important tool results, errors, unfinished work, and the distinction between observed evidence and inference.",
    "Be concise and factual. Do not invent progress or claim unfinished work is complete.",
    tail.length > 0
      ? `Do not summarize the recent ${tail.length}-message tail; it will be appended verbatim after this summary.`
      : "No safe recent user-turn boundary was available, so summarize the full context.",
    `The full transcript is preserved at ${transcriptPath} if details are needed later.`,
    "\nOlder context to summarize:",
    serialized,
  ].join("\n");

  const processed = await processModelTurn({
    apiUrl: options.apiUrl,
    apiKey: options.apiKey,
    model: options.model,
    messages: [{ role: "user", content: prompt }],
    fallbackMaxOutputTokens: 2000,
    maxOutputTokens: 2000,
    temperature: 0.1,
    signal: options.signal,
  });
  const summary = processed.response.choices?.[0]?.message?.content?.trim();
  if (!summary) {
    throw new Error("Context summary response was empty");
  }

  const messages: OpenAIMessage[] = [
    {
      role: "user",
      content: `[Compressed context; full transcript: ${transcriptPath}]\n${summary}`,
    },
    {
      role: "assistant",
      content: "Understood. Continuing with the compressed context.",
    },
    ...tail,
  ];

  const preview: ContextCompactionPreview = {
    strategy: "summary",
    estimatedTokensBefore,
    estimatedTokensAfter: estimateMessageTokens(messages),
    transcriptPath,
    protectedMessageCount: options.messages.filter(isProtectedMessage).length,
    compactedMessageCount: head.length,
    preservedMessageCount: messages.length,
  };

  return {
    messages,
    transcriptPath,
    estimatedTokensBefore,
    estimatedTokensAfter: preview.estimatedTokensAfter,
    preview,
  };
}

function isProtectedMessage(message: OpenAIMessage): boolean {
  if (message.role === "user") return true;
  if (message.role === "assistant" && (Boolean(message.content) || Boolean(message.tool_calls?.length))) {
    return true;
  }
  return message.role === "tool" && isImportantToolOutput(message);
}
