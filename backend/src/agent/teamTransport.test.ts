import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { agentSnapshot, teamRouter } from "../routes/team.js";
import { AgentRunRecorder } from "../chat/runHistory.js";
import { TraceStore } from "../chat/traceStore.js";
import { setActiveTeamId, setTeamManagerForTests } from "../team/sessionBridge.js";
import { TeamManager } from "../team/teamManager.js";
import { TaskManager } from "./taskManager.js";
import { TEAMMATE_CAPABILITY } from "./types.js";
import { deriveAgentEvent, handleTeamWs, pushAgentUpdate, sendAgentEventForRecipient } from "../ws/team.js";
import { WebSocket } from "ws";

class FakeTeamSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  frames: any[] = [];
  send(value: string) { this.frames.push(JSON.parse(value)); }
}

async function fixture() {
  const calls: string[] = [];
  const member = { id: "teammate:alpha", name: "alpha", role: "worker", status: "working", version: 3, capabilities: ["read_file", TEAMMATE_CAPABILITY.UPDATE_BUDGET] };
  const manager = {
    reconcile() { return 0; }, listDetails() { return [{ ...member }]; },
    stop(name: string) { calls.push(`stop:${name}`); member.status = "stopped"; member.version++; return true; },
    steer(name: string, content: string) { calls.push(`steer:${name}:${content}`); return true; },
    pause() { return true; }, resume() { return true; }, retry: async () => "ok", reassign: () => true, replace: async () => "ok",
    updateBudget(_name: string, _budget: unknown, version: number) { if (version !== member.version) throw new Error("Agent version conflict"); member.version++; return { ...member }; },
  };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.userSession = { username: "solo", token: `transport-${Date.now()}`, workspaceDir: "/tmp/solo", isAdmin: false, teammateManager: manager, taskManager: { listTasks: () => [] } }; next(); });
  app.use("/api/team", teamRouter);
  const server = http.createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { calls, member, url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function invokeAgentListing(session: Record<string, unknown>, view?: string): unknown {
  const layer = (teamRouter as any).stack.find((candidate: any) => candidate.route?.path === "/agents" && candidate.route.methods.get);
  assert.ok(layer, "GET /agents route is registered");
  let payload: unknown;
  layer.route.stack[0].handle(
    { userSession: session, query: view ? { view } : {} },
    { json(value: unknown) { payload = value; return this; } },
    (error: unknown) => { throw error; },
  );
  assert.notEqual(payload, undefined);
  return payload;
}

test("agent control alias is target-scoped and enforces If-Match", async (t) => {
  const f = await fixture(); t.after(f.close);
  const good = await fetch(`${f.url}/api/team/agents/teammate%3Aalpha/control`, { method: "POST", headers: { "Content-Type": "application/json", "If-Match": "3" }, body: JSON.stringify({ action: "steer", instruction: "focus" }) });
  assert.equal(good.status, 200); assert.deepEqual(f.calls, ["steer:alpha:focus"]);
  const stale = await fetch(`${f.url}/api/team/agents/teammate%3Aalpha/control`, { method: "POST", headers: { "Content-Type": "application/json", "If-Match": "2" }, body: JSON.stringify({ action: "stop" }) });
  assert.equal(stale.status, 409); assert.deepEqual(f.calls, ["steer:alpha:focus"]);
  const foreign = await fetch(`${f.url}/api/team/agents/teammate%3Aother/control`, { method: "POST", headers: { "Content-Type": "application/json", "If-Match": "3" }, body: JSON.stringify({ action: "stop" }) });
  assert.equal(foreign.status, 404); assert.deepEqual(f.calls, ["steer:alpha:focus"]);
});

test("budget capability contract is exposed only to authorized snapshots", () => {
  const member = { name: "alpha", role: "worker", status: "idle", capabilities: ["read_file", TEAMMATE_CAPABILITY.UPDATE_BUDGET] };
  const owner = agentSnapshot(member, true); const viewer = agentSnapshot(member, false);
  assert.equal(TEAMMATE_CAPABILITY.UPDATE_BUDGET, "budget.update");
  assert.equal(owner.canManageBudget, true); assert.ok(owner.capabilities.includes("budget.update"));
  assert.equal(viewer.canManageBudget, false); assert.ok(!viewer.capabilities.includes("budget.update"));
});

test("agent listing preserves the flat response by default", () => {
  const member = { id: "teammate:alpha", name: "alpha", role: "worker", status: "working", version: 3, capabilities: ["read_file"] };
  const session = {
    username: "solo",
    workspaceDir: "/tmp/solo",
    workspaceRoot: "/tmp/solo",
    isAdmin: false,
    isolated: true,
    teammateManager: { reconcile: () => 0, listDetails: () => [{ ...member }] },
  };
  const payload = invokeAgentListing(session) as { agents: Array<{ id: string }>; updatedAt: number };
  assert.deepEqual(Object.keys(payload).sort(), ["agents", "updatedAt"]);
  assert.equal(payload.agents[0].id, member.id);
  assert.equal(typeof payload.updatedAt, "number");
});

test("graph agent listing treats absent workspace stores as empty", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-graph-empty-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", workspace]);
  const graph = invokeAgentListing({
    username: "solo",
    workspaceDir: workspace,
    workspaceRoot: workspace,
    isAdmin: false,
    isolated: true,
    teammateManager: { reconcile: () => 0, listDetails: () => [] },
    taskManager: new TaskManager(workspace),
  }, "graph") as { nodes: unknown[]; edges: unknown[]; events: unknown[] };
  assert.deepEqual({ nodes: graph.nodes, edges: graph.edges, events: graph.events }, { nodes: [], edges: [], events: [] });
});

test("authorized agent listing exposes budget editor contract and budget route enforces capability", async (t) => {
  const f = await fixture(); t.after(f.close);
  const listing = await fetch(`${f.url}/api/team/agents`); assert.equal(listing.status, 200);
  const listed = (await listing.json()) as { agents: Array<{ canManageBudget?: boolean; capabilities: string[] }>; updatedAt: number };
  assert.deepEqual(Object.keys(listed).sort(), ["agents", "updatedAt"]);
  assert.equal(listed.agents[0].canManageBudget, true); assert.ok(listed.agents[0].capabilities.includes(TEAMMATE_CAPABILITY.UPDATE_BUDGET));
  const updated = await fetch(`${f.url}/api/team/agents/teammate%3Aalpha/budget`, { method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": "3" }, body: JSON.stringify({ budget: { maxTokens: 42 } }) });
  assert.equal(updated.status, 200);
  f.member.capabilities = ["read_file"];
  const denied = await fetch(`${f.url}/api/team/agents/teammate%3Aalpha/budget`, { method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": "4" }, body: JSON.stringify({ budget: { maxTokens: 50 } }) });
  assert.equal(denied.status, 403);
});

test("graph agent listing projects only the requested workspace and sanitizes transport output", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-graph-workspace-"));
  const foreignWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-graph-foreign-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  t.after(() => fs.rmSync(foreignWorkspace, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", workspace]);
  execFileSync("git", ["init", "-q", foreignWorkspace]);

  const taskManager = new TaskManager(workspace);
  taskManager.create("Local task token=local-task-secret");
  new TaskManager(foreignWorkspace).create("foreign-only-task");
  new TraceStore(workspace).append({
    kind: "agent",
    action: "Local trace api_key=local-trace-secret",
    correlationId: "local",
    agentId: "teammate:alpha",
    metadata: { reasoning: "private-reasoning", raw_output: "private-output", retained: "visible" },
  });
  new TraceStore(foreignWorkspace).append({ kind: "agent", action: "foreign-only-event", correlationId: "foreign" });
  const recorder = new AgentRunRecorder(workspace, "local-run", "local-conversation", "code");
  await recorder.start();
  await recorder.toolState({
    toolCallId: "local-tool",
    requestId: "local-request",
    name: "shell",
    toolInput: { path: "/private/tool-input-path", prompt: "tool-input-secret" },
    status: "completed",
    resultSummary: "tool-result-secret",
  });

  const member = {
    id: "teammate:alpha",
    name: "alpha",
    role: "worker",
    status: "working",
    version: 3,
    capabilities: ["read_file"],
    currentTask: "Use password=local-agent-secret",
    worktreePath: "/private/worktree-path",
    prompt: "private-agent-prompt",
  };
  const graph = invokeAgentListing({
    username: "solo",
    workspaceDir: workspace,
    workspaceRoot: workspace,
    isAdmin: false,
    isolated: true,
    teammateManager: { reconcile: () => 0, listDetails: () => [{ ...member }] },
    taskManager,
  }, "graph") as { schemaVersion: number; revision: string; nodes: Array<{ id: string }>; events: Array<{ id: string }> };
  assert.equal(graph.schemaVersion, 1);
  assert.match(graph.revision, /^[a-f0-9]{64}$/);
  assert.equal(graph.nodes.some((node) => node.id === "agent:teammate:alpha"), true);
  assert.equal(graph.nodes.some((node) => node.id === "task:1"), true);
  assert.equal(graph.nodes.some((node) => node.id === "run:local-run"), true);
  assert.equal(graph.events.some((event) => event.id.startsWith("event:trace:")), true);

  const serialized = JSON.stringify(graph);
  assert.doesNotMatch(serialized, /foreign-only|private\/worktree-path|private\/tool-input-path/);
  assert.doesNotMatch(serialized, /tool-input-secret|tool-result-secret|private-agent-prompt|private-reasoning|private-output/);
  assert.doesNotMatch(serialized, /worktreePath|raw_output|reasoning|prompt/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.match(serialized, /visible/);
});

test("WS initial, broadcast, and replay derive capabilities independently per connection", () => {
  const rawAgent = { name: "alpha", role: "worker", status: "working", capabilities: ["read_file", TEAMMATE_CAPABILITY.UPDATE_BUDGET] };
  const assertRole = (event: ReturnType<typeof deriveAgentEvent>, allowed: boolean) => {
    const agent = event.agents[0] as { canManageBudget?: boolean; capabilities: string[] };
    assert.equal(agent.canManageBudget, allowed);
    assert.equal(agent.capabilities.includes(TEAMMATE_CAPABILITY.UPDATE_BUDGET), allowed);
  };
  const initial = { type: "agent_snapshot" as const, sequence: 0, agents: [rawAgent] };
  assertRole(deriveAgentEvent(initial, true), true);
  assertRole(deriveAgentEvent(initial, false), false);
  const broadcast = { type: "agent_update" as const, sequence: 1, agents: [rawAgent] };
  const ownerDelivery = deriveAgentEvent(broadcast, true);
  const viewerDelivery = deriveAgentEvent(broadcast, false);
  assertRole(ownerDelivery, true); assertRole(viewerDelivery, false);
  // Replay re-derives from raw history; it must not reuse the owner's payload.
  assertRole(deriveAgentEvent(broadcast, false), false);
  assertRole(deriveAgentEvent(broadcast, true), true);

  const ownerFrames: string[] = []; const viewerFrames: string[] = [];
  const ownerSocket = { readyState: WebSocket.OPEN, send: (frame: string) => ownerFrames.push(frame) } as unknown as WebSocket;
  const viewerSocket = { readyState: WebSocket.OPEN, send: (frame: string) => viewerFrames.push(frame) } as unknown as WebSocket;
  sendAgentEventForRecipient(ownerSocket, broadcast, true);
  sendAgentEventForRecipient(viewerSocket, broadcast, false);
  assertRole(JSON.parse(ownerFrames[0]), true);
  assertRole(JSON.parse(viewerFrames[0]), false);
});

test("WS graph snapshots and events are sanitized, ordered, and isolated by team and workspace", (t) => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "agent-graph-ws-"));
  const workspace = path.join(outer, "workspace");
  const foreignWorkspace = path.join(outer, "foreign");
  const soloWorkspace = path.join(outer, "solo");
  fs.mkdirSync(workspace); fs.mkdirSync(foreignWorkspace); fs.mkdirSync(soloWorkspace);
  execFileSync("git", ["init", "-q", workspace]);
  execFileSync("git", ["init", "-q", foreignWorkspace]);
  execFileSync("git", ["init", "-q", soloWorkspace]);
  const manager = new TeamManager(outer);
  setTeamManagerForTests(manager);
  t.after(() => { setTeamManagerForTests(null); fs.rmSync(outer, { recursive: true, force: true }); });

  const firstTeam = manager.createTeam({ username: "owner", teamName: "First", workspaceDir: workspace });
  const secondTeam = manager.createTeam({ username: "owner", teamName: "Second", workspaceDir: workspace });
  const foreignTeam = manager.createTeam({ username: "owner", teamName: "Foreign", workspaceDir: foreignWorkspace });
  const member = {
    id: "teammate:alpha", name: "alpha", role: "worker", status: "working", version: 1,
    capabilities: ["read_file"], currentTask: "Use token=transport-secret", prompt: "private prompt",
    worktreePath: "/private/agent-worktree",
  };
  const teammateManager = { reconcile: () => 0, listDetails: () => [{ ...member }] };
  const session = (token: string, workspaceDir: string) => ({
    username: "owner", token, workspaceDir, workspaceRoot: workspaceDir, isAdmin: false, isolated: false,
    teammateManager, taskManager: new TaskManager(workspaceDir),
  } as any);
  const firstSession = session("graph-first", workspace);
  const secondSession = session("graph-second", workspace);
  const foreignSession = session("graph-foreign", foreignWorkspace);
  const soloSession = session("graph-solo", soloWorkspace);
  setActiveTeamId(firstSession, firstTeam.id);
  setActiveTeamId(secondSession, secondTeam.id);
  setActiveTeamId(foreignSession, foreignTeam.id);

  const firstSocket = new FakeTeamSocket();
  const secondSocket = new FakeTeamSocket();
  const foreignSocket = new FakeTeamSocket();
  const soloSocket = new FakeTeamSocket();
  handleTeamWs(firstSocket as unknown as WebSocket, firstSession);
  handleTeamWs(secondSocket as unknown as WebSocket, secondSession);
  handleTeamWs(foreignSocket as unknown as WebSocket, foreignSession);
  handleTeamWs(soloSocket as unknown as WebSocket, soloSession);
  t.after(() => { firstSocket.emit("close"); secondSocket.emit("close"); foreignSocket.emit("close"); soloSocket.emit("close"); });

  const initial = firstSocket.frames.find((frame) => frame.type === "agent_graph_snapshot");
  assert.ok(initial);
  assert.equal(initial.cursor, initial.sequence);
  assert.equal(initial.revision, initial.graph.revision);
  assert.equal(initial.graph.schemaVersion, 1);
  const serialized = JSON.stringify(initial.graph);
  assert.doesNotMatch(serialized, /transport-secret|private prompt|private\/agent-worktree|worktreePath|prompt/);
  assert.match(serialized, /\[REDACTED\]/);

  const secondBefore = secondSocket.frames.filter((frame) => frame.type === "agent_graph_event").length;
  const foreignBefore = foreignSocket.frames.filter((frame) => frame.type === "agent_graph_event").length;
  pushAgentUpdate(firstSession);
  member.status = "stopped"; member.version++;
  pushAgentUpdate(firstSession);
  const events = firstSocket.frames.filter((frame) => frame.type === "agent_graph_event");
  assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
  assert.deepEqual(events.map((event) => event.cursor), [1, 2]);
  assert.equal(events.every((event) => event.revision === event.graph.revision), true);
  assert.equal(secondSocket.frames.filter((frame) => frame.type === "agent_graph_event").length, secondBefore);
  assert.equal(foreignSocket.frames.filter((frame) => frame.type === "agent_graph_event").length, foreignBefore);
  pushAgentUpdate(soloSession);
  assert.deepEqual(soloSocket.frames.filter((frame) => frame.type === "agent_graph_event").map((frame) => frame.sequence), [1]);
});

test("WS graph reconnect replays once after its cursor and falls back to a snapshot on history gaps", (t) => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "agent-graph-replay-"));
  const workspace = path.join(outer, "workspace");
  fs.mkdirSync(workspace);
  execFileSync("git", ["init", "-q", workspace]);
  const manager = new TeamManager(outer);
  setTeamManagerForTests(manager);
  t.after(() => { setTeamManagerForTests(null); fs.rmSync(outer, { recursive: true, force: true }); });

  const landingTeam = manager.createTeam({ username: "owner", teamName: "Landing", workspaceDir: workspace });
  const replayTeam = manager.createTeam({ username: "owner", teamName: "Replay", workspaceDir: workspace });
  const member = { id: "teammate:alpha", name: "alpha", role: "worker", status: "working", version: 1, capabilities: ["read_file"] };
  const teammateManager = { reconcile: () => 0, listDetails: () => [{ ...member }] };
  const makeSession = (token: string) => ({
    username: "owner", token, workspaceDir: workspace, workspaceRoot: workspace, isAdmin: false, isolated: false,
    teammateManager, taskManager: new TaskManager(workspace),
  } as any);
  const publisher = makeSession("graph-publisher");
  setActiveTeamId(publisher, replayTeam.id);
  pushAgentUpdate(publisher); member.version++; pushAgentUpdate(publisher);

  const replaySession = makeSession("graph-replay-client");
  setActiveTeamId(replaySession, landingTeam.id);
  const replaySocket = new FakeTeamSocket();
  handleTeamWs(replaySocket as unknown as WebSocket, replaySession);
  t.after(() => replaySocket.emit("close"));
  const replayStart = replaySocket.frames.length;
  replaySocket.emit("message", Buffer.from(JSON.stringify({
    type: "subscribe", teamId: replayTeam.id, afterGraphSequence: 1, afterSequence: Number.MAX_SAFE_INTEGER,
  })));
  const replayFrames = replaySocket.frames.slice(replayStart).filter((frame) => frame.type.startsWith("agent_graph_"));
  assert.deepEqual(replayFrames.map((frame) => [frame.type, frame.sequence]), [["agent_graph_event", 2]]);

  replaySocket.emit("message", Buffer.from(JSON.stringify({
    type: "subscribe", teamId: landingTeam.id, afterGraphSequence: 0, afterSequence: Number.MAX_SAFE_INTEGER,
  })));
  member.version++; pushAgentUpdate(publisher);
  const dedupeStart = replaySocket.frames.length;
  replaySocket.emit("message", Buffer.from(JSON.stringify({
    type: "subscribe", teamId: replayTeam.id, afterGraphSequence: 1, afterSequence: Number.MAX_SAFE_INTEGER,
  })));
  const dedupedReplay = replaySocket.frames.slice(dedupeStart).filter((frame) => frame.type.startsWith("agent_graph_"));
  assert.deepEqual(dedupedReplay.map((frame) => [frame.type, frame.sequence]), [["agent_graph_event", 3]]);

  for (let index = 0; index < 100; index++) { member.version++; pushAgentUpdate(publisher); }
  const gapSession = makeSession("graph-gap-client");
  setActiveTeamId(gapSession, landingTeam.id);
  const gapSocket = new FakeTeamSocket();
  handleTeamWs(gapSocket as unknown as WebSocket, gapSession);
  t.after(() => gapSocket.emit("close"));
  const gapStart = gapSocket.frames.length;
  gapSocket.emit("message", Buffer.from(JSON.stringify({
    type: "subscribe", teamId: replayTeam.id, afterGraphCursor: 1, afterSequence: Number.MAX_SAFE_INTEGER,
  })));
  const gapFrames = gapSocket.frames.slice(gapStart).filter((frame) => frame.type.startsWith("agent_graph_"));
  assert.equal(gapFrames.length, 1);
  assert.equal(gapFrames[0].type, "agent_graph_snapshot");
  assert.equal(gapFrames[0].sequence, 103);
  assert.equal(gapFrames[0].cursor, 103);
  assert.equal(gapFrames[0].revision, gapFrames[0].graph.revision);
});
