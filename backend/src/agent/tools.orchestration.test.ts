import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MessageBus } from "./messageBus.js";
import { TaskManager } from "./taskManager.js";
import { TOOL_DISPATCH } from "./tools.js";

test("structured orchestration commands are idempotent and enforce lease tokens", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-tool-command-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const taskManager = new TaskManager(workspaceDir);
  const messageBus = new MessageBus(workspaceDir);
  const context = { workspaceDir, actorName: "lead", taskManager, messageBus } as never;

  const createArgs = { action: "create", subject: "once", idempotency_key: "create-1" };
  const first = await TOOL_DISPATCH.task_command(createArgs, context);
  const again = await TOOL_DISPATCH.task_command(createArgs, context);
  assert.equal(first, again);
  assert.equal(taskManager.listTasks().length, 1);

  const lease = JSON.parse(String(await TOOL_DISPATCH.task_command({ action: "claim", task_id: 1, owner: "lead" }, context))).lease;
  assert.ok(lease.token);
  assert.equal(JSON.parse(String(await TOOL_DISPATCH.task_command({ action: "renew", task_id: 1, owner: "lead", lease_token: "wrong" }, context))).renewed, false);
  assert.equal(JSON.parse(String(await TOOL_DISPATCH.task_command({ action: "renew", task_id: 1, owner: "lead", lease_token: lease.token }, context))).renewed, true);

  await TOOL_DISPATCH.message_command({ action: "send", to: "worker", content: "hello", idempotency_key: "message-1" }, context);
  await TOOL_DISPATCH.message_command({ action: "send", to: "worker", content: "hello", idempotency_key: "message-1" }, context);
  const messages = JSON.parse(String(await TOOL_DISPATCH.message_command({ action: "lease", agent: "worker" }, context)));
  assert.equal(messages.length, 1);
  assert.equal(JSON.parse(String(await TOOL_DISPATCH.message_command({ action: "ack", agent: "worker", message_id: messages[0].message.id, lease_token: "wrong" }, context))).acked, false);
  assert.equal(JSON.parse(String(await TOOL_DISPATCH.message_command({ action: "ack", agent: "worker", message_id: messages[0].message.id, lease_token: messages[0].token }, context))).acked, true);
});
