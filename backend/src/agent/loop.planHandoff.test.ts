import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { MessageBus } from "./messageBus.js";
import { runAgentLoop } from "./loop.js";
import { TaskManager } from "./taskManager.js";
import { TeammateManager } from "./teammateManager.js";
import type { WsServerMessage } from "./types.js";
import type { UserSession } from "../auth/sessionManager.js";
import { findLatestApprovedExecutionPlan } from "../chat/executionPlans.js";
import { PLAN_HANDOFF_CONFIRMATION } from "../chat/planHandoff.js";
import { AgentRunRecorder } from "../chat/runHistory.js";

test("an approved submit_plan ends the Plan model loop before any edit attempt", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-plan-loop-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));

  const taskManager = new TaskManager(workspaceDir);
  const messageBus = new MessageBus(workspaceDir);
  const session: UserSession = {
    token: "plan-loop-token",
    username: "plan-loop-user",
    workspaceDir,
    workspaceRoot: workspaceDir,
    isAdmin: false,
    isolated: false,
    taskManager,
    messageBus,
    teammateManager: new TeammateManager(workspaceDir, messageBus, taskManager),
  };
  const recorder = new AgentRunRecorder(
    workspaceDir,
    "plan-run",
    "conversation-1",
    "plan",
    undefined,
    undefined,
    undefined,
    "test-model"
  );
  await recorder.start();

  const emitted: WsServerMessage[] = [];
  const ws = {
    readyState: WebSocket.OPEN,
    send(payload: string) {
      emitted.push(JSON.parse(payload) as WsServerMessage);
    },
  } as unknown as WebSocket;
  const originalFetch = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = async () => {
    modelCalls += 1;
    assert.equal(modelCalls, 1, "Plan must not request another model turn after approval");
    return Response.json({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "submit-plan-1",
            type: "function",
            function: {
              name: "submit_plan",
              arguments: JSON.stringify({
                goal: "Fix the approved issue",
                files: ["src/feature.ts"],
                steps: ["Apply the fix"],
                risks: [],
                verification_commands: ["npm test"],
                acceptance_criteria: ["The issue is fixed"],
              }),
            },
          }],
        },
      }],
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const persisted = await runAgentLoop(
    ws,
    "Plan and fix the issue",
    "request-1",
    session,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      isStopped: () => false,
      createAbortSignal: () => undefined,
      mode: "plan",
      modelName: "test-model",
      conversationId: "conversation-1",
      runRecorder: recorder,
      requestToolApproval: async () => "allow_once",
    }
  );

  assert.equal(modelCalls, 1);
  assert.ok(persisted[0]?.content?.includes(PLAN_HANDOFF_CONFIRMATION));
  assert.equal(persisted[0]?.toolCalls?.[0]?.name, "submit_plan");
  assert.equal(persisted[0]?.toolCalls?.[0]?.isError, false);
  assert.ok(findLatestApprovedExecutionPlan(workspaceDir, "conversation-1"));
  assert.ok(emitted.some((message) =>
    message.type === "done" && message.requestId === "request-1"
  ));
});
