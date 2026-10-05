import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { config } from "../config.js";
import { listCheckpoints } from "../chat/checkpoints.js";
import { listChangeSets } from "../chat/changeSets.js";
import { readRunChanges } from "../chat/runChanges.js";
import { listChildRuns, readRunRecord } from "../chat/runHistory.js";
import { listManagedWorktrees } from "../chat/worktrees.js";
import { listDesktopExternalToolEffects } from "../desktop/nativeExternalEffects.js";
import { shutdownDesktopNativeIde } from "../desktop/nativeIdeClient.js";
import { MessageBus } from "./messageBus.js";
import { clearModelCapabilityCache } from "./modelCapabilities.js";
import { runSubagent } from "./subagent.js";
import { TaskManager } from "./taskManager.js";
import { TeammateManager } from "./teammateManager.js";
import type { PermissionAuthorizer } from "./permissionService.js";
import type { OpenAIMessage, OpenAIToolDef } from "./types.js";

const providerUrl = "https://delegated-effects.invalid/v1";
const releaseCore = fileURLToPath(new URL(`../../../desktop/rust/target/release/crownforge-ide-core${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
const debugCore = fileURLToPath(new URL(`../../../desktop/rust/target/debug/crownforge-ide-core${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
const nativeCore = process.env.CROWNFORGE_TEST_NATIVE_IDE || (fs.existsSync(debugCore) ? debugCore : releaseCore);
const nativeOptions = { skip: !fs.existsSync(nativeCore), timeout: 45_000 };

type ToolCall = { id: string; name: string; args: Record<string, unknown> };
type Turn = { content: string } | { toolCalls: ToolCall[] };
type ChatRequest = { messages?: OpenAIMessage[]; tools?: OpenAIToolDef[] };

function initializeGitWorkspace(workspaceDir: string): void {
  execFileSync("git", ["init", "-q", workspaceDir]);
  execFileSync("git", ["-C", workspaceDir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", workspaceDir, "config", "user.name", "Test"]);
  fs.writeFileSync(path.join(workspaceDir, "README.md"), "fixture\n");
  execFileSync("git", ["-C", workspaceDir, "add", "README.md"]);
  execFileSync("git", ["-C", workspaceDir, "commit", "-qm", "fixture"]);
}

function fixture(t: test.TestContext, prefix: string, turns: Turn[]) {
  const workspaceDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  initializeGitWorkspace(workspaceDir);
  const previous = {
    fetch: globalThis.fetch,
    models: config.models,
    profiles: config.agentProfiles,
    fallbacks: config.modelFallbacks,
    desktop: process.env.CREWFORGE_DESKTOP,
    core: process.env.CROWNFORGE_IDE_CORE_EXECUTABLE,
  };
  const requests: ChatRequest[] = [];
  let chatCalls = 0;
  clearModelCapabilityCache();
  config.models = [{ modelName: "delegated-native-model", apiUrl: providerUrl, apiKey: "", maxTokens: 1024 }];
  config.agentProfiles = {};
  config.modelFallbacks = [];
  process.env.CREWFORGE_DESKTOP = "1";
  process.env.CROWNFORGE_IDE_CORE_EXECUTABLE = nativeCore;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    assert.ok(url.startsWith(providerUrl), `unexpected provider URL: ${url}`);
    if (url.endsWith("/models")) return Response.json({ data: [{ id: "delegated-native-model", max_output_tokens: 1024 }] });
    assert.ok(url.endsWith("/chat/completions"), `unexpected provider URL: ${url}`);
    requests.push(JSON.parse(String(init?.body || "{}")) as ChatRequest);
    const turn = turns[Math.min(chatCalls, turns.length - 1)];
    chatCalls += 1;
    if ("toolCalls" in turn) {
      return Response.json({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: turn.toolCalls.map((tool) => ({
              id: tool.id,
              type: "function",
              function: { name: tool.name, arguments: JSON.stringify(tool.args) },
            })),
          },
        }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });
    }
    return Response.json({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: turn.content } }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    });
  }) as typeof fetch;
  t.after(async () => {
    await shutdownDesktopNativeIde();
    globalThis.fetch = previous.fetch;
    config.models = previous.models;
    config.agentProfiles = previous.profiles;
    config.modelFallbacks = previous.fallbacks;
    if (previous.desktop === undefined) delete process.env.CREWFORGE_DESKTOP; else process.env.CREWFORGE_DESKTOP = previous.desktop;
    if (previous.core === undefined) delete process.env.CROWNFORGE_IDE_CORE_EXECUTABLE; else process.env.CROWNFORGE_IDE_CORE_EXECUTABLE = previous.core;
    clearModelCapabilityCache();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });
  return { workspaceDir, requests, get chatCalls() { return chatCalls; } };
}

async function waitFor(predicate: () => boolean, message: () => string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message());
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\''`)}'`;
}

function writeCommand(relativePath: string, content: string): string {
  return `printf %s ${shellQuote(content)} > ${shellQuote(relativePath)}`;
}

function readRawRunStatus(workspaceDir: string, runId: string): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(workspaceDir, ".history", "runs", `${runId}.json`), "utf8")) as { status?: string };
    return raw.status;
  } catch {
    return undefined;
  }
}

function assertUntrackedReceipt(input: { workspaceDir: string; childRunId: string; requestId: string; toolCallId: string; toolName: string }) {
  const receipts = listDesktopExternalToolEffects(input.workspaceDir, {
    runId: input.childRunId,
    requestId: input.requestId,
    expectedToolCallIds: [input.toolCallId],
  });
  assert.equal(receipts.length, 1, JSON.stringify(receipts));
  assert.equal(receipts[0].runId, input.childRunId);
  assert.equal(receipts[0].requestId, input.requestId);
  assert.equal(receipts[0].toolCallId, input.toolCallId);
  assert.equal(receipts[0].toolName, input.toolName);
  assert.equal(receipts[0].rollbackCoverage, "untracked");
  assert.equal(receipts[0].observationComplete, false);
  assert.deepEqual(receipts[0].observedPaths, []);
  assert.ok(receipts[0].finishedAt !== undefined && receipts[0].finishedAt >= receipts[0].startedAt);
  return receipts[0];
}

function assertNoChildCheckpoints(childWorkspace: string): void {
  assert.equal(listCheckpoints(childWorkspace).length, 0);
  assert.equal(fs.existsSync(path.join(childWorkspace, ".checkpoints", "index.json")), false);
}

const allowAll: PermissionAuthorizer = async () => ({ allowed: true });

test("native general subagent bash records parent-owned untracked effects without child checkpoints", nativeOptions, async (t) => {
  const bashId = "subagent-bash";
  const requestId = "request-subagent-native";
  const f = fixture(t, "crewforge-native-subagent-effects-", [
    { toolCalls: [{ id: bashId, name: "bash", args: { command: writeCommand("delegated.txt", "subagent wrote\n") } }] },
    { content: "subagent done" },
  ]);

  const output = await runSubagent(
    "write through bash",
    "general",
    f.workspaceDir,
    providerUrl,
    "delegated-native-model",
    "",
    allowAll,
    undefined,
    {
      parentRunId: "parent-subagent-native",
      parentConversationId: "conversation-subagent-native",
      parentRequestId: requestId,
      parentToolCallId: "parent-subagent-call",
    }
  );

  assert.match(output, /subagent done\nChangeSet [a-f0-9]+ \(ready_for_review\)$/);
  const childRuns = listChildRuns(f.workspaceDir, "parent-subagent-native");
  assert.equal(childRuns.length, 1);
  const childRunId = childRuns[0].runId;
  await waitFor(() => readRunRecord(f.workspaceDir, childRunId).status === "completed", () => JSON.stringify(readRunRecord(f.workspaceDir, childRunId)));
  const run = readRunRecord(f.workspaceDir, childRunId);
  assert.equal(run.status, "completed");
  assert.equal(run.agentName, "subagent:general");
  assert.equal(run.parentRequestId, requestId);
  const execution = run.toolExecutions.find((tool) => tool.toolCallId === bashId);
  assert.equal(execution?.status, "completed");
  assert.equal(execution?.rollbackCoverage, "untracked");
  assert.equal(execution?.snapshotId, undefined);

  const worktree = listManagedWorktrees(f.workspaceDir)[0];
  assert.ok(worktree);
  assert.equal(worktree.runId, childRunId);
  assert.equal(fs.readFileSync(path.join(worktree.path, "delegated.txt"), "utf8"), "subagent wrote\n");
  assert.equal(fs.existsSync(path.join(f.workspaceDir, "delegated.txt")), false);
  assertNoChildCheckpoints(worktree.path);
  assert.equal(listChangeSets(f.workspaceDir)[0]?.status, "ready_for_review");
  assert.deepEqual(listChangeSets(f.workspaceDir)[0]?.changedFiles, ["delegated.txt"]);

  assertUntrackedReceipt({ workspaceDir: f.workspaceDir, childRunId, requestId, toolCallId: bashId, toolName: "bash" });
  const changes = readRunChanges(f.workspaceDir, childRunId, undefined, requestId);
  assert.deepEqual(changes.files, []);
  assert.deepEqual(changes.externalToolEffects?.map((effect) => [effect.runId, effect.requestId, effect.toolCallId, effect.toolName, effect.rollbackCoverage]), [[childRunId, requestId, bashId, "bash", "untracked"]]);
  assert.equal(f.chatCalls, 2);
});

test("native teammate bash and idle publish child-run effects to parent run changes without snapshots", nativeOptions, async (t) => {
  const bashId = "teammate-bash";
  const teammateName = "nativeworker";
  const requestId = `teammate:${teammateName}`;
  const f = fixture(t, "crewforge-native-teammate-effects-", [
    { toolCalls: [{ id: bashId, name: "bash", args: { command: writeCommand("delegated-team.txt", "teammate wrote\n") } }] },
    { toolCalls: [{ id: "teammate-idle", name: "idle", args: {} }] },
  ]);
  const manager = new TeammateManager(f.workspaceDir, new MessageBus(f.workspaceDir), new TaskManager(f.workspaceDir));

  assert.match(await manager.spawn(teammateName, "implementation", "write then idle", allowAll, undefined, {
    parentRunId: "parent-teammate-native",
    parentConversationId: "conversation-teammate-native",
    parentRequestId: "request-teammate-native",
    parentToolCallId: "parent-teammate-call",
  }, "delegated-native-model"), /Spawned/);
  await waitFor(() => manager.listDetails()[0]?.status === "idle" || manager.listDetails()[0]?.status === "failed", () => JSON.stringify(manager.listDetails()[0]));

  const member = manager.listDetails()[0];
  assert.equal(member.status, "idle", JSON.stringify(member));
  assert.ok(member.childRunId);
  const childRunId = member.childRunId;
  await waitFor(() => readRawRunStatus(f.workspaceDir, childRunId) === "completed", () => JSON.stringify({ member: manager.listDetails()[0], rawStatus: readRawRunStatus(f.workspaceDir, childRunId) }));
  const run = readRunRecord(f.workspaceDir, childRunId);
  assert.equal(run.status, "completed");
  assert.equal(run.agentName, `teammate:${teammateName}`);
  const execution = run.toolExecutions.find((tool) => tool.toolCallId === bashId);
  assert.ok(execution, JSON.stringify(run.toolExecutions));
  assert.equal(execution?.requestId, requestId);
  assert.equal(execution?.rollbackCoverage, "untracked");
  assert.equal(execution?.snapshotId, undefined);

  const worktree = listManagedWorktrees(f.workspaceDir)[0];
  assert.ok(worktree);
  assert.equal(worktree.runId, childRunId);
  assert.equal(worktree.status, "ready_for_review");
  assert.equal(fs.readFileSync(path.join(worktree.path, "delegated-team.txt"), "utf8"), "teammate wrote\n");
  assert.equal(fs.existsSync(path.join(f.workspaceDir, "delegated-team.txt")), false);
  assertNoChildCheckpoints(worktree.path);
  const changeSet = listChangeSets(f.workspaceDir)[0];
  assert.equal(changeSet?.status, "ready_for_review");
  assert.deepEqual(changeSet?.changedFiles, ["delegated-team.txt"]);

  assertUntrackedReceipt({ workspaceDir: f.workspaceDir, childRunId, requestId, toolCallId: bashId, toolName: "bash" });
  const changes = readRunChanges(f.workspaceDir, childRunId, undefined, requestId);
  assert.deepEqual(changes.files, []);
  assert.deepEqual(changes.externalToolEffects?.map((effect) => [effect.runId, effect.requestId, effect.toolCallId, effect.toolName, effect.rollbackCoverage]), [[childRunId, requestId, bashId, "bash", "untracked"]]);
  assert.equal(f.chatCalls, 2);
});
