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
import { bindConfiguredFallbacks, buildProviderExecutionContract } from "./providerRouting.js";

function session(workspaceDir: string): UserSession {
  const taskManager = new TaskManager(workspaceDir);
  const messageBus = new MessageBus(workspaceDir);
  return { token: "fallback", username: "fallback", workspaceDir, workspaceRoot: workspaceDir, isAdmin: false, isolated: false, taskManager, messageBus, teammateManager: new TeammateManager(workspaceDir, messageBus, taskManager) };
}

test("production agent loop uses configured fallback order under the exact effective authority contract", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-production-fallback-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const priorUrl = config.vllmApiUrl;
  const priorFallbacks = config.modelFallbacks;
  const priorFetch = globalThis.fetch;
  config.vllmApiUrl = "https://primary.invalid/v1";
  config.modelFallbacks = [
    { apiUrl: "https://eligible.invalid/v1", model: "eligible" },
    { apiUrl: "https://unused.invalid/v1", model: "unused" },
  ];
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("https://primary.invalid")) return new Response("busy", { status: 503 });
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }] });
  };
  t.after(() => { config.vllmApiUrl = priorUrl; config.modelFallbacks = priorFallbacks; globalThis.fetch = priorFetch; });

  await runAgentLoop({ readyState: WebSocket.OPEN, send() {} } as unknown as WebSocket, "status", "request", session(workspaceDir), undefined, undefined, undefined, undefined, undefined, undefined, { isStopped: () => false, createAbortSignal: () => undefined, mode: "ask", modelName: "primary", conversationId: "conversation" });
  assert.ok(calls.filter((url) => url.startsWith("https://primary.invalid")).length >= 3);
  assert.ok(calls.some((url) => url.startsWith("https://eligible.invalid")));
  assert.equal(calls.some((url) => url.startsWith("https://unused.invalid")), false);

  const contract = buildProviderExecutionContract({ id: "effective", permissions: ["read_file"], isolation: "workspace", tools: ["read_file"] });
  const bound = bindConfiguredFallbacks(config.modelFallbacks.map((candidate) => ({ ...candidate, maxOutputTokens: 10_000 })), contract, 64);
  assert.ok(bound.every((candidate) => candidate.executionContract === contract));
  assert.deepEqual(bound.map((candidate) => candidate.executionContract.permissions), [["read_file"], ["read_file"]]);
  assert.deepEqual(bound.map((candidate) => candidate.maxOutputTokens), [64, 64]);
});
