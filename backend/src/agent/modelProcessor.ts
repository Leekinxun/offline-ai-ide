import fs from "node:fs";
import { capabilitiesFromDeclaration, getModelCapabilities, type ModelCapabilities, type ModelFeature } from "./modelCapabilities.js";
import { classifyProviderHttpError, parseRetryAfterMs, ProviderRequestError, type ProviderErrorCode } from "./providerErrors.js";
import type { OpenAIMessage, OpenAIResponse, OpenAIToolDef } from "./types.js";
import { getProviderAdapter } from "./providerAdapter.js";
import { assertFallbackContract, assertModelSuitable, type ModelRole, type ProviderExecutionContract, validateProviderResponse } from "./providerConformance.js";
import { estimateModelRequest, ModelBudgetGovernor, type BudgetScope, type BudgetUsageProvenance } from "./modelBudget.js";
import { runAgentHooks, type AgentHookContext } from "./agentHooks.js";
import { redactSecrets } from "./secretRedaction.js";
import { buildContextManifest, toContextManifestState, type ContextAuditOptions, type ContextManifestState, type ContextManifestV1 } from "./contextManifest.js";
import { finishContextManifestAttempt, prepareContextManifest, startContextManifestAttempt, updateContextManifest } from "./contextManifestStore.js";
import { TraceStore } from "../chat/traceStore.js";

export interface ModelFallbackCandidate { apiUrl: string; apiKey?: string; model: string; providerId?: string; maxOutputTokens?: number; executionContract: ProviderExecutionContract; }
export type ProviderState = "capability_checked" | "attempt_started" | "retrying" | "fallback_selected" | "overflow" | "budget_warning" | "completed" | "cancelled" | "failed" | "budget_exhausted";
export interface ProviderStateEvent { state: ProviderState; providerId: string; modelName: string; attempt?: number; candidateIndex: number; code?: ProviderErrorCode; detail?: string; }
export interface ModelProcessorOptions {
  apiUrl: string; apiKey?: string; model: string; providerId?: string; systemPrompt?: string; messages: OpenAIMessage[]; tools?: OpenAIToolDef[];
  fallbackMaxOutputTokens: number; maxOutputTokens?: number; temperature?: number; signal?: AbortSignal; maxAttempts?: number; retryBaseDelayMs?: number;
  onContentDelta?: (delta: string) => void; onReasoningDelta?: (delta: string) => void; onRetry?: (event: ModelRetryEvent) => void; onProviderState?: (event: ProviderStateEvent) => Promise<void> | void;
  hookContext?: AgentHookContext; contextAudit: ContextAuditOptions; onContextManifest?: (state: ContextManifestState) => Promise<void> | void;
  role?: ModelRole; requiredCapabilities?: ModelFeature[]; structuredOutput?: boolean; reasoning?: { effort?: "low" | "medium" | "high"; budgetTokens?: number };
  executionContract?: ProviderExecutionContract; fallbacks?: ModelFallbackCandidate[];
  pricing?: { inputPerMillionUsd: number; outputPerMillionUsd: number }; budgetScopes?: BudgetScope[];
}
export interface ModelRetryEvent { attempt: number; nextAttempt: number; delayMs: number; error: ProviderRequestError; }
export interface ModelProcessorResult { response: OpenAIResponse; attempts: number; maxOutputTokens: number; contextManifest: ContextManifestV1; providerId: string; modelName: string; fallbackIndex: number; capabilities: ModelCapabilities; usage: { promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number; provenance: BudgetUsageProvenance["source"] }; }
interface Candidate { apiUrl: string; apiKey?: string; model: string; providerId: string; maxOutputTokens?: number; executionContract?: ProviderExecutionContract; }

export async function processModelTurn(options: ModelProcessorOptions): Promise<ModelProcessorResult> {
  const requestSignal = options.signal || new AbortController().signal;
  const maxAttempts = Math.max(1, Math.min(5, Math.floor(options.maxAttempts || 3))); const role = options.role || roleFromAgent(options.hookContext?.agentId); const primaryContract = options.executionContract;
  const candidates: Candidate[] = [{ apiUrl: options.apiUrl, apiKey: options.apiKey, model: options.model, providerId: options.providerId || "openai-compatible", maxOutputTokens: options.maxOutputTokens, executionContract: primaryContract }, ...(options.fallbacks || []).slice(0, 3).map((item) => ({ ...item, providerId: item.providerId || "openai-compatible" }))];
  for (const candidate of candidates.slice(1)) assertFallbackContract(primaryContract, candidate.executionContract);
  const safeRequest = redactSecrets({ systemPrompt: options.systemPrompt, messages: options.messages, tools: options.tools }); let governor: ModelBudgetGovernor | undefined; const scopes = options.budgetScopes || defaultBudgetScopes(options);
  let totalAttempts = 0; let lastError: ProviderRequestError | undefined;
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const candidate = candidates[candidateIndex]; const adapter = getProviderAdapter(candidate.providerId); let capabilities: ModelCapabilities;
    try {
      capabilities = candidate.maxOutputTokens ? capabilitiesFromDeclaration(candidate.model, candidate.maxOutputTokens, adapter.declaredSupports) : await getModelCapabilities({ apiUrl: candidate.apiUrl, apiKey: candidate.apiKey, modelName: candidate.model, fallbackMaxOutputTokens: options.fallbackMaxOutputTokens, signal: options.signal, declaredSupports: adapter.declaredSupports });
      assertModelSuitable({ role, capabilities, tools: safeRequest.tools, required: [...(options.requiredCapabilities || []), ...(options.reasoning ? ["reasoning_controls" as const] : [])], structuredOutput: options.structuredOutput });
      await state(options, { state: "capability_checked", providerId: candidate.providerId, modelName: candidate.model, candidateIndex });
    } catch (error) {
      const normalized = normalizeError(error, 0); lastError = normalized;
      if (candidateIndex + 1 < candidates.length && canFallback(normalized)) { await state(options, { state: "fallback_selected", providerId: candidates[candidateIndex + 1].providerId, modelName: candidates[candidateIndex + 1].model, candidateIndex: candidateIndex + 1, code: normalized.code, detail: normalized.message }); continue; }
      throw normalized;
    }
    const maxOutputTokens = Math.min(candidate.maxOutputTokens || capabilities.maxOutputTokens, capabilities.maxOutputTokens); let contextManifest = prepareContextManifest(options.contextAudit.storeWorkspaceDir, buildContextManifest({ audit: options.contextAudit, providerId: candidate.providerId, modelName: candidate.model, systemPrompt: safeRequest.systemPrompt, messages: safeRequest.messages, tools: safeRequest.tools }));
    const notifyManifest = async () => { await options.onContextManifest?.(toContextManifestState(contextManifest)); };
    try { await notifyManifest(); } catch (error) { contextManifest = updateContextManifest(options.contextAudit.storeWorkspaceDir, contextManifest.manifestId, (manifest) => { manifest.status = "failed"; manifest.errorCode = "manifest_observer"; }); throw error; }
    governor ||= new ModelBudgetGovernor(options.contextAudit.storeWorkspaceDir);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      totalAttempts += 1; let emittedDelta = false;
      if (options.signal?.aborted) { contextManifest = updateContextManifest(options.contextAudit.storeWorkspaceDir, contextManifest.manifestId, (manifest) => { manifest.status = "aborted"; manifest.errorCode = "aborted"; }); await notifyManifest(); await state(options, { state: "cancelled", providerId: candidate.providerId, modelName: candidate.model, candidateIndex, attempt }); options.signal.throwIfAborted(); }
      const estimate = estimateModelRequest({ messages: safeRequest.messages, tools: safeRequest.tools, systemPrompt: safeRequest.systemPrompt, maxOutputTokens, inputPerMillionUsd: options.pricing?.inputPerMillionUsd, outputPerMillionUsd: options.pricing?.outputPerMillionUsd }); let budgetVersions: Record<string, number>;
      try { const preflight = governor.preflight(scopes, { tokens: estimate.tokens, costUsd: estimate.costUsd }); budgetVersions = preflight.versions; if (preflight.warnings.length) await state(options, { state: "budget_warning", providerId: candidate.providerId, modelName: candidate.model, candidateIndex, attempt, detail: preflight.warnings.map((item) => `${item.scope.kind}:${item.scope.id}`).join(",") }); }
      catch (error) { const normalized = normalizeError(error, attempt); await state(options, { state: "budget_exhausted", providerId: candidate.providerId, modelName: candidate.model, candidateIndex, attempt, code: normalized.code, detail: normalized.message }); throw normalized; }
      try {
        contextManifest = startContextManifestAttempt(options.contextAudit.storeWorkspaceDir, contextManifest.manifestId, totalAttempts); await notifyManifest(); await state(options, { state: "attempt_started", providerId: candidate.providerId, modelName: candidate.model, candidateIndex, attempt });
        await runAgentHooks("beforeModelRequest", { agentId: options.hookContext?.agentId || "agent", ...options.hookContext, providerId: candidate.providerId, modelName: candidate.model, metadata: { ...(options.hookContext?.metadata || {}), attempt, candidateIndex } });
        const response = await adapter.createChatCompletion({ apiUrl: candidate.apiUrl, apiKey: candidate.apiKey, model: candidate.model, systemPrompt: safeRequest.systemPrompt, messages: safeRequest.messages, tools: safeRequest.tools, maxTokens: maxOutputTokens, temperature: options.temperature, stream: true, signal: requestSignal, structuredOutput: options.structuredOutput, reasoning: options.reasoning });
        if (!response.ok) {
          const body = await response.text(); const classification = classifyProviderHttpError({ status: response.status, body }); const safeBody = redactSecrets(body); const error = new ProviderRequestError({ ...classification, status: response.status, body: safeBody, attempts: attempt, message: `Provider request failed (HTTP ${response.status}): ${safeBody.slice(0, 300)}`, recoverable: classification.code === "context_overflow", state: classification.code === "context_overflow" ? "overflow" : "failed" });
          if (classification.code === "context_overflow") await state(options, { state: "overflow", providerId: candidate.providerId, modelName: candidate.model, candidateIndex, attempt, code: error.code, detail: "Caller may compact once before submitting a new bounded request" });
          if (classification.retryable && attempt < maxAttempts) { contextManifest = finishContextManifestAttempt(options.contextAudit.storeWorkspaceDir, contextManifest.manifestId, { attempt: totalAttempts, status: "retrying", httpStatus: response.status, errorCode: classification.code }); await notifyManifest(); await retry(options, attempt, error, response.headers.get("retry-after") || undefined, candidate, candidateIndex); lastError = error; continue; }
          throw error;
        }
        let result: OpenAIResponse;
        try { result = validateProviderResponse(await adapter.readChatCompletion(response, { onContentDelta: (delta) => { emittedDelta = true; options.onContentDelta?.(delta); }, onReasoningDelta: (delta) => { emittedDelta = true; options.onReasoningDelta?.(delta); } }, requestSignal), options.structuredOutput); }
        catch (error) { options.signal?.throwIfAborted(); if (error instanceof ProviderRequestError) throw error; throw new ProviderRequestError({ code: "response_parse", message: `Provider response could not be parsed: ${safe(error)}`, attempts: attempt, retryable: !emittedDelta, recoverable: true, cause: new Error(safe(error)) }); }
        await runAgentHooks("afterModelResponse", { agentId: options.hookContext?.agentId || "agent", ...options.hookContext, providerId: candidate.providerId, modelName: candidate.model, output: result, metadata: { ...(options.hookContext?.metadata || {}), attempt, candidateIndex } });
        const promptTokens = validUsage(result.usage?.prompt_tokens) ?? estimate.inputTokens; const completionTokens = validUsage(result.usage?.completion_tokens) ?? Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(result.choices[0].message), "utf8") / 4)); const totalTokens = validUsage(result.usage?.total_tokens) ?? promptTokens + completionTokens; const costUsd = Math.round((promptTokens / 1_000_000 * (options.pricing?.inputPerMillionUsd || 0) + completionTokens / 1_000_000 * (options.pricing?.outputPerMillionUsd || 0)) * 1_000_000) / 1_000_000; const provenance: BudgetUsageProvenance = { source: result.usage ? "provider_reported" : "estimated", providerId: candidate.providerId, modelName: candidate.model, runId: options.contextAudit.runId, requestId: options.contextAudit.requestId };
        governor.record(scopes, { tokens: totalTokens, costUsd, provenance }, budgetVersions);
        contextManifest = finishContextManifestAttempt(options.contextAudit.storeWorkspaceDir, contextManifest.manifestId, { attempt: totalAttempts, status: "completed", actualPromptTokens: promptTokens }); await notifyManifest(); await state(options, { state: "completed", providerId: candidate.providerId, modelName: candidate.model, candidateIndex, attempt });
        return { response: result, attempts: totalAttempts, maxOutputTokens, contextManifest, providerId: candidate.providerId, modelName: candidate.model, fallbackIndex: candidateIndex, capabilities, usage: { promptTokens, completionTokens, totalTokens, costUsd, provenance: provenance.source } };
      } catch (error) {
        if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) { contextManifest = finishContextManifestAttempt(options.contextAudit.storeWorkspaceDir, contextManifest.manifestId, { attempt: totalAttempts, status: "aborted", errorCode: "aborted" }); await notifyManifest(); await state(options, { state: "cancelled", providerId: candidate.providerId, modelName: candidate.model, candidateIndex, attempt }); options.signal?.throwIfAborted(); throw error; }
        const normalized = normalizeError(error, attempt); lastError = normalized;
        if (normalized.retryable && !emittedDelta && attempt < maxAttempts) { contextManifest = finishContextManifestAttempt(options.contextAudit.storeWorkspaceDir, contextManifest.manifestId, { attempt: totalAttempts, status: "retrying", httpStatus: normalized.status, errorCode: normalized.code }); await notifyManifest(); await retry(options, attempt, normalized, undefined, candidate, candidateIndex); continue; }
        contextManifest = finishContextManifestAttempt(options.contextAudit.storeWorkspaceDir, contextManifest.manifestId, { attempt: totalAttempts, status: "failed", httpStatus: normalized.status, errorCode: normalized.code }); await notifyManifest();
        if (candidateIndex + 1 < candidates.length && canFallback(normalized)) { await state(options, { state: "fallback_selected", providerId: candidates[candidateIndex + 1].providerId, modelName: candidates[candidateIndex + 1].model, candidateIndex: candidateIndex + 1, code: normalized.code, detail: normalized.message }); break; }
        await state(options, { state: normalized.code === "budget_exhausted" ? "budget_exhausted" : "failed", providerId: candidate.providerId, modelName: candidate.model, candidateIndex, attempt, code: normalized.code, detail: normalized.message }); throw normalized;
      }
    }
  }
  throw lastError || new ProviderRequestError({ code: "network", message: "Provider request failed without a response", attempts: totalAttempts });
}

function roleFromAgent(value?: string): ModelRole { const id = (value || "ask").toLowerCase(); if (id.includes("verifier")) return "verifier"; if (id.includes("review")) return "review"; if (id.includes("explore")) return "explore"; if (id === "plan") return "plan"; if (["code", "subagent", "teammate"].includes(id)) return "code"; return "ask"; }
function defaultBudgetScopes(options: ModelProcessorOptions): BudgetScope[] { const scopes: BudgetScope[] = [{ kind: "workspace", id: "workspace" }, { kind: "agent", id: options.hookContext?.agentId || "agent" }]; const metadata = options.hookContext?.metadata || {}; if (typeof metadata.teamId === "string") scopes.push({ kind: "team", id: metadata.teamId }); if (typeof metadata.taskId === "string" || typeof metadata.taskId === "number") scopes.push({ kind: "task", id: String(metadata.taskId) }); return scopes; }
function validUsage(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function canFallback(error: ProviderRequestError): boolean { return ["network", "timeout", "rate_limit", "server_error", "model_not_found", "capability_mismatch"].includes(error.code); }
function normalizeError(error: unknown, attempts: number): ProviderRequestError { return error instanceof ProviderRequestError ? error : new ProviderRequestError({ code: "network", message: `Provider network request failed: ${safe(error)}`, attempts: Math.max(1, attempts), retryable: true, cause: new Error(safe(error)) }); }
function safe(error: unknown): string { return redactSecrets(error instanceof Error ? error.message : String(error)); }
async function state(options: ModelProcessorOptions, event: ProviderStateEvent): Promise<void> {
  const workspace = options.contextAudit.storeWorkspaceDir;
  if (fs.existsSync(workspace)) {
    try {
      new TraceStore(workspace).append({
        kind: event.state === "failed" || event.state === "budget_exhausted" ? "error" : "model",
        action: `Provider ${event.state}`,
        correlationId: options.contextAudit.runId || options.contextAudit.requestId || `${event.providerId}:${event.modelName}`,
        causationId: options.contextAudit.requestId,
        runId: options.contextAudit.runId,
        conversationId: options.contextAudit.conversationId,
        agentId: options.contextAudit.agentId || options.hookContext?.agentId,
        requestId: options.contextAudit.requestId,
        evidence: event.detail,
        decision: event.code,
        metadata: { providerId: event.providerId, modelName: event.modelName, state: event.state, attempt: event.attempt, candidateIndex: event.candidateIndex, code: event.code },
      });
    } catch { /* provider execution must not depend on optional trace persistence */ }
  }
  await options.onProviderState?.(event);
}
async function retry(options: ModelProcessorOptions, attempt: number, error: ProviderRequestError, retryAfter: string | undefined, candidate: Candidate, candidateIndex: number): Promise<void> { const exponential = Math.max(0, options.retryBaseDelayMs ?? 250) * 2 ** (attempt - 1); const delayMs = Math.min(10_000, parseRetryAfterMs(retryAfter || null) ?? exponential); options.onRetry?.({ attempt, nextAttempt: attempt + 1, delayMs, error }); await state(options, { state: "retrying", providerId: candidate.providerId, modelName: candidate.model, candidateIndex, attempt, code: error.code, detail: `delayMs=${delayMs}` }); if (delayMs > 0) await abortableDelay(delayMs, options.signal); }
async function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> { signal?.throwIfAborted(); await new Promise<void>((resolve, reject) => { const cleanup = () => signal?.removeEventListener("abort", abort); const timer = setTimeout(() => { cleanup(); resolve(); }, delayMs); const abort = () => { clearTimeout(timer); cleanup(); reject(signal?.reason || new DOMException("The operation was aborted", "AbortError")); }; signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort(); }); signal?.throwIfAborted(); }
