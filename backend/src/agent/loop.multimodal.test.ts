import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { config } from "../config.js";
import { storeChatAttachments } from "../chat/attachments.js";
import type { UserSession } from "../auth/sessionManager.js";
import { MessageBus } from "./messageBus.js";
import { TaskManager } from "./taskManager.js";
import { TeammateManager } from "./teammateManager.js";
import { runAgentLoop } from "./loop.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

test("image-only turns and historical image references reach the selected vision model", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-loop-multimodal-"));
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

  const [attachment] = storeChatAttachments(workspaceDir, [{ originalname: "screen.png", mimetype: "image/png", buffer: PNG }]);
  config.models = [{ modelName: "vision-test", apiUrl: "https://vision.invalid/v1", apiKey: "", supportsImageInput: true }];
  config.agentProfiles = {};
  config.modelFallbacks = [];
  const requestBodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "vision-test", max_output_tokens: 1024 }, { id: "text-only", max_output_tokens: 1024 }] });
    requestBodies.push(JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: unknown }> });
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "seen" } }] });
  };

  const taskManager = new TaskManager(workspaceDir);
  const messageBus = new MessageBus(workspaceDir);
  const session = { token: "vision", username: "vision", workspaceDir, workspaceRoot: workspaceDir, isAdmin: false, isolated: false, taskManager, messageBus, teammateManager: new TeammateManager(workspaceDir, messageBus, taskManager) } as UserSession;
  const ws = { readyState: WebSocket.OPEN, send() {} } as unknown as WebSocket;
  const control = { isStopped: () => false, createAbortSignal: () => undefined, mode: "ask" as const, modelName: "vision-test", conversationId: "conversation" };

  await runAgentLoop(ws, "", "image-request", session, undefined, undefined, undefined, undefined, undefined, undefined, { ...control, attachments: [attachment] });
  assert.ok(requestBodies.length > 0);
  const firstUser = requestBodies[0].messages.find((message) => message.role === "user");
  assert.ok(Array.isArray(firstUser?.content));
  assert.ok(firstUser.content.some((part: { type: string; image_url?: { url: string } }) => part.type === "image_url" && part.image_url?.url.startsWith("data:image/png;base64,")));
  assert.equal(JSON.stringify(firstUser.content).includes("attachment_ref"), false);

  await runAgentLoop(ws, "What changed?", "follow-up", session, undefined,
    [{ role: "user", content: "Previous image", attachments: [attachment] }, { role: "assistant", content: "seen" }],
    undefined, undefined, undefined, undefined, control);
  const historicalUser = requestBodies.at(-1)?.messages.find((message) => message.role === "user" && Array.isArray(message.content));
  assert.ok(historicalUser && Array.isArray(historicalUser.content));
  assert.ok(historicalUser.content.some((part: { type: string }) => part.type === "image_url"));

  const moreAttachments = [
    ...storeChatAttachments(workspaceDir, Array.from({ length: 4 }, (_, index) => ({ originalname: `more-${index}.png`, mimetype: "image/png", buffer: PNG }))),
    ...storeChatAttachments(workspaceDir, [{ originalname: "more-4.png", mimetype: "image/png", buffer: PNG }]),
  ];
  await runAgentLoop(ws, "Summarize recent images", "bounded-history", session, undefined,
    moreAttachments.map((item) => ({ role: "user", content: "Prior image", attachments: [item] })),
    undefined, undefined, undefined, undefined, control);
  const boundedBody = requestBodies.at(-1);
  assert.ok(boundedBody);
  const boundedParts = boundedBody.messages.flatMap((message) => Array.isArray(message.content) ? message.content as Array<{ type: string; text?: string }> : []);
  assert.equal(boundedParts.filter((part) => part.type === "image_url").length, 4);
  assert.ok(JSON.stringify(boundedBody).includes("omitted"));

  await runAgentLoop(ws, "Retry the attached image", "attachment-retry", session, undefined,
    Array.from({ length: 4 }, () => ({ role: "user", content: "Earlier attempt", attachments: [attachment] })),
    undefined, undefined, undefined, undefined, { ...control, attachments: [attachment] });
  const retryBody = requestBodies.at(-1);
  assert.ok(retryBody);
  const retryParts = retryBody.messages.flatMap((message) => Array.isArray(message.content) ? message.content as Array<{ type: string }> : []);
  assert.equal(retryParts.filter((part) => part.type === "image_url").length, 4);
  assert.ok(JSON.stringify(retryBody).includes("omitted"));

  config.models.push({ modelName: "text-only", apiUrl: "https://text.invalid/v1", apiKey: "" });
  await runAgentLoop(ws, "Answer in text", "text-switch", session, undefined,
    [{ role: "user", content: "Earlier image", attachments: [attachment] }],
    undefined, undefined, undefined, undefined, { ...control, modelName: "text-only" });
  const textOnlyBody = requestBodies.at(-1);
  assert.ok(textOnlyBody);
  assert.equal(JSON.stringify(textOnlyBody).includes("image_url"), false);
  assert.ok(JSON.stringify(textOnlyBody).includes("omitted because the selected model cannot read it"));
  assert.ok(JSON.stringify(textOnlyBody).includes("untrusted data"));
});
