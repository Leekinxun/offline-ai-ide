import crypto from "node:crypto";
import { OrchestrationStore } from "../../agent/orchestrationStore.js";
import type { GitOperation, GitOperationStatus } from "./types.js";
import { isProcessAlive } from "../../utils/processLiveness.js";

interface GitDeliveryState {
  schemaVersion: 1;
  operations: Record<string, GitOperation>;
  idempotency: Record<string, { requestDigest: string; operationId: string }>;
}

function initial(): GitDeliveryState {
  return { schemaVersion: 1, operations: {}, idempotency: {} };
}

export class GitOperationVersionConflictError extends Error {
  constructor(readonly current: GitOperation) {
    super("Git operation version conflict");
  }
}

export class GitDeliveryStore {
  private readonly store: OrchestrationStore<GitDeliveryState>;

  constructor(workspaceDir: string) {
    this.store = new OrchestrationStore(workspaceDir, "git-delivery", initial);
  }

  list(): GitOperation[] {
    return Object.values(this.store.snapshot().operations).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): GitOperation {
    const operation = this.store.snapshot().operations[id];
    if (!operation) throw new Error("Git operation not found");
    return operation;
  }

  create(operation: GitOperation): GitOperation {
    return this.store.transact((state) => {
      const previous = state.idempotency[operation.idempotencyKeyHash];
      if (previous) {
        const existing = state.operations[previous.operationId];
        if (previous.requestDigest !== operation.requestDigest) throw new Error("Idempotency key was already used for a different Git request");
        if (!existing) throw new Error("Git idempotency record is inconsistent");
        return structuredClone(existing);
      }
      state.operations[operation.id] = structuredClone(operation);
      state.idempotency[operation.idempotencyKeyHash] = { requestDigest: operation.requestDigest, operationId: operation.id };
      return structuredClone(operation);
    });
  }

  approve(id: string, expectedVersion: number, digest: string, actor: string, reason?: string): GitOperation {
    return this.store.transact((state) => {
      const operation = state.operations[id];
      if (!operation) throw new Error("Git operation not found");
      if (operation.version !== expectedVersion) throw new GitOperationVersionConflictError(structuredClone(operation));
      if (operation.status !== "awaiting_approval") throw new Error("Git operation is not awaiting approval");
      if (operation.preflight.approvalDigest !== digest) throw new Error("Git operation approval digest is stale");
      operation.approval = { digest, approvedBy: actor, approvedAt: Date.now(), ...(reason?.trim() ? { reason: reason.trim().slice(0, 1000) } : {}) };
      operation.status = "queued";
      operation.version += 1;
      operation.updatedAt = Date.now();
      return structuredClone(operation);
    });
  }

  cancel(id: string, expectedVersion: number): GitOperation {
    return this.store.transact((state) => {
      const operation = state.operations[id];
      if (!operation) throw new Error("Git operation not found");
      if (operation.version !== expectedVersion) throw new GitOperationVersionConflictError(structuredClone(operation));
      if (!['awaiting_approval', 'queued'].includes(operation.status)) throw new Error("Git operation can no longer be cancelled");
      operation.status = "cancelled";
      operation.version += 1;
      operation.updatedAt = Date.now();
      return structuredClone(operation);
    });
  }

  claim(id: string, leaseMs = 60_000): GitOperation {
    return this.store.transact((state) => {
      const operation = state.operations[id];
      if (!operation) throw new Error("Git operation not found");
      if (operation.status !== "queued") throw new Error("Git operation is not queued");
      const now = Date.now();
      operation.status = "running";
      operation.lease = { ownerPid: process.pid, ownerToken: crypto.randomUUID(), expiresAt: now + leaseMs };
      operation.version += 1;
      operation.updatedAt = now;
      return structuredClone(operation);
    });
  }

  finish(id: string, ownerToken: string, patch: { status: Extract<GitOperationStatus, "completed" | "conflicted" | "failed" | "manual_recovery">; after?: Record<string, unknown>; conflicts?: Array<Record<string, unknown>>; error?: string; traceEventIds?: string[] }): GitOperation {
    return this.store.transact((state) => {
      const operation = state.operations[id];
      if (!operation) throw new Error("Git operation not found");
      if (operation.status !== "running" || operation.lease?.ownerToken !== ownerToken) throw new Error("Git operation lease is no longer owned by this executor");
      operation.status = patch.status;
      operation.lease = undefined;
      if (patch.after) operation.after = patch.after;
      if (patch.conflicts) operation.conflicts = patch.conflicts;
      if (patch.error) operation.error = patch.error.slice(0, 2000);
      if (patch.traceEventIds) operation.traceEventIds.push(...patch.traceEventIds);
      operation.version += 1;
      operation.updatedAt = Date.now();
      return structuredClone(operation);
    });
  }

  checkpoint(id: string, ownerToken: string, after: Record<string, unknown>): GitOperation {
    return this.store.transact((state) => {
      const operation = state.operations[id];
      if (!operation) throw new Error("Git operation not found");
      if (operation.status !== "running" || operation.lease?.ownerToken !== ownerToken) throw new Error("Git operation lease is no longer owned by this executor");
      operation.after = structuredClone(after);
      operation.version += 1;
      operation.updatedAt = Date.now();
      return structuredClone(operation);
    });
  }

  addTrace(id: string, eventId: string): void {
    this.store.transact((state) => {
      const operation = state.operations[id];
      if (!operation || operation.traceEventIds.includes(eventId)) return;
      operation.traceEventIds.push(eventId);
      operation.version += 1;
      operation.updatedAt = Date.now();
    });
  }

  reconcileRunning(resolve: (operation: GitOperation) => { status: "completed" | "queued" | "manual_recovery"; after?: Record<string, unknown>; error?: string }): GitOperation[] {
    return this.store.transact((state) => {
      const now = Date.now();
      for (const operation of Object.values(state.operations)) {
        if (operation.status !== "running" || !operation.lease || operation.lease.expiresAt > now) continue;
        if (isProcessAlive(operation.lease.ownerPid)) continue;
        const resolution = resolve(structuredClone(operation));
        operation.status = resolution.status;
        operation.lease = undefined;
        if (resolution.after) operation.after = resolution.after;
        if (resolution.error) operation.error = resolution.error.slice(0, 2000);
        operation.version += 1;
        operation.updatedAt = now;
      }
      return Object.values(state.operations).map((operation) => structuredClone(operation));
    });
  }
}
