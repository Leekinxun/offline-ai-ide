import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MessageBus } from "../agent/messageBus.js";
import { TaskManager } from "../agent/taskManager.js";
import { TeammateManager } from "../agent/teammateManager.js";
import { classifyToolApproval } from "../agent/toolApproval.js";
import type { UserSession } from "../auth/sessionManager.js";
import { AgentRunRecorder } from "./runHistory.js";
import { createActiveRun, stopRunsForSession } from "./runCoordinator.js";

test("approval survives continuation only within the same login, workspace and conversation, and logout clears it", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-grants-"));
  const a = path.join(root, "a"); const b = path.join(root, "b"); fs.mkdirSync(a); fs.mkdirSync(b);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let count = 0;
  const session = (workspaceDir: string, token = "grants-owner"): UserSession => {
    const taskManager = new TaskManager(workspaceDir); const messageBus = new MessageBus(workspaceDir);
    return { token, username: "tester", workspaceDir, workspaceRoot: root, isAdmin: false, isolated: false,
      taskManager, messageBus, teammateManager: new TeammateManager(workspaceDir, messageBus, taskManager) };
  };
  const run = (workspace: string, conversation = "chat", token?: string) => createActiveRun({
    session: session(workspace, token), recorder: new AgentRunRecorder(workspace, `run-${++count}`, conversation, "code"),
    queueSteering: async () => ({ ok: true, code: "accepted" }),
  });
  const request = (active: ReturnType<typeof run>, command = "npm test") => {
    const requirement = classifyToolApproval("bash", { command }, { workspaceDir: active.workspaceDir });
    assert.equal(requirement.kind, "approval");
    if (requirement.kind !== "approval") throw new Error("expected approval");
    return active.approvals.requestDetailed({ ...requirement, conversationId: active.conversationId, requestId: "req", toolCallId: "tool", name: "bash", input: { command } });
  };
  const first = run(a); const initial = request(first);
  first.approvals.resolve(first.approvals.listPending()[0].approvalId, "allow_session");
  assert.equal((await initial).decision, "allow_session"); first.finish();
  const continued = run(a);
  assert.equal((await request(continued)).decision, "allow_session");
  const changedCommand = request(continued, "npm run build");
  assert.equal(continued.approvals.pendingCount(), 1);
  continued.approvals.cancelAll(); await changedCommand; continued.finish();
  for (const [workspace, conversation, token] of [[b, "chat", "grants-owner"], [a, "another-chat", "grants-owner"], [a, "chat", "another-login"]]) {
    const active = run(workspace, conversation, token);
    const pending = request(active); assert.equal(active.approvals.pendingCount(), 1);
    active.approvals.cancelAll(); assert.equal((await pending).decision, "deny"); active.finish();
  }
  stopRunsForSession("grants-owner");
  const afterLogout = run(a); const pending = request(afterLogout);
  assert.equal(afterLogout.approvals.pendingCount(), 1);
  afterLogout.approvals.cancelAll(); await pending; afterLogout.finish();
});
