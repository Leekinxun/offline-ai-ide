import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
import { agentSnapshot, teamRouter } from "../routes/team.js";
import { TEAMMATE_CAPABILITY } from "./types.js";
import { deriveAgentEvent, sendAgentEventForRecipient } from "../ws/team.js";
import { WebSocket } from "ws";

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
  app.use((req: any, _res, next) => { req.userSession = { username: "solo", token: `transport-${Date.now()}`, workspaceDir: "/tmp/solo", isAdmin: false, teammateManager: manager }; next(); });
  app.use("/api/team", teamRouter);
  const server = http.createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { calls, member, url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
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

test("authorized agent listing exposes budget editor contract and budget route enforces capability", async (t) => {
  const f = await fixture(); t.after(f.close);
  const listing = await fetch(`${f.url}/api/team/agents`); assert.equal(listing.status, 200);
  const listed = (await listing.json()) as { agents: Array<{ canManageBudget?: boolean; capabilities: string[] }> };
  assert.equal(listed.agents[0].canManageBudget, true); assert.ok(listed.agents[0].capabilities.includes(TEAMMATE_CAPABILITY.UPDATE_BUDGET));
  const updated = await fetch(`${f.url}/api/team/agents/teammate%3Aalpha/budget`, { method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": "3" }, body: JSON.stringify({ budget: { maxTokens: 42 } }) });
  assert.equal(updated.status, 200);
  f.member.capabilities = ["read_file"];
  const denied = await fetch(`${f.url}/api/team/agents/teammate%3Aalpha/budget`, { method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": "4" }, body: JSON.stringify({ budget: { maxTokens: 50 } }) });
  assert.equal(denied.status, 403);
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
