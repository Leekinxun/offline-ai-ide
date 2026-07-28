import { resolveMaxOutputTokens } from "./modelCapabilities.js";
import {
  classifyProviderHttpError,
  parseRetryAfterMs,
  ProviderRequestError,
} from "./providerErrors.js";
import type { OpenAIMessage, OpenAIResponse, OpenAIToolDef } from "./types.js";
import { getProviderAdapter } from "./providerAdapter.js";
import { runAgentHooks, type AgentHookContext } from "./agentHooks.js";

export interface ModelProcessorOptions {
  apiUrl: string;
  apiKey?: string;
  model: string;
  providerId?: string;
  systemPrompt?: string;
  messages: OpenAIMessage[];
  tools?: OpenAIToolDef[];
  fallbackMaxOutputTokens: number;
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  onContentDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onRetry?: (event: ModelRetryEvent) => void;
  hookContext?: AgentHookContext;
}

export interface ModelRetryEvent {
  attempt: number;
  nextAttempt: number;
  delayMs: number;
  error: ProviderRequestError;
}

export interface ModelProcessorResult {
  response: OpenAIResponse;
  attempts: number;
  maxOutputTokens: number;
}

export async function processModelTurn(
  options: ModelProcessorOptions
): Promise<ModelProcessorResult> {
  const maxAttempts = Math.max(1, Math.min(5, Math.floor(options.maxAttempts || 3)));
  const providerId = options.providerId || "openai-compatible";
  const adapter = getProviderAdapter(providerId);
  const maxOutputTokens = options.maxOutputTokens || await resolveMaxOutputTokens({
    apiUrl: options.apiUrl,
    apiKey: options.apiKey,
    modelName: options.model,
    fallbackMaxOutputTokens: options.fallbackMaxOutputTokens,
    signal: options.signal,
  });

  let lastError: ProviderRequestError | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    options.signal?.throwIfAborted();
    let emittedDelta = false;
    try {
      await runAgentHooks("beforeModelRequest", {
        agentId: options.hookContext?.agentId || "agent",
        ...options.hookContext,
        providerId,
        modelName: options.model,
        metadata: { ...(options.hookContext?.metadata || {}), attempt },
      });
      const response = await adapter.createChatCompletion({
        apiUrl: options.apiUrl,
        apiKey: options.apiKey,
        model: options.model,
        systemPrompt: options.systemPrompt,
        messages: options.messages,
        tools: options.tools,
        maxTokens: maxOutputTokens,
        temperature: options.temperature,
        stream: true,
        signal: options.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        const classification = classifyProviderHttpError({ status: response.status, body });
        const error = new ProviderRequestError({
          ...classification,
          status: response.status,
          body,
          attempts: attempt,
          message: `Provider request failed (HTTP ${response.status}): ${body.slice(0, 300)}`,
        });
        if (classification.retryable && attempt < maxAttempts) {
          await waitBeforeRetry(options, attempt, error, response.headers.get("retry-after"));
          lastError = error;
          continue;
        }
        throw error;
      }

      try {
        const result = await adapter.readChatCompletion(response, {
          onContentDelta: (delta) => {
            emittedDelta = true;
            options.onContentDelta?.(delta);
          },
          onReasoningDelta: (delta) => {
            emittedDelta = true;
            options.onReasoningDelta?.(delta);
          },
        }, options.signal);
        await runAgentHooks("afterModelResponse", {
          agentId: options.hookContext?.agentId || "agent",
          ...options.hookContext,
          providerId,
          modelName: options.model,
          output: result,
          metadata: { ...(options.hookContext?.metadata || {}), attempt },
        });
        return { response: result, attempts: attempt, maxOutputTokens };
      } catch (error) {
        options.signal?.throwIfAborted();
        throw new ProviderRequestError({
          code: "response_parse",
          message: `Provider response could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
          attempts: attempt,
          retryable: !emittedDelta,
          cause: error,
        });
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      const normalized = error instanceof ProviderRequestError
        ? error
        : new ProviderRequestError({
            code: "network",
            message: `Provider network request failed: ${error instanceof Error ? error.message : String(error)}`,
            attempts: attempt,
            retryable: true,
            cause: error,
          });
      if (normalized.retryable && !emittedDelta && attempt < maxAttempts) {
        await waitBeforeRetry(options, attempt, normalized);
        lastError = normalized;
        continue;
      }
      throw normalized;
    }
  }

  throw lastError || new ProviderRequestError({
    code: "network",
    message: "Provider request failed without a response",
    attempts: maxAttempts,
  });
}

async function waitBeforeRetry(
  options: ModelProcessorOptions,
  attempt: number,
  error: ProviderRequestError,
  retryAfter?: string | null
): Promise<void> {
  const exponential = Math.max(0, options.retryBaseDelayMs ?? 250) * 2 ** (attempt - 1);
  const delayMs = Math.min(10_000, parseRetryAfterMs(retryAfter || null) ?? exponential);
  options.onRetry?.({ attempt, nextAttempt: attempt + 1, delayMs, error });
  if (delayMs <= 0) return;
  await abortableDelay(delayMs, options.signal);
}

async function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason || new DOMException("The operation was aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
  signal?.throwIfAborted();
}
