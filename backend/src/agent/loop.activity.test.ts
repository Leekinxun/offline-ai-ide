import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { runAgentLoop } from "./loop.js";
import { MessageBus } from "./messageBus.js";
import { TaskManager } from "./taskManager.js";
import { TeammateManager } from "./teammateManager.js";
import { AgentRunRecorder } from "../chat/runHistory.js";
import type { UserSession } from "../auth/sessionManager.js";
import type { WsServerMessage } from "./types.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-live-activity-"));
  fs.writeFileSync(path.join(root, "sample.ts"), "export const source = 1;\n");
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; fs.rmSync(root, { recursive: true, force: true }); });
  const taskManager = new TaskManager(root); const messageBus = new MessageBus(root);
  const session: UserSession = { token: "activity", username: "tester", workspaceDir: root, workspaceRoot: root, isAdmin: false, isolated: false, taskManager, messageBus, teammateManager: new TeammateManager(root, messageBus, taskManager) };
  const events: WsServerMessage[] = [];
  const recorder = new AgentRunRecorder(root, "run-activity", "conversation-activity", "ask");
  const execute = async () => {
    await recorder.start();
    return runAgentLoop({ readyState: WebSocket.OPEN, send() {} } as unknown as WebSocket, "Inspect sample.ts", "request-activity", session, undefined, undefined, (event) => events.push(event), undefined, undefined, undefined, { mode: "ask", modelName: "test-model", conversationId: "conversation-activity", runRecorder: recorder, isStopped: () => false, createAbortSignal: () => undefined });
  };
  return { events, execute };
}

test("run activity and reasoning are emitted before completion, followed by real tool events", async (t) => {
  const f = fixture(t);
  let writer!: ReadableStreamDefaultController<Uint8Array>; let requests = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "test-model" }] });
    requests++;
    if (requests > 1) return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Finished inspecting." } }] });
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { writer = controller; controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Provider reasoning visible during execution." } }] })}\n\n`)); } }), { headers: { "content-type": "text/event-stream" } });
  };
  const pending = f.execute();
  const deadline = Date.now() + 5000;
  while (!f.events.some((event) => event.type === "thinking")) {
    if (Date.now() > deadline) throw new Error("reasoning was not emitted while the stream was open");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(f.events.some((event) => event.type === "run_state" && event.event?.kind === "model_call" && event.requestId === "request-activity"));
  assert.equal(f.events.some((event) => event.type === "done"), false);
  writer.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "read-source", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "sample.ts" }) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`));
  writer.close();
  await pending;
  assert.ok(f.events.some((event) => event.type === "tool_call" && event.name === "read_file"));
  assert.ok(f.events.some((event) => event.type === "tool_result" && event.name === "read_file" && event.isError === false));
});

test("ordinary tool-prefacing commentary is assistant output, never fabricated model reasoning", async (t) => {
  const f = fixture(t); let requests = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "test-model" }] });
    requests++;
    return Response.json({ choices: [{ finish_reason: requests === 1 ? "tool_calls" : "stop", message: requests === 1
      ? { role: "assistant", content: "I will read the selected source.", tool_calls: [{ id: "read-source", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "sample.ts" }) } }] }
      : { role: "assistant", content: "Done." } }] });
  };
  await f.execute();
  assert.ok(f.events.some((event) => event.type === "token" && event.content.includes("I will read")));
  assert.equal(f.events.some((event) => event.type === "thinking"), false);
});
