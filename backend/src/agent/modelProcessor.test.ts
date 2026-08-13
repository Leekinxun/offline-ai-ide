import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { processModelTurn } from "./modelProcessor.js";
import { ProviderRequestError } from "./providerErrors.js";

const completion = {
  choices: [{
    message: { role: "assistant", content: "ok" },
    finish_reason: "stop",
  }],
};

const manifestWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-model-manifest-"));

function baseOptions(apiUrl = "http://provider.test/v1") {
  return {
    apiUrl,
    model: "test-model",
    messages: [{ role: "user" as const, content: "hello" }],
    fallbackMaxOutputTokens: 1000,
    maxOutputTokens: 1000,
    retryBaseDelayMs: 0,
    contextAudit: {
      storeWorkspaceDir: manifestWorkspace,
      scope: { kind: "workspace" as const, scopeId: "model-processor-tests" },
      purpose: "agent_turn" as const,
      agentId: "test-agent",
    },
  };
}

test("retries a rate limit response and respects a zero Retry-After", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } })
      : Response.json(completion);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const retries: number[] = [];
  const result = await processModelTurn({
    ...baseOptions(),
    onRetry: (event) => retries.push(event.delayMs),
  });
  assert.equal(result.attempts, 2);
  assert.equal(result.response.choices[0].message.content, "ok");
  assert.deepEqual(retries, [0]);
});

test("retries transient server and network failures", async (t) => {
  const originalFetch = globalThis.fetch;
  const outcomes: Array<Error | Response> = [
    new TypeError("socket reset"),
    new Response("unavailable", { status: 503 }),
    Response.json(completion),
  ];
  globalThis.fetch = async () => {
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return outcome as Response;
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await processModelTurn(baseOptions());
  assert.equal(result.attempts, 3);
});

test("surfaces context overflow without provider retry", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("maximum context length exceeded", { status: 400 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    processModelTurn(baseOptions()),
    (error: unknown) => {
      assert.ok(error instanceof ProviderRequestError);
      assert.equal(error.code, "context_overflow");
      assert.equal(error.attempts, 1);
      return true;
    }
  );
  assert.equal(calls, 1);
});

test("does not replay a stream after emitting a delta", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: not-json\n\n',
      { headers: { "content-type": "text/event-stream" } }
    );
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const deltas: string[] = [];
  await assert.rejects(
    processModelTurn({ ...baseOptions(), onContentDelta: (delta) => deltas.push(delta) }),
    (error: unknown) => error instanceof ProviderRequestError && error.code === "response_parse"
  );
  assert.equal(calls, 1);
  assert.deepEqual(deltas, ["partial"]);
});

test("redacts a detached copy of model-visible request content", async (t) => {
  const originalFetch = globalThis.fetch;
  const canary = "sk-test_MODEL_CANARY_123456";
  let requestBody = "";
  globalThis.fetch = async (_input, init) => {
    requestBody = String(init?.body || "");
    return Response.json(completion);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const messages = [{ role: "user" as const, content: `safe code(); token=${canary}` }];
  await processModelTurn({
    ...baseOptions(),
    systemPrompt: `Use https://user:${canary}@provider.test/?api_key=${canary}`,
    messages,
    tools: [{
      type: "function",
      function: {
        name: "safe_tool",
        description: `Bearer ${canary}`,
        parameters: { type: "object", properties: { token: { default: canary }, safe: { default: "code()" } } },
      },
    }],
  });

  assert.doesNotMatch(requestBody, new RegExp(canary));
  assert.match(requestBody, /safe code\(\)/);
  assert.match(requestBody, /code\(\)/);
  assert.match(messages[0].content || "", new RegExp(canary));
});

test("does not expose provider response secrets in thrown errors", async (t) => {
  const originalFetch = globalThis.fetch;
  const canary = "sk-test_PROVIDER_CANARY_123456";
  globalThis.fetch = async () => new Response(`provider failure token=${canary}`, { status: 400 });
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(processModelTurn(baseOptions()), (error: unknown) => {
    assert.ok(error instanceof ProviderRequestError);
    assert.doesNotMatch(error.message, new RegExp(canary));
    assert.doesNotMatch(error.body || "", new RegExp(canary));
    return true;
  });
});
