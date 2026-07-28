import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyProviderHttpError,
  isContextOverflowError,
  parseRetryAfterMs,
} from "./providerErrors.js";

test("recognizes common provider context overflow responses", () => {
  assert.equal(
    isContextOverflowError({
      status: 400,
      body: '{"error":{"message":"maximum context length is 32768 tokens"}}',
    }),
    true
  );
  assert.equal(
    isContextOverflowError({ status: 413, body: "Prompt is too long for this model" }),
    true
  );
});

test("does not retry unrelated provider failures as context overflow", () => {
  assert.equal(isContextOverflowError({ status: 401, body: "invalid api key" }), false);
  assert.equal(isContextOverflowError({ status: 500, body: "maximum context length" }), false);
  assert.equal(isContextOverflowError({ status: 400, body: "invalid tool schema" }), false);
});

test("classifies retryable and terminal provider errors", () => {
  assert.deepEqual(classifyProviderHttpError({ status: 429, body: "limited" }), {
    code: "rate_limit",
    retryable: true,
  });
  assert.deepEqual(classifyProviderHttpError({ status: 401, body: "invalid key" }), {
    code: "authentication",
    retryable: false,
  });
  assert.deepEqual(classifyProviderHttpError({ status: 503, body: "unavailable" }), {
    code: "server_error",
    retryable: true,
  });
});

test("parses Retry-After seconds and dates", () => {
  assert.equal(parseRetryAfterMs("1.5"), 1500);
  assert.equal(parseRetryAfterMs("Thu, 01 Jan 1970 00:00:02 GMT", 1000), 1000);
  assert.equal(parseRetryAfterMs("invalid"), undefined);
});
