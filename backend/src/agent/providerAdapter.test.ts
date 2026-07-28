import assert from "node:assert/strict";
import test from "node:test";
import {
  getProviderAdapter,
  listProviderAdapters,
  registerProviderAdapter,
} from "./providerAdapter.js";

test("registers provider adapters without coupling the processor to one SDK", (t) => {
  const dispose = registerProviderAdapter({
    id: "test-adapter",
    createChatCompletion: async () => Response.json({}),
    readChatCompletion: async () => ({ choices: [] }),
  });
  t.after(dispose);
  assert.equal(getProviderAdapter("test-adapter").id, "test-adapter");
  assert.ok(listProviderAdapters().includes("openai-compatible"));
  assert.throws(() => registerProviderAdapter(getProviderAdapter("test-adapter")), /already registered/);
});
