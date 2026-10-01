import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { authMiddleware } from "../auth/middleware.js";
import { SessionManager, sessionManager, setSessionManagerForTests } from "../auth/sessionManager.js";
import { config } from "../config.js";
import { chatRouter, probeModelHealth } from "../routes/chat.js";

async function withModelHealthApi(run: (baseUrl: string, token: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-model-health-"));
  const usersPath = path.join(root, "users.json");
  fs.writeFileSync(usersPath, JSON.stringify({
    allowedRoots: [root],
    users: [{ username: "admin", password: "secret", defaultWorkspace: root, isAdmin: true }],
  }));
  const originalManager = sessionManager;
  const manager = new SessionManager(usersPath);
  const session = manager.login("admin", "secret");
  assert.ok(session);
  setSessionManagerForTests(manager);
  const app = express();
  app.use("/api/chat", authMiddleware, chatRouter);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}/api/chat`, session.token);
  } finally {
    setSessionManagerForTests(originalManager);
    fs.rmSync(root, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("model health route keeps auth protection and probes selected configured endpoint", async (t) => {
  const previousModelName = config.modelName;
  const previousModels = config.models;
  const nativeFetch = globalThis.fetch;
  config.modelName = "default-health-model";
  config.models = [{ modelName: "selected-health-model", apiUrl: "https://selected-health.invalid/v1", apiKey: "selected-key" }];
  const calls: Array<{ url: string; authorization: string | null }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith("https://selected-health.invalid/v1/")) return nativeFetch(input, init);
    calls.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
    return Response.json({ data: [] });
  };
  t.after(() => {
    config.modelName = previousModelName;
    config.models = previousModels;
    globalThis.fetch = nativeFetch;
  });

  await withModelHealthApi(async (baseUrl, token) => {
    const anonymous = await fetch(`${baseUrl}/model-health`);
    assert.equal(anonymous.status, 401);
    assert.equal(calls.length, 0);

    const response = await fetch(`${baseUrl}/model-health?model=selected-health-model`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ready",
      modelName: "selected-health-model",
      apiUrl: "https://selected-health.invalid/v1",
    });
    assert.deepEqual(calls, [{
      url: "https://selected-health.invalid/v1/models",
      authorization: "Bearer selected-key",
    }]);
  });
});

test("model health classifies auth and provider errors without real network calls", async (t) => {
  const previousModelName = config.modelName;
  const previousApiUrl = config.vllmApiUrl;
  const previousApiKey = config.vllmApiKey;
  config.modelName = "health-default";
  config.vllmApiUrl = "https://default-health.invalid/v1";
  config.vllmApiKey = "";
  t.after(() => {
    config.modelName = previousModelName;
    config.vllmApiUrl = previousApiUrl;
    config.vllmApiKey = previousApiKey;
  });

  const authError = await probeModelHealth("health-default", {
    fetchImpl: async () => new Response("nope", { status: 403 }),
  });
  assert.equal(authError.status, "auth_error");
  assert.equal(authError.error, "Authentication failed");
  assert.equal(authError.apiUrl, "https://default-health.invalid/v1");

  const modelError = await probeModelHealth("health-default", {
    fetchImpl: async () => new Response("bad gateway", { status: 502 }),
  });
  assert.equal(modelError.status, "model_error");
  assert.equal(modelError.error, "HTTP 502");

  const unreachable = await probeModelHealth("health-default", {
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(unreachable.status, "unreachable");
  assert.equal(unreachable.error, "ECONNREFUSED");
});

test("model health reports timeout and settles the fetch after abort", async (t) => {
  const previousApiUrl = config.vllmApiUrl;
  const previousApiKey = config.vllmApiKey;
  config.vllmApiUrl = "https://timeout-health.invalid/v1";
  config.vllmApiKey = "";
  t.after(() => {
    config.vllmApiUrl = previousApiUrl;
    config.vllmApiKey = previousApiKey;
  });

  let aborted = false;
  const result = await probeModelHealth("timeout-model", {
    timeoutMs: 1,
    fetchImpl: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    }),
  });
  assert.equal(aborted, true);
  assert.equal(result.status, "timeout");
  assert.equal(result.error, "Connection timeout");
});
