import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { WebSocket } from "ws";
import { runAgentLoop } from "./loop.js";
import { MessageBus } from "./messageBus.js";
import { TaskManager } from "./taskManager.js";
import { TeammateManager } from "./teammateManager.js";
import { registerAgentHooks } from "./agentHooks.js";
import { AgentRunRecorder, listChildRuns, readRunRecord } from "../chat/runHistory.js";
import { listFileMutations } from "../files/mutationRegistry.js";
import { listCheckpoints } from "../chat/checkpoints.js";
import { probeFilesystemIsolation } from "./processSandbox.js";
import type { UserSession } from "../auth/sessionManager.js";
import type { WsServerMessage } from "./types.js";
import { runSubagent } from "./subagent.js";
import { listManagedWorktrees } from "../chat/worktrees.js";
import { clearModelCapabilityCache } from "./modelCapabilities.js";
import { listChangeSets } from "../chat/changeSets.js";

async function readonlyLoop(t: test.TestContext, commands: string[], beforeExecute?: (root: string, input: Record<string, unknown>) => void) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-readonly-loop-")));
  fs.writeFileSync(path.join(root, "notes.md"), "original\n");
  const taskManager = new TaskManager(root); const messageBus = new MessageBus(root);
  const session: UserSession = { token: "readonly-loop", username: "tester", workspaceDir: root, workspaceRoot: root, isAdmin: false, isolated: false,
    taskManager, messageBus, teammateManager: new TeammateManager(root, messageBus, taskManager) };
  const recorder = new AgentRunRecorder(root, "readonly-run", "readonly-conversation", "code");
  const toolStatuses: string[] = [];
  const recordToolState = recorder.toolState.bind(recorder);
  recorder.toolState = async (input) => { toolStatuses.push(input.status); return recordToolState(input); };
  const events: WsServerMessage[] = []; const approvals: string[] = []; const bodies: string[] = [];
  const originalFetch = globalThis.fetch; const previousPath = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin";
  const unregister = registerAgentHooks({ name: "readonly-loop-concurrent-fixture", handlers: { beforeToolExecute: (context) => {
    if (context.toolName === "bash") beforeExecute?.(root, context.input as Record<string, unknown>);
  } } });
  t.after(() => {
    unregister(); globalThis.fetch = originalFetch;
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  });
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "readonly-fixture" }] });
    const index = bodies.length; bodies.push(String(init?.body));
    return Response.json({ choices: [{ finish_reason: index < commands.length ? "tool_calls" : "stop", message: index < commands.length
      ? { role: "assistant", content: null, tool_calls: [{ id: `query-${index}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: commands[index] }) } }] }
      : { role: "assistant", content: "Inspection finished." } }] });
  };
  await recorder.start();
  const messages = await runAgentLoop({ readyState: WebSocket.OPEN, send() {} } as unknown as WebSocket, "Inspect the current directory without changing files.", "readonly-request", session,
    undefined, undefined, (event) => events.push(event), undefined, undefined, undefined, {
      mode: "code", modelName: "readonly-fixture", conversationId: "readonly-conversation", runRecorder: recorder,
      isStopped: () => false, createAbortSignal: () => undefined,
      requestToolApproval: async (request) => { approvals.push(request.name); return "deny"; },
    });
  return { root, recorder, events, approvals, bodies, messages, toolStatuses };
}

test("primary readonly bash runs without approval or step snapshots and never attributes concurrent user edits", async (t) => {
  const result = await readonlyLoop(t, ["pwd", "ls -la"], (root, input) => {
    if (input.command === "ls -la") fs.writeFileSync(path.join(root, "notes.md"), "human edit while Agent inspects\n");
  });
  assert.deepEqual(result.approvals, []); assert.equal(result.bodies.length, 3);
  assert.equal(result.events.some((event) => event.type === "tool_approval_request"), false);
  assert.equal(listCheckpoints(result.root).some((checkpoint) => checkpoint.kind === "step"), false);
  assert.deepEqual(listFileMutations(result.root, { runId: result.recorder.runId }), []);
  assert.equal(fs.readFileSync(path.join(result.root, "notes.md"), "utf8"), "human edit while Agent inspects\n");
  const record = result.recorder.snapshot();
  assert.equal(record.toolExecutions.length, 2);
  assert.ok(record.toolExecutions.every((execution) => !execution.snapshotId));
  const results = result.events.filter((event): event is Extract<WsServerMessage, { type: "tool_result" }> => event.type === "tool_result");
  assert.equal(results.length, 2);
  if (probeFilesystemIsolation().available) {
    assert.ok(results.every((event) => !event.isError), JSON.stringify(results));
    assert.equal(results[0].result, result.root); assert.match(results[1].result, /notes\.md/);
  } else assert.ok(results.every((event) => event.isError));
  assert.equal(result.toolStatuses.includes("awaiting_permission"), false);
});

test("a hook cannot change auto-approved readonly text into a writable or network-enabled invocation", async (t) => {
  for (const network of [false, true]) await t.test(network ? "network flag changed" : "command text changed", async (child) => {
    const result = await readonlyLoop(child, ["pwd"], (_root, input) => {
      if (network) input.allow_network = true;
      else input.command = "echo changed > unauthorized.txt";
    });
    assert.deepEqual(result.approvals, []);
    const failed = result.events.find((event) => event.type === "tool_result");
    assert.ok(failed && failed.type === "tool_result");
    assert.equal(failed.isError, true); assert.match(failed.result, /Read-only command changed after authorization/);
    assert.equal(fs.existsSync(path.join(result.root, "unauthorized.txt")), false);
    assert.deepEqual(listFileMutations(result.root), []);
    assert.equal(listCheckpoints(result.root).some((checkpoint) => checkpoint.kind === "step"), false);
    assert.match(result.bodies[1], /Read-only command changed after authorization/);
  });
});

test("a general subagent performs readonly queries without an approval channel or mutation step evidence", async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-readonly-child-")));
  for (const args of [["init", "-q"], ["config", "user.email", "fixture@example.test"], ["config", "user.name", "Fixture"], ["commit", "--allow-empty", "-qm", "fixture"]]) {
    execFileSync("git", ["-C", root, ...args]);
  }
  const previousFetch = globalThis.fetch; const previousPath = process.env.PATH;
  const bodies: string[] = []; const statuses: string[] = [];
  const recordToolState = AgentRunRecorder.prototype.toolState;
  AgentRunRecorder.prototype.toolState = async function (input) { statuses.push(input.status); return recordToolState.call(this, input); };
  process.env.PATH = "/usr/bin:/bin";
  clearModelCapabilityCache();
  t.after(() => {
    globalThis.fetch = previousFetch; AgentRunRecorder.prototype.toolState = recordToolState; clearModelCapabilityCache();
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  });
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "readonly-child-fixture" }] });
    const first = bodies.length === 0; bodies.push(String(init?.body));
    return Response.json({ choices: [{ finish_reason: first ? "tool_calls" : "stop", message: first
      ? { role: "assistant", content: null, tool_calls: [{ id: "child-pwd", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "pwd" }) } }] }
      : { role: "assistant", content: "Directory inspected." } }] });
  };
  const output = await runSubagent("Inspect current directory without changes.", "general", root, "http://readonly-child.invalid/v1", "readonly-child-fixture", undefined, undefined, undefined, {
    parentRunId: "readonly-parent", parentConversationId: "readonly-child-conversation", parentRequestId: "readonly-parent-request", parentToolCallId: "spawn-child",
  });
  assert.match(output, /Directory inspected/); assert.equal(bodies.length, 2);
  const child = listChildRuns(root, "readonly-parent")[0]; assert.ok(child);
  const record = readRunRecord(root, child.runId); assert.ok(record);
  assert.equal(record.toolExecutions.length, 1);
  assert.equal(record.toolExecutions[0].snapshotId, undefined);
  assert.equal(statuses.includes("awaiting_permission"), false);
  const worktree = listManagedWorktrees(root)[0]; assert.ok(worktree);
  assert.equal(listCheckpoints(worktree.path).some((checkpoint) => checkpoint.kind === "step"), false);
  assert.deepEqual(listFileMutations(worktree.path), []);
  if (probeFilesystemIsolation().available) assert.equal(record.toolExecutions[0].status, "completed");
  assert.deepEqual(listChangeSets(root)[0]?.changedFiles, [], "readonly child should not report source changes");
  assert.match(output, /no_changes/);
});
