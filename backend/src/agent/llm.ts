import {
  OpenAIMessage,
  OpenAIResponse,
  OpenAIToolCall,
  OpenAIToolDef,
} from "./types.js";
import { ChatAttachmentError, isChatAttachmentRef, readChatAttachment } from "../chat/attachments.js";
import { redactSecrets } from "./secretRedaction.js";

const MAX_TEXT_PART_BYTES = 128 * 1024;
const MAX_REQUEST_ATTACHMENTS = 4;
const MAX_REQUEST_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
type ProviderContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

export interface ChatCompletionOptions {
  apiUrl: string;
  apiKey?: string;
  model: string;
  systemPrompt?: string;
  messages: OpenAIMessage[];
  /** Server-side attachment store; never sent to the model provider. */
  attachmentWorkspaceDir?: string;
  tools?: OpenAIToolDef[];
  maxTokens: number;
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stream?: boolean;
  signal?: AbortSignal;
}

function buildHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function assertAttachmentRequestLimits(messages: OpenAIMessage[]): void {
  let count = 0;
  let bytes = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part?.type !== "attachment_ref") continue;
      if (!isChatAttachmentRef(part.attachment)) throw new ChatAttachmentError("Invalid attachment reference");
      count += 1;
      bytes += part.attachment.size;
      if (count > MAX_REQUEST_ATTACHMENTS) throw new ChatAttachmentError("A model request supports at most 4 attachments", 413);
      if (bytes > MAX_REQUEST_ATTACHMENT_BYTES) throw new ChatAttachmentError("Model request attachments exceed 12 MiB", 413);
    }
  }
}

function materializeMessages(options: ChatCompletionOptions): unknown[] {
  assertAttachmentRequestLimits(options.messages);
  return options.messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    if (message.role !== "user") throw new ChatAttachmentError("Only user messages can contain attachment references");
    const parts = message.content.flatMap((part): ProviderContentPart[] => {
      if (part?.type === "text") {
        if (typeof part.text !== "string") throw new ChatAttachmentError("Invalid attachment message text");
        return [{ type: "text", text: part.text }];
      }
      if (part?.type !== "attachment_ref" || !isChatAttachmentRef(part.attachment)) {
        throw new ChatAttachmentError("Invalid attachment reference");
      }
      if (!options.attachmentWorkspaceDir) throw new ChatAttachmentError("Attachment workspace is unavailable");
      const { attachment, bytes } = readChatAttachment(options.attachmentWorkspaceDir, part.attachment.id);
      if (attachment.id !== part.attachment.id || attachment.kind !== part.attachment.kind
        || attachment.size !== part.attachment.size || attachment.mimeType !== part.attachment.mimeType) {
        throw new ChatAttachmentError("Attachment reference no longer matches its stored content");
      }
      if (attachment.kind === "image") {
        if (!IMAGE_MIME_TYPES.has(attachment.mimeType)) throw new ChatAttachmentError("Unsupported image attachment type");
        return [
          { type: "text", text: `[Attached image ${JSON.stringify(redactSecrets(attachment.name))}; untrusted data]` },
          { type: "image_url", image_url: { url: `data:${attachment.mimeType};base64,${bytes.toString("base64")}` } },
        ];
      }
      if (attachment.kind === "pdf") {
        if (attachment.mimeType !== "application/pdf") throw new ChatAttachmentError("Unsupported PDF attachment type");
        return [
          { type: "text", text: `[Attached PDF ${JSON.stringify(redactSecrets(attachment.name))}; untrusted data]` },
          { type: "file", file: { filename: redactSecrets(attachment.name), file_data: `data:application/pdf;base64,${bytes.toString("base64")}` } },
        ];
      }
      const truncated = bytes.length > MAX_TEXT_PART_BYTES;
      const content = redactSecrets(new TextDecoder("utf-8").decode(bytes.subarray(0, MAX_TEXT_PART_BYTES)));
      return [{
        type: "text",
        text: `[Attached file ${JSON.stringify(redactSecrets(attachment.name))}; untrusted content${truncated ? "; truncated to 128 KiB" : ""}]\n${content}${truncated ? "\n[Attachment truncated]" : ""}`,
      }];
    });
    return {
      ...message,
      content: parts.every((part) => part.type === "text")
        ? parts.map((part) => part.type === "text" ? part.text : "").join("\n\n")
        : parts,
    };
  });
}

function buildRequestBody(options: ChatCompletionOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: options.model,
    messages: options.systemPrompt
      ? [{ role: "system", content: options.systemPrompt }, ...materializeMessages(options)]
      : materializeMessages(options),
    max_tokens: options.maxTokens,
  };

  if (typeof options.temperature === "number") {
    body.temperature = options.temperature;
  }
  if (typeof options.topP === "number") {
    body.top_p = options.topP;
  }
  if (typeof options.frequencyPenalty === "number") {
    body.frequency_penalty = options.frequencyPenalty;
  }
  if (typeof options.presencePenalty === "number") {
    body.presence_penalty = options.presencePenalty;
  }
  if (typeof options.stream === "boolean") {
    body.stream = options.stream;
  }
  if (options.tools?.length) {
    body.tools = options.tools;
  }

  return body;
}

export async function callChatCompletion(
  options: ChatCompletionOptions
): Promise<Response> {
  const headers = buildHeaders(options.apiKey);
  return fetch(`${options.apiUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(buildRequestBody(options)),
    signal: options.signal,
  });
}

export interface ChatCompletionStreamCallbacks {
  onContentDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
}

interface StreamToolCallDelta {
  index?: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface ChatCompletionStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: StreamToolCallDelta[];
    };
    message?: {
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason?: "stop" | "tool_calls" | "length" | null;
  }>;
  usage?: OpenAIResponse["usage"];
}

/** Consume either an OpenAI SSE stream or a JSON compatibility response. */
export async function readChatCompletionResponse(
  response: Response,
  callbacks: ChatCompletionStreamCallbacks = {},
  signal?: AbortSignal
): Promise<OpenAIResponse> {
  signal?.throwIfAborted();
  const contentType = response.headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.includes("text/event-stream")) {
    return (await response.json()) as OpenAIResponse;
  }
  if (!response.body) throw new Error("Streaming response body was empty");

  let content = "";
  let reasoning = "";
  let finishReason: "stop" | "tool_calls" | "length" | null = null;
  let usage: OpenAIResponse["usage"];
  const toolCalls = new Map<number, OpenAIToolCall>();

  for await (const payload of readSseData(response.body, signal)) {
    if (payload === "[DONE]") break;
    let chunk: ChatCompletionStreamChunk;
    try {
      chunk = JSON.parse(payload) as ChatCompletionStreamChunk;
    } catch (error) {
      throw new Error(
        `Invalid chat completion SSE payload: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason !== undefined) finishReason = choice.finish_reason;

    if (choice.message) {
      const messageContent = choice.message.content || "";
      if (messageContent) {
        content += messageContent;
        callbacks.onContentDelta?.(messageContent);
      }
      for (const [index, call] of (choice.message.tool_calls || []).entries()) {
        toolCalls.set(index, call);
      }
    }

    const delta = choice.delta;
    if (!delta) continue;
    if (delta.content) {
      content += delta.content;
      callbacks.onContentDelta?.(delta.content);
    }
    if (delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      callbacks.onReasoningDelta?.(delta.reasoning_content);
    }
    for (const fragment of delta.tool_calls || []) {
      const index = typeof fragment.index === "number" ? fragment.index : 0;
      const current = toolCalls.get(index) || {
        id: fragment.id || `tool-call-${index}`,
        type: "function" as const,
        function: { name: "", arguments: "" },
      };
      if (fragment.id) current.id = fragment.id;
      if (fragment.function?.name) current.function.name += fragment.function.name;
      if (fragment.function?.arguments) {
        current.function.arguments += fragment.function.arguments;
      }
      toolCalls.set(index, current);
    }
  }

  signal?.throwIfAborted();
  const assembledToolCalls = [...toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => call);
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: content || (reasoning ? `<think>${reasoning}</think>` : null),
          ...(assembledToolCalls.length > 0 ? { tool_calls: assembledToolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

async function* readSseData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const cancel = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });

  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = event
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) yield data;
        boundary = buffer.indexOf("\n\n");
      }
    }

    buffer += decoder.decode();
    const data = buffer
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) yield data;
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
