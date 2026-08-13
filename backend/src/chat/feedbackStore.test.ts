import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskManager } from "../agent/taskManager.js";
import { DeliveryFeedbackStore, DeliveryFeedbackVersionConflictError } from "../integrations/feedbackStore.js";
import type { DeliveryBindingV1, NormalizedDeliveryEventV1 } from "../integrations/types.js";
import { ReviewFindingStore } from "./reviewFindingStore.js";
import { readRunRecord } from "./runHistory.js";

function fixture(t: test.TestContext) { const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-feedback-")); t.after(() => fs.rmSync(workspace, { recursive: true, force: true })); const binding: DeliveryBindingV1 = { schemaVersion: 1, id: "binding-1", providerConfigId: "github-main", repositoryId: "repo-1", proposalKey: "42", headSha: "remote-head-1", conversationId: "conversation-1", executionPlanId: "plan-1", originRunId: "origin-run-1", parentRunId: "parent-run-1", worktreeId: "worktree-1", changeSetId: "change-set-1", revision: "patch-revision-1", createdAt: 1, updatedAt: 1 }; const event: NormalizedDeliveryEventV1 = { schemaVersion: 1, providerConfigId: "github-main", deliveryId: "delivery-1", repositoryId: "repo-1", proposalKey: "42", headSha: "remote-head-1", receivedAt: 1, source: { kind: "review_comment", id: "comment-1", author: "reviewer", body: "Fix this sk_feedbacksecret123", path: "src/a.ts", line: 10 } }; return { workspace, binding, event }; }

test("delivery feedback replay is idempotent, redacted, versioned, and creates tasks only after approval", (t) => {
  const { workspace, binding, event } = fixture(t); const store = new DeliveryFeedbackStore(workspace); const manager = new TaskManager(workspace);
  const initial = store.ingest(event, binding); const replay = store.ingest({ ...event, deliveryId: "delivery-redelivery" }, binding);
  assert.equal(initial.id, replay.id); assert.equal(initial.version, replay.version); assert.equal(initial.lifecycle, "pending_approval"); assert.equal(manager.listTasks().length, 0);
  assert(!JSON.stringify(initial).includes("sk_feedbacksecret123")); assert.equal(initial.changeSetId, binding.changeSetId); assert.equal(initial.revision, binding.revision);
  const approved = store.approveAndCreateTask(initial.id, "human-reviewer", initial.version, manager); assert.equal(approved.lifecycle, "task_created"); assert.equal(manager.listTasks().length, 1);
  const task = manager.getTask(approved.taskId!); assert.equal(task.requiresPlanApproval, true); assert.equal(task.minimumCompletionQuality, 1); assert(task.description.includes(initial.id));
  assert(approved.followUpRunId); const run = readRunRecord(workspace, approved.followUpRunId); assert.equal(run.status, "queued"); assert.equal(run.conversationId, binding.conversationId); assert.equal(run.executionPlanId, binding.executionPlanId); assert.equal(run.parentRunId, binding.originRunId); assert.deepEqual(run.followUp, { feedbackId: initial.id, taskId: approved.taskId, deliveryId: event.deliveryId, externalId: binding.proposalKey, headSha: binding.headSha, revision: binding.revision, changeSetId: binding.changeSetId, providerConfigId: binding.providerConfigId });
  assert.throws(() => store.approveAndCreateTask(initial.id, "human-reviewer", initial.version, manager), DeliveryFeedbackVersionConflictError);
});

test("stale heads never create tasks", (t) => {
  const { workspace, binding, event } = fixture(t); const store = new DeliveryFeedbackStore(workspace); const manager = new TaskManager(workspace);
  const stale = store.ingest({ ...event, headSha: "upstream-other-head" }, binding); assert.equal(stale.lifecycle, "stale"); assert.equal(stale.stale, true);
  assert.throws(() => store.approveAndCreateTask(stale.id, "human", stale.version, manager), /not eligible/i); assert.equal(manager.listTasks().length, 0);
});

test("approved follow-up runs are queued without auto-execution and changed feedback requires renewed approval", (t) => {
  const { workspace, binding, event } = fixture(t); const store = new DeliveryFeedbackStore(workspace); const manager = new TaskManager(workspace);
  const initial = store.ingest(event, binding); const approved = store.approveAndCreateTask(initial.id, "human", initial.version, manager);
  assert.throws(() => store.attachFollowUpRun(initial.id, "follow-up-1", "wrong-parent", "human", approved.version), /lineage/i);
  assert.equal(approved.lifecycle, "task_created"); assert(approved.followUpRunId); assert.equal(readRunRecord(workspace, approved.followUpRunId).status, "queued");
  assert.equal(event.source.kind, "review_comment");
  const changedSource = event.source.kind === "review_comment" ? { ...event.source, body: "Updated actionable review comment" } : event.source;
  const changed = store.ingest({ ...event, deliveryId: "delivery-2", source: changedSource }, binding); assert.equal(changed.lifecycle, "pending_approval"); assert(changed.version > approved.version);
  const second = store.approveAndCreateTask(changed.id, "human", changed.version, manager); assert.deepEqual(second.taskIds, [approved.taskId, second.taskId]); assert.equal(manager.listTasks().length, 2); assert.notEqual(second.followUpRunId, approved.followUpRunId); assert.equal(readRunRecord(workspace, second.followUpRunId!).status, "queued");
});

test("external feedback actors cannot bypass independent review verification", (t) => {
  const { workspace, binding } = fixture(t); const review = new ReviewFindingStore(workspace); const finding = review.ingest({ severity: "error", path: "src/a.ts", line: 1, message: "external issue", evidence: ["provider annotation"] }, { id: "provider:github", revision: binding.revision, changeSetId: binding.changeSetId, reviewRunId: "external-event" })!;
  review.transition(finding.id, "accepted", { id: "writer" }, { expectedVersion: finding.version }); const accepted = review.list()[0]; review.transition(accepted.id, "fixed", { id: "writer" }, { expectedVersion: accepted.version, fixRef: "fix" }); const fixed = review.list()[0];
  assert.throws(() => review.transition(fixed.id, "verified", { id: "provider:github", revision: binding.revision }, { expectedVersion: fixed.version, evidence: ["external success"] }), /reserved/i);
});

test("existing corrupt feedback state fails closed and is preserved", (t) => {
  const { workspace } = fixture(t); const target = path.join(workspace, ".history", "delivery-feedback.json");
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, "{corrupt-feedback");
  assert.throws(() => new DeliveryFeedbackStore(workspace).list(), (error: unknown) => (error as { code?: string }).code === "delivery_feedback_persistence_invalid");
  assert.equal(fs.readFileSync(target, "utf8"), "{corrupt-feedback");
});
