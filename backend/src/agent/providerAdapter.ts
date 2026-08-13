import {
  callChatCompletion,
  readChatCompletionResponse,
  type ChatCompletionOptions,
  type ChatCompletionStreamCallbacks,
} from "./llm.js";
import type { OpenAIResponse } from "./types.js";
import type { CapabilitySupport } from "./modelCapabilities.js";

export interface ProviderChatCompletionOptions extends ChatCompletionOptions {
  structuredOutput?: boolean;
  reasoning?: { effort?: "low" | "medium" | "high"; budgetTokens?: number };
}

export interface ProviderAdapter {
  id: string;
  declaredSupports?: Partial<CapabilitySupport>;
  createChatCompletion(options: ProviderChatCompletionOptions): Promise<Response>;
  readChatCompletion(
    response: Response,
    callbacks?: ChatCompletionStreamCallbacks,
    signal?: AbortSignal
  ): Promise<OpenAIResponse>;
}

const adapters = new Map<string, ProviderAdapter>();

export const openAiCompatibleAdapter: ProviderAdapter = {
  id: "openai-compatible",
  declaredSupports: { streaming: true, tool_calling: true, cancellation: true, usage_reporting: true },
  createChatCompletion: callChatCompletion,
  readChatCompletion: readChatCompletionResponse,
};
adapters.set(openAiCompatibleAdapter.id, openAiCompatibleAdapter);

export function getProviderAdapter(id = openAiCompatibleAdapter.id): ProviderAdapter {
  const adapter = adapters.get(id);
  if (!adapter) throw new Error(`Unknown provider adapter: ${id}`);
  return adapter;
}

export function registerProviderAdapter(adapter: ProviderAdapter): () => void {
  if (!adapter.id.trim()) throw new Error("Provider adapter requires an id");
  if (adapters.has(adapter.id)) throw new Error(`Provider adapter already registered: ${adapter.id}`);
  adapters.set(adapter.id, adapter);
  return () => adapters.delete(adapter.id);
}

export function listProviderAdapters(): string[] {
  return [...adapters.keys()].sort();
}
