import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { MessageBus } from "./messageBus.js";
import { TaskManager } from "./taskManager.js";
import { TeammateManager } from "./teammateManager.js";
import { applyChangeSetDecision, captureChangeSet, listChangeSets } from "../chat/changeSets.js";
import { listManagedWorktrees, removeManagedWorktree, updateManagedWorktreeMetadata, type ManagedWorktree } from "../chat/worktrees.js";
import { registerAgentHooks } from "./agentHooks.js";
import { TEAMMATE_CAPABILITY } from "./types.js";
import { AgentRunRecorder, readRunRecord } from "../chat/runHistory.js";

function initializeGitWorkspace(workspaceDir: string): void {
  execFileSync("git", ["init", "-q", workspaceDir]);
  execFileSync("git", ["-C", workspaceDir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", workspaceDir, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", workspaceDir, "commit", "--allow-empty", "-qm", "initial"]);
}

test("teammate allocation fails closed outside a Git workspace", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-teammate-nogit-"));
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  const bus = new MessageBus(workspaceDir);
  const manager = new TeammateManager(workspaceDir, bus, new TaskManager(workspaceDir));

  const result = await manager.spawn("writer", "implementation", "make a change");

  assert.match(result, /isolated worktree allocation failed; refusing to spawn/);
  assert.equal(manager.listDetails().length, 0);
});

test("restart reconciliation persists interrupted agents", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-teammate-restart-"));
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspaceDir, ".team"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, ".team", "config.json"), JSON.stringify({ team_name: "t", members: [{ name: "lost", role: "work", status: "working", heartbeatAt: Date.now(), updatedAt: Date.now() }] }));
  const bus = new MessageBus(workspaceDir);
  const manager = new TeammateManager(workspaceDir, bus, new TaskManager(workspaceDir));
  assert.equal(manager.listDetails()[0].status, "interrupted");
  const persisted = JSON.parse(await fs.readFile(path.join(workspaceDir, ".team", "config.json"), "utf8")) as { members: Array<{ status: string }> };
  assert.equal(persisted.members[0].status, "interrupted");
});

test("budget updates are versioned, bounded, and persisted in member snapshots", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-teammate-budget-"));
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspaceDir, ".team"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, ".team", "config.json"), JSON.stringify({ team_name: "t", members: [{ name: "budget", role: "work", status: "idle", version: 4, capabilities: ["read_file"], budget: { maxTokens: 12 } }] }));
  const manager = new TeammateManager(workspaceDir, new MessageBus(workspaceDir), new TaskManager(workspaceDir));
  const updated = manager.updateBudget("budget", { maxTokens: 100, maxCostUsd: 2.5 }, 4);
  assert.equal(updated.version, 5); assert.equal(updated.budget?.maxTokens, 100); assert.ok(updated.capabilities?.includes(TEAMMATE_CAPABILITY.UPDATE_BUDGET));
  assert.throws(() => manager.updateBudget("budget", { maxTokens: -1 }, 5), /Invalid budget/);
  assert.throws(() => manager.updateBudget("budget", { maxTokens: 1 }, 4), /version conflict/);
  const restarted = new TeammateManager(workspaceDir, new MessageBus(workspaceDir), new TaskManager(workspaceDir));
  assert.equal(restarted.listDetails()[0].budget?.maxCostUsd, 2.5);
});

test("separate managers preserve independent members and gate revisions", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-team-config-cas-")); t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspaceDir, ".team"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, ".team", "config.json"), JSON.stringify({ team_name: "t", members: [{ name: "a", role: "one", status: "idle", version: 1, requiresPlanApproval: true, minimumCompletionQuality: 0.8 }, { name: "b", role: "two", status: "idle", version: 1 }] }));
  const first = new TeammateManager(workspaceDir, new MessageBus(workspaceDir), new TaskManager(workspaceDir)); const second = new TeammateManager(workspaceDir, new MessageBus(workspaceDir), new TaskManager(workspaceDir));
  const approved = first.approvePlan("a", 1); assert.equal(approved.version, 2); assert.throws(() => second.updateBudget("a", { maxTokens: 10 }, 1), /version conflict/);
  const evidence = second.recordCompletionEvidence("a", ["tests"], 0.9, 2); assert.equal(evidence.version, 3);
  first.updateBudget("b", { maxTokens: 5 }, 1);
  const restarted = new TeammateManager(workspaceDir, new MessageBus(workspaceDir), new TaskManager(workspaceDir)); assert.equal(restarted.listDetails().length, 2); assert.equal(restarted.listDetails().find((m) => m.name === "a")?.completionQuality, 0.9); assert.equal(restarted.listDetails().find((m) => m.name === "b")?.budget?.maxTokens, 5);
});

test("stale execution generations cannot mutate replacement state", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-team-fence-")); t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspaceDir, ".team"), { recursive: true }); await fs.writeFile(path.join(workspaceDir, ".team", "config.json"), JSON.stringify({ team_name: "t", members: [{ name: "same", role: "work", status: "working", version: 1, executionId: "replacement", processId: process.pid, leaseExpiresAt: Date.now() + 60_000 }] }));
  const manager = new TeammateManager(workspaceDir, new MessageBus(workspaceDir), new TaskManager(workspaceDir));
  const setStatus = (manager as unknown as { setStatus(name: string, status: "failed", task: string, execution: string): void }).setStatus.bind(manager);
  setStatus("same", "failed", "old loop", "old-generation");
  assert.equal(new TeammateManager(workspaceDir, new MessageBus(workspaceDir), new TaskManager(workspaceDir)).listDetails()[0].status, "working");
});

test("member, team, and workspace usage budgets are atomically enforced", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-team-usage-")); t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspaceDir, ".team"), { recursive: true }); await fs.writeFile(path.join(workspaceDir, ".team", "config.json"), JSON.stringify({ team_name: "t", budget: { maxTokens: 6 }, workspaceBudget: { maxCostUsd: 1 }, members: [{ name: "usage", role: "work", status: "working", version: 1, executionId: "run", processId: process.pid, leaseExpiresAt: Date.now() + 60_000, budget: { maxTokens: 5 } }] }));
  const manager = new TeammateManager(workspaceDir, new MessageBus(workspaceDir), new TaskManager(workspaceDir));
  const consume = (manager as unknown as { consumeUsage(name: string, execution: string, tokens: number, cost: number): boolean }).consumeUsage.bind(manager);
  assert.equal(consume("usage", "run", 5, 1), true); assert.equal(consume("usage", "run", 1, 0), false);
  const member = new TeammateManager(workspaceDir, new MessageBus(workspaceDir), new TaskManager(workspaceDir)).listDetails()[0]; assert.equal(member.status, "failed"); assert.equal(member.budget?.usedTokens, 5);
});

test("teammate worktree awaits review and is reused only after revision is requested", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-teammate-review-"));
  initializeGitWorkspace(workspaceDir);
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  const bus = new MessageBus(workspaceDir);
  const manager = new TeammateManager(workspaceDir, bus, new TaskManager(workspaceDir));
  const allocate = (manager as unknown as { managedWorktree(name: string): ManagedWorktree }).managedWorktree.bind(manager);
  const finalize = (manager as unknown as { finalizeManagedWorktree(name: string, reason: string): { id: string; status: string } | undefined }).finalizeManagedWorktree.bind(manager);

  const original = allocate("writer");
  await fs.writeFile(path.join(original.path, "draft.txt"), "draft\n");
  const firstChangeSet = captureChangeSet(workspaceDir, original.id, { reason: "idle" });
  assert.throws(() => allocate("writer"), /awaiting review/);

  applyChangeSetDecision(workspaceDir, firstChangeSet, "request_revision");
  const revision = allocate("writer");
  assert.equal(revision.id, original.id);
  await fs.writeFile(path.join(revision.path, "revision.txt"), "revised\n");

  const captured = finalize("writer", "idle");
  assert.equal(captured?.status, "ready_for_review");
  assert.equal(finalize("writer", "shutdown"), undefined);
  assert.equal(bus.readInbox("lead").filter((message) => message.content.includes("ChangeSet")).length, 1);
  const current = listManagedWorktrees(workspaceDir).find((entry) => entry.id === original.id);
  assert.equal(current?.status, "ready_for_review");
  assert.equal(current?.reviewState, "pending");
  assert.throws(() => allocate("writer"), /awaiting review/);

  const latest = listChangeSets(workspaceDir).find((changeSet) => changeSet.id === captured?.id);
  assert.ok(latest);
  applyChangeSetDecision(workspaceDir, latest, "reject");
  await fs.rm(path.join(revision.path, "revision.txt"));
  await fs.rm(path.join(revision.path, "draft.txt"));
  removeManagedWorktree(workspaceDir, original.id);
});

test("teammate idle capture stops before queued work can mutate the reviewed worktree", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-teammate-idle-review-"));
  initializeGitWorkspace(workspaceDir);
  const originalFetch = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "test-model", max_output_tokens: 1024 }] });
    modelCalls += 1;
    return Response.json({ choices: [{ message: modelCalls === 1
      ? { role: "assistant", content: null, tool_calls: [{ id: "review-write", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "review.txt", content: "review me\n" }) } }] }
      : { role: "assistant", content: "done" }, finish_reason: modelCalls === 1 ? "tool_calls" : "stop" }], usage: {} });
  };
  t.after(async () => { globalThis.fetch = originalFetch; await fs.rm(workspaceDir, { recursive: true, force: true }); });
  const manager = new TeammateManager(workspaceDir, new MessageBus(workspaceDir), new TaskManager(workspaceDir));
  const parentRecorder = new AgentRunRecorder(workspaceDir, "parent-run", "conversation", "code");
  await parentRecorder.start();

  assert.match(await manager.spawn("writer", "implementation", "finish once", async () => ({ allowed: true }), undefined, {
    parentRunId: "parent-run", parentTaskId: 17, parentConversationId: "conversation", parentRequestId: "request", parentToolCallId: "spawn-call",
  }), /Spawned/);
  const spawnedMember = manager.listDetails()[0];
  assert.equal(spawnedMember.parentRunId, "parent-run");
  assert.equal(spawnedMember.parentTaskId, 17);
  assert.equal(readRunRecord(workspaceDir, spawnedMember.childRunId!).parentTaskId, 17);
  const blockedParent = await parentRecorder.finish("completed", {}, undefined, { schemaVersion: 1, outcome: "completed", ledger: { changedFiles: [], verification: [], criteria: [], blockers: [] } });
  assert.equal(blockedParent.status, "failed");
  assert.deepEqual(blockedParent.completionEvidence?.ledger.blockers, ["childRun"]);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (listManagedWorktrees(workspaceDir)[0]?.status === "ready_for_review") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(listManagedWorktrees(workspaceDir)[0]?.status, "ready_for_review");
  assert.match(await manager.spawn("writer", "implementation", "mutate again", async () => ({ allowed: true })), /awaiting review/);
  assert.equal(modelCalls, 2);

  const changeSet = listChangeSets(workspaceDir)[0];
  applyChangeSetDecision(workspaceDir, changeSet, "reject");
  const worktree = listManagedWorktrees(workspaceDir)[0];
  await fs.rm(path.join(worktree.path, "review.txt"), { force: true });
  await fs.rm(path.join(worktree.path, ".checkpoints"), { recursive: true, force: true });
  removeManagedWorktree(workspaceDir, changeSet.worktreeId);
});

test("teammate no_changes completion is terminal and permits a fresh run", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-teammate-nochanges-"));
  initializeGitWorkspace(workspaceDir);
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  const bus = new MessageBus(workspaceDir);
  const manager = new TeammateManager(workspaceDir, bus, new TaskManager(workspaceDir));
  const allocate = (manager as unknown as { managedWorktree(name: string): ManagedWorktree }).managedWorktree.bind(manager);
  const finalize = (manager as unknown as { finalizeManagedWorktree(name: string, reason: string): { id: string; status: string } | undefined }).finalizeManagedWorktree.bind(manager);

  const first = allocate("writer");
  const evidence = finalize("writer", "idle");
  assert.equal(evidence?.status, "no_changes");
  assert.match(bus.readInbox("lead")[0]?.content || "", /\(no_changes\) completed without workspace changes/);
  const completed = listManagedWorktrees(workspaceDir).find((entry) => entry.id === first.id);
  assert.equal(completed?.status, "integrated");
  assert.equal(completed?.reviewState, "approved");

  const second = allocate("writer");
  assert.notEqual(second.id, first.id);
  assert.equal(finalize("writer", "idle")?.status, "no_changes");
  removeManagedWorktree(workspaceDir, first.id);
  removeManagedWorktree(workspaceDir, second.id);
});

test("authorized teammate bash can use a compatibility-shell pipe", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-teammate-pipe-"));
  initializeGitWorkspace(workspaceDir);
  const originalFetch = globalThis.fetch;
  let completion = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "test-model", max_output_tokens: 1024 }] });
    completion += 1;
    if (completion === 2) {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string }> };
      assert.match(body.messages.find((message) => message.role === "tool")?.content || "", /TEAMMATE/);
    }
    return Response.json({ choices: [{ message: completion === 1
      ? { role: "assistant", content: null, tool_calls: [{ id: "teammate-pipe", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf teammate | tr a-z A-Z" }) } }] }
      : { role: "assistant", content: "done" }, finish_reason: completion === 1 ? "tool_calls" : "stop" }], usage: {} });
  };
  t.after(async () => { globalThis.fetch = originalFetch; await fs.rm(workspaceDir, { recursive: true, force: true }); });
  const manager = new TeammateManager(workspaceDir, new MessageBus(workspaceDir), new TaskManager(workspaceDir));

  assert.match(await manager.spawn("shell", "implementation", "run pipe", async () => ({ allowed: true })), /Spawned/);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (listManagedWorktrees(workspaceDir)[0]?.status === "ready_for_review") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(completion, 2);
  const changeSet = listChangeSets(workspaceDir)[0];
  applyChangeSetDecision(workspaceDir, changeSet, "reject");
  await fs.rm(path.join(listManagedWorktrees(workspaceDir)[0].path, ".checkpoints"), { recursive: true, force: true });
  removeManagedWorktree(workspaceDir, changeSet.worktreeId);
});

test("write-capable teammate fails before mutation when its required checkpoint cannot be created", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-teammate-checkpoint-fail-"));
  initializeGitWorkspace(workspaceDir);
  await fs.writeFile(path.join(workspaceDir, ".checkpoints"), "tracked blocker\n");
  execFileSync("git", ["-C", workspaceDir, "add", ".checkpoints"]);
  execFileSync("git", ["-C", workspaceDir, "commit", "-qm", "checkpoint blocker"]);
  const originalFetch = globalThis.fetch;
  let completion = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "test-model", max_output_tokens: 1024 }] });
    completion += 1;
    if (completion === 2) {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string }> };
      assert.match(body.messages.find((message) => message.role === "tool")?.content || "", /Required mutation checkpoint unavailable/);
    }
    return Response.json({ choices: [{ message: completion === 1
      ? { role: "assistant", content: null, tool_calls: [{ id: "blocked-teammate-write", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "blocked.txt", content: "must not exist\n" }) } }] }
      : { role: "assistant", content: "done" }, finish_reason: completion === 1 ? "tool_calls" : "stop" }], usage: {} });
  };
  t.after(async () => { globalThis.fetch = originalFetch; await fs.rm(workspaceDir, { recursive: true, force: true }); });
  const manager = new TeammateManager(workspaceDir, new MessageBus(workspaceDir), new TaskManager(workspaceDir));

  assert.match(await manager.spawn("blocked", "implementation", "attempt write", async () => ({ allowed: true })), /Spawned/);
  for (let attempt = 0; attempt < 100 && completion < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const child = listManagedWorktrees(workspaceDir)[0];
  assert.equal(await fs.stat(path.join(child.path, "blocked.txt")).then(() => true).catch(() => false), false);
  assert.equal(completion, 2);
  for (let attempt = 0; attempt < 100 && listManagedWorktrees(workspaceDir)[0]?.status === "running"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(listManagedWorktrees(workspaceDir)[0]?.status, "needs_attention");
  updateManagedWorktreeMetadata(workspaceDir, child.id, "rejected", "rejected");
  removeManagedWorktree(workspaceDir, child.id);
});

test("teammate mutation evidence gaps fail hook, member/run state, and worktree consistently", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-teammate-evidence-gap-"));
  initializeGitWorkspace(workspaceDir);
  const originalFetch = globalThis.fetch;
  let completion = 0;
  let hookError = "";
  const unregister = registerAgentHooks({ name: "observe-teammate-gap", handlers: { afterToolExecute: (context) => { if (context.toolCallId === "teammate-gap") hookError = context.error || ""; } } });
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "test-model", max_output_tokens: 1024 }] });
    completion += 1;
    return Response.json({ choices: [{ message: completion === 1
      ? { role: "assistant", content: null, tool_calls: [{ id: "teammate-gap", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf OK && printf '\\0binary' > evidence.bin" }) } }] }
      : { role: "assistant", content: "handled" }, finish_reason: completion === 1 ? "tool_calls" : "stop" }], usage: {} });
  };
  t.after(async () => { unregister(); globalThis.fetch = originalFetch; await fs.rm(workspaceDir, { recursive: true, force: true }); });
  const bus = new MessageBus(workspaceDir);
  const manager = new TeammateManager(workspaceDir, bus, new TaskManager(workspaceDir));
  assert.match(await manager.spawn("gap", "implementation", "make binary", async () => ({ allowed: true }), undefined, {
    parentRunId: "parent-gap", parentConversationId: "conversation-gap", parentRequestId: "request-gap", parentToolCallId: "spawn-gap",
  }), /Spawned/);
  for (let attempt = 0; attempt < 100 && manager.listDetails()[0]?.status !== "failed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const member = manager.listDetails()[0];
  const worktree = listManagedWorktrees(workspaceDir)[0];
  assert.match(hookError, /mutation evidence incomplete/i);
  assert.equal(member.status, "failed");
  assert.equal(readRunRecord(workspaceDir, member.childRunId!).status, "failed");
  assert.equal(worktree.status, "needs_attention");
  assert.equal(listChangeSets(workspaceDir)[0]?.status, "needs_attention");
  const notification = bus.readInbox("lead").find((message) => message.content.includes("ChangeSet"))?.content || "";
  assert.match(notification, /needs_attention.*mutation evidence.*(?:request revision|reject)/i);
  assert.doesNotMatch(notification, /ready for review/i);
  await fs.rm(path.join(worktree.path, "evidence.bin"), { force: true });
  await fs.rm(path.join(worktree.path, ".checkpoints"), { recursive: true, force: true });
  updateManagedWorktreeMetadata(workspaceDir, worktree.id, "rejected", "rejected");
  removeManagedWorktree(workspaceDir, worktree.id);
});

test("teammate mutation-journal failure remains observable and fails member and run", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-teammate-journal-fail-"));
  initializeGitWorkspace(workspaceDir);
  const originalFetch = globalThis.fetch;
  let completion = 0;
  let hookError = "";
  const unregister = registerAgentHooks({ name: "observe-teammate-journal-fail", handlers: {
    beforeToolExecute: async (context) => { if (context.toolCallId === "teammate-journal-fail") await fs.writeFile(path.join(listManagedWorktrees(workspaceDir)[0].path, ".checkpoints", "mutations.json"), "{broken"); },
    afterToolExecute: (context) => { if (context.toolCallId === "teammate-journal-fail") hookError = context.error || ""; },
  } });
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "test-model", max_output_tokens: 1024 }] });
    completion += 1;
    return Response.json({ choices: [{ message: completion === 1
      ? { role: "assistant", content: null, tool_calls: [{ id: "teammate-journal-fail", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf changed > journal-failure.txt" }) } }] }
      : { role: "assistant", content: "handled" }, finish_reason: completion === 1 ? "tool_calls" : "stop" }], usage: {} });
  };
  t.after(async () => { unregister(); globalThis.fetch = originalFetch; await fs.rm(workspaceDir, { recursive: true, force: true }); });
  const bus = new MessageBus(workspaceDir);
  const manager = new TeammateManager(workspaceDir, bus, new TaskManager(workspaceDir));
  assert.match(await manager.spawn("journal", "implementation", "corrupt journal", async () => ({ allowed: true }), undefined, {
    parentRunId: "parent-journal", parentConversationId: "conversation-journal", parentRequestId: "request-journal", parentToolCallId: "spawn-journal",
  }), /Spawned/);
  for (let attempt = 0; attempt < 100 && !["failed", "shutdown"].includes(manager.listDetails()[0]?.status || ""); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const member = manager.listDetails()[0];
  const worktree = listManagedWorktrees(workspaceDir)[0];
  assert.match(hookError, /mutation evidence capture failed.*journal evidence.*(?:invalid|unreadable)/i);
  assert.equal(member.status, "failed");
  assert.equal(readRunRecord(workspaceDir, member.childRunId!).status, "failed");
  assert.equal(worktree.status, "needs_attention");
  assert.deepEqual(listChangeSets(workspaceDir), []);
  assert.match(bus.readInbox("lead").map((message) => message.content).join("\n"), /ChangeSet capture failed.*journal evidence.*(?:invalid|unreadable)/i);
  await fs.rm(path.join(worktree.path, ".checkpoints"), { recursive: true, force: true });
  await fs.rm(path.join(worktree.path, "journal-failure.txt"), { force: true });
  updateManagedWorktreeMetadata(workspaceDir, worktree.id, "rejected", "rejected");
  removeManagedWorktree(workspaceDir, worktree.id);
});

test("model failure leaves leased inbox command unacked for restart redelivery", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-inbox-crash-")); initializeGitWorkspace(workspaceDir);
  const originalFetch = globalThis.fetch; globalThis.fetch = async (input) => { if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "test-model", max_output_tokens: 1024 }] }); throw new Error("simulated crash before response"); };
  t.after(async () => { globalThis.fetch = originalFetch; await fs.rm(workspaceDir, { recursive: true, force: true }); });
  const bus = new MessageBus(workspaceDir); bus.send("lead", "crashy", "durable command"); const manager = new TeammateManager(workspaceDir, bus, new TaskManager(workspaceDir));
  assert.match(await manager.spawn("crashy", "implementation", "wait for command", async () => ({ allowed: true })), /Spawned/);
  for (let attempt = 0; attempt < 100 && manager.listDetails()[0]?.status !== "shutdown"; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  const stored = bus.list("crashy")[0]; assert.equal(stored.delivery, "leased");
  bus.reclaimExpired(Number.MAX_SAFE_INTEGER); const replay = new MessageBus(workspaceDir).leaseInbox("crashy", "restart"); assert.equal(replay[0].message.content, "durable command");
  for (const worktree of listManagedWorktrees(workspaceDir)) removeManagedWorktree(workspaceDir, worktree.id);
});

test("successful model turn commits one durable receipt before inbox ACK", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-inbox-commit-")); initializeGitWorkspace(workspaceDir);
  const originalFetch = globalThis.fetch; let observedCommands = 0;
  globalThis.fetch = async (input, init) => { if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "test-model", max_output_tokens: 1024 }] }); const body = JSON.parse(String(init?.body)) as { messages: Array<{ content?: string }> }; observedCommands += body.messages.filter((message) => message.content?.includes("once-only command")).length; return Response.json({ choices: [{ message: { role: "assistant", content: "handled" }, finish_reason: "stop" }], usage: {} }); };
  t.after(async () => { globalThis.fetch = originalFetch; await fs.rm(workspaceDir, { recursive: true, force: true }); });
  const bus = new MessageBus(workspaceDir); bus.send("lead", "steady", "once-only command"); const manager = new TeammateManager(workspaceDir, bus, new TaskManager(workspaceDir));
  assert.match(await manager.spawn("steady", "implementation", "process inbox", async () => ({ allowed: true })), /Spawned/);
  for (let attempt = 0; attempt < 100 && bus.list("steady")[0]?.delivery !== "acked"; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(bus.list("steady")[0]?.delivery, "acked"); assert.equal(observedCommands, 1); assert.equal(manager.listDetails()[0].handledMessageIds?.length, 1);
  for (const worktree of listManagedWorktrees(workspaceDir)) removeManagedWorktree(workspaceDir, worktree.id);
});

test("tool-loop crash after model response leaves command unhandled and redeliverable", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-inbox-tool-crash-")); initializeGitWorkspace(workspaceDir);
  const originalFetch = globalThis.fetch; globalThis.fetch = async (input) => { if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "test-model", max_output_tokens: 1024 }] }); return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "crash-tool", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "crash.txt", content: "written\n" }) } }] }, finish_reason: "tool_calls" }], usage: {} }); };
  const unregister = registerAgentHooks({ name: "crash-after-tool", critical: true, handlers: { afterToolExecute: () => { throw new Error("simulated tool-loop crash"); } } });
  t.after(async () => { unregister(); globalThis.fetch = originalFetch; await fs.rm(workspaceDir, { recursive: true, force: true }); });
  const bus = new MessageBus(workspaceDir); bus.send("lead", "toolcrash", "must replay after tool crash"); const manager = new TeammateManager(workspaceDir, bus, new TaskManager(workspaceDir));
  assert.match(await manager.spawn("toolcrash", "implementation", "run tool", async () => ({ allowed: true })), /Spawned/);
  for (let attempt = 0; attempt < 100 && manager.listDetails()[0]?.status !== "shutdown"; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(bus.list("toolcrash")[0]?.delivery, "leased"); assert.deepEqual(manager.listDetails()[0].handledMessageIds || [], []);
  bus.reclaimExpired(Number.MAX_SAFE_INTEGER); assert.equal(new MessageBus(workspaceDir).leaseInbox("toolcrash", "restart")[0]?.message.content, "must replay after tool crash");
  const changeSet = listChangeSets(workspaceDir)[0]; if (changeSet) applyChangeSetDecision(workspaceDir, changeSet, "reject");
  for (const worktree of listManagedWorktrees(workspaceDir)) { await fs.rm(path.join(worktree.path, "crash.txt"), { force: true }); await fs.rm(path.join(worktree.path, ".checkpoints"), { recursive: true, force: true }); removeManagedWorktree(workspaceDir, worktree.id); }
});

test("successful full tool loop commits receipt and ACK exactly once", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-inbox-tool-success-")); initializeGitWorkspace(workspaceDir);
  const originalFetch = globalThis.fetch; let calls = 0; globalThis.fetch = async (input) => { if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "test-model", max_output_tokens: 1024 }] }); calls++; return Response.json({ choices: [{ message: calls === 1 ? { role: "assistant", content: null, tool_calls: [{ id: "success-tool", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "success.txt", content: "done\n" }) } }] } : { role: "assistant", content: "done" }, finish_reason: calls === 1 ? "tool_calls" : "stop" }], usage: {} }); };
  t.after(async () => { globalThis.fetch = originalFetch; await fs.rm(workspaceDir, { recursive: true, force: true }); });
  const bus = new MessageBus(workspaceDir); bus.send("lead", "toolok", "handle with tool once"); const manager = new TeammateManager(workspaceDir, bus, new TaskManager(workspaceDir));
  assert.match(await manager.spawn("toolok", "implementation", "run tool", async () => ({ allowed: true })), /Spawned/);
  for (let attempt = 0; attempt < 100 && bus.list("toolok")[0]?.delivery !== "acked"; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(bus.list("toolok")[0]?.delivery, "acked"); assert.equal(manager.listDetails()[0].handledMessageIds?.length, 1); assert.equal(bus.leaseInbox("toolok").length, 0);
  for (let attempt = 0; attempt < 100 && listManagedWorktrees(workspaceDir)[0]?.status !== "ready_for_review"; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  const changeSet = listChangeSets(workspaceDir)[0]; if (changeSet) applyChangeSetDecision(workspaceDir, changeSet, "reject");
  for (const worktree of listManagedWorktrees(workspaceDir)) { await fs.rm(path.join(worktree.path, "success.txt"), { force: true }); await fs.rm(path.join(worktree.path, ".checkpoints"), { recursive: true, force: true }); removeManagedWorktree(workspaceDir, worktree.id); }
});
