import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MessageBus } from "./messageBus.js";
import { TaskManager } from "./taskManager.js";
import { TOOL_DISPATCH } from "./tools.js";
import { TraceStore } from "../chat/traceStore.js";

test("structured orchestration commands are idempotent and enforce lease tokens", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-tool-command-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const taskManager = new TaskManager(workspaceDir);
  const messageBus = new MessageBus(workspaceDir);
  const context = { workspaceDir, actorName: "lead", agentProfileId: "primary", runId: "run-1", requestId: "request-1", toolCallId: "message-tool-1", taskManager, messageBus } as never;

  const createArgs = { action: "create", subject: "once", idempotency_key: "create-1" };
  const first = await TOOL_DISPATCH.task_command(createArgs, context);
  const again = await TOOL_DISPATCH.task_command(createArgs, context);
  assert.equal(first, again);
  assert.equal(taskManager.listTasks().length, 1);

  const lease = JSON.parse(String(await TOOL_DISPATCH.task_command({ action: "claim", task_id: 1, owner: "lead" }, context))).lease;
  assert.ok(lease.token);
  assert.equal(JSON.parse(String(await TOOL_DISPATCH.task_command({ action: "renew", task_id: 1, owner: "lead", lease_token: "wrong" }, context))).renewed, false);
  assert.equal(JSON.parse(String(await TOOL_DISPATCH.task_command({ action: "renew", task_id: 1, owner: "lead", lease_token: lease.token }, context))).renewed, true);

  await TOOL_DISPATCH.message_command({ action: "send", to: "worker", content: "password=message-secret", idempotency_key: "message-1" }, context);
  await TOOL_DISPATCH.message_command({ action: "send", to: "worker", content: "password=message-secret", idempotency_key: "message-1" }, context);
  const messages = JSON.parse(String(await TOOL_DISPATCH.message_command({ action: "lease", agent: "worker" }, context)));
  assert.equal(messages.length, 1);
  assert.equal(JSON.parse(String(await TOOL_DISPATCH.message_command({ action: "ack", agent: "worker", message_id: messages[0].message.id, lease_token: "wrong" }, context))).acked, false);
  assert.equal(JSON.parse(String(await TOOL_DISPATCH.message_command({ action: "ack", agent: "worker", message_id: messages[0].message.id, lease_token: messages[0].token }, context))).acked, true);
  const lifecycle = new TraceStore(workspaceDir).list().filter((event) => event.action === "collaboration.message_leased" || event.action === "collaboration.message_acked");
  assert.equal(lifecycle.filter((event) => event.action === "collaboration.message_leased").length, 1);
  assert.equal(lifecycle.filter((event) => event.action === "collaboration.message_acked").length, 2);
  for (const event of lifecycle) {
    assert.equal(event.metadata?.runId, "run-1");
    assert.equal(event.metadata?.agentId, "primary");
    assert.equal(event.metadata?.requestId, "request-1");
    assert.equal(event.metadata?.toolCallId, "message-tool-1");
    assert.equal(event.metadata?.messageId, messages[0].message.id);
  }
  assert.doesNotMatch(JSON.stringify(lifecycle), /message-secret|password|lease_token|content/);
});
