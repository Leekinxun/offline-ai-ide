import { OpenAIMessage, OpenAIToolDef } from "./types.js";

export interface ChatCompletionOptions {
  apiUrl: string;
  apiKey?: string;
  model: string;
  systemPrompt?: string;
  messages: OpenAIMessage[];
  tools?: OpenAIToolDef[];
  maxTokens: number;
  temperature?: number;
  stream?: boolean;
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

function buildRequestBody(options: ChatCompletionOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: options.model,
    messages: options.systemPrompt
      ? [{ role: "system", content: options.systemPrompt }, ...options.messages]
      : options.messages,
    max_tokens: options.maxTokens,
  };

  if (typeof options.temperature === "number") {
    body.temperature = options.temperature;
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
  });
}
