import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createActiveRun } from "./runCoordinator.js";
import { AgentRunRecorder } from "./runHistory.js";
import { executeProcessTool } from "../agent/processTools.js";
import { pollProcessSession, startProjectTaskSession, stopProcessSession } from "../run/processSessions.js";
import { TaskManager } from "../agent/taskManager.js";
import { MessageBus } from "../agent/messageBus.js";
import { TeammateManager } from "../agent/teammateManager.js";
import type { UserSession } from "../auth/sessionManager.js";
import type { ToolContext } from "../agent/types.js";

test("finishing a chat cancels its Agent process while preserving a user's manual task", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-process-run-cleanup-"));
  fs.writeFileSync(path.join(workspaceDir, "hold.cjs"), "setInterval(() => {}, 1000);");
  fs.writeFileSync(path.join(workspaceDir, "package.json"), JSON.stringify({ scripts: { hold: "node hold.cjs" } }));
  const taskManager = new TaskManager(workspaceDir);
  const messageBus = new MessageBus(workspaceDir);
  const session: UserSession = { token: "cleanup-token", username: "operator", workspaceDir, workspaceRoot: workspaceDir, isAdmin: false, isolated: false, taskManager, messageBus, teammateManager: new TeammateManager(workspaceDir, messageBus, taskManager) };
  const recorder = new AgentRunRecorder(workspaceDir, "cleanup-run", "cleanup-conversation", "code");
  const run = createActiveRun({ session, recorder, queueSteering: async () => ({ ok: true, code: "accepted" }) });
  const owner = { workspaceDir, owner: "operator" };
  const manual = startProjectTaskSession(owner, "npm:hold");
  const context = { workspaceDir, mode: "code", sessionOwner: "operator", sessionToken: session.token, runId: run.runId, requestId: "cleanup-request", toolCallId: "cleanup-start", compatibilityShellAuthorized: true, signal: run.controlState.createAbortSignal() } as ToolContext;
  const agent = await executeProcessTool("process_start", { command: "node hold.cjs" }, context);
  t.after(async () => { run.finish(); stopProcessSession(owner, manual.id); await new Promise((resolve) => setTimeout(resolve, 100)); fs.rmSync(workspaceDir, { recursive: true, force: true }); });
  run.finish();
  const deadline = Date.now() + 5000;
  while (pollProcessSession({ ...owner, runId: run.runId }, agent.process.session.id).session.status === "running") {
    if (Date.now() > deadline) throw new Error("Agent process did not stop with its run");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(pollProcessSession({ ...owner, runId: run.runId }, agent.process.session.id).session.status, "cancelled");
  assert.equal(pollProcessSession(owner, manual.id).session.status, "running");
});
