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
import type { UserSession } from "../auth/sessionManager.js";
import { AgentRunRecorder } from "../chat/runHistory.js";
import { listFileMutations, rollbackFileMutations } from "../files/mutationRegistry.js";

function sessionFor(workspaceDir: string): UserSession {
  const taskManager = new TaskManager(workspaceDir);
  const messageBus = new MessageBus(workspaceDir);
  return {
    token: "mutation-token", username: "primary-user", workspaceDir, workspaceRoot: workspaceDir,
    isAdmin: false, isolated: false, taskManager, messageBus,
    teammateManager: new TeammateManager(workspaceDir, messageBus, taskManager),
  };
}

async function runSingleTool(
  workspaceDir: string,
  toolCall: { id: string; name: string; arguments: Record<string, unknown> },
  approve: () => Promise<"allow_once" | "deny"> = async () => "allow_once",
) {
  const recorder = new AgentRunRecorder(workspaceDir, "run-primary", "conversation-primary", "code", undefined, undefined, undefined, "test-model");
  await recorder.start();
  const ws = { readyState: WebSocket.OPEN, send() {} } as unknown as WebSocket;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json(calls === 1 ? {
      choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: toolCall.id, type: "function", function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) } }] } }],
    } : { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }] });
  };
  try {
    return await runAgentLoop(ws, "make a change", "request-primary", sessionFor(workspaceDir), undefined, undefined, undefined, undefined, undefined, undefined, {
      isStopped: () => false, createAbortSignal: () => undefined, mode: "code", modelName: "test-model",
      conversationId: "conversation-primary", runRecorder: recorder, requestToolApproval: approve,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("primary shell changes are captured from the step checkpoint as create, modify, and delete", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-shell-mutations-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspaceDir, "changed.txt"), "before");
  fs.writeFileSync(path.join(workspaceDir, "deleted.txt"), "remove-me");
  await runSingleTool(workspaceDir, {
    id: "bash-call", name: "bash",
    arguments: { command: "sed -i '' s/before/after/ changed.txt; touch created.txt; mv deleted.txt moved.txt" },
  });
  const records = listFileMutations(workspaceDir, { runId: "run-primary", toolCallId: "bash-call" });
  assert.deepEqual(records.map((record) => [record.path, record.operation, record.preimageContent]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))), [
    ["changed.txt", "modify", "before"],
    ["created.txt", "create", undefined],
    ["deleted.txt", "delete", "remove-me"],
    ["moved.txt", "create", undefined],
  ]);
  assert.ok(records.every((record) => record.actor === "primary-user"));
});

test("a failed primary shell tool journals partial side effects and supports rollback", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-failed-shell-mutations-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspaceDir, "partial.txt"), "before");
  const persisted = await runSingleTool(workspaceDir, {
    id: "failed-bash-call", name: "bash",
    arguments: { command: "sed -i '' s/before/partial/ partial.txt; false" },
  });

  assert.equal(persisted[0]?.toolCalls?.[0]?.isError, true);
  assert.match(persisted[0]?.toolCalls?.[0]?.result || "", /Process exited with code 1/);
  const records = listFileMutations(workspaceDir, {
    runId: "run-primary",
    toolCallId: "failed-bash-call",
  });
  assert.deepEqual(records.map((record) => ({
    path: record.path,
    operation: record.operation,
    preimageContent: record.preimageContent,
  })), [{ path: "partial.txt", operation: "modify", preimageContent: "before" }]);
  assert.deepEqual(
    rollbackFileMutations(workspaceDir, { runId: "run-primary", toolCallId: "failed-bash-call" }).applied,
    [records[0].id]
  );
  assert.equal(fs.readFileSync(path.join(workspaceDir, "partial.txt"), "utf8"), "before");
});

test("a denied primary tool never creates a mutation journal entry", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-denied-mutations-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  await runSingleTool(workspaceDir, {
    id: "denied-write", name: "write_file", arguments: { path: "denied.txt", content: "no" },
  }, async () => "deny");
  assert.equal(fs.existsSync(path.join(workspaceDir, "denied.txt")), false);
  assert.equal(listFileMutations(workspaceDir, { runId: "run-primary", toolCallId: "denied-write" }).length, 0);
});

test("a mutating primary tool fails before execution when its checkpoint cannot be created", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-checkpoint-required-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspaceDir, ".checkpoints"), "blocks checkpoint directory");
  const persisted = await runSingleTool(workspaceDir, { id: "write-without-baseline", name: "write_file", arguments: { path: "should-not-exist.txt", content: "unsafe" } });
  assert.equal(fs.existsSync(path.join(workspaceDir, "should-not-exist.txt")), false);
  assert.equal(persisted[0]?.toolCalls?.[0]?.isError, true);
  assert.match(persisted[0]?.toolCalls?.[0]?.result || "", /required mutation checkpoint unavailable/i);
});
