import {
  callChatCompletion,
  readChatCompletionResponse,
  type ChatCompletionOptions,
  type ChatCompletionStreamCallbacks,
} from "./llm.js";
import type { OpenAIResponse } from "./types.js";

export interface ProviderAdapter {
  id: string;
  createChatCompletion(options: ChatCompletionOptions): Promise<Response>;
  readChatCompletion(
    response: Response,
    callbacks?: ChatCompletionStreamCallbacks,
    signal?: AbortSignal
  ): Promise<OpenAIResponse>;
}

const adapters = new Map<string, ProviderAdapter>();

export const openAiCompatibleAdapter: ProviderAdapter = {
  id: "openai-compatible",
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
