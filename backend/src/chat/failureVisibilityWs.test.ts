import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { config } from "../config.js";
import { MessageBus } from "../agent/messageBus.js";
import { TaskManager } from "../agent/taskManager.js";
import { TeammateManager } from "../agent/teammateManager.js";
import type { UserSession } from "../auth/sessionManager.js";
import { handleChatWs } from "../ws/chat.js";
import { appendConversationMessage, listConversationSummaries } from "./history.js";
import { listRunSummaries, readRunRecord } from "./runHistory.js";
import { getActiveRunContext, listActiveRuns } from "./runCoordinator.js";

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for failure visibility evidence");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(t: test.TestContext) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-failure-visibility-ws-"));
  fs.writeFileSync(path.join(workspace, "sample.txt"), "Disposable project content\n");
  const original = { fetch: globalThis.fetch, models: config.models, profiles: config.agentProfiles, fallbacks: config.modelFallbacks };
  config.models = [{ modelName: "failure-visibility-fixture", apiUrl: "https://failure-visibility.invalid/v1", apiKey: "", maxTokens: 2048 }];
  config.agentProfiles = { code: { budget: { maxSteps: 30 } } };
  config.modelFallbacks = [];
  const taskManager = new TaskManager(workspace);
  const messageBus = new MessageBus(workspace);
  const session: UserSession = { token: "failure-visibility-fixture", username: "tester", workspaceDir: workspace, workspaceRoot: workspace,
    isAdmin: false, isolated: false, taskManager, messageBus, teammateManager: new TeammateManager(workspace, messageBus, taskManager) };
  await appendConversationMessage(workspace, "visibility-task", { role: "user", content: "Inspect the sample", timestamp: Date.now() });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  server.on("connection", (socket) => handleChatWs(socket, session, { validateSession: () => true }));
  const address = server.address(); assert(address && typeof address !== "string");
  const clients: WebSocket[] = [];
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const frames: any[] = [];
    socket.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
    clients.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    return { frames, send: (data: unknown) => socket.send(JSON.stringify(data)) };
  };
  t.after(async () => {
    for (const run of listActiveRuns(workspace)) getActiveRunContext(workspace, run.conversationId)?.forceStop();
    await waitUntil(() => !listActiveRuns(workspace).length);
    for (const client of clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    globalThis.fetch = original.fetch; config.models = original.models; config.agentProfiles = original.profiles; config.modelFallbacks = original.fallbacks;
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  return { workspace, connect };
}

test("real WS retains a 30-iteration failure cause after partial assistant text and reconnect", async (t) => {
  const f = await fixture(t);
  let requests = 0;
  globalThis.fetch = async (input) => {
    assert.ok(String(input).startsWith("https://failure-visibility.invalid/v1/"), "provider calls must stay inside the mocked fixture");
    if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "failure-visibility-fixture", max_output_tokens: 2048 }] });
    requests++;
    return Response.json({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: "I am still inspecting the project.\n",
      tool_calls: [{ id: `inspect-${requests}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "sample.txt" }) } }],
    } }] });
  };
  const client = await f.connect();
  client.send({ conversationId: "visibility-task", requestId: "limit-request", message: "Inspect repeatedly", mode: "code", modelName: "failure-visibility-fixture" });
  await waitUntil(() => client.frames.some((frame) => frame.type === "run_state" && frame.status === "failed"));
  await waitUntil(() => !listActiveRuns(f.workspace).length);
  const expected = "Agent loop exceeded maximum iterations (30)";
  const finished = client.frames.find((frame) => frame.type === "run_state" && frame.status === "failed");
  assert.equal(requests, 30);
  assert.ok(client.frames.some((frame) => frame.type === "token" && frame.content.includes("I am still inspecting")));
  assert.equal(finished.failureReason, expected);
  assert.equal(finished.event.detail, expected);
  assert.equal(client.frames.find((frame) => frame.type === "summary").failureReason, expected);
  assert.equal(readRunRecord(f.workspace, finished.runId).failureReason, expected);
  assert.equal(listRunSummaries(f.workspace)[0].failureReason, expected);
  assert.equal(listConversationSummaries(f.workspace)[0].summary?.failureReason, expected);
  const reconnected = await f.connect();
  reconnected.send({ type: "subscribe_run", conversationId: "visibility-task" });
  await waitUntil(() => reconnected.frames.some((frame) => frame.type === "conversation_snapshot"));
  const restored = reconnected.frames.find((frame) => frame.type === "conversation_snapshot").run;
  assert.equal(restored.failureReason, expected);
  assert.equal(restored.summary.failureReason, expected);
});

test("real WS exposes generic provider failures in final run state and saved summaries", async (t) => {
  const f = await fixture(t);
  globalThis.fetch = async (input) => {
    assert.ok(String(input).startsWith("https://failure-visibility.invalid/v1/"));
    if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "failure-visibility-fixture" }] });
    return Response.json({ error: { message: "Provider authentication rejected" } }, { status: 401 });
  };
  const client = await f.connect();
  client.send({ conversationId: "visibility-task", requestId: "provider-request", message: "Inspect the sample", mode: "code", modelName: "failure-visibility-fixture" });
  await waitUntil(() => client.frames.some((frame) => frame.type === "run_state" && frame.status === "failed"));
  await waitUntil(() => !listActiveRuns(f.workspace).length);
  const finished = client.frames.find((frame) => frame.type === "run_state" && frame.status === "failed");
  assert.match(finished.failureReason, /401|authentication|auth/i);
  assert.equal(finished.event.detail, finished.failureReason);
  assert.equal(listConversationSummaries(f.workspace)[0].summary?.failureReason, finished.failureReason);
});
