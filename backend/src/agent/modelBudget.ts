import crypto from "node:crypto";
import { OrchestrationStore } from "./orchestrationStore.js";
import { ProviderRequestError } from "./providerErrors.js";
import type { OpenAIMessage, OpenAIToolDef } from "./types.js";

export type BudgetScopeKind = "workspace" | "team" | "task" | "agent";
export interface BudgetScope { kind: BudgetScopeKind; id: string; }
export interface ModelBudgetPolicy { maxTokens?: number; maxCostUsd?: number; warningRatio?: number; }
export interface BudgetUsageProvenance { source: "provider_reported" | "estimated"; providerId: string; modelName: string; runId?: string; requestId?: string; }
export interface ModelBudgetEntry { scope: BudgetScope; version: number; policy: ModelBudgetPolicy; usedTokens: number; usedCostUsd: number; updatedAt: number; lastUsage?: { tokens: number; costUsd: number; provenance: BudgetUsageProvenance; recordedAt: number }; }
interface BudgetState { schemaVersion: 1; entries: Record<string, ModelBudgetEntry>; }
function initial(): BudgetState { return { schemaVersion: 1, entries: {} }; }
function key(scope: BudgetScope): string { if (!scope.id.trim() || !/^[A-Za-z0-9_.:@/-]{1,300}$/.test(scope.id)) throw new Error("Invalid budget scope"); return `${scope.kind}:${scope.id}`; }
function normalizedPolicy(value: ModelBudgetPolicy): ModelBudgetPolicy {
  const result: ModelBudgetPolicy = {};
  if (value.maxTokens !== undefined) { if (!Number.isSafeInteger(value.maxTokens) || value.maxTokens < 0) throw new Error("Invalid maxTokens budget"); result.maxTokens = value.maxTokens; }
  if (value.maxCostUsd !== undefined) { if (!Number.isFinite(value.maxCostUsd) || value.maxCostUsd < 0) throw new Error("Invalid maxCostUsd budget"); result.maxCostUsd = Math.round(value.maxCostUsd * 1_000_000) / 1_000_000; }
  if (value.warningRatio !== undefined) { if (!Number.isFinite(value.warningRatio) || value.warningRatio <= 0 || value.warningRatio > 1) throw new Error("warningRatio must be in (0,1]"); result.warningRatio = value.warningRatio; }
  return result;
}
function exhausted(entry: ModelBudgetEntry, tokens: number, cost: number): boolean { return (entry.policy.maxTokens !== undefined && entry.usedTokens + tokens > entry.policy.maxTokens) || (entry.policy.maxCostUsd !== undefined && entry.usedCostUsd + cost > entry.policy.maxCostUsd); }
function budgetError(entries: ModelBudgetEntry[]): ProviderRequestError { return new ProviderRequestError({ code: "budget_exhausted", message: `Model budget exhausted for ${entries.map((entry) => `${entry.scope.kind}:${entry.scope.id}`).join(", ")}`, retryable: false, recoverable: true, state: "budget_exhausted" }); }

export class ModelBudgetGovernor {
  private readonly store: OrchestrationStore<BudgetState>;
  constructor(workspaceDir: string) { this.store = new OrchestrationStore(workspaceDir, "model-budgets", initial); }
  list(): ModelBudgetEntry[] { return Object.values(this.store.snapshot().entries).sort((a, b) => key(a.scope).localeCompare(key(b.scope))); }
  get(scope: BudgetScope): ModelBudgetEntry { const found = this.store.snapshot().entries[key(scope)]; return found ? structuredClone(found) : { scope: structuredClone(scope), version: 0, policy: {}, usedTokens: 0, usedCostUsd: 0, updatedAt: 0 }; }
  update(scope: BudgetScope, policy: ModelBudgetPolicy, expectedVersion: number): ModelBudgetEntry {
    return this.store.transact((state) => { const id = key(scope); const current = state.entries[id] || { scope: structuredClone(scope), version: 0, policy: {}, usedTokens: 0, usedCostUsd: 0, updatedAt: 0 }; if (current.version !== expectedVersion) throw new Error(`Budget version conflict: expected ${expectedVersion}, got ${current.version}`); current.policy = normalizedPolicy(policy); current.version += 1; current.updatedAt = Date.now(); state.entries[id] = current; return structuredClone(current); });
  }
  preflight(scopes: BudgetScope[], estimate: { tokens: number; costUsd: number }): { warnings: ModelBudgetEntry[]; versions: Record<string, number> } {
    if (!Number.isSafeInteger(estimate.tokens) || estimate.tokens < 0 || !Number.isFinite(estimate.costUsd) || estimate.costUsd < 0) throw new Error("Invalid model budget estimate");
    const snapshot = this.store.snapshot(); const entries = scopes.flatMap((scope) => snapshot.entries[key(scope)] ? [snapshot.entries[key(scope)]] : []); const blocked = entries.filter((entry) => exhausted(entry, estimate.tokens, estimate.costUsd)); if (blocked.length) throw budgetError(blocked);
    const warnings = entries.filter((entry) => { const ratio = entry.policy.warningRatio ?? 0.8; return (entry.policy.maxTokens !== undefined && entry.usedTokens + estimate.tokens >= entry.policy.maxTokens * ratio) || (entry.policy.maxCostUsd !== undefined && entry.usedCostUsd + estimate.costUsd >= entry.policy.maxCostUsd * ratio); });
    return { warnings: structuredClone(warnings), versions: Object.fromEntries(entries.map((entry) => [key(entry.scope), entry.version])) };
  }
  record(scopes: BudgetScope[], usage: { tokens: number; costUsd: number; provenance: BudgetUsageProvenance }, expectedVersions: Record<string, number>): ModelBudgetEntry[] {
    if (!Number.isSafeInteger(usage.tokens) || usage.tokens < 0 || !Number.isFinite(usage.costUsd) || usage.costUsd < 0) throw new Error("Invalid model usage");
    return this.store.transact((state) => {
      const entries = scopes.flatMap((scope) => state.entries[key(scope)] ? [state.entries[key(scope)]] : []);
      const conflicts = entries.filter((entry) => expectedVersions[key(entry.scope)] !== entry.version); if (conflicts.length) throw new ProviderRequestError({ code: "budget_exhausted", message: "Budget changed while the model request was in flight; usage was not committed", retryable: false, recoverable: true, state: "budget_exhausted" });
      const blocked = entries.filter((entry) => exhausted(entry, usage.tokens, usage.costUsd)); if (blocked.length) throw budgetError(blocked);
      const now = Date.now(); for (const entry of entries) { entry.usedTokens += usage.tokens; entry.usedCostUsd = Math.round((entry.usedCostUsd + usage.costUsd) * 1_000_000) / 1_000_000; entry.lastUsage = { tokens: usage.tokens, costUsd: usage.costUsd, provenance: structuredClone(usage.provenance), recordedAt: now }; entry.version += 1; entry.updatedAt = now; }
      return entries.map((entry) => structuredClone(entry));
    });
  }
}

export function estimateModelRequest(input: { messages: OpenAIMessage[]; tools?: OpenAIToolDef[]; systemPrompt?: string; maxOutputTokens: number; inputPerMillionUsd?: number; outputPerMillionUsd?: number }): { inputTokens: number; outputTokens: number; tokens: number; costUsd: number } {
  const serialized = JSON.stringify({ systemPrompt: input.systemPrompt || "", messages: input.messages, tools: input.tools || [] }); const inputTokens = Math.max(1, Math.ceil(Buffer.byteLength(serialized, "utf8") / 4)); const outputTokens = Math.max(0, Math.floor(input.maxOutputTokens)); const costUsd = Math.round((inputTokens / 1_000_000 * (input.inputPerMillionUsd || 0) + outputTokens / 1_000_000 * (input.outputPerMillionUsd || 0)) * 1_000_000) / 1_000_000; return { inputTokens, outputTokens, tokens: inputTokens + outputTokens, costUsd };
}
export function budgetReceiptId(value: unknown): string { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
