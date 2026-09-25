import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { MessageBus } from "../agent/messageBus.js";
import { TaskManager } from "../agent/taskManager.js";
import { TeammateManager } from "../agent/teammateManager.js";
import type { UserSession } from "../auth/sessionManager.js";
import { config } from "../config.js";
import { setActiveTeamId, setTeamManagerForTests } from "../team/sessionBridge.js";
import { TeamManager } from "../team/teamManager.js";
import { handleChatWs, startMobileRun } from "../ws/chat.js";
import { appendConversationMessage, readConversationMessages } from "./history.js";
import { AgentRunRecorder, readRunRecord } from "./runHistory.js";
import {
  createActiveRun,
  dispatchRunCommand,
  getActiveRun,
  listPendingApprovals,
  stopRunsForSession,
  subscribeRunEvents,
} from "./runCoordinator.js";

function sessionFor(workspaceDir: string): UserSession {
  const taskManager = new TaskManager(workspaceDir);
  const messageBus = new MessageBus(workspaceDir);
  return {
    token: crypto.randomUUID(), username: "operator", workspaceDir, workspaceRoot: workspaceDir,
    isAdmin: false, isolated: false, taskManager, messageBus,
    teammateManager: new TeammateManager(workspaceDir, messageBus, taskManager),
  };
}

async function waitFor(predicate: () => boolean, debug?: () => unknown): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for run state: ${JSON.stringify(debug?.())}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly frames: Array<Record<string, unknown>> = [];
  send(serialized: string): void { this.frames.push(JSON.parse(serialized) as Record<string, unknown>); }
  close(): void { this.readyState = WebSocket.CLOSED; this.emit("close"); }
  receive(message: Record<string, unknown>): void { this.emit("message", Buffer.from(JSON.stringify(message))); }
}

test("shared run decisions are first-wins and mobile cannot approve high-risk actions", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-shared-run-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const session = sessionFor(workspaceDir);
  const recorder = new AgentRunRecorder(workspaceDir, "run-1", "conversation-1", "ask");
  const eventsA: string[] = [];
  const eventsB: string[] = [];
  const unsubscribeA = subscribeRunEvents(workspaceDir, (event) => eventsA.push(event.payload.type));
  const unsubscribeB = subscribeRunEvents(workspaceDir, (event) => eventsB.push(event.payload.type));
  const run = createActiveRun({
    session, recorder,
    queueSteering: async () => ({ ok: true, code: "accepted" }),
  });
  t.after(() => { run.finish(); unsubscribeA(); unsubscribeB(); });

  const lowDecision = run.approvals.request({
    conversationId: "conversation-1", requestId: "request-1", toolCallId: "tool-1",
    name: "write_file", input: { path: "src/app.ts" }, risk: "medium", reason: "Edit file",
    scope: "src/app.ts", canAllowSession: true,
  });
  const low = listPendingApprovals(workspaceDir)[0]!;
  assert.equal(low.runId, "run-1");
  assert.deepEqual(low.allowedDecisions, ["deny", "allow_once"]);
  const first = await dispatchRunCommand(session, {
    source: "mobile", type: "tool_approval", conversationId: "conversation-1",
    runId: "run-1", approvalId: low.approvalId, decision: "allow_once",
  });
  const second = await dispatchRunCommand(session, {
    source: "web", type: "tool_approval", conversationId: "conversation-1",
    runId: "run-1", approvalId: low.approvalId, decision: "deny",
  });
  assert.equal(first.code, "accepted");
  assert.equal(second.code, "conflict");
  assert.equal(await lowDecision, "allow_once");

  const highDecision = run.approvals.request({
    conversationId: "conversation-1", requestId: "request-2", toolCallId: "tool-2",
    name: "bash", input: { command: "echo safe" }, risk: "high", reason: "Shell command",
    scope: "echo safe", canAllowSession: false,
  });
  const high = listPendingApprovals(workspaceDir)[0]!;
  assert.deepEqual(high.allowedDecisions, ["deny"]);
  assert.equal((await dispatchRunCommand(session, {
    source: "mobile", type: "tool_approval", conversationId: "conversation-1",
    runId: "run-1", approvalId: high.approvalId, decision: "allow_once",
  })).code, "forbidden");
  assert.equal((await dispatchRunCommand(session, {
    source: "mobile", type: "tool_approval", conversationId: "conversation-1",
    runId: "run-1", approvalId: high.approvalId, decision: "deny",
  })).code, "accepted");
  assert.equal(await highDecision, "deny");
  assert.deepEqual(eventsA, ["tool_approval_request", "tool_approval_request"]);
  assert.deepEqual(eventsB, eventsA);

  unsubscribeA();
  assert.equal((await dispatchRunCommand(session, {
    source: "mobile", type: "stop", conversationId: "conversation-1", runId: "run-1",
  })).code, "accepted");
  assert.equal(run.controlState.createAbortSignal().aborted, true);
  assert.equal(eventsA.includes("stopped"), false);
  assert.equal(eventsB.at(-1), "stopped");
  assert.equal(getActiveRun(workspaceDir, "conversation-1")?.status, "stopping");
});

test("role downgrade blocks both shared commands and chat WebSocket mutations", async (t) => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-run-role-"));
  const workspaceDir = path.join(outer, "workspace");
  fs.mkdirSync(workspaceDir);
  const manager = new TeamManager(outer);
  setTeamManagerForTests(manager);
  t.after(() => { setTeamManagerForTests(null); fs.rmSync(outer, { recursive: true, force: true }); });
  const team = manager.createTeam({ username: "owner", teamName: "Run role test", workspaceDir });
  const invite = manager.createInvite(team.id, "owner", "member");
  manager.joinTeamByInvite(invite.code, "operator");
  const session = sessionFor(workspaceDir);
  setActiveTeamId(session, team.id);
  const run = createActiveRun({
    session,
    recorder: new AgentRunRecorder(workspaceDir, "run-role", "conversation-role", "ask"),
    queueSteering: async () => ({ ok: true, code: "accepted" }),
  });
  t.after(() => run.finish());
  manager.updateMemberRole(team.id, "owner", "operator", "viewer");
  assert.equal(run.controlState.stopped, true, "downgrade must abort synchronously after persistence");
  assert.equal((await dispatchRunCommand(session, {
    source: "web", type: "stop", conversationId: "conversation-role", runId: "run-role",
  })).code, "forbidden");
  run.stopIfAccessRevoked();
  assert.equal(run.controlState.stopped, true);

  const socket = new FakeSocket();
  handleChatWs(socket as unknown as WebSocket, session, { validateSession: () => true });
  socket.receive({ type: "message", requestId: "viewer-write", message: "try", mode: "ask" });
  await waitFor(() => socket.frames.some((frame) => frame.type === "error"));
  assert.match(String(socket.frames.find((frame) => frame.type === "error")?.content), /read-only/);
  socket.close();
});

test("member removal and leaving a team abort owned runs synchronously", (t) => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-run-member-loss-"));
  const workspaceDir = path.join(outer, "workspace");
  fs.mkdirSync(workspaceDir);
  const manager = new TeamManager(outer);
  setTeamManagerForTests(manager);
  t.after(() => { setTeamManagerForTests(null); fs.rmSync(outer, { recursive: true, force: true }); });
  const team = manager.createTeam({ username: "owner", teamName: "Member loss", workspaceDir });
  const join = () => manager.joinTeamByInvite(manager.createInvite(team.id, "owner", "member").code, "operator");
  join();
  const firstSession = sessionFor(workspaceDir);
  setActiveTeamId(firstSession, team.id);
  const removedRun = createActiveRun({
    session: firstSession, recorder: new AgentRunRecorder(workspaceDir, "run-removed", "conversation-removed", "ask"),
    queueSteering: async () => ({ ok: true, code: "accepted" }),
  });
  t.after(() => removedRun.finish());
  manager.removeMember(team.id, "owner", "operator");
  assert.equal(removedRun.controlState.stopped, true);

  join();
  const secondSession = sessionFor(workspaceDir);
  setActiveTeamId(secondSession, team.id);
  const leftRun = createActiveRun({
    session: secondSession, recorder: new AgentRunRecorder(workspaceDir, "run-left", "conversation-left", "ask"),
    queueSteering: async () => ({ ok: true, code: "accepted" }),
  });
  t.after(() => leftRun.finish());
  manager.leaveTeam(team.id, "operator");
  assert.equal(leftRun.controlState.stopped, true);
});

test("session revocation aborts every owned run and cancels pending approvals", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-run-revoke-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const session = sessionFor(workspaceDir);
  const run = createActiveRun({
    session, recorder: new AgentRunRecorder(workspaceDir, "run-revoke", "conversation-revoke", "ask"),
    queueSteering: async () => ({ ok: true, code: "accepted" }),
  });
  t.after(() => run.finish());
  const decision = run.approvals.request({
    conversationId: "conversation-revoke", requestId: "request-revoke", toolCallId: "tool-revoke",
    name: "write_file", input: { path: "a.ts" }, risk: "medium", reason: "Edit",
    scope: "a.ts", canAllowSession: false,
  });
  run.steeringQueue.push({ requestId: "queued", message: "later", conversationId: "conversation-revoke", mode: "ask", modelName: config.modelName });
  assert.equal(stopRunsForSession(session.token), 1);
  assert.equal(stopRunsForSession(session.token), 0);
  assert.equal(run.controlState.createAbortSignal().aborted, true);
  assert.equal(run.steeringQueue.length, 0);
  assert.equal(run.approvals.pendingCount(), 0);
  assert.equal(await decision, "deny");
});

test("subscribing to another conversation detaches the previous event stream", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-run-subscribe-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const session = sessionFor(workspaceDir);
  for (const conversationId of ["conversation-one", "conversation-two"]) {
    await appendConversationMessage(workspaceDir, conversationId, { role: "user", content: "start", timestamp: Date.now() });
  }
  const first = createActiveRun({
    session, recorder: new AgentRunRecorder(workspaceDir, "run-one", "conversation-one", "ask"),
    queueSteering: async () => ({ ok: true, code: "accepted" }),
  });
  const second = createActiveRun({
    session, recorder: new AgentRunRecorder(workspaceDir, "run-two", "conversation-two", "ask"),
    queueSteering: async () => ({ ok: true, code: "accepted" }),
  });
  t.after(() => { first.finish(); second.finish(); });
  const socket = new FakeSocket();
  handleChatWs(socket as unknown as WebSocket, session, { validateSession: () => true });
  socket.receive({ type: "subscribe_run", conversationId: "conversation-one" });
  socket.receive({ type: "subscribe_run", conversationId: "conversation-two" });
  first.emit({ type: "token", requestId: "first-token", content: "old" });
  second.emit({ type: "token", requestId: "second-token", content: "current" });
  assert.equal(socket.frames.some((frame) => frame.requestId === "first-token"), false);
  assert.equal(socket.frames.some((frame) => frame.requestId === "second-token"), true);
  socket.close();
});

test("browser disconnect leaves an in-flight run available to another connection", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-run-disconnect-"));
  const oldFetch = globalThis.fetch;
  const session = sessionFor(workspaceDir);
  let resolveCompletion!: () => void;
  const modelGate = new Promise<void>((resolve) => { resolveCompletion = resolve; });
  globalThis.fetch = async (input) => String(input).endsWith("/models")
    ? Response.json({ data: [{ id: config.modelName, max_output_tokens: 1024 }] })
    : modelGate.then(() => Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }] }));
  const first = new FakeSocket();
  const second = new FakeSocket();
  handleChatWs(first as unknown as WebSocket, session, { validateSession: () => true });
  handleChatWs(second as unknown as WebSocket, session, { validateSession: () => true });
  t.after(() => {
    resolveCompletion();
    first.close(); second.close(); globalThis.fetch = oldFetch;
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  first.receive({ type: "message", requestId: "start-1", message: "continue", mode: "ask", modelName: config.modelName });
  await waitFor(() => first.frames.some((frame) => frame.type === "run_state" && frame.status === "running"));
  const started = first.frames.find((frame) => frame.type === "run_state" && frame.status === "running")!;
  const conversationId = String(started.conversationId);
  const runId = String(started.runId);
  second.receive({ type: "subscribe_run", conversationId });
  await waitFor(() => second.frames.some((frame) => frame.type === "run_state" && frame.runId === runId));
  const remote = await dispatchRunCommand(sessionFor(workspaceDir), {
    source: "mobile", type: "steer", conversationId, runId,
    requestId: "remote-correction", message: "check one more thing",
  });
  assert.equal(remote.code, "accepted");
  assert.equal(readConversationMessages(workspaceDir, conversationId).some((message) =>
    message.role === "user" && message.requestId === "remote-correction"
  ), true);
  first.close();
  assert.equal(getActiveRun(workspaceDir, conversationId)?.runId, runId);
  resolveCompletion();
  await waitFor(() => second.frames.some((frame) => frame.type === "run_state" && frame.runId === runId && frame.status === "completed"), () => ({ frames: second.frames, record: readRunRecord(workspaceDir, runId)?.status }));
  assert.equal(readRunRecord(workspaceDir, runId)?.status, "completed");
  assert.equal(getActiveRun(workspaceDir, conversationId), null);
});

test("stop during queued follow-up startup cannot be cleared by recorder transition", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-follow-up-stop-"));
  const session = sessionFor(workspaceDir);
  const oldFetch = globalThis.fetch;
  const originalStart = AgentRunRecorder.prototype.start;
  const originalFinish = AgentRunRecorder.prototype.finish;
  let startCount = 0;
  let secondRunId = "";
  let releaseFirstFinish!: () => void;
  let enteredFirstFinish!: () => void;
  let releaseSecondStart!: () => void;
  let enteredSecondStart!: () => void;
  const firstFinishGate = new Promise<void>((resolve) => { releaseFirstFinish = resolve; });
  const firstFinishEntered = new Promise<void>((resolve) => { enteredFirstFinish = resolve; });
  const secondStartGate = new Promise<void>((resolve) => { releaseSecondStart = resolve; });
  const secondStartEntered = new Promise<void>((resolve) => { enteredSecondStart = resolve; });
  AgentRunRecorder.prototype.start = async function () {
    startCount += 1;
    if (startCount === 2) {
      secondRunId = this.runId;
      enteredSecondStart();
      await secondStartGate;
    }
    return originalStart.call(this);
  };
  let finishCount = 0;
  AgentRunRecorder.prototype.finish = async function (...args) {
    finishCount += 1;
    if (finishCount === 1) {
      enteredFirstFinish();
      await firstFinishGate;
    }
    return originalFinish.call(this, ...args);
  };
  globalThis.fetch = async () => Response.json({
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }],
  });
  const socket = new FakeSocket();
  handleChatWs(socket as unknown as WebSocket, session, { validateSession: () => true });
  t.after(() => {
    releaseFirstFinish(); releaseSecondStart();
    AgentRunRecorder.prototype.start = originalStart;
    AgentRunRecorder.prototype.finish = originalFinish;
    globalThis.fetch = oldFetch;
    socket.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  socket.receive({ type: "message", requestId: "first-follow-up", message: "first", mode: "ask", modelName: config.modelName });
  await waitFor(() => socket.frames.some((frame) => frame.type === "run_state" && frame.status === "running"));
  const initial = socket.frames.find((frame) => frame.type === "run_state" && frame.status === "running")!;
  const conversationId = String(initial.conversationId);
  const firstRunId = String(initial.runId);
  await firstFinishEntered;
  socket.receive({ type: "message", requestId: "second-follow-up", message: "second", conversationId, mode: "ask", modelName: config.modelName });
  await waitFor(() => socket.frames.some((frame) => frame.type === "steering" && frame.requestId === "second-follow-up"));
  releaseFirstFinish();
  await secondStartEntered;
  assert.equal(getActiveRun(workspaceDir, conversationId)?.runId, firstRunId);
  const stopped = await dispatchRunCommand(session, {
    source: "web", type: "stop", conversationId, runId: firstRunId,
  });
  assert.equal(stopped.code, "accepted");
  releaseSecondStart();
  await waitFor(() => {
    if (!secondRunId) return false;
    try { return readRunRecord(workspaceDir, secondRunId)?.status === "stopped"; }
    catch { return false; }
  });
  await waitFor(() => getActiveRun(workspaceDir, conversationId) === null);
  assert.equal(socket.frames.some((frame) => frame.type === "run_state" && frame.runId === secondRunId && frame.status === "running"), false);
});

test("mobile prompt creates a durable run, replays idempotently, and continues a completed task", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-mobile-start-"));
  const oldFetch = globalThis.fetch;
  const session = sessionFor(workspaceDir);
  globalThis.fetch = async () => Response.json({
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  t.after(() => { globalThis.fetch = oldFetch; fs.rmSync(workspaceDir, { recursive: true, force: true }); });
  const auth = { resolveOwnerSession: () => session };

  const first = await startMobileRun(session, {
    ownerSessionToken: session.token, message: "first mobile prompt", mode: "ask", requestId: "mobile-first",
  }, auth);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.created, true);
  assert.ok(first.runId);
  await waitFor(() => readRunRecord(workspaceDir, first.runId!)?.status === "completed");
  assert.equal(readConversationMessages(workspaceDir, first.conversationId).some((item) =>
    item.role === "assistant" && item.content.includes("done")
  ), true);

  const replay = await startMobileRun(session, {
    ownerSessionToken: session.token, message: "first mobile prompt", mode: "ask", requestId: "mobile-first",
  }, auth);
  assert.equal(replay.ok, true);
  if (replay.ok) assert.equal(replay.replayed, true);
  assert.equal(readConversationMessages(workspaceDir, first.conversationId).filter((item) => item.role === "user").length, 1);

  const second = await startMobileRun(session, {
    ownerSessionToken: session.token, conversationId: first.conversationId,
    message: "continue from mobile", requestId: "mobile-second",
  }, auth);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.created, false);
  assert.notEqual(second.runId, first.runId);
  await waitFor(() => readRunRecord(workspaceDir, second.runId!)?.status === "completed");
  assert.equal(readRunRecord(workspaceDir, second.runId!)?.mode, "ask");
  assert.equal(readConversationMessages(workspaceDir, first.conversationId).filter((item) => item.role === "user").length, 2);
});

test("mobile start rejects a second active run and revocation stops its owner run", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-mobile-active-"));
  const oldFetch = globalThis.fetch;
  const session = sessionFor(workspaceDir);
  let release!: () => void;
  const modelGate = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = async () => modelGate.then(() => Response.json({
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }],
  }));
  t.after(() => { release(); globalThis.fetch = oldFetch; fs.rmSync(workspaceDir, { recursive: true, force: true }); });
  const auth = { resolveOwnerSession: () => session };
  const first = await startMobileRun(session, {
    ownerSessionToken: session.token, message: "wait", mode: "ask", requestId: "mobile-active",
  }, auth);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = await startMobileRun(session, {
    ownerSessionToken: session.token, conversationId: first.conversationId,
    message: "another run", mode: "ask", requestId: "mobile-conflict",
  }, auth);
  assert.deepEqual(second, { ok: false, code: "conflict", message: "This conversation already has an active run" });
  assert.equal(readConversationMessages(workspaceDir, first.conversationId).filter((item) => item.role === "user").length, 1);
  assert.equal(stopRunsForSession(session.token), 1);
  assert.equal(getActiveRun(workspaceDir, first.conversationId)?.status, "stopping");
  release();
  await waitFor(() => getActiveRun(workspaceDir, first.conversationId) === null);
  assert.equal(readRunRecord(workspaceDir, first.runId!)?.status, "stopped");
});

test("mobile start uses the selected workspace without switching the parent browser session", async (t) => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-mobile-scope-"));
  const parentWorkspace = path.join(outer, "parent");
  const mobileWorkspace = path.join(outer, "mobile");
  fs.mkdirSync(parentWorkspace); fs.mkdirSync(mobileWorkspace);
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }],
  });
  t.after(() => { globalThis.fetch = oldFetch; fs.rmSync(outer, { recursive: true, force: true }); });
  const parent = sessionFor(parentWorkspace);
  const scoped = { ...parent, token: "mobile:scoped", workspaceDir: mobileWorkspace, workspaceRoot: mobileWorkspace };
  const result = await startMobileRun(scoped, {
    ownerSessionToken: parent.token, message: "mobile workspace request", mode: "ask", requestId: "mobile-scoped",
  }, { resolveOwnerSession: () => parent });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  await waitFor(() => readRunRecord(mobileWorkspace, result.runId!)?.status === "completed");
  assert.equal(parent.workspaceDir, parentWorkspace);
  assert.equal(fs.existsSync(path.join(parentWorkspace, ".history", "runs", `${result.runId}.json`)), false);
  assert.equal(readConversationMessages(mobileWorkspace, result.conversationId)[0]?.content, "mobile workspace request");
});
