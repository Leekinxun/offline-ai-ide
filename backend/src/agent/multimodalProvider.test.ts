import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compactMessages, estimateMessageTokens } from "./context.js";
import { estimateModelRequest } from "./modelBudget.js";
import { processModelTurn } from "./modelProcessor.js";
import { registerProviderAdapter } from "./providerAdapter.js";
import type { ProviderExecutionContract } from "./providerConformance.js";
import { ProviderRequestError } from "./providerErrors.js";
import type { OpenAIMessage } from "./types.js";

const contract: ProviderExecutionContract = {
  id: "multimodal-test", permissions: [], isolation: "workspace", tools: [],
};
const image = { id: "image-1", name: "screen.png", mimeType: "image/png", size: 500_000, kind: "image" as const };
const pdf = { id: "pdf-1", name: "design.pdf", mimeType: "application/pdf", size: 1_000_000, kind: "pdf" as const };
const messages: OpenAIMessage[] = [{
  role: "user",
  content: [{ type: "text", text: "Read both" }, { type: "attachment_ref", attachment: image }, { type: "attachment_ref", attachment: pdf }],
}];

function workspace(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-multimodal-provider-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function options(root: string, providerId: string) {
  return {
    apiUrl: "https://provider.invalid/v1", providerId, model: "primary", messages,
    fallbackMaxOutputTokens: 64, maxOutputTokens: 64, maxAttempts: 1,
    role: "ask" as const, executionContract: contract,
    contextAudit: { storeWorkspaceDir: root, scope: { kind: "workspace" as const, scopeId: "workspace" }, purpose: "agent_turn" as const, agentId: "ask" },
  };
}

test("image and PDF references require both model capabilities before provider egress", async (t) => {
  const root = workspace(t);
  let calls = 0;
  const dispose = registerProviderAdapter({
    id: "multimodal-required", declaredSupports: { streaming: true, cancellation: true },
    async createChatCompletion() { calls += 1; return Response.json({}); },
    async readChatCompletion() { return { choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }; },
  });
  t.after(dispose);
  await assert.rejects(
    processModelTurn({ ...options(root, "multimodal-required"), inputCapabilities: { image_input: true, pdf_input: false } }),
    (error: unknown) => error instanceof ProviderRequestError && error.code === "capability_mismatch" && /pdf_input/.test(error.message),
  );
  assert.equal(calls, 0);
});

test("fallback rechecks attachment capabilities and keeps the same references", async (t) => {
  const root = workspace(t);
  const seen: OpenAIMessage[][] = [];
  const dispose = registerProviderAdapter({
    id: "multimodal-fallback", declaredSupports: { streaming: true, cancellation: true },
    async createChatCompletion(input) { seen.push(input.messages); return Response.json({}); },
    async readChatCompletion() { return { choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }; },
  });
  t.after(dispose);
  const result = await processModelTurn({
    ...options(root, "multimodal-fallback"),
    inputCapabilities: { image_input: false, pdf_input: false },
    fallbacks: [{ apiUrl: "https://fallback.invalid/v1", providerId: "multimodal-fallback", model: "fallback", maxOutputTokens: 64, inputCapabilities: { image_input: true, pdf_input: true }, executionContract: contract }],
  });
  assert.equal(result.fallbackIndex, 1);
  assert.deepEqual(seen, [messages]);
  assert.equal(result.contextManifest.items.some((item) => item.kind === "conversation_message"), true);
  const persisted = fs.readFileSync(path.join(root, ".history", "context-manifests", `${result.contextManifest.manifestId}.json`), "utf8");
  assert.equal(persisted.includes("data:image/"), false);
  assert.equal(persisted.includes("data:application/pdf"), false);
});

test("media allowances are bounded and do not count Base64 as text", () => {
  const textOnly: OpenAIMessage[] = [{ role: "user", content: "Read both" }];
  const contextDelta = estimateMessageTokens(messages) - estimateMessageTokens(textOnly);
  const budgetDelta = estimateModelRequest({ messages, maxOutputTokens: 0 }).inputTokens
    - estimateModelRequest({ messages: textOnly, maxOutputTokens: 0 }).inputTokens;
  assert.ok(contextDelta > 2048);
  assert.ok(contextDelta < 25_000);
  assert.ok(budgetDelta > 2048);
  assert.ok(budgetDelta < 25_000);
});

test("missing attachment bytes fail before HTTP without retry", async (t) => {
  const root = workspace(t);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({}); };
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(processModelTurn({
    ...options(root, "openai-compatible"),
    messages: [{ role: "user", content: [{ type: "attachment_ref", attachment: {
      id: "att-00000000-0000-0000-0000-000000000000", name: "missing.png", mimeType: "image/png", size: 100, kind: "image",
    } }] }],
    inputCapabilities: { image_input: true },
    maxAttempts: 3,
  }), (error: unknown) => error instanceof ProviderRequestError && error.code === "invalid_request" && error.attempts === 1);
  assert.equal(calls, 0);
});

test("compaction transcripts and summary requests retain references without binary data", async (t) => {
  const root = workspace(t);
  const originalFetch = globalThis.fetch;
  let providerBody = "";
  globalThis.fetch = async (_input, init) => {
    providerBody = String(init?.body);
    return Response.json({ choices: [{ message: { role: "assistant", content: "Earlier user attached a screenshot." }, finish_reason: "stop" }] });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const compacted = await compactMessages({
    workspaceDir: root, apiUrl: "https://provider.invalid/v1", model: "text-model",
    messages: [messages[0], { role: "assistant", content: "I saw the files." }, { role: "user", content: "Continue" }],
  });
  const transcript = fs.readFileSync(path.join(root, compacted.transcriptPath), "utf8");
  assert.match(transcript, /attachment_ref/);
  assert.match(providerBody, /attachment_ref/);
  assert.equal(transcript.includes("data:image/"), false);
  assert.equal(transcript.includes("data:application\/pdf"), false);
  assert.equal(providerBody.includes("data:image/"), false);
  assert.equal(providerBody.includes("data:application\/pdf"), false);
});
