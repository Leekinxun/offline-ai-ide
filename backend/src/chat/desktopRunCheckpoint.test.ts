import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { MessageBus } from "../agent/messageBus.js";
import { TaskManager } from "../agent/taskManager.js";
import { TeammateManager } from "../agent/teammateManager.js";
import type { UserSession } from "../auth/sessionManager.js";
import { config } from "../config.js";
import { shutdownDesktopNativeIde } from "../desktop/nativeIdeClient.js";
import { buildFileHash, buildFileVersion, listFileMutations, rollbackFileMutationsAsync } from "../files/mutationRegistry.js";
import { handleChatWs } from "../ws/chat.js";
import { listCheckpoints } from "./checkpoints.js";
import { appendConversationMessage, readConversationMessages } from "./history.js";
import { getActiveRunContext, listActiveRuns } from "./runCoordinator.js";

const providerUrl = "https://desktop-run-checkpoint.invalid/v1";
const releaseCore = fileURLToPath(new URL(`../../../desktop/rust/target/release/crownforge-ide-core${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
const debugCore = fileURLToPath(new URL(`../../../desktop/rust/target/debug/crownforge-ide-core${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
const nativeCore = process.env.CROWNFORGE_TEST_NATIVE_IDE || (fs.existsSync(releaseCore) ? releaseCore : debugCore);
const nativeOptions = { skip: !fs.existsSync(nativeCore), timeout: 90_000 };

function sessionFor(workspaceDir: string): UserSession {
  const taskManager = new TaskManager(workspaceDir);
  const messageBus = new MessageBus(workspaceDir);
  return {
    token: "desktop-checkpoint-fixture",
    username: "desktop-user",
    workspaceDir,
    workspaceRoot: workspaceDir,
    isAdmin: false,
    isolated: false,
    taskManager,
    messageBus,
    teammateManager: new TeammateManager(workspaceDir, messageBus, taskManager),
  };
}

async function waitUntil(predicate: () => boolean, input: string | (() => string) = "Timed out waiting for desktop checkpoint test event", timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(typeof input === "function" ? input() : input);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function socketServer(session: UserSession) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  server.on("connection", (socket) => handleChatWs(socket, session, { validateSession: () => true }));
  const address = server.address();
  assert(address && typeof address !== "string");
  const clients: WebSocket[] = [];
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const frames: any[] = [];
    socket.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
    clients.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return {
      frames,
      send: (message: unknown) => socket.send(JSON.stringify(message)),
    };
  };
  return {
    connect,
    close: async () => {
      for (const client of clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function withFixture(t: test.TestContext, workspace: string, input: {
  desktop: boolean;
  responses: Array<Record<string, unknown>>;
}) {
  const prior = {
    fetch: globalThis.fetch,
    models: config.models,
    profiles: config.agentProfiles,
    fallbacks: config.modelFallbacks,
    desktop: process.env.CREWFORGE_DESKTOP,
    core: process.env.CROWNFORGE_IDE_CORE_EXECUTABLE,
  };
  const providerBodies: any[] = [];
  const providerState = { calls: 0, modelDiscoveryCalls: 0, remainingResponses: input.responses.length };
  config.models = [{ modelName: "desktop-checkpoint-fixture", apiUrl: providerUrl, apiKey: "", maxTokens: 4096 }];
  config.agentProfiles = { code: { budget: { maxSteps: 8 } } };
  config.modelFallbacks = [];
  if (input.desktop) {
    process.env.CREWFORGE_DESKTOP = "1";
    process.env.CROWNFORGE_IDE_CORE_EXECUTABLE = nativeCore;
  } else {
    delete process.env.CREWFORGE_DESKTOP;
    delete process.env.CROWNFORGE_IDE_CORE_EXECUTABLE;
  }
  globalThis.fetch = async (request, init) => {
    assert.ok(String(request).startsWith(providerUrl), `unexpected provider URL: ${String(request)}`);
    if (String(request).endsWith("/models")) {
      providerState.modelDiscoveryCalls += 1;
      return Response.json({ data: [{ id: "desktop-checkpoint-fixture", max_output_tokens: 4096 }] });
    }
    providerState.calls += 1;
    providerBodies.push(JSON.parse(String(init?.body)));
    const response = input.responses.shift();
    providerState.remainingResponses = input.responses.length;
    assert.ok(response, "provider fixture exhausted");
    return Response.json(response);
  };
  t.after(async () => {
    for (const run of listActiveRuns(workspace)) getActiveRunContext(workspace, run.conversationId)?.forceStop();
    await waitUntil(() => !listActiveRuns(workspace).length);
    await shutdownDesktopNativeIde();
    globalThis.fetch = prior.fetch;
    config.models = prior.models;
    config.agentProfiles = prior.profiles;
    config.modelFallbacks = prior.fallbacks;
    if (prior.desktop === undefined) delete process.env.CREWFORGE_DESKTOP; else process.env.CREWFORGE_DESKTOP = prior.desktop;
    if (prior.core === undefined) delete process.env.CROWNFORGE_IDE_CORE_EXECUTABLE; else process.env.CROWNFORGE_IDE_CORE_EXECUTABLE = prior.core;
  });
  return { providerBodies, providerState };
}

function frameDiagnostics(frames: any[], workspace: string, fixture?: Awaited<ReturnType<typeof withFixture>>): string {
  const counts = frames.reduce((map: Record<string, number>, frame) => {
    map[frame.type] = (map[frame.type] || 0) + 1;
    return map;
  }, {});
  const recent = frames.slice(-12).map((frame) => ({
    type: frame.type,
    requestId: frame.requestId,
    status: frame.status,
    name: frame.name,
    toolCallId: frame.toolCallId,
    isError: frame.isError,
  }));
  let checkpoints: number | string = "unreadable";
  try { checkpoints = listCheckpoints(workspace).length; } catch { /* keep diagnostics bounded */ }
  return JSON.stringify({
    counts,
    recent,
    providerCalls: fixture?.providerState.calls,
    modelDiscoveryCalls: fixture?.providerState.modelDiscoveryCalls,
    remainingResponses: fixture?.providerState.remainingResponses,
    activeRuns: listActiveRuns(workspace).length,
    checkpoints,
    nativeCore: path.basename(nativeCore),
  });
}

async function runWsTurn(workspace: string, message: string, requestId: string, fixture?: Awaited<ReturnType<typeof withFixture>>) {
  const server = await socketServer(sessionFor(workspace));
  try {
    const client = await server.connect();
    client.send({ conversationId: "desktop-task", requestId, message, mode: "code", modelName: "desktop-checkpoint-fixture" });
    const approved = new Set<string>();
    await waitUntil(() => {
      for (const frame of client.frames) {
        if (frame.type !== "tool_approval_request" || approved.has(frame.approvalId)) continue;
        approved.add(frame.approvalId);
        client.send({ type: "tool_approval", conversationId: frame.conversationId, runId: frame.runId, approvalId: frame.approvalId, decision: "allow_once" });
      }
      return client.frames.some((frame) => frame.type === "done" && frame.requestId === requestId)
        || client.frames.some((frame) => frame.type === "run_state" && frame.status === "failed")
        || client.frames.some((frame) => frame.type === "error" && frame.requestId === requestId);
    }, () => `Timed out waiting for WS turn ${requestId}: ${frameDiagnostics(client.frames, workspace, fixture)}`, 75_000);
    await waitUntil(() => !listActiveRuns(workspace).length, () => `Timed out waiting for active run cleanup ${requestId}: ${frameDiagnostics(client.frames, workspace, fixture)}`, 20_000);
    return client.frames;
  } finally {
    await server.close();
  }
}

function hugeWorkspace(t: test.TestContext, prefix: string): string {
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  for (let index = 0; index <= 20_000; index += 1) {
    fs.closeSync(fs.openSync(path.join(workspace, `eligible-${index}.txt`), "w"));
  }
  return workspace;
}

async function seedConversation(workspace: string): Promise<void> {
  await appendConversationMessage(workspace, "desktop-task", {
    role: "user",
    content: "seed",
    timestamp: Date.now(),
  });
}

function stop(content: string): Record<string, unknown> {
  return { choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage: {} };
}

function tools(toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>): Record<string, unknown> {
  return {
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: toolCalls.map((tool) => ({
          id: tool.id,
          type: "function",
          function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
        })),
      },
    }],
    usage: {},
  };
}

test("desktop Code read-only answers on oversized workspaces without checkpoints", nativeOptions, async (t) => {
  const workspace = hugeWorkspace(t, "crewforge-desktop-greeting-");
  await seedConversation(workspace);
  const fixture = await withFixture(t, workspace, {
    desktop: true,
    responses: [stop("你好")],
  });

  const frames = await runWsTurn(workspace, "你好", "read-only-request", fixture);

  assert.equal(frames.some((frame) => frame.type === "error"), false, JSON.stringify(frames.filter((frame) => frame.type === "error")));
  assert.ok(frames.some((frame) => frame.type === "token" && frame.content === "你好"));
  assert.ok(frames.some((frame) => frame.type === "done" && frame.requestId === "read-only-request"));
  assert.equal(fixture.providerBodies.length, 1);
  assert.equal(listCheckpoints(workspace).length, 0);
});

test("desktop Code write, edit, and rename on oversized workspaces use native journal evidence without checkpoints", nativeOptions, async (t) => {
  const workspace = hugeWorkspace(t, "crewforge-desktop-direct-native-");
  await seedConversation(workspace);
  const created = "created by desktop\n";
  const edited = "edited by desktop\n";
  const fixture = await withFixture(t, workspace, {
    desktop: true,
    responses: [
      tools([
        { id: "write-created", name: "write_file", arguments: { path: "note.txt", content: created, expected_version: "missing" } },
        { id: "edit-created", name: "edit_file", arguments: { path: "note.txt", old_text: "created", new_text: "edited", expected_version: buildFileVersion(created) } },
        { id: "rename-created", name: "rename_file", arguments: { source_path: "note.txt", target_path: "renamed.txt", expected_version: buildFileVersion(edited) } },
      ]),
      stop("Done."),
    ],
  });

  const frames = await runWsTurn(workspace, "write edit rename", "mutation-request", fixture);
  const accepted = frames.find((frame) => frame.type === "request_accepted" && frame.requestId === "mutation-request");
  assert.ok(accepted);
  assert.ok(frames.some((frame) => frame.type === "done" && frame.requestId === "mutation-request"), frameDiagnostics(frames, workspace, fixture));
  const records = listFileMutations(workspace, { runId: accepted.runId });
  const toolResults = frames.filter((frame) => frame.type === "tool_result");

  assert.equal(fixture.providerBodies.length, 2);
  assert.deepEqual(toolResults.map((frame) => [frame.toolCallId, frame.isError]), [
    ["write-created", false],
    ["edit-created", false],
    ["rename-created", false],
  ], JSON.stringify({ toolResults, diagnostics: frameDiagnostics(frames, workspace, fixture) }));
  assert.equal(fs.existsSync(path.join(workspace, "note.txt")), false);
  assert.equal(fs.existsSync(path.join(workspace, "renamed.txt")), true, frameDiagnostics(frames, workspace, fixture));
  assert.equal(fs.readFileSync(path.join(workspace, "renamed.txt"), "utf8"), edited);
  assert.equal(listCheckpoints(workspace).length, 0);
  assert.equal(records.length, 4, JSON.stringify(records));
  assert.deepEqual(records.map((record) => [record.toolCallId, record.path, record.operation]).sort(), [
    ["edit-created", "note.txt", "modify"],
    ["rename-created", "note.txt", "delete"],
    ["rename-created", "renamed.txt", "create"],
    ["write-created", "note.txt", "create"],
  ]);
  assert.equal(records.find((record) => record.toolCallId === "write-created")?.postimageHash, buildFileHash(created));
  assert.equal(records.find((record) => record.toolCallId === "edit-created")?.preimageHash, buildFileHash(created));
  assert.equal(records.find((record) => record.toolCallId === "edit-created")?.postimageHash, buildFileHash(edited));
  const rollback = await rollbackFileMutationsAsync(workspace, { runId: accepted.runId });
  assert.deepEqual(new Set(rollback.applied), new Set(records.map((record) => record.id)));
  assert.equal(fs.existsSync(path.join(workspace, "note.txt")), false);
  assert.equal(fs.existsSync(path.join(workspace, "renamed.txt")), false);
});

test("desktop Code corrupt mutation journal blocks direct write before touching the file", nativeOptions, async (t) => {
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-desktop-corrupt-journal-")));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, ".checkpoints"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".checkpoints", "mutations.json"), "{corrupt");
  await seedConversation(workspace);
  const fixture = await withFixture(t, workspace, {
    desktop: true,
    responses: [
      tools([{ id: "blocked-write", name: "write_file", arguments: { path: "blocked.txt", content: "must not exist", expected_version: "missing" } }]),
      stop("I could not write the file."),
    ],
  });

  const frames = await runWsTurn(workspace, "write a file", "blocked-request", fixture);
  const tool = frames.find((frame) => frame.type === "tool_result" && frame.toolCallId === "blocked-write");

  assert.equal(fs.existsSync(path.join(workspace, "blocked.txt")), false);
  assert.equal(tool?.isError, true);
  assert.match(tool?.result || "", /mutation journal evidence|invalid|unreadable/i);
  assert.equal(listCheckpoints(workspace).length, 0);
  const messages = readConversationMessages(workspace, "desktop-task");
  assert.match(messages.flatMap((message) => message.toolCalls || []).find((call) => call.toolCallId === "blocked-write")?.result || "", /mutation journal evidence|invalid|unreadable/i);
});

test("desktop Code uncertain bash retains checkpoint gate and does not execute when checkpoint is blocked", nativeOptions, async (t) => {
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-desktop-bash-checkpoint-")));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, ".checkpoints"), "not a directory");
  await seedConversation(workspace);
  const fixture = await withFixture(t, workspace, {
    desktop: true,
    responses: [
      tools([{ id: "blocked-bash", name: "bash", arguments: { command: "printf effect > bash-effect.txt" } }]),
      stop("The command did not run."),
    ],
  });

  const frames = await runWsTurn(workspace, "run a command", "bash-request", fixture);
  const tool = frames.find((frame) => frame.type === "tool_result" && frame.toolCallId === "blocked-bash");

  assert.equal(fs.existsSync(path.join(workspace, "bash-effect.txt")), false);
  assert.equal(tool?.isError, true);
  assert.match(tool?.result || "", /required mutation checkpoint unavailable/i);
});

test("web Code still requires the full startup checkpoint on oversized workspaces before model execution", async (t) => {
  const workspace = hugeWorkspace(t, "crewforge-web-startup-checkpoint-");
  await seedConversation(workspace);
  const fixture = await withFixture(t, workspace, {
    desktop: false,
    responses: [stop("should not run")],
  });

  const frames = await runWsTurn(workspace, "你好", "web-startup-request", fixture);

  assert.equal(fixture.providerBodies.length, 0);
  const error = frames.find((frame) => frame.type === "error" && frame.requestId === "web-startup-request");
  assert.match(error?.content || "", /Checkpoint exceeds 20000 files/);
});
