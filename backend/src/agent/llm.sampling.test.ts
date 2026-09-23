import assert from "node:assert/strict";
import test from "node:test";
import { callChatCompletion } from "./llm.js";

test("chat completion sends configured sampling values, including zero", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: Record<string, unknown>[] = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ choices: [] });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await callChatCompletion({
    apiUrl: "https://model.example/v1", model: "configured", messages: [{ role: "user", content: "Hello" }],
    maxTokens: 512, temperature: 0, topP: 0, frequencyPenalty: -1.5, presencePenalty: 0,
  });
  assert.equal(requests[0].max_tokens, 512);
  assert.equal(requests[0].temperature, 0);
  assert.equal(requests[0].top_p, 0);
  assert.equal(requests[0].frequency_penalty, -1.5);
  assert.equal(requests[0].presence_penalty, 0);

  await callChatCompletion({
    apiUrl: "https://model.example/v1", model: "default", messages: [{ role: "user", content: "Hello" }], maxTokens: 256,
  });
  for (const field of ["temperature", "top_p", "frequency_penalty", "presence_penalty"]) {
    assert.equal(Object.hasOwn(requests[1], field), false);
  }
});
