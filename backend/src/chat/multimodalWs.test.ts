import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { config } from "../config.js";
import { storeChatAttachments } from "./attachments.js";
import { readConversationMessages } from "./history.js";
import { MessageBus } from "../agent/messageBus.js";
import { TaskManager } from "../agent/taskManager.js";
import { TeammateManager } from "../agent/teammateManager.js";
import type { UserSession } from "../auth/sessionManager.js";
import { handleChatWs } from "../ws/chat.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

async function waitForEvent(ws: WebSocket, predicate: (event: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off("message", onMessage); reject(new Error("Timed out waiting for chat event")); }, 5_000);
    const onMessage = (raw: WebSocket.RawData) => {
      const event = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (!predicate(event)) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(event);
    };
    ws.on("message", onMessage);
  });
}

test("chat WS rejects unsupported attachments before accepting and ACKs accepted image-only turns", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-mm-ws-"));
  const priorModels = config.models;
  const priorProfiles = config.agentProfiles;
  const priorFallbacks = config.modelFallbacks;
  const priorFetch = globalThis.fetch;
  config.models = [
    { modelName: "text-ws", apiUrl: "https://text-ws.invalid/v1", apiKey: "" },
    { modelName: "vision-ws", apiUrl: "https://vision-ws.invalid/v1", apiKey: "", supportsImageInput: true },
  ];
  config.agentProfiles = {};
  config.modelFallbacks = [];
  globalThis.fetch = async (input) => String(input).endsWith("/models")
    ? Response.json({ data: [{ id: "vision-ws", max_output_tokens: 1024 }] })
    : Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "image received" } }] });
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  let client: WebSocket | undefined;
  t.after(async () => {
    client?.terminate();
    config.models = priorModels;
    config.agentProfiles = priorProfiles;
    config.modelFallbacks = priorFallbacks;
    globalThis.fetch = priorFetch;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  assert(address && typeof address !== "string");
  const taskManager = new TaskManager(workspaceDir);
  const messageBus = new MessageBus(workspaceDir);
  const session = { token: "ws", username: "tester", workspaceDir, workspaceRoot: workspaceDir, isAdmin: false, isolated: false, taskManager, messageBus, teammateManager: new TeammateManager(workspaceDir, messageBus, taskManager) } as UserSession;
  wss.on("connection", (serverSocket) => handleChatWs(serverSocket, session, { validateSession: () => true }));
  client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await new Promise<void>((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
  const [attachment] = storeChatAttachments(workspaceDir, [{ originalname: "image.png", mimetype: "image/png", buffer: PNG }]);

  const rejected = waitForEvent(client, (event) => event.type === "error" && event.requestId === "unsupported");
  client.send(JSON.stringify({ requestId: "unsupported", message: "", attachments: [attachment.id], mode: "ask", modelName: "text-ws" }));
  assert.match(String((await rejected).content), /not configured for image input/);
  assert.equal(fs.readdirSync(path.join(workspaceDir, ".history")).filter((name) => name.endsWith(".jsonl")).length, 0);

  const missing = waitForEvent(client, (event) => event.type === "error" && event.requestId === "missing");
  client.send(JSON.stringify({ requestId: "missing", message: "", attachments: [attachment.id], conversationId: "not-here", mode: "ask", modelName: "vision-ws" }));
  assert.match(String((await missing).content), /Conversation not found/);

  const accepted = waitForEvent(client, (event) => event.type === "request_accepted" && event.requestId === "accepted");
  const completed = waitForEvent(client, (event) => event.type === "run_state" && event.status === "completed" && Boolean(event.conversationId));
  client.send(JSON.stringify({ requestId: "accepted", message: "", attachments: [attachment.id], mode: "ask", modelName: "vision-ws" }));
  const ack = await accepted;
  await completed;
  assert.equal(ack.requestId, "accepted");
  assert.equal(typeof ack.conversationId, "string");
  const messages = readConversationMessages(workspaceDir, String(ack.conversationId));
  assert.equal(messages[0]?.attachments?.[0]?.id, attachment.id);
  assert.equal(messages[0]?.requestId, "accepted");
  assert.equal(messages[0]?.content, "");

  const duplicateAck = waitForEvent(client, (event) => event.type === "request_accepted" && event.requestId === "accepted");
  client.send(JSON.stringify({ requestId: "accepted", message: "", attachments: [attachment.id], mode: "ask", modelName: "vision-ws" }));
  assert.equal((await duplicateAck).conversationId, ack.conversationId);
  assert.equal(readConversationMessages(workspaceDir, String(ack.conversationId)).filter((message) => message.role === "user").length, 1);

  config.models = [
    { modelName: "text-ws", apiUrl: "https://text-ws.invalid/v1", apiKey: "" },
    { modelName: "vision-ws", apiUrl: "https://vision-ws.invalid/v1", apiKey: "", supportsImageInput: false },
  ];
  const replayAck = waitForEvent(client, (event) => event.type === "request_accepted" && event.requestId === "accepted" && event.replayed === true);
  const replayDone = waitForEvent(client, (event) => event.type === "done" && event.requestId === "accepted");
  client.send(JSON.stringify({ requestId: "accepted", message: "", attachments: [attachment.id], mode: "ask", modelName: "vision-ws" }));
  assert.equal((await replayAck).conversationId, ack.conversationId);
  await replayDone;

  const mismatch = waitForEvent(client, (event) => event.type === "error" && event.requestId === "accepted");
  client.send(JSON.stringify({ requestId: "accepted", message: "edited", attachments: [attachment.id], mode: "ask", modelName: "vision-ws" }));
  assert.match(String((await mismatch).content), /different message/);
  assert.equal(readConversationMessages(workspaceDir, String(ack.conversationId)).filter((message) => message.role === "user").length, 1);
});
