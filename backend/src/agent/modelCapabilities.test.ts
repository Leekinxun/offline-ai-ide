import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { getModelCapabilities } from "./modelCapabilities.js";

test("detects output and context limits from an OpenAI-compatible model endpoint", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          data: [{ id: "demo", max_output_tokens: 4096, context_length: 32768 }],
        })
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");

  const capabilities = await getModelCapabilities({
    apiUrl: `http://127.0.0.1:${address.port}/v1`,
    modelName: "demo",
    fallbackMaxOutputTokens: 8192,
  }, true);

  assert.equal(capabilities.maxOutputTokens, 4096);
  assert.equal(capabilities.contextWindow, 32768);
  assert.equal(capabilities.source, "model_metadata");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("continues probing when the first model response has no capability metadata", async () => {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "demo" }] }));
      return;
    }
    if (request.url === "/v1/models/demo") {
      response.end(JSON.stringify({ id: "demo", context_window: 16384 }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");

  const capabilities = await getModelCapabilities({
    apiUrl: `http://127.0.0.1:${address.port}/v1`,
    modelName: "demo",
  }, true);

  assert.equal(capabilities.contextWindow, 16384);
  assert.equal(capabilities.source, "context_window");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
