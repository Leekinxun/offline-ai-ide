import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskManager } from "./taskManager.js";
import { AgentRunRecorder } from "../chat/runHistory.js";

test("task claims use durable CAS leases and expired work is reclaimable", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-task-")); t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const a = new TaskManager(workspace); const id = JSON.parse(a.create("ship")) as { id: number };
  const lease = a.claimLease(id.id, "a", 1); assert.ok(lease); assert.equal(new TaskManager(workspace).claimLease(id.id, "b"), null);
  assert.equal(a.releaseExpiredLeases(lease.expiresAt + 1), 1);
  assert.ok(new TaskManager(workspace).claimLease(id.id, "b"));
});

test("stale lease owners cannot renew or complete after replacement", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-task-fence-")); t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const tasks = new TaskManager(workspace); const task = JSON.parse(tasks.create("fenced")) as { id: number };
  const oldLease = tasks.claimLease(task.id, "a", 1)!; tasks.releaseExpiredLeases(oldLease.expiresAt + 1);
  const newLease = tasks.claimLease(task.id, "b")!;
  assert.equal(tasks.renewLease(task.id, "a", oldLease.token), false);
  assert.throws(() => tasks.complete(task.id, "a", oldLease.token), /current task lease/);
  assert.equal(JSON.parse(tasks.complete(task.id, "b", newLease.token)).status, "completed");
});

test("tasks validate dependencies and required child quality gate", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-task-tree-")); t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const tasks = new TaskManager(workspace); const parent = JSON.parse(tasks.create("parent")) as { id: number };
  const child = JSON.parse(tasks.create("child", "", { parentId: parent.id, required: true })) as { id: number };
  assert.throws(() => tasks.update(parent.id, "completed"), /required children/);
  tasks.update(child.id, "completed", undefined, undefined, { evidence: ["test passed"] });
  assert.equal(JSON.parse(tasks.update(parent.id, "completed")).status, "completed");
  assert.throws(() => tasks.create("bad", "", { blockedBy: [999] }), /Dependency/);
});

test("task completion is blocked by bound nonterminal agent descendants until terminal", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-task-run-descendant-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const tasks = new TaskManager(workspace);
  const task = JSON.parse(tasks.create("parent")) as { id: number };
  const child = new AgentRunRecorder(workspace, "child-run", "conversation", "code", undefined, { parentRunId: "parent-run", parentTaskId: task.id });
  await child.start();
  assert.throws(() => tasks.update(task.id, "completed"), /nonterminal agent descendants.*child-run/);
  await child.finish("stopped");
  assert.equal(JSON.parse(tasks.update(task.id, "completed")).status, "completed");
});

test("dependency cycles and incomplete required descendants are rejected", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-task-cycle-")); t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const tasks = new TaskManager(workspace); const a = JSON.parse(tasks.create("a")); const b = JSON.parse(tasks.create("b", "", { blockedBy: [a.id] }));
  assert.throws(() => tasks.update(a.id, undefined, [b.id]), /cycle/);
  const child = JSON.parse(tasks.create("child", "", { parentId: a.id })); const grandchild = JSON.parse(tasks.create("grandchild", "", { parentId: child.id }));
  assert.throws(() => tasks.update(child.id, "completed"), new RegExp(String(grandchild.id))); tasks.update(grandchild.id, "completed"); tasks.update(child.id, "completed"); assert.equal(JSON.parse(tasks.update(a.id, "completed")).status, "completed");
});

test("plan, evidence, quality, and usage budgets are persisted and fenced", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-task-gate-")); t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const tasks = new TaskManager(workspace); const task = JSON.parse(tasks.create("gated", "", { requiresPlanApproval: true, minimumCompletionQuality: 0.8, budget: { maxTokens: 10, maxCostUsd: 1 } }));
  const lease = tasks.claimLease(task.id, "agent")!;
  assert.equal(tasks.recordUsage(task.id, "agent", lease.token, 10, 1), true); assert.equal(tasks.recordUsage(task.id, "agent", lease.token, 1, 0), false);
  assert.throws(() => tasks.complete(task.id, "agent", lease.token, ["proof"]), /plan approval/);
  const approved = tasks.approvePlan(task.id, tasks.getTask(task.id).version!); const evidence = tasks.recordCompletionEvidence(task.id, ["proof"], 0.9, approved.version!);
  assert.equal(JSON.parse(tasks.update(task.id, "completed", undefined, undefined, { owner: "agent", leaseToken: lease.token, expectedVersion: evidence.version })).status, "completed");
});
