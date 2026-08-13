import crypto from "crypto";
import { OrchestrationStore } from "./orchestrationStore.js";
import { InboxMessage } from "./types.js";

interface MessageState { schemaVersion: 1; version: number; sequence: number; messages: InboxMessage[]; }
export interface MessageLease { message: InboxMessage; token: string; }
const safeId = (value: string) => { if (!/^[A-Za-z0-9_.:@-]{1,160}$/.test(value)) throw new Error("Invalid agent identifier"); return value; };

/** Append-only durable inbox. Messages are acknowledged, never destructively read. */
export class MessageBus {
  private readonly store: OrchestrationStore<MessageState>;
  private readonly listeners = new Map<string, Set<() => void>>();
  constructor(workspaceDir: string) { this.store = new OrchestrationStore(workspaceDir, "messages", () => ({ schemaVersion: 1, version: 1, sequence: 0, messages: [] })); }
  send(sender: string, to: string, content: string, msgType = "message", extra?: Record<string, unknown>): string {
    safeId(sender); safeId(to); if (!content.trim()) throw new Error("Message content is required");
    const safeExtra = Object.fromEntries(Object.entries(extra || {}).filter(([key]) => !["id", "sequence", "type", "from", "recipient", "content", "timestamp", "delivery", "lease"].includes(key)).slice(0, 50));
    const message = this.store.transact((state) => { const created: InboxMessage = { ...safeExtra, id: crypto.randomUUID(), sequence: ++state.sequence, type: msgType.slice(0, 80), from: sender, recipient: to, content: content.slice(0, 16_000), timestamp: Date.now(), delivery: "available" }; state.messages.push(created); if (state.messages.length > 20_000) { const removable = state.messages.length - 20_000; let removed = 0; state.messages = state.messages.filter((item) => item.delivery !== "acked" || removed++ >= removable); } state.version++; return created; });
    this.listeners.get(to)?.forEach((listener) => { try { listener(); } catch { /* subscriber isolation */ } });
    return `Sent ${msgType} to ${to} (${message.id})`;
  }
  leaseInbox(name: string, consumer = name, limit = 50, leaseMs = 30_000): MessageLease[] { safeId(name); safeId(consumer); return this.store.transact((state) => { const now = Date.now(); const delivered: MessageLease[] = []; for (const message of state.messages) { if (delivered.length >= Math.max(1, limit) || message.recipient !== name || message.delivery === "acked") continue; if (message.delivery === "leased" && message.lease && message.lease.expiresAt > now) continue; const token = crypto.randomUUID(); message.delivery = "leased"; message.lease = { consumer, token, expiresAt: now + Math.max(1000, leaseMs) }; delivered.push({ message: structuredClone(message), token }); } return delivered; }); }
  ack(name: string, messageId: string, token: string): boolean { safeId(name); return this.store.transact((state) => { const message = state.messages.find((item) => item.id === messageId && item.recipient === name); if (!message?.lease || message.lease.token !== token) return false; message.delivery = "acked"; message.lease = undefined; return true; }); }
  reclaimExpired(now = Date.now()): number { return this.store.transact((state) => { let count = 0; for (const message of state.messages) if (message.delivery === "leased" && message.lease && message.lease.expiresAt <= now) { message.delivery = "available"; message.lease = undefined; count++; } return count; }); }
  /** Compatibility read: safely leases and acknowledges exactly the returned messages. */
  readInbox(name: string): InboxMessage[] { const leased = this.leaseInbox(name); leased.forEach(({ message, token }) => this.ack(name, message.id!, token)); return leased.map(({ message }) => message); }
  subscribe(name: string, listener: () => void): () => void { safeId(name); const set = this.listeners.get(name) || new Set(); set.add(listener); this.listeners.set(name, set); return () => { set.delete(listener); if (!set.size) this.listeners.delete(name); }; }
  broadcast(sender: string, content: string, names: string[]): string { let count = 0; for (const name of names) if (name !== sender) { this.send(sender, name, content, "broadcast"); count++; } return `Broadcast to ${count} teammates`; }
  list(name?: string): InboxMessage[] { return this.store.snapshot().messages.filter((message) => !name || message.recipient === name).map((message) => structuredClone(message)); }
}
