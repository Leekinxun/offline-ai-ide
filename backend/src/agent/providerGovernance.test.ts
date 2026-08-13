import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModelBudgetGovernor } from "./modelBudget.js";
import { processModelTurn, type ProviderStateEvent } from "./modelProcessor.js";
import { registerProviderAdapter } from "./providerAdapter.js";
import type { ProviderExecutionContract } from "./providerConformance.js";
import { ProviderRequestError } from "./providerErrors.js";
import { TraceStore } from "../chat/traceStore.js";

const full = { streaming: true, tool_calling: true, structured_output: true, reasoning_controls: true, cancellation: true, usage_reporting: true };
const contract: ProviderExecutionContract = { id: "code-contract", permissions: ["read_file", "write_file"], isolation: "managed-worktree", tools: ["read_file", "write_file"], requiredCapabilities: ["streaming", "tool_calling", "cancellation", "usage_reporting"] };
function workspace(t: test.TestContext): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-provider-governance-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function options(root: string, providerId: string) { return { apiUrl: "https://provider.invalid/v1", providerId, model: "mock-model", messages: [{ role: "user" as const, content: "hello" }], fallbackMaxOutputTokens: 64, maxOutputTokens: 64, maxAttempts: 1, retryBaseDelayMs: 0, role: "code" as const, executionContract: contract, contextAudit: { storeWorkspaceDir: root, scope: { kind: "workspace" as const, scopeId: "workspace" }, purpose: "agent_turn" as const, agentId: "code", runId: "run-1", requestId: "request-1" } }; }
const success = { choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" as const }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } };

test("mock adapter conformance covers streaming, tools, structured output, reasoning controls, and provider-reported usage", async (t) => {
  const root = workspace(t); const deltas: string[] = []; let observedSignal: AbortSignal | undefined; let observedTools = 0;
  const dispose = registerProviderAdapter({ id: "conformance-full", declaredSupports: full, async createChatCompletion(input) { observedSignal = input.signal; observedTools = input.tools?.length || 0; return Response.json({}); }, async readChatCompletion(_response, callbacks) { callbacks?.onContentDelta?.('{"ok":true}'); return { choices: [{ message: { role: "assistant", content: '{"ok":true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } }; } }); t.after(dispose);
  const result = await processModelTurn({ ...options(root, "conformance-full"), tools: [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object" } } }], structuredOutput: true, reasoning: { effort: "high" }, onContentDelta: (delta) => deltas.push(delta) });
  assert.deepEqual(deltas, ['{"ok":true}']); assert.equal(observedTools, 1); assert.ok(observedSignal); assert.equal(result.usage.provenance, "provider_reported"); assert.equal(result.usage.totalTokens, 11); assert.equal(result.capabilities.supports.reasoning_controls, true); assert.ok(new TraceStore(root).list({ runId: "run-1" }).some((event) => event.metadata?.state === "completed"));
});

test("cancellation reaches adapter creation and records an explicit cancelled state", async (t) => {
  const root = workspace(t); const states: ProviderStateEvent[] = []; const controller = new AbortController();
  const dispose = registerProviderAdapter({ id: "conformance-cancel", declaredSupports: full, createChatCompletion(input) { return new Promise((_resolve, reject) => { input.signal?.addEventListener("abort", () => reject(input.signal?.reason || new DOMException("aborted", "AbortError")), { once: true }); }); }, async readChatCompletion() { return success; } }); t.after(dispose);
  const pending = processModelTurn({ ...options(root, "conformance-cancel"), signal: controller.signal, onProviderState: (event) => { states.push(event); } }); controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(pending, /cancel/i); assert.ok(states.some((event) => event.state === "cancelled"));
});

test("overflow, retry, malformed response, and capability mismatch are explicit and fail closed", async (t) => {
  const root = workspace(t); const states: ProviderStateEvent[] = []; let overflowCalls = 0;
  const disposeOverflow = registerProviderAdapter({ id: "conformance-overflow", declaredSupports: full, async createChatCompletion() { overflowCalls += 1; return new Response("maximum context length exceeded", { status: 400 }); }, async readChatCompletion() { return success; } }); t.after(disposeOverflow);
  await assert.rejects(processModelTurn({ ...options(root, "conformance-overflow"), maxAttempts: 5, onProviderState: (event) => { states.push(event); } }), (error: unknown) => error instanceof ProviderRequestError && error.code === "context_overflow" && error.recoverable); assert.equal(overflowCalls, 1); assert.ok(states.some((event) => event.state === "overflow"));
  let retryCalls = 0; const disposeRetry = registerProviderAdapter({ id: "conformance-retry", declaredSupports: full, async createChatCompletion() { retryCalls += 1; return retryCalls === 1 ? new Response("busy", { status: 503 }) : Response.json({}); }, async readChatCompletion() { return success; } }); t.after(disposeRetry);
  const retried = await processModelTurn({ ...options(root, "conformance-retry"), maxAttempts: 2 }); assert.equal(retried.attempts, 2); assert.equal(retryCalls, 2);
  let malformedFallbackCalls = 0; const disposeMalformed = registerProviderAdapter({ id: "conformance-malformed", declaredSupports: full, async createChatCompletion() { return Response.json({}); }, async readChatCompletion() { return { choices: [] }; } }); const disposeUnused = registerProviderAdapter({ id: "conformance-unused-fallback", declaredSupports: full, async createChatCompletion() { malformedFallbackCalls += 1; return Response.json({}); }, async readChatCompletion() { return success; } }); t.after(disposeMalformed); t.after(disposeUnused);
  await assert.rejects(processModelTurn({ ...options(root, "conformance-malformed"), fallbacks: [{ apiUrl: "https://fallback.invalid/v1", providerId: "conformance-unused-fallback", model: "fallback", maxOutputTokens: 64, executionContract: contract }] }), (error: unknown) => error instanceof ProviderRequestError && error.code === "response_parse"); assert.equal(malformedFallbackCalls, 0);
  let unsuitableCalls = 0; const disposeUnsuitable = registerProviderAdapter({ id: "conformance-unsuitable", declaredSupports: { streaming: true, cancellation: true }, async createChatCompletion() { unsuitableCalls += 1; return Response.json({}); }, async readChatCompletion() { return success; } }); t.after(disposeUnsuitable);
  await assert.rejects(processModelTurn(options(root, "conformance-unsuitable")), (error: unknown) => error instanceof ProviderRequestError && error.code === "capability_mismatch"); assert.equal(unsuitableCalls, 0);
});

test("fallback never expands execution authority and selection is deterministic across 100 repetitions", async (t) => {
  const root = workspace(t); let primaryCalls = 0; let fallbackCalls = 0;
  const disposePrimary = registerProviderAdapter({ id: "stable-primary", declaredSupports: full, async createChatCompletion() { primaryCalls += 1; return new Response("unavailable", { status: 503 }); }, async readChatCompletion() { return success; } }); const disposeFallback = registerProviderAdapter({ id: "stable-fallback", declaredSupports: full, async createChatCompletion() { fallbackCalls += 1; return Response.json({}); }, async readChatCompletion() { return success; } }); t.after(disposePrimary); t.after(disposeFallback);
  const mismatched = { ...contract, permissions: [...contract.permissions, "network"] };
  await assert.rejects(processModelTurn({ ...options(root, "stable-primary"), fallbacks: [{ apiUrl: "https://fallback.invalid/v1", providerId: "stable-fallback", model: "fallback", maxOutputTokens: 64, executionContract: mismatched }] }), /execution.*contract|fallback/i); assert.equal(primaryCalls, 0);
  for (let index = 0; index < 100; index += 1) { const result = await processModelTurn({ ...options(root, "stable-primary"), contextAudit: { ...options(root, "stable-primary").contextAudit, requestId: `fallback-${index}` }, fallbacks: [{ apiUrl: "https://fallback.invalid/v1", providerId: "stable-fallback", model: "fallback", maxOutputTokens: 64, executionContract: contract }] }); assert.equal(result.fallbackIndex, 1); assert.equal(result.providerId, "stable-fallback"); }
  assert.equal(primaryCalls, 100); assert.equal(fallbackCalls, 100);
});

test("durable budgets use CAS, warn/preflight, preserve usage provenance, and exhaust before provider egress", async (t) => {
  const root = workspace(t); const governor = new ModelBudgetGovernor(root); const workspaceScope = { kind: "workspace" as const, id: "workspace" }; const configured = governor.update(workspaceScope, { maxTokens: 100, maxCostUsd: 1, warningRatio: 0.5 }, 0); assert.equal(configured.version, 1); assert.throws(() => governor.update(workspaceScope, { maxTokens: 200 }, 0), /version conflict/i);
  const preflight = governor.preflight([workspaceScope], { tokens: 60, costUsd: 0.1 }); assert.equal(preflight.warnings.length, 1); governor.record([workspaceScope], { tokens: 5, costUsd: 0.01, provenance: { source: "provider_reported", providerId: "mock", modelName: "m", runId: "r" } }, preflight.versions); assert.equal(governor.get(workspaceScope).lastUsage?.provenance.source, "provider_reported");
  governor.update(workspaceScope, { maxTokens: 5 }, governor.get(workspaceScope).version); let calls = 0; const dispose = registerProviderAdapter({ id: "budget-blocked", declaredSupports: full, async createChatCompletion() { calls += 1; return Response.json({}); }, async readChatCompletion() { return success; } }); t.after(dispose); const states: ProviderStateEvent[] = [];
  await assert.rejects(processModelTurn({ ...options(root, "budget-blocked"), onProviderState: (event) => { states.push(event); } }), (error: unknown) => error instanceof ProviderRequestError && error.code === "budget_exhausted" && error.recoverable); assert.equal(calls, 0); assert.ok(states.some((event) => event.state === "budget_exhausted"));
});
