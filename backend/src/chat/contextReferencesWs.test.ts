import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { config } from "../config.js";
import { readConversationMessages } from "./history.js";
import { MessageBus } from "../agent/messageBus.js";
import { TaskManager } from "../agent/taskManager.js";
import { TeammateManager } from "../agent/teammateManager.js";
import type { UserSession } from "../auth/sessionManager.js";
import { handleChatWs } from "../ws/chat.js";

function waitForEvent(ws: WebSocket, predicate: (event: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off("message", receive); reject(new Error("Timed out waiting for reference event")); }, 10_000);
    const receive = (raw: WebSocket.RawData) => {
      const event = JSON.parse(raw.toString());
      if (!predicate(event)) return;
      clearTimeout(timer); ws.off("message", receive); resolve(event);
    };
    ws.on("message", receive);
  });
}

test("WS reference delivery is workspace bound, reaches the provider, persists, and participates in idempotency", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-reference-ws-"));
  fs.writeFileSync(path.join(workspaceDir, "picked.ts"), "WS_REFERENCE_CONTENT_5479");
  const prior = { models: config.models, profiles: config.agentProfiles, fallbacks: config.modelFallbacks, fetch: globalThis.fetch };
  config.models = [{ modelName: "reference-ws", apiUrl: "https://reference-ws.invalid/v1", apiKey: "" }];
  config.agentProfiles = {}; config.modelFallbacks = [];
  const bodies: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "reference-ws", max_output_tokens: 1024 }] });
    bodies.push(String(init?.body));
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "received" } }] });
  };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  let client: WebSocket | undefined;
  t.after(async () => {
    client?.terminate();
    config.models = prior.models; config.agentProfiles = prior.profiles; config.modelFallbacks = prior.fallbacks; globalThis.fetch = prior.fetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const taskManager = new TaskManager(workspaceDir);
  const messageBus = new MessageBus(workspaceDir);
  const session: UserSession = { token: "references", username: "tester", workspaceDir, workspaceRoot: workspaceDir, isAdmin: false, isolated: false, taskManager, messageBus, teammateManager: new TeammateManager(workspaceDir, messageBus, taskManager) };
  server.on("connection", (socket) => handleChatWs(socket, session, { validateSession: () => true }));
  client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await new Promise<void>((resolve, reject) => { client!.once("open", resolve); client!.once("error", reject); });
  const request = { message: "Explain the attached code", mode: "ask", modelName: "reference-ws", contextReferences: [{ kind: "file", path: "picked.ts" }], referenceWorkspaceDir: workspaceDir };
  const wrong = waitForEvent(client, (event) => event.type === "error" && event.requestId === "wrong-workspace");
  client.send(JSON.stringify({ ...request, requestId: "wrong-workspace", referenceWorkspaceDir: `${workspaceDir}-old` }));
  assert.match(String((await wrong).content), /Workspace changed/);
  assert.equal(bodies.length, 0);
  const secret = waitForEvent(client, (event) => event.type === "error" && event.requestId === "blocked-reference");
  client.send(JSON.stringify({ ...request, requestId: "blocked-reference", contextReferences: [{ kind: "file", path: ".env" }] }));
  assert.match(String((await secret).content), /not authorized/);
  assert.equal(bodies.length, 0);

  const accepted = waitForEvent(client, (event) => event.type === "request_accepted" && event.requestId === "accepted-reference");
  const completed = waitForEvent(client, (event) => event.type === "run_state" && event.status === "completed");
  client.send(JSON.stringify({ ...request, requestId: "accepted-reference" }));
  const ack = await accepted; await completed;
  assert.ok(bodies.some((body) => body.includes("WS_REFERENCE_CONTENT_5479")));
  assert.deepEqual(readConversationMessages(workspaceDir, String(ack.conversationId))[0].contextReferences, request.contextReferences);
  const replay = waitForEvent(client, (event) => event.type === "request_accepted" && event.replayed === true);
  client.send(JSON.stringify({ ...request, requestId: "accepted-reference" }));
  await replay;
  const mismatch = waitForEvent(client, (event) => event.type === "error" && event.requestId === "accepted-reference");
  client.send(JSON.stringify({ ...request, requestId: "accepted-reference", contextReferences: [] }));
  assert.match(String((await mismatch).content), /different message/);
  assert.equal(readConversationMessages(workspaceDir, String(ack.conversationId)).filter((entry) => entry.role === "user").length, 1);
});
