import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isProcessAlive } from "../utils/processLiveness.js";
import { TaskManager } from "../agent/taskManager.js";
import { redactSecrets } from "../agent/secretRedaction.js";
import { canonicalJson, sha256 } from "../artifacts/reviewArtifact.js";
import { createQueuedFollowUpRun } from "../chat/runHistory.js";
import type {
  DeliveryBindingV1,
  DeliveryFeedbackLifecycle,
  DeliveryFeedbackV1,
  NormalizedDeliveryEventV1,
} from "./types.js";
import { normalizeProviderWebUrl } from "./delivery/providerUrl.js";

interface FeedbackStateV1 { schemaVersion: 1; version: number; feedback: DeliveryFeedbackV1[]; }

export class DeliveryFeedbackVersionConflictError extends Error {
  readonly code = "delivery_feedback_version_conflict";
  constructor(readonly expectedVersion: number, readonly actualVersion: number) { super(`Delivery feedback version conflict: expected ${expectedVersion}, got ${actualVersion}`); }
}
export class DeliveryFeedbackPersistenceError extends Error { readonly code = "delivery_feedback_persistence_invalid"; constructor(readonly filePath: string, cause?: unknown) { super(`Delivery feedback persistence is invalid or unreadable: ${path.basename(filePath)}`, { cause }); } }

const allowed: Record<DeliveryFeedbackLifecycle, DeliveryFeedbackLifecycle[]> = {
  received: ["linked", "stale", "failed"],
  linked: ["pending_approval", "ignored", "stale", "failed"],
  pending_approval: ["task_created", "ignored", "stale", "failed"],
  task_created: ["in_progress", "pending_approval", "ignored", "failed"],
  in_progress: ["fixed", "pending_approval", "failed"],
  fixed: ["verified", "pending_approval", "failed"],
  verified: ["pending_approval"],
  ignored: ["pending_approval"],
  stale: [],
  failed: ["pending_approval", "ignored"],
};

function statePath(workspace: string): string { return path.join(path.resolve(workspace), ".history", "delivery-feedback.json"); }
function safeText(value: unknown, max = 2_000): string | undefined { return typeof value === "string" && value.trim() ? redactSecrets(value).trim().slice(0, max) : undefined; }
function safeRelative(value: unknown): string | undefined {
  const text = safeText(value, 1_000)?.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!text || path.posix.isAbsolute(text) || text.split("/").some((part) => !part || part === "." || part === "..")) return undefined;
  return text;
}
function sanitizeSource(source: NormalizedDeliveryEventV1["source"]): NormalizedDeliveryEventV1["source"] {
  const url = normalizeProviderWebUrl(source.url);
  if (source.kind === "ci_check") return {
    kind: "ci_check",
    id: safeText(source.id, 200) || "unknown-check",
    name: safeText(source.name, 500) || "CI check",
    conclusion: safeText(source.conclusion, 100) || "unknown",
    ...(url ? { url } : {}),
    ...(Array.isArray(source.evidence) ? { evidence: source.evidence.flatMap((item) => safeText(item, 2_000) ? [safeText(item, 2_000)!] : []).slice(0, 20) } : {}),
  };
  return {
    kind: "review_comment",
    id: safeText(source.id, 200) || "unknown-comment",
    ...(safeText(source.threadId, 200) ? { threadId: safeText(source.threadId, 200) } : {}),
    ...(safeText(source.author, 200) ? { author: safeText(source.author, 200) } : {}),
    body: safeText(source.body, 4_000) || "Redacted review comment",
    ...(url ? { url } : {}),
    ...(safeRelative(source.path) ? { path: safeRelative(source.path) } : {}),
    ...(Number.isSafeInteger(source.line) && (source.line || 0) > 0 ? { line: source.line } : {}),
    ...(typeof source.resolved === "boolean" ? { resolved: source.resolved } : {}),
  };
}
function defaultState(): FeedbackStateV1 { return { schemaVersion: 1, version: 1, feedback: [] }; }
function read(workspace: string): FeedbackStateV1 {
  const target = statePath(workspace);
  try {
    const value = JSON.parse(fs.readFileSync(target, "utf8")) as Partial<FeedbackStateV1>;
    if (value.schemaVersion === 1 && Number.isSafeInteger(value.version) && Array.isArray(value.feedback)) return value as FeedbackStateV1;
    throw new DeliveryFeedbackPersistenceError(target);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultState(); if (error instanceof DeliveryFeedbackPersistenceError) throw error; throw new DeliveryFeedbackPersistenceError(target, error); }
}
function write(workspace: string, state: FeedbackStateV1): void {
  const target = statePath(workspace); fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(redactSecrets(state), null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  fs.renameSync(temp, target);
}
const alive = isProcessAlive;
function withLock<T>(workspace: string, operation: (state: FeedbackStateV1) => T): T {
  const target = statePath(workspace); const lock = `${target}.lock`; fs.mkdirSync(path.dirname(target), { recursive: true });
  let fd: number | undefined; const token = crypto.randomUUID();
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try { fd = fs.openSync(lock, "wx", 0o600); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, createdAt: Date.now() })); break; }
    catch {
      try { const owner = JSON.parse(fs.readFileSync(lock, "utf8")) as { pid?: number; createdAt?: number }; if (owner.pid && !alive(owner.pid) && Date.now() - (owner.createdAt || 0) > 1_000) fs.rmSync(lock, { force: true }); } catch { /* malformed locks fail closed until old */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  if (fd === undefined) throw new Error("Delivery feedback store is busy");
  try { const state = read(workspace); const result = operation(state); write(workspace, state); return result; }
  finally { fs.closeSync(fd); try { const owner = JSON.parse(fs.readFileSync(lock, "utf8")) as { token?: string }; if (owner.token === token) fs.rmSync(lock, { force: true }); } catch { /* already released */ } }
}
function feedbackId(event: NormalizedDeliveryEventV1): string {
  return `feedback-${sha256([event.providerConfigId, event.repositoryId, event.proposalKey, event.source.kind, event.source.id].join("\0"))}`;
}
function transition(item: DeliveryFeedbackV1, to: DeliveryFeedbackLifecycle, actorId: string, reason?: string): void {
  if (item.lifecycle === to) return;
  if (!allowed[item.lifecycle].includes(to)) throw new Error(`Invalid delivery feedback transition: ${item.lifecycle} -> ${to}`);
  const now = Date.now(); item.transitions.push({ from: item.lifecycle, to, at: now, actorId: safeText(actorId, 160) || "system", ...(safeText(reason) ? { reason: safeText(reason) } : {}), version: item.version + 1 });
  item.lifecycle = to; item.version += 1; item.updatedAt = now;
}

export class DeliveryFeedbackStore {
  constructor(private readonly workspace: string) {}

  list(filter: { changeSetId?: string; lifecycle?: DeliveryFeedbackLifecycle } = {}): DeliveryFeedbackV1[] {
    return read(this.workspace).feedback.filter((item) => (!filter.changeSetId || item.changeSetId === filter.changeSetId) && (!filter.lifecycle || item.lifecycle === filter.lifecycle)).map((item) => structuredClone(item));
  }

  get(id: string): DeliveryFeedbackV1 { const item = read(this.workspace).feedback.find((entry) => entry.id === id); if (!item) throw new Error("Delivery feedback not found"); return structuredClone(item); }

  ingest(eventInput: NormalizedDeliveryEventV1, binding?: DeliveryBindingV1): DeliveryFeedbackV1 {
    const event = { ...eventInput, source: sanitizeSource(eventInput.source) };
    if (event.schemaVersion !== 1 || !event.providerConfigId || !event.deliveryId || !event.repositoryId || !event.proposalKey || !event.headSha) throw new Error("Invalid normalized delivery event");
    const id = feedbackId(event); const sourceDigest = sha256(canonicalJson({ headSha: event.headSha, source: event.source }));
    return withLock(this.workspace, (state) => {
      const existing = state.feedback.find((item) => item.id === id);
      if (existing && existing.sourceDigest === sourceDigest) return structuredClone(existing);
      const bindingMatches = Boolean(binding && binding.schemaVersion === 1 && binding.providerConfigId === event.providerConfigId && binding.repositoryId === event.repositoryId && binding.proposalKey === event.proposalKey);
      const stale = !bindingMatches || binding!.headSha !== event.headSha;
      if (existing) {
        existing.source = event.source; existing.sourceDigest = sourceDigest; existing.deliveryId = event.deliveryId; existing.headSha = event.headSha; existing.stale = stale;
        existing.version += 1; existing.updatedAt = Date.now();
        if (stale) transition(existing, "stale", "system", "Feedback head does not match the immutable delivery binding");
        else transition(existing, "pending_approval", "system", "External feedback changed and requires renewed approval");
        state.version += 1; return structuredClone(existing);
      }
      const now = Date.now();
      const item: DeliveryFeedbackV1 = {
        schemaVersion: 1, id, version: stale ? 2 : 3, providerConfigId: event.providerConfigId, deliveryId: event.deliveryId,
        repositoryId: event.repositoryId, proposalKey: event.proposalKey, source: event.source, sourceDigest,
        headSha: event.headSha, lifecycle: stale ? "stale" : "pending_approval", stale, createdAt: now, updatedAt: now,
        transitions: [{ from: "received", to: stale ? "stale" : "linked", at: now, actorId: "system", reason: stale ? "No exact immutable delivery binding" : "Matched immutable delivery binding", version: 2 }],
        ...(bindingMatches ? {
          conversationId: binding!.conversationId, ...(binding!.executionPlanId ? { executionPlanId: binding!.executionPlanId } : {}),
          originRunId: binding!.originRunId, ...(binding!.parentRunId ? { parentRunId: binding!.parentRunId } : {}), worktreeId: binding!.worktreeId,
          changeSetId: binding!.changeSetId, revision: binding!.revision,
        } : {}),
      };
      if (!stale) item.transitions.push({ from: "linked", to: "pending_approval", at: now, actorId: "system", reason: "Follow-up work requires explicit user approval", version: 3 });
      state.feedback.push(item); state.version += 1; return structuredClone(item);
    });
  }

  approveAndCreateTask(id: string, actorId: string, expectedVersion: number, taskManager = new TaskManager(this.workspace)): DeliveryFeedbackV1 {
    const approved = withLock(this.workspace, (state) => {
      const item = state.feedback.find((entry) => entry.id === id); if (!item) throw new Error("Delivery feedback not found");
      if (item.version !== expectedVersion) throw new DeliveryFeedbackVersionConflictError(expectedVersion, item.version);
      if (item.stale || item.lifecycle !== "pending_approval" || !item.changeSetId || !item.revision || !item.originRunId || !item.conversationId) throw new Error("Delivery feedback is not eligible for a follow-up task");
      const subject = item.source.kind === "ci_check" ? `Fix CI: ${item.source.name}` : `Address review feedback${item.source.path ? ` in ${item.source.path}` : ""}`;
      const evidence = item.source.kind === "ci_check" ? item.source.evidence || [] : [item.source.body];
      const task = JSON.parse(taskManager.create(subject, JSON.stringify({ feedbackId: item.id, source: item.source.kind, changeSetId: item.changeSetId, revision: item.revision, conversationId: item.conversationId, executionPlanId: item.executionPlanId, parentRunId: item.originRunId, evidence }), { requiresPlanApproval: true, minimumCompletionQuality: 1 })) as { id: number };
      item.taskId = task.id; item.taskIds = [...new Set([...(item.taskIds || []), task.id])];
      transition(item, "task_created", actorId, "User approved the traceable follow-up proposal"); state.version += 1; return structuredClone(item);
    });
    const runId = `followup-${sha256(`${approved.id}\0${approved.version}\0${approved.taskId}`).slice(0, 32)}`;
    createQueuedFollowUpRun(this.workspace, {
      runId,
      conversationId: approved.conversationId!,
      ...(approved.executionPlanId ? { executionPlanId: approved.executionPlanId } : {}),
      parentRunId: approved.originRunId!,
      binding: {
        feedbackId: approved.id,
        taskId: approved.taskId!,
        deliveryId: approved.deliveryId,
        externalId: approved.proposalKey,
        headSha: approved.headSha,
        revision: approved.revision!,
        changeSetId: approved.changeSetId!,
        providerConfigId: approved.providerConfigId,
      },
    });
    return this.attachFollowUpRun(approved.id, runId, approved.originRunId!, actorId, approved.version);
  }

  attachFollowUpRun(id: string, runId: string, parentRunId: string, actorId: string, expectedVersion: number): DeliveryFeedbackV1 {
    return withLock(this.workspace, (state) => {
      const item = state.feedback.find((entry) => entry.id === id); if (!item) throw new Error("Delivery feedback not found");
      if (item.version !== expectedVersion) throw new DeliveryFeedbackVersionConflictError(expectedVersion, item.version);
      if (item.lifecycle !== "task_created" || !item.taskId || parentRunId !== item.originRunId) throw new Error("Follow-up run lineage does not match the originating run");
      const normalizedRunId = safeText(runId, 200); if (!normalizedRunId) throw new Error("Follow-up run id is required");
      item.followUpRunId = normalizedRunId; const now = Date.now(); item.transitions.push({ from: item.lifecycle, to: item.lifecycle, at: now, actorId: safeText(actorId, 160) || "system", reason: "Approved follow-up run queued and attached to the originating run lineage", version: item.version + 1 }); item.version += 1; item.updatedAt = now; state.version += 1; return structuredClone(item);
    });
  }

  transition(id: string, to: DeliveryFeedbackLifecycle, actorId: string, expectedVersion: number, reason?: string): DeliveryFeedbackV1 {
    return withLock(this.workspace, (state) => { const item = state.feedback.find((entry) => entry.id === id); if (!item) throw new Error("Delivery feedback not found"); if (item.version !== expectedVersion) throw new DeliveryFeedbackVersionConflictError(expectedVersion, item.version); transition(item, to, actorId, reason); state.version += 1; return structuredClone(item); });
  }
}
