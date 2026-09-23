import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { config } from "../config.js";
import type { UserSession } from "../auth/sessionManager.js";
import { MessageBus } from "./messageBus.js";
import { TaskManager } from "./taskManager.js";
import { TeammateManager } from "./teammateManager.js";
import { runAgentLoop } from "./loop.js";

test("a selected model uses its own endpoint and API key", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-model-endpoint-"));
  const previousModels = config.models;
  const previousProfiles = config.agentProfiles;
  const previousFallbacks = config.modelFallbacks;
  const previousFetch = globalThis.fetch;
  t.after(() => {
    config.models = previousModels;
    config.agentProfiles = previousProfiles;
    config.modelFallbacks = previousFallbacks;
    globalThis.fetch = previousFetch;
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  config.models = [{ modelName: "selected-model", apiUrl: "https://selected.invalid/v1", apiKey: "selected-secret", maxTokens: 512, temperature: 0, topP: 0.7, frequencyPenalty: -0.5, presencePenalty: 1 }];
  config.agentProfiles = { ask: { budget: { maxOutputTokens: 4096 } } };
  config.modelFallbacks = [];
  const calls: Array<{ url: string; authorization: string | undefined; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    calls.push({ url, authorization: headers.get("Authorization") || undefined, body });
    if (url.endsWith("/models")) return Response.json({ data: [{ id: "selected-model", max_output_tokens: 1024 }] });
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }] });
  };

  const taskManager = new TaskManager(workspaceDir);
  const messageBus = new MessageBus(workspaceDir);
  const session = { token: "selected", username: "selected", workspaceDir, workspaceRoot: workspaceDir, isAdmin: false, isolated: false, taskManager, messageBus, teammateManager: new TeammateManager(workspaceDir, messageBus, taskManager) } as UserSession;
  await runAgentLoop({ readyState: WebSocket.OPEN, send() {} } as unknown as WebSocket, "hello", "request", session, undefined, undefined, undefined, undefined, undefined, undefined, { isStopped: () => false, createAbortSignal: () => undefined, mode: "ask", modelName: "selected-model", conversationId: "conversation" });

  const completions = calls.filter((call) => call.url.endsWith("/chat/completions"));
  assert.ok(completions.length > 0);
  assert.ok(completions.every((call) => call.url === "https://selected.invalid/v1/chat/completions"));
  assert.ok(completions.every((call) => call.authorization === "Bearer selected-secret" && call.body.model === "selected-model"));
  assert.ok(completions.every((call) => call.body.max_tokens === 512 && call.body.temperature === 0 && call.body.top_p === 0.7));
  assert.ok(completions.every((call) => call.body.frequency_penalty === -0.5 && call.body.presence_penalty === 1));
});
