import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { MessageBus } from "../agent/messageBus.js";
import { TaskManager } from "../agent/taskManager.js";
import { TeammateManager } from "../agent/teammateManager.js";
import type { UserSession } from "../auth/sessionManager.js";
import { config } from "../config.js";
import { handleChatWs } from "../ws/chat.js";
import { listCheckpoints } from "./checkpoints.js";
import { getActiveRunContext, listActiveRuns } from "./runCoordinator.js";
import { readRunRecord } from "./runHistory.js";
import { appendConversationMessage } from "./history.js";
import { listExternalToolEffects } from "./externalToolEffects.js";

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for large workspace WS run");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function writeManyFiles(workspace: string): void {
  const root = path.join(workspace, "many");
  fs.mkdirSync(root, { recursive: true });
  for (let index = 0; index <= 20_000; index += 1) {
    fs.writeFileSync(path.join(root, `file-${index}.txt`), "x");
  }
}

function writeLargeFiles(workspace: string): void {
  const root = path.join(workspace, "large");
  fs.mkdirSync(root, { recursive: true });
  const chunk = Buffer.alloc(2 * 1024 * 1024, "a");
  for (let index = 0; index < 33; index += 1) {
    fs.writeFileSync(path.join(root, `blob-${index}.bin`), chunk);
  }
}

async function fixture(t: test.TestContext, populate: (workspace: string) => void) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-large-ws-"));
  populate(workspace);
  await appendConversationMessage(workspace, "large-ws-task", { role: "user", content: "Inspect this workspace", timestamp: Date.now() });
  const original = { fetch: globalThis.fetch, models: config.models, profiles: config.agentProfiles, fallbacks: config.modelFallbacks };
  config.models = [{ modelName: "large-workspace-ws", apiUrl: "https://large-workspace.invalid/v1", apiKey: "", maxTokens: 1024 }];
  config.agentProfiles = { code: { budget: { maxSteps: 3 } } };
  config.modelFallbacks = [];
  const taskManager = new TaskManager(workspace);
  const messageBus = new MessageBus(workspace);
  const session: UserSession = {
    token: "large-workspace-ws",
    username: "tester",
    workspaceDir: workspace,
    workspaceRoot: workspace,
    isAdmin: false,
    isolated: false,
    taskManager,
    messageBus,
    teammateManager: new TeammateManager(workspace, messageBus, taskManager),
  };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  server.on("connection", (socket) => handleChatWs(socket, session, { validateSession: () => true }));
  const address = server.address();
  assert(address && typeof address !== "string");
  const clients: WebSocket[] = [];
  const connect = async (approveTools = false) => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const frames: any[] = [];
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      frames.push(frame);
      if (approveTools && frame.type === "tool_approval_request") {
        socket.send(JSON.stringify({ type: "tool_approval", conversationId: frame.conversationId, runId: frame.runId, approvalId: frame.approvalId, decision: "allow_once" }));
      }
    });
    clients.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    return { frames, send: (message: unknown) => socket.send(JSON.stringify(message)) };
  };
  t.after(async () => {
    for (const run of listActiveRuns(workspace)) getActiveRunContext(workspace, run.conversationId)?.forceStop();
    await waitUntil(() => !listActiveRuns(workspace).length);
    for (const client of clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    globalThis.fetch = original.fetch;
    config.models = original.models;
    config.agentProfiles = original.profiles;
    config.modelFallbacks = original.fallbacks;
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  return { workspace, connect };
}

async function runCodeTurn(f: Awaited<ReturnType<typeof fixture>>, requestId: string, approveTools = false) {
  const client = await f.connect(approveTools);
  client.send({ conversationId: "large-ws-task", requestId, message: "Handle this request.", mode: "code", modelName: "large-workspace-ws" });
  await waitUntil(() => client.frames.some((frame) => frame.type === "run_state" && ["completed", "failed"].includes(frame.status)));
  await waitUntil(() => !listActiveRuns(f.workspace).length);
  const finalState = client.frames.find((frame) => frame.type === "run_state" && ["completed", "failed"].includes(frame.status));
  assert.ok(finalState);
  return { client, finalState };
}

function assertNoRunCheckpoint(workspace: string, runId: string, frames: any[]): void {
  assert.equal(listCheckpoints(workspace).some((checkpoint) => checkpoint.kind === "run" && checkpoint.runId === runId), false);
  assert.equal(frames.some((frame) => frame.type === "tool_result" && frame.toolName === "workspace_checkpoint"), false);
  assert.equal(readRunRecord(workspace, runId).events.some((event) => event.kind === "tool_result" && event.toolName === "workspace_checkpoint"), false);
}

test("code WS starts and reaches the provider when checkpointable file count exceeds the run snapshot limit", async (t) => {
  const f = await fixture(t, writeManyFiles);
  let requests = 0;
  globalThis.fetch = async (input) => {
    assert.ok(String(input).startsWith("https://large-workspace.invalid/v1/"), "provider calls must stay inside the mocked fixture");
    if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "large-workspace-ws", max_output_tokens: 1024 }] });
    requests += 1;
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }] });
  };
  const { client, finalState } = await runCodeTurn(f, "many-files");
  assert.ok(requests > 0);
  assert.equal(finalState.status, "completed");
  assertNoRunCheckpoint(f.workspace, finalState.runId, client.frames);
});

test("code WS starts and reaches the provider when checkpointable bytes exceed the run snapshot limit", async (t) => {
  const f = await fixture(t, writeLargeFiles);
  let requests = 0;
  globalThis.fetch = async (input) => {
    assert.ok(String(input).startsWith("https://large-workspace.invalid/v1/"), "provider calls must stay inside the mocked fixture");
    if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "large-workspace-ws", max_output_tokens: 1024 }] });
    requests += 1;
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }] });
  };
  const { client, finalState } = await runCodeTurn(f, "large-bytes");
  assert.ok(requests > 0);
  assert.equal(finalState.status, "completed");
  assertNoRunCheckpoint(f.workspace, finalState.runId, client.frames);
});

test("code WS still fails when the provider fails after skipping the run checkpoint", async (t) => {
  const f = await fixture(t, writeManyFiles);
  let requests = 0;
  globalThis.fetch = async (input) => {
    assert.ok(String(input).startsWith("https://large-workspace.invalid/v1/"), "provider calls must stay inside the mocked fixture");
    if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "large-workspace-ws", max_output_tokens: 1024 }] });
    requests += 1;
    return Response.json({ error: { message: "Provider rejected the request" } }, { status: 503 });
  };
  const { client, finalState } = await runCodeTurn(f, "provider-fails");
  assert.ok(requests > 0);
  assert.equal(finalState.status, "failed");
  assert.match(finalState.failureReason, /503|provider rejected/i);
  assertNoRunCheckpoint(f.workspace, finalState.runId, client.frames);
});

for (const [limit, populate] of [["file-count", writeManyFiles], ["total-bytes", writeLargeFiles]] as const) {
  test(`code WS executes a command beyond the old checkpoint ${limit} limit with explicit effects coverage`, async (t) => {
    const f = await fixture(t, populate);
    let requests = 0;
    globalThis.fetch = async (input) => {
      assert.ok(String(input).startsWith("https://large-workspace.invalid/v1/"));
      if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "large-workspace-ws", max_output_tokens: 1024 }] });
      requests++;
      return Response.json({ choices: [requests === 1 ? {
        finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{
          id: "large-ws-command", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf verified > generated.txt" }) },
        }] },
      } : { finish_reason: "stop", message: { role: "assistant", content: "done" } }] });
    };
    const { client, finalState } = await runCodeTurn(f, `command-${limit}`, true);
    assert.ok(client.frames.some((frame) => frame.type === "tool_approval_request"));
    assert.equal(finalState.status, "completed", finalState.failureReason);
    assert.equal(fs.readFileSync(path.join(f.workspace, "generated.txt"), "utf8"), "verified");
    const run = readRunRecord(f.workspace, finalState.runId);
    assert.equal(run.toolExecutions.find((tool) => tool.toolCallId === "large-ws-command")?.rollbackCoverage, "untracked");
    assert.equal(listExternalToolEffects(f.workspace, { runId: finalState.runId })[0]?.rollbackCoverage, "untracked");
    assert.deepEqual(listCheckpoints(f.workspace), []);
    assertNoRunCheckpoint(f.workspace, finalState.runId, client.frames);
  });
}
