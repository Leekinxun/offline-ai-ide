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
import { appendConversationMessage, readConversationMessages } from "./history.js";
import { AgentRunRecorder } from "./runHistory.js";
import { createActiveRun, getActiveRunContext, listActiveRuns } from "./runCoordinator.js";
import { answerAgentQuestion, listAgentQuestions, requestAgentQuestion } from "./agentQuestions.js";

function sessionFor(workspaceDir: string): UserSession {
  const taskManager = new TaskManager(workspaceDir); const messageBus = new MessageBus(workspaceDir);
  return { token: "background-fixture", username: "tester", workspaceDir, workspaceRoot: workspaceDir, isAdmin: false, isolated: false,
    taskManager, messageBus, teammateManager: new TeammateManager(workspaceDir, messageBus, taskManager) };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 7000;
  while (!predicate()) { if (Date.now() > end) throw new Error("Timed out waiting for background run event"); await new Promise((resolve) => setTimeout(resolve, 10)); }
}

async function socketServer(session: UserSession) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  server.on("connection", (socket) => handleChatWs(socket, session, { validateSession: () => true }));
  const address = server.address(); assert(address && typeof address !== "string");
  const clients: WebSocket[] = [];
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`); const frames: any[] = [];
    socket.on("message", (raw) => frames.push(JSON.parse(raw.toString()))); clients.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    return { socket, frames, send: (message: unknown) => socket.send(JSON.stringify(message)) };
  };
  return { connect, close: async () => { for (const client of clients) client.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

test("real WS switching and reconnect recover live text and approvals without stopping background work", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-background-ws-"));
  const session = sessionFor(workspace);
  await appendConversationMessage(workspace, "task-a", { role: "user", requestId: "req-a", content: "A", timestamp: Date.now() - 10 });
  await appendConversationMessage(workspace, "task-b", { role: "user", requestId: "req-b", content: "B", timestamp: Date.now() - 5 });
  const a = new AgentRunRecorder(workspace, "run-a", "task-a", "code"); await a.start();
  const b = new AgentRunRecorder(workspace, "run-b", "task-b", "ask"); await b.start();
  const runA = createActiveRun({ session, recorder: a, queueSteering: async () => ({ ok: true, code: "accepted" }) });
  const runB = createActiveRun({ session, recorder: b, queueSteering: async () => ({ ok: true, code: "accepted" }) });
  const server = await socketServer(session);
  t.after(async () => { runA.forceStop(); runB.forceStop(); runA.finish(); runB.finish(); await server.close(); fs.rmSync(workspace, { recursive: true, force: true }); });
  const first = await server.connect();
  first.send({ type: "subscribe_run", conversationId: "task-a" });
  await waitUntil(() => first.frames.some((frame) => frame.type === "conversation_snapshot" && frame.conversationId === "task-a"));
  runA.emit({ type: "token", requestId: "req-a", content: "A partial" });
  runA.emit({ type: "context_state", requestId: "req-a", estimatedTokens: 234, threshold: 1000, status: "ready", compactionCount: 0 });
  await waitUntil(() => first.frames.some((frame) => frame.type === "token" && frame.content === "A partial"));
  const token = first.frames.find((frame) => frame.type === "token");
  assert.equal(token.conversationId, "task-a"); assert.equal(token.runId, "run-a");
  first.send({ type: "subscribe_run", conversationId: "task-b" });
  await waitUntil(() => first.frames.some((frame) => frame.type === "conversation_snapshot" && frame.conversationId === "task-b"));
  runA.emit({ type: "token", requestId: "req-a", content: " while away" });
  runB.emit({ type: "token", requestId: "req-b", content: "B partial" });
  await waitUntil(() => first.frames.some((frame) => frame.type === "token" && frame.content === "B partial"));
  assert.equal(first.frames.some((frame) => frame.type === "token" && frame.content === " while away"), false);
  assert.equal(runA.controlState.stopped, false);
  const approvalResult = runA.approvals.request({ conversationId: "task-a", requestId: "req-a", toolCallId: "tool-a", name: "write_file", input: { path: "a.txt" }, risk: "medium", reason: "write", scope: "a.txt", canAllowSession: true });
  await waitUntil(() => first.frames.some((frame) => frame.type === "background_run_state" && frame.conversationId === "task-a" && frame.waiting));
  first.socket.terminate();
  const second = await server.connect();
  second.send({ type: "subscribe_run", conversationId: "task-a" });
  await waitUntil(() => second.frames.some((frame) => frame.type === "conversation_snapshot"));
  const restored = second.frames.find((frame) => frame.type === "conversation_snapshot");
  assert.equal(restored.messages.find((message: any) => message.role === "assistant").content, "A partial while away");
  assert.deepEqual(restored.activeRequestIds, ["req-a"]);
  assert.equal(restored.pendingApprovals.length, 1);
  await waitUntil(() => second.frames.some((frame) => frame.type === "context_state" && frame.conversationId === "task-a" && frame.estimatedTokens === 234));
  const approvalId = restored.pendingApprovals[0].approvalId;
  second.send({ type: "tool_approval", conversationId: "task-b", runId: "run-b", approvalId, decision: "allow_once" });
  await waitUntil(() => second.frames.some((frame) => frame.type === "error" && /does not belong/.test(frame.content)));
  assert.equal(runA.approvals.pendingCount(), 1);
  second.send({ type: "tool_approval", conversationId: "task-a", runId: "run-a", approvalId, decision: "allow_once" });
  assert.equal(await approvalResult, "allow_once");
  second.send({ type: "stop", conversationId: "task-b", runId: "run-a", requestId: "req-a" });
  await waitUntil(() => second.frames.some((frame) => frame.type === "error" && /older run/.test(frame.content)));
  assert.equal(runB.controlState.stopped, false);
  second.send({ type: "stop", conversationId: "task-a", runId: "run-a", requestId: "req-a" });
  await waitUntil(() => runA.controlState.stopped);
  assert.equal(runB.controlState.stopped, false);
  second.send({ type: "unsubscribe_run", conversationId: "task-a" });
  second.send({ type: "subscribe_run", conversationId: "task-b" });
  await waitUntil(() => second.frames.some((frame) => frame.type === "conversation_snapshot" && frame.conversationId === "task-b"));
  assert.equal(runB.controlState.stopped, false);
});

test("real WS bulk approval ack keeps high-risk and Plan requests visible through reconnect", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-approval-ack-ws-"));
  const session = sessionFor(workspace);
  await appendConversationMessage(workspace, "approval-task", { role: "user", requestId: "request", content: "seed", timestamp: Date.now() });
  const recorder = new AgentRunRecorder(workspace, "approval-run", "approval-task", "code"); await recorder.start();
  const run = createActiveRun({ session, recorder, queueSteering: async () => ({ ok: true, code: "accepted" }) });
  const server = await socketServer(session);
  t.after(async () => { run.finish(); await server.close(); fs.rmSync(workspace, { recursive: true, force: true }); });
  const first = await server.connect();
  first.send({ type: "subscribe_run", conversationId: "approval-task" });
  await waitUntil(() => first.frames.some((frame) => frame.type === "conversation_snapshot"));
  const base = { conversationId: "approval-task", requestId: "request", toolCallId: "write", name: "write_file", input: { path: "a.ts" } as Record<string, unknown>, risk: "medium" as const, reason: "action", scope: "action", canAllowSession: true };
  const write = run.approvals.request(base);
  const high = run.approvals.request({ ...base, toolCallId: "shell", name: "bash", input: { command: "npm test" }, risk: "high" });
  const plan = run.approvals.request({ ...base, toolCallId: "plan", name: "submit_plan", canAllowSession: false });
  await waitUntil(() => first.frames.filter((frame) => frame.type === "tool_approval_request").length === 3);
  first.send({ type: "tool_approval_all", conversationId: "approval-task", runId: "stale-run" });
  await waitUntil(() => first.frames.some((frame) => frame.type === "error" && /older run/.test(frame.content)));
  assert.equal(run.approvals.pendingCount(), 3);
  assert.equal(first.frames.some((frame) => frame.type === "tool_approval_all_result"), false);
  first.send({ type: "tool_approval_all", conversationId: "approval-task", runId: "approval-run" });
  await waitUntil(() => first.frames.some((frame) => frame.type === "tool_approval_all_result"));
  const ack = first.frames.find((frame) => frame.type === "tool_approval_all_result");
  assert.equal(ack.conversationId, "approval-task"); assert.equal(ack.runId, "approval-run");
  assert.equal(ack.resolvedCount, 1); assert.equal(await write, "allow_once");
  assert.deepEqual(ack.pendingApprovals.map((item: { toolCallId: string }) => item.toolCallId), ["shell", "plan"]);
  assert.ok(ack.eventSequence > first.frames.filter((frame) => frame.type === "tool_approval_request").at(-1).eventSequence);
  first.socket.terminate();
  const second = await server.connect(); second.send({ type: "subscribe_run", conversationId: "approval-task" });
  await waitUntil(() => second.frames.some((frame) => frame.type === "conversation_snapshot"));
  const restored = second.frames.find((frame) => frame.type === "conversation_snapshot");
  assert.deepEqual(restored.pendingApprovals.map((item: { approvalId: string }) => item.approvalId), ack.pendingApprovals.map((item: { approvalId: string }) => item.approvalId));
  assert.equal(run.snapshot().waitingForInput, true);
  run.approvals.cancelAll(); assert.deepEqual(await Promise.all([high, plan]), ["deny", "deny"]);
});

test("real WS admission serializes primary Code writers while allowing concurrent Ask", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-background-writer-"));
  const session = sessionFor(workspace);
  for (const id of ["task-code-a", "task-code-b", "task-ask"]) await appendConversationMessage(workspace, id, { role: "user", content: "seed", timestamp: Date.now() });
  const original = { models: config.models, profiles: config.agentProfiles, fallbacks: config.modelFallbacks, fetch: globalThis.fetch };
  config.models = [{ modelName: "background-fixture", apiUrl: "https://background-fixture.invalid/v1", apiKey: "" }]; config.agentProfiles = {}; config.modelFallbacks = [];
  const releases: Array<() => void> = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "background-fixture", max_output_tokens: 1024 }] });
    return new Promise<Response>((resolve) => {
      const release = () => resolve(Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Finished." } }] }));
      releases.push(release);
      const signal = init?.signal; signal?.addEventListener("abort", release, { once: true });
      if (signal?.aborted) release();
    });
  };
  const server = await socketServer(session);
  t.after(async () => {
    for (const run of listActiveRuns(workspace)) getActiveRunContext(workspace, run.conversationId)?.forceStop();
    for (const release of releases) release();
    await waitUntil(() => !listActiveRuns(workspace).length);
    await server.close(); globalThis.fetch = original.fetch; config.models = original.models; config.agentProfiles = original.profiles; config.modelFallbacks = original.fallbacks;
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  const client = await server.connect();
  client.send({ conversationId: "task-code-a", requestId: "code-a", message: "First writer", mode: "code", modelName: "background-fixture" });
  client.send({ conversationId: "task-code-b", requestId: "code-b", message: "Second writer", mode: "code", modelName: "background-fixture" });
  await waitUntil(() => client.frames.some((frame) => frame.type === "error" && frame.requestId === "code-b"));
  assert.match(client.frames.find((frame) => frame.type === "error" && frame.requestId === "code-b").content, /Another Code task/);
  assert.equal(readConversationMessages(workspace, "task-code-b").some((message) => message.requestId === "code-b"), false);
  client.send({ requestId: "new-code-draft", message: "Writer from a fresh task", mode: "code", modelName: "background-fixture" });
  await waitUntil(() => client.frames.some((frame) => frame.type === "error" && frame.requestId === "new-code-draft"));
  assert.match(client.frames.find((frame) => frame.type === "error" && frame.requestId === "new-code-draft").content, /Another Code task/);
  assert.equal(client.frames.some((frame) => frame.type === "request_accepted" && frame.requestId === "new-code-draft"), false);
  client.send({ conversationId: "task-ask", requestId: "ask", message: "Explain the project", mode: "ask", modelName: "background-fixture" });
  await waitUntil(() => client.frames.some((frame) => frame.type === "request_accepted" && frame.requestId === "ask"));
  assert.equal(listActiveRuns(workspace).length, 2);
  const ask = getActiveRunContext(workspace, "task-ask")!;
  assert.throws(() => ask.setRecorder(new AgentRunRecorder(workspace, "promoted", "task-ask", "code")), /Another Code task/);
  const a = getActiveRunContext(workspace, "task-code-a")!;
  const alias = path.join(workspace, "linked-root"); fs.symlinkSync(workspace, alias, "dir");
  assert.throws(() => createActiveRun({ session: { ...session, workspaceDir: alias },
    recorder: new AgentRunRecorder(alias, "alias-code", "task-code-a", "code"),
    queueSteering: async () => ({ ok: true, code: "accepted" }),
  }), /Another Code task/);
  client.send({ type: "stop", conversationId: "task-ask", runId: ask.runId, requestId: "ask" });
  await waitUntil(() => !getActiveRunContext(workspace, "task-ask"));
  assert.equal(a.controlState.stopped, false);
});

test("background structured questions retain waiting state across reconnect and clear immediately on answer or stop", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-background-question-"));
  const session = sessionFor(workspace);
  await appendConversationMessage(workspace, "question-task", { role: "user", requestId: "question-req", content: "Clarify", timestamp: Date.now() });
  await appendConversationMessage(workspace, "visible-task", { role: "user", content: "Other task", timestamp: Date.now() });
  const recorder = new AgentRunRecorder(workspace, "question-run", "question-task", "ask"); await recorder.start();
  const run = createActiveRun({ session, recorder, queueSteering: async () => ({ ok: true, code: "accepted" }) });
  const server = await socketServer(session);
  const otherServer = await socketServer({ ...session, username: "someone-else", token: "other-owner" });
  t.after(async () => { run.forceStop(); run.finish(); await server.close(); await otherServer.close(); fs.rmSync(workspace, { recursive: true, force: true }); });
  const client = await server.connect(); const otherClient = await otherServer.connect();
  client.send({ type: "subscribe_run", conversationId: "visible-task" });
  await waitUntil(() => client.frames.some((frame) => frame.type === "conversation_snapshot"));
  const input = { workspaceDir: workspace, owner: session.username, runId: run.runId, requestId: "question-req", conversationId: "question-task", questions: [{ prompt: "Which scope?", options: ["One file", "Whole module"] }], signal: run.controlState.createAbortSignal() };
  const pending = requestAgentQuestion({ ...input, toolCallId: "question-one" });
  await waitUntil(() => client.frames.some((frame) => frame.type === "background_run_state" && frame.conversationId === "question-task" && frame.waiting));
  assert.equal(run.snapshot().pendingQuestionCount, 1); assert.equal(run.snapshot().waitingForInput, true);
  run.emit({ type: "run_state", conversationId: "question-task", runId: run.runId, mode: "ask", status: "running", metrics: recorder.snapshot().metrics });
  client.socket.terminate();
  const reconnected = await server.connect();
  await waitUntil(() => reconnected.frames.some((frame) => frame.type === "background_run_state" && frame.conversationId === "question-task" && frame.waiting));
  reconnected.send({ type: "subscribe_run", conversationId: "question-task" });
  await waitUntil(() => reconnected.frames.some((frame) => frame.type === "conversation_snapshot"));
  const restored = reconnected.frames.find((frame) => frame.type === "conversation_snapshot");
  assert.equal(restored.pendingQuestionCount, 1); assert.equal(restored.waitingForInput, true);
  const [question] = listAgentQuestions(workspace, session.username, "question-task");
  const body = { requestId: "question-req", answers: [{ id: "q1", selected: ["One file"], text: "" }] };
  assert.throws(() => answerAgentQuestion(workspace, "someone-else", question.id, body));
  assert.throws(() => answerAgentQuestion(`${workspace}-foreign`, session.username, question.id, body));
  assert.equal(run.snapshot().pendingQuestionCount, 1);
  const beforeAnswer = reconnected.frames.length;
  answerAgentQuestion(workspace, session.username, question.id, body);
  assert.equal(JSON.parse(await pending).status, "answered");
  await waitUntil(() => reconnected.frames.slice(beforeAnswer).some((frame) => frame.type === "background_run_state" && frame.conversationId === "question-task" && !frame.waiting));
  assert.equal(otherClient.frames.some((frame) => frame.conversationId === "question-task"), false);
  assert.equal(run.controlState.stopped, false);
  const second = requestAgentQuestion({ ...input, toolCallId: "question-two" });
  assert.equal(run.snapshot().pendingQuestionCount, 1);
  run.forceStop(); await second;
  assert.equal(run.snapshot().pendingQuestionCount, 0); assert.equal(run.snapshot().waitingForInput, false);
  assert.equal(listAgentQuestions(workspace, session.username, "question-task").length, 0);
});
