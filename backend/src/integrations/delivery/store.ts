import crypto from "node:crypto";
import { OrchestrationStore } from "../../agent/orchestrationStore.js";
import type { DeliveryBinding, PreparedDeliveryRequest, ProviderCapabilities, VerifiedDeliveryEvent } from "./types.js";
import { DeliveryConflictError } from "./types.js";
import { normalizeDeliveryBindingUrls } from "./providerUrl.js";

export type DeliveryOperationStatus = "awaiting_approval" | "approved" | "in_flight" | "succeeded" | "ambiguous" | "failed";
export interface DeliveryOperation {
  id: string;
  version: number;
  idempotencyKeyHash: string;
  requestDigest: string;
  approvalDigest: string;
  status: DeliveryOperationStatus;
  providerConfigId: string;
  preparedBy: string;
  request: PreparedDeliveryRequest;
  approval?: { digest: string; approvedBy: string; approvedAt: number };
  deliveryId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}
interface DeliveryState {
  schemaVersion: 2;
  operations: Record<string, DeliveryOperation>;
  idempotency: Record<string, { operationId: string; requestDigest: string }>;
  deliveries: Record<string, DeliveryBinding>;
  webhookReceipts: Record<string, { providerConfigId: string; event: string; receivedAt: number }>;
  capabilities: Record<string, ProviderCapabilities>;
}
function initial(): DeliveryState { return { schemaVersion: 2, operations: {}, idempotency: {}, deliveries: {}, webhookReceipts: {}, capabilities: {} }; }
function hash(value: string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function trimMap<T>(value: Record<string, T>, max: number): void { const entries = Object.entries(value); if (entries.length <= max) return; for (const [key] of entries.slice(0, entries.length - max)) delete value[key]; }

export class DeliveryStore {
  private readonly store: OrchestrationStore<DeliveryState>;
  constructor(workspaceDir: string) { this.store = new OrchestrationStore(workspaceDir, "provider-delivery", initial); }

  prepare(input: { idempotencyKey: string; requestDigest: string; approvalDigest: string; providerConfigId: string; actorId: string; request: PreparedDeliveryRequest }): DeliveryOperation {
    if (!input.idempotencyKey.trim()) throw new Error("Idempotency-Key is required");
    const keyHash = hash(input.idempotencyKey);
    return this.store.transact((state) => {
      const previous = state.idempotency[keyHash];
      if (previous) {
        if (previous.requestDigest !== input.requestDigest) throw new DeliveryConflictError("idempotency_conflict", "Idempotency-Key is bound to different publication fields; use a new key for the changed request");
        const existing = state.operations[previous.operationId];
        if (!existing) throw new Error("Delivery idempotency ledger is inconsistent");
        return structuredClone(existing);
      }
      const now = Date.now();
      const operation: DeliveryOperation = { id: `delivery-op-${crypto.randomUUID()}`, version: 1, idempotencyKeyHash: keyHash, requestDigest: input.requestDigest, approvalDigest: input.approvalDigest, status: "awaiting_approval", providerConfigId: input.providerConfigId, preparedBy: input.actorId, request: structuredClone(input.request), createdAt: now, updatedAt: now };
      state.operations[operation.id] = operation; state.idempotency[keyHash] = { operationId: operation.id, requestDigest: input.requestDigest };
      trimMap(state.operations, 2_000); trimMap(state.idempotency, 2_000); return structuredClone(operation);
    });
  }

  listOperations(): DeliveryOperation[] { return Object.values(this.store.snapshot().operations).sort((a, b) => b.createdAt - a.createdAt); }
  getOperation(id: string): DeliveryOperation { const item = this.store.snapshot().operations[id]; if (!item) throw new Error("Delivery operation not found"); return structuredClone(item); }

  approve(id: string, expectedVersion: number, digest: string, actorId: string): DeliveryOperation {
    return this.store.transact((state) => {
      const operation = state.operations[id]; if (!operation) throw new Error("Delivery operation not found");
      if (operation.version !== expectedVersion) throw new DeliveryConflictError("version_conflict", `Delivery operation version changed: expected ${expectedVersion}, got ${operation.version}`);
      if (operation.status !== "awaiting_approval") throw new DeliveryConflictError("approval_conflict", "Delivery operation is not awaiting approval");
      if (operation.approvalDigest !== digest) throw new DeliveryConflictError("approval_conflict", "Delivery approval digest is stale or was not issued by the server");
      operation.approval = { digest, approvedBy: actorId, approvedAt: Date.now() }; operation.status = "approved"; operation.version += 1; operation.updatedAt = Date.now(); return structuredClone(operation);
    });
  }

  claimApproved(id: string, expectedVersion: number, actorId: string): DeliveryOperation {
    return this.store.transact((state) => {
      const operation = state.operations[id]; if (!operation) throw new Error("Delivery operation not found");
      if (operation.status === "succeeded") return structuredClone(operation);
      if (operation.status === "ambiguous") throw new DeliveryConflictError("ambiguous_operation", "Publication result is ambiguous; use read-only reconcile before any new write");
      if (operation.status === "in_flight") throw new DeliveryConflictError("approval_conflict", "Publication is already in flight");
      if (operation.status === "failed") throw new DeliveryConflictError("approval_conflict", "Failed publication cannot be replayed; prepare a new request with a new idempotency key");
      if (operation.version !== expectedVersion) throw new DeliveryConflictError("version_conflict", `Delivery operation version changed: expected ${expectedVersion}, got ${operation.version}`);
      if (operation.status !== "approved" || !operation.approval || operation.approval.digest !== operation.approvalDigest) throw new DeliveryConflictError("approval_conflict", "A valid server-owned approval is required");
      if (operation.approval.approvedBy !== actorId) throw new DeliveryConflictError("approval_conflict", "The approving actor must publish this operation");
      operation.status = "in_flight"; operation.version += 1; operation.updatedAt = Date.now(); return structuredClone(operation);
    });
  }

  finish(id: string, status: "succeeded" | "ambiguous" | "failed", patch: { deliveryId?: string; error?: string } = {}): DeliveryOperation {
    return this.store.transact((state) => {
      const operation = state.operations[id]; if (!operation) throw new Error("Delivery operation not found");
      if (status !== "succeeded" && operation.status !== "in_flight" && operation.status !== "ambiguous") throw new Error("Delivery operation cannot transition from its current state");
      operation.status = status; if (patch.deliveryId) operation.deliveryId = patch.deliveryId; if (patch.error) operation.error = patch.error.slice(0, 2_000); operation.version += 1; operation.updatedAt = Date.now(); return structuredClone(operation);
    });
  }

  putDelivery(binding: DeliveryBinding): DeliveryBinding { const safeBinding = normalizeDeliveryBindingUrls(binding); return this.store.transact((state) => { state.deliveries[safeBinding.id] = structuredClone(safeBinding); trimMap(state.deliveries, 1_000); return structuredClone(safeBinding); }); }
  getDelivery(id: string): DeliveryBinding | undefined { const item = this.store.snapshot().deliveries[id]; return item ? structuredClone(item) : undefined; }
  listDeliveries(): DeliveryBinding[] { return Object.values(this.store.snapshot().deliveries).sort((a, b) => b.updatedAt - a.updatedAt); }
  putCapabilities(value: ProviderCapabilities): void { this.store.transact((state) => { state.capabilities[value.providerConfigId] = structuredClone(value); }); }
  getCapabilities(providerConfigId: string): ProviderCapabilities | undefined { const item = this.store.snapshot().capabilities[providerConfigId]; return item ? structuredClone(item) : undefined; }
  recordWebhook(event: VerifiedDeliveryEvent): boolean { return this.store.transact((state) => { const key = `${event.providerConfigId}:${event.deliveryId}`; if (state.webhookReceipts[key]) return false; state.webhookReceipts[key] = { providerConfigId: event.providerConfigId, event: event.event, receivedAt: event.receivedAt }; trimMap(state.webhookReceipts, 10_000); return true; }); }
}
