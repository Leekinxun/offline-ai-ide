import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MessageBus } from "./messageBus.js";

test("message delivery survives restart, leases, acks, and reclaims", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-bus-")); t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const bus = new MessageBus(workspace); bus.send("lead", "worker", "hello");
  const first = new MessageBus(workspace).leaseInbox("worker", "consumer", 1, 1); assert.equal(first.length, 1); assert.equal(new MessageBus(workspace).leaseInbox("worker").length, 0);
  bus.reclaimExpired(first[0].message.lease!.expiresAt + 1);
  const again = bus.leaseInbox("worker"); assert.equal(again[0].message.content, "hello"); assert.equal(bus.ack("worker", again[0].message.id!, again[0].token), true); assert.equal(bus.leaseInbox("worker").length, 0);
});

test("message subscriptions are event driven and identifiers are safe", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-bus-sub-")); t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const bus = new MessageBus(workspace); let notified = 0; const unsubscribe = bus.subscribe("worker", () => notified++);
  bus.send("lead", "worker", "go"); unsubscribe(); bus.send("lead", "worker", "later");
  assert.equal(notified, 1); assert.throws(() => bus.send("lead", "../escape", "no"), /Invalid agent identifier/);
});

test("malicious extra fields cannot redirect, pre-ack, or replace identity", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-bus-extra-")); t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const bus = new MessageBus(workspace); bus.send("lead", "worker", "safe", "message", { id: "evil", recipient: "other", delivery: "acked", sequence: -1, lease: { token: "evil" }, trace: "ok" });
  assert.equal(bus.leaseInbox("other").length, 0); const [leased] = bus.leaseInbox("worker"); assert.notEqual(leased.message.id, "evil"); assert.notEqual(leased.message.sequence, -1); assert.equal(leased.message.trace, "ok");
  // A process crash before ACK leaves the message leased and reclaimable.
  assert.equal(new MessageBus(workspace).leaseInbox("worker").length, 0); bus.reclaimExpired(leased.message.lease!.expiresAt + 1); assert.equal(new MessageBus(workspace).leaseInbox("worker").length, 1);
});
