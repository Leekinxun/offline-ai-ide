import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { OpenAIResponse, OpenAIUsage } from "./types.js";
import type { ProviderStateEvent } from "./modelProcessor.js";

// Set disposable paths before loading modules that read runtime configuration.
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-provider-usage-"));
process.env.APP_SETTINGS_CONFIG = path.join(fixtureRoot, "app-settings.json");
process.env.USERS_CONFIG = path.join(fixtureRoot, "users.json");
process.env.WORKSPACE_DIR = fixtureRoot;
process.env.PLUGINS_DIR = path.join(fixtureRoot, "plugins");
process.env.VLLM_API_URL = "http://127.0.0.1:9/v1";
process.env.AGENT_BASE_URL = "http://127.0.0.1:9/v1";
process.env.VLLM_API_KEY = "";
process.env.AGENT_API_KEY = "";
fs.writeFileSync(process.env.APP_SETTINGS_CONFIG, JSON.stringify({
  schemaVersion: 1,
  llm: { vllmApiUrl: "http://127.0.0.1:9/v1", vllmApiKey: "", modelName: "usage-fixture", models: [] },
  mcp: { baseUrls: [], lazyUrls: [], disabledUrls: [], servers: [] },
  delivery: { providers: [] },
}));
fs.writeFileSync(process.env.USERS_CONFIG, "[]");
after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

const { readChatCompletionResponse } = await import("./llm.js");
const { validateProviderResponse } = await import("./providerConformance.js");
const { ProviderRequestError } = await import("./providerErrors.js");
const { processModelTurn } = await import("./modelProcessor.js");
const { registerProviderAdapter } = await import("./providerAdapter.js");
const { ModelBudgetGovernor } = await import("./modelBudget.js");

function completion(usage?: unknown): OpenAIResponse {
  return {
    choices: [{ message: { role: "assistant", content: "Hello from DeepSeek" }, finish_reason: "stop" }],
    ...(usage !== undefined ? { usage } : {}),
  } as OpenAIResponse;
}

function deepSeekUsage(): OpenAIUsage {
  return {
    prompt_tokens: 17,
    completion_tokens: 9,
    total_tokens: 26,
    prompt_cache_hit_tokens: 14,
    prompt_cache_miss_tokens: 3,
    prompt_tokens_details: { cached_tokens: 14, audio_tokens: null },
    completion_tokens_details: { reasoning_tokens: 7, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 1 },
  };
}

function sseResponse(chunks: unknown[]): Response {
  const data = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(data, { headers: { "content-type": "text/event-stream" } });
}

function textStream(usage: unknown, usageOnlyChunk = true): Response {
  const terminal = { delta: {}, finish_reason: "stop" };
  return sseResponse([
    { choices: [{ delta: { content: "Hello " }, finish_reason: null }], usage: null },
    { choices: [{ delta: { content: "from DeepSeek" }, finish_reason: null }], usage: null },
    ...(usageOnlyChunk
      ? [{ choices: [terminal], usage: null }, { choices: [], usage }]
      : [{ choices: [terminal], usage }]),
  ]);
}

test("DeepSeek JSON usage details survive the real reader and response validation", async () => {
  const usage = deepSeekUsage();
  const response = await readChatCompletionResponse(Response.json(completion(usage)));
  assert.equal(validateProviderResponse(response), response);
  assert.deepEqual(response.usage, usage);
  assert.equal(response.choices[0].message.content, "Hello from DeepSeek");
});

test("streamed text completes with null interim usage and either final usage chunk shape", async (t) => {
  for (const usageOnlyChunk of [true, false]) {
    await t.test(usageOnlyChunk ? "separate usage-only chunk" : "terminal choice carries usage", async () => {
      const deltas: string[] = [];
      const usage = deepSeekUsage();
      const response = validateProviderResponse(await readChatCompletionResponse(textStream(usage, usageOnlyChunk), {
        onContentDelta: (delta) => deltas.push(delta),
      }));
      assert.deepEqual(deltas, ["Hello ", "from DeepSeek"]);
      assert.equal(response.choices[0].message.content, deltas.join(""));
      assert.equal(response.choices[0].finish_reason, "stop");
      assert.deepEqual(response.usage, usage);
    });
  }
});

test("streamed tool call fragments remain intact with nested usage details", async () => {
  const response = validateProviderResponse(await readChatCompletionResponse(sseResponse([
    { choices: [{ delta: { content: "Checking file", tool_calls: [{ index: 0, id: "call-usage", type: "function", function: { name: "read_", arguments: '{"path":' } }] }, finish_reason: null }], usage: null },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "file", arguments: '"README.md"}' } }] }, finish_reason: "tool_calls" }], usage: null },
    { choices: [], usage: deepSeekUsage() },
  ])));
  assert.equal(response.choices[0].message.content, "Checking file");
  assert.deepEqual(response.choices[0].message.tool_calls, [{ id: "call-usage", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } }]);
  assert.equal(response.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(response.usage, deepSeekUsage());
});

test("legacy absent, null, partial and nullable detail usage remain compatible", async () => {
  const usages = [
    undefined, null, {}, { prompt_tokens: 0 }, { completion_tokens: 2 }, { total_tokens: 3 },
    { prompt_tokens_details: null, completion_tokens_details: null },
    { prompt_tokens_details: { cached_tokens: null, audio_tokens: null }, completion_tokens_details: { reasoning_tokens: null, audio_tokens: null, accepted_prediction_tokens: null, rejected_prediction_tokens: null } },
    { prompt_tokens: 1, completion_tokens: 2, total_tokens: 4 },
  ];
  for (const usage of usages) {
    const response = await readChatCompletionResponse(Response.json(completion(usage)));
    assert.equal(validateProviderResponse(response), response);
    assert.deepEqual(response.usage, usage);
  }
});

test("unknown usage extensions are preserved without recursive numeric validation", async () => {
  const usage: OpenAIUsage = {
    ...deepSeekUsage(),
    provider_metadata: { tier: "cached", discount: -0.25, labels: ["batch"] },
    provider_units: -1,
    prompt_tokens_details: { cached_tokens: 14, provider_metadata: { mode: "cache", token_ratio: 0.5 } },
    completion_tokens_details: { reasoning_tokens: 7, future_breakdown: ["reasoning", { units: -2 }] },
  };
  const response = completion(usage);
  assert.equal(validateProviderResponse(response).usage, usage);
  const parsed = validateProviderResponse(await readChatCompletionResponse(Response.json(response)));
  assert.deepEqual(parsed.usage, usage);
});

test("malformed usage containers and known counts remain response parse errors", () => {
  const invalidCounts = [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "2", true, null, {}, []];
  const rejectsUsage = (usage: unknown, label: string) => assert.throws(
    () => validateProviderResponse(completion(usage)),
    (error: unknown) => error instanceof ProviderRequestError && error.code === "response_parse" && !error.retryable && error.recoverable,
    label,
  );
  for (const usage of [[], "usage", 0, false, 1]) rejectsUsage(usage, `container ${JSON.stringify(usage)}`);
  for (const field of ["prompt_tokens", "completion_tokens", "total_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens"]) {
    for (const amount of invalidCounts) rejectsUsage({ [field]: amount }, field);
  }
  const detailFields = {
    prompt_tokens_details: ["cached_tokens", "audio_tokens"],
    completion_tokens_details: ["audio_tokens", "reasoning_tokens", "accepted_prediction_tokens", "rejected_prediction_tokens"],
  };
  for (const [key, fields] of Object.entries(detailFields)) {
    for (const details of [[], "details", 0, false]) rejectsUsage({ [key]: details }, key);
    for (const field of fields) {
      for (const amount of invalidCounts.filter((value) => value !== null)) rejectsUsage({ [key]: { [field]: amount } }, `${key}.${field}`);
    }
  }
});

test("a model turn completes and budgets use aggregates without adding usage details", async (t) => {
  const workspace = path.join(fixtureRoot, "model-turn");
  fs.mkdirSync(workspace);
  const budgetScope = { kind: "workspace" as const, id: "workspace" };
  const governor = new ModelBudgetGovernor(workspace);
  governor.update(budgetScope, { maxTokens: 1_000, maxCostUsd: 1 }, 0);
  const states: ProviderStateEvent[] = [];
  const deltas: string[] = [];
  const dispose = registerProviderAdapter({
    id: "deepseek-usage-fixture",
    declaredSupports: { streaming: true, tool_calling: true, cancellation: true, usage_reporting: true },
    async createChatCompletion(input) {
      assert.equal(input.apiUrl, "http://127.0.0.1:9/v1");
      assert.equal(input.apiKey, "");
      assert.equal(input.stream, true);
      return textStream(deepSeekUsage());
    },
    readChatCompletion: readChatCompletionResponse,
  });
  t.after(dispose);
  const result = await processModelTurn({
    apiUrl: "http://127.0.0.1:9/v1", apiKey: "", providerId: "deepseek-usage-fixture", model: "deepseek-fixture",
    messages: [{ role: "user", content: "hello" }], fallbackMaxOutputTokens: 64, maxOutputTokens: 64,
    maxAttempts: 1, role: "code", pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
    budgetScopes: [budgetScope], onContentDelta: (delta) => deltas.push(delta), onProviderState: (event) => { states.push(event); },
    contextAudit: { storeWorkspaceDir: workspace, scope: { kind: "workspace", scopeId: "workspace" }, purpose: "agent_turn", agentId: "code", runId: "usage-run", requestId: "usage-request" },
  });
  assert.equal(result.attempts, 1);
  assert.equal(states.at(-1)?.state, "completed");
  assert.equal(result.contextManifest.status, "completed");
  assert.deepEqual(deltas, ["Hello ", "from DeepSeek"]);
  assert.deepEqual(result.usage, { promptTokens: 17, completionTokens: 9, totalTokens: 26, costUsd: 0.000035, provenance: "provider_reported" });
  assert.deepEqual(result.response.usage, deepSeekUsage());
  const budget = governor.get(budgetScope);
  assert.equal(budget.usedTokens, 26);
  assert.equal(budget.usedCostUsd, 0.000035);
  assert.deepEqual(budget.lastUsage?.provenance, { source: "provider_reported", providerId: "deepseek-usage-fixture", modelName: "deepseek-fixture", runId: "usage-run", requestId: "usage-request" });
});
