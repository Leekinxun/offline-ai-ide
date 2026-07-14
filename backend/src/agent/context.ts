import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { callChatCompletion } from "./llm.js";
import { OpenAIMessage } from "./types.js";

export type ContextStatus = "ready" | "compacting" | "warning";

export interface ContextState {
  estimatedTokens: number;
  threshold: number;
  status: ContextStatus;
  compactionCount: number;
  lastCompactedAt?: number;
  transcriptPath?: string;
  message?: string;
}

export interface ContextCompactionResult {
  messages: OpenAIMessage[];
  transcriptPath: string;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
}

const TRANSCRIPT_LIMIT = 80_000;

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
    clearedIndexes.has(index)
      ? { ...message, content: "[cleared]" }
      : { ...message }
  );
}

/** Last-resort loss reduction if the summarization request itself fails. */
export function safeTrimMessages(messages: OpenAIMessage[], keepRecent = 8): OpenAIMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-keepRecent)
    .map((message) => ({
      ...message,
      tool_calls: undefined,
      tool_call_id: undefined,
    }));
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

export async function compactMessages(options: {
  workspaceDir: string;
  messages: OpenAIMessage[];
  apiUrl: string;
  apiKey?: string;
  model: string;
}): Promise<ContextCompactionResult> {
  const estimatedTokensBefore = estimateMessageTokens(options.messages);
  const transcriptPath = await persistTranscript(options.workspaceDir, options.messages);
  const serialized = truncateForSummary(JSON.stringify(options.messages));
  const prompt = [
    "Summarize the following coding-agent conversation context for continuation.",
    "Preserve the user's goals, decisions, constraints, files changed, important tool results, errors, and unfinished work.",
    "Be concise and factual. Do not invent progress or claim that unfinished work is complete.",
    `The full transcript is preserved at ${transcriptPath} if details are needed later.`,
    "\nConversation context:",
    serialized,
  ].join("\n");

  const response = await callChatCompletion({
    apiUrl: options.apiUrl,
    apiKey: options.apiKey,
    model: options.model,
    messages: [{ role: "user", content: prompt }],
    maxTokens: 2000,
    temperature: 0.1,
    stream: false,
  });

  if (!response.ok) {
    throw new Error(`Context summary request failed (${response.status})`);
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
  const summary = data.choices?.[0]?.message?.content?.trim();
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
  ];

  return {
    messages,
    transcriptPath,
    estimatedTokensBefore,
    estimatedTokensAfter: estimateMessageTokens(messages),
  };
}
