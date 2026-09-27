import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { listChildRuns, readRunRecord } from "../chat/runHistory.js";
import { listManagedWorktrees } from "../chat/worktrees.js";
import { MessageBus } from "./messageBus.js";
import { clearModelCapabilityCache } from "./modelCapabilities.js";
import type { PermissionAuthorizer } from "./permissionService.js";
import { registerAgentHooks } from "./agentHooks.js";
import { runSubagent, type SubagentToolRuntime } from "./subagent.js";
import { runInspectionCommand } from "./shell.js";
import { TaskManager } from "./taskManager.js";
import { TeammateManager } from "./teammateManager.js";
import { TodoManager } from "./todoManager.js";
import { getAllTools, TOOL_DISPATCH, type ToolHandler } from "./tools.js";
import type { OpenAIToolDef } from "./types.js";

type ChatRequest = {
  messages: Array<{ role: string; content?: string | null }>;
  tools?: OpenAIToolDef[];
};

type MockTurn =
  | { content: string }
  | { toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> };

const READ_TOOLS = ["read_file", "find_files", "search_files", "list_directory"];
const SORTED_READ_TOOLS = [...READ_TOOLS].sort();

function initializeGitWorkspace(workspaceDir: string): void {
  execFileSync("git", ["init", "-q", workspaceDir]);
  execFileSync("git", ["-C", workspaceDir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", workspaceDir, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", workspaceDir, "commit", "--allow-empty", "-qm", "initial"]);
}

async function createWorkspace(t: TestContext, prefix: string): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  initializeGitWorkspace(workspaceDir);
  await fs.writeFile(path.join(workspaceDir, "note.txt"), "needle\n");
  execFileSync("git", ["-C", workspaceDir, "add", "note.txt"]);
  execFileSync("git", ["-C", workspaceDir, "commit", "-qm", "fixture"]);
  t.after(async () => {
    clearModelCapabilityCache();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });
  return workspaceDir;
}

function installMockProvider(t: TestContext, turns: MockTurn[]) {
  const originalFetch = globalThis.fetch;
  const requests: ChatRequest[] = [];
  let chatCalls = 0;
  clearModelCapabilityCache();
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/models")) {
      return Response.json({ data: [{ id: "test-model", max_output_tokens: 1024 }] });
    }
    if (url.endsWith("/chat/completions")) {
      const body = JSON.parse(String(init?.body || "{}")) as ChatRequest;
      requests.push(body);
      const turn = turns[Math.min(chatCalls, turns.length - 1)];
      chatCalls += 1;
      if ("toolCalls" in turn) {
        return Response.json({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: turn.toolCalls.map((tool) => ({
                id: tool.id,
                type: "function",
                function: { name: tool.name, arguments: JSON.stringify(tool.args) },
              })),
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        });
      }
      return Response.json({
        choices: [{
          message: { role: "assistant", content: turn.content },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    clearModelCapabilityCache();
  });
  return requests;
}

function names(body: ChatRequest): string[] {
  return (body.tools || []).map((tool) => tool.function.name).sort();
}

function lineage(label: string) {
  return {
    parentRunId: `parent-${label}`,
    parentConversationId: `conversation-${label}`,
    parentRequestId: `request-${label}`,
    parentToolCallId: `tool-${label}`,
  };
}

function createGeneralRuntime(workspaceDir: string, tools: OpenAIToolDef[] = getAllTools({ mode: "code" })) {
  const taskManager = new TaskManager(workspaceDir);
  const messageBus = new MessageBus(workspaceDir);
  const runtime = {
    tools,
    context: {
      workspaceDir,
      vllmApiUrl: "http://provider.test/v1",
      vllmApiKey: "",
      modelName: "test-model",
      mode: "code",
      actorName: "parent",
      requestId: "parent-request",
      runId: "parent-run",
      filesystemSandbox: { readPaths: ["."], writePaths: ["."] },
      todoManager: new TodoManager(),
      taskManager,
      messageBus,
      teammateManager: new TeammateManager(workspaceDir, messageBus, taskManager),
    },
  } as unknown as SubagentToolRuntime;
  return { runtime, taskManager, messageBus };
}

test("canonical subagent roles publish role-specific schemas and system prompts", async (t) => {
  for (const role of ["general", "explore", "review", "planner"]) {
    const workspaceDir = await createWorkspace(t, `crewforge-subagent-role-${role}-`);
    const requests = installMockProvider(t, [{ content: `${role} done` }]);

    await runSubagent(
      "inspect role",
      role,
      workspaceDir,
      "http://provider.test/v1",
      "test-model"
    );

    const first = requests[0];
    assert.ok(first, role);
    assert.match(String(first.messages[0]?.content), new RegExp(`isolated ${role} subagent`));
    const toolNames = names(first);
    if (role === "general") {
      assert.ok(toolNames.includes("bash"), role);
      assert.ok(toolNames.includes("write_file"), role);
      assert.ok(toolNames.includes("TodoWrite"), role);
      assert.ok(toolNames.includes("task_list"), role);
    } else if (role === "explore") {
      assert.deepEqual(toolNames, SORTED_READ_TOOLS, role);
      assert.match(String(first.messages[0]?.content), /Do not modify files or execute commands/);
    } else {
      assert.deepEqual(toolNames, [...READ_TOOLS, "bash"].sort(), role);
      assert.match(String(first.messages[0]?.content), /Only read-only repository inspection commands are permitted/);
    }
  }
});

test("legacy Explore, general-purpose, and Code aliases resolve to canonical roles", async (t) => {
  for (const [alias, expectedPrompt, expectedTools] of [
    ["Explore", /isolated explore subagent/, READ_TOOLS],
    ["general-purpose", /isolated general subagent/, ["bash", "write_file", "TodoWrite", "task_list"]],
    ["Code", /isolated general subagent/, ["bash", "write_file", "TodoWrite", "task_list"]],
  ] as const) {
    const workspaceDir = await createWorkspace(t, `crewforge-subagent-alias-${alias.toLowerCase()}-`);
    const requests = installMockProvider(t, [{ content: `${alias} done` }]);

    await runSubagent(alias, alias, workspaceDir, "http://provider.test/v1", "test-model");

    assert.match(String(requests[0].messages[0]?.content), expectedPrompt, alias);
    for (const name of expectedTools) assert.ok(names(requests[0]).includes(name), `${alias}:${name}`);
  }
});

test("unknown subagent type is rejected before LLM calls or worktree allocation", async (t) => {
  const workspaceDir = await createWorkspace(t, "crewforge-subagent-unknown-");
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("model must not be called");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const output = await runSubagent("inspect", "not-a-role", workspaceDir, "http://provider.test/v1", "test-model");

  assert.match(output, /^Error: Unknown subagent type/);
  assert.equal(fetchCalls, 0);
  assert.equal(listManagedWorktrees(workspaceDir).length, 0);
});

test("explore exposes only repository read tools and rejects forged tools before parent authorization", async (t) => {
  const workspaceDir = await createWorkspace(t, "crewforge-subagent-explore-forged-");
  let parentAuthorizeCalls = 0;
  const requests = installMockProvider(t, [
    {
      toolCalls: [
        { id: "bash-1", name: "bash", args: { command: "pwd" } },
        { id: "write-1", name: "write_file", args: { path: "owned.txt", content: "nope\n" } },
        { id: "mcp-1", name: "mcp_external__lookup", args: { query: "nope" } },
        { id: "task-1", name: "task", args: { prompt: "nested", agent_type: "general" } },
      ],
    },
    { content: "explore handled forged tools" },
  ]);
  const parentAuthorize: PermissionAuthorizer = async () => {
    parentAuthorizeCalls += 1;
    return { allowed: true };
  };

  const output = await runSubagent(
    "explore forged tools",
    "explore",
    workspaceDir,
    "http://provider.test/v1",
    "test-model",
    undefined,
    parentAuthorize
  );

  assert.deepEqual(names(requests[0]), SORTED_READ_TOOLS);
  assert.equal(parentAuthorizeCalls, 0);
  const toolOutputs = requests[1].messages.filter((message) => message.role === "tool").map((message) => String(message.content));
  assert.equal(toolOutputs.length, 4);
  assert.ok(toolOutputs.every((content) => /explore subagent does not expose/.test(content)));
  assert.match(output, /^explore handled forged tools\nChangeSet /);
  assert.equal(await fs.stat(path.join(workspaceDir, "owned.txt")).then(() => true).catch(() => false), false);
});

test("review and planner allow only read tools plus safe bash, reject writes and dangerous bash, and record mode", async (t) => {
  for (const [role, expectedMode] of [["review", "review"], ["planner", "plan"]] as const) {
    const workspaceDir = await createWorkspace(t, `crewforge-subagent-${role}-policy-`);
    let parentAuthorizeCalls = 0;
    const requests = installMockProvider(t, [
      {
        toolCalls: [
          { id: `${role}-safe`, name: "bash", args: { command: "pwd" } },
          { id: `${role}-sed`, name: "bash", args: { command: "sed -n -i 1,2p note.txt" } },
          { id: `${role}-rg`, name: "bash", args: { command: "rg --pre cat needle ." } },
          { id: `${role}-write`, name: "write_file", args: { path: "owned.txt", content: "nope\n" } },
        ],
      },
      { content: `${role} finished` },
    ]);
    const parentAuthorize: PermissionAuthorizer = async () => {
      parentAuthorizeCalls += 1;
      return { allowed: true };
    };
    const line = lineage(role);

    await runSubagent(
      `${role} policy`,
      role,
      workspaceDir,
      "http://provider.test/v1",
      "test-model",
      undefined,
      parentAuthorize,
      undefined,
      line
    );

    assert.deepEqual(names(requests[0]), [...READ_TOOLS, "bash"].sort(), role);
    assert.equal(parentAuthorizeCalls, 1, role);
    const toolOutputs = requests[1].messages.filter((message) => message.role === "tool").map((message) => String(message.content));
    assert.doesNotMatch(toolOutputs[0], /^Error:/);
    assert.match(toolOutputs[0], new RegExp(`subagent-${role}`));
    assert.match(toolOutputs[1], /^Error:/);
    assert.match(toolOutputs[1], /sed/i);
    assert.match(toolOutputs[2], /bypass repository policy/);
    assert.match(toolOutputs[3], new RegExp(`${role} subagent does not expose write_file`));
    assert.equal(await fs.stat(path.join(workspaceDir, "owned.txt")).then(() => true).catch(() => false), false);
    const child = listChildRuns(workspaceDir, line.parentRunId)[0];
    assert.equal(readRunRecord(workspaceDir, child.runId).mode, expectedMode);
  }
});

test("general subagent forwards published tools through parent authorization, profile limits, workspace isolation, and external callback", async (t) => {
  const workspaceDir = await createWorkspace(t, "crewforge-subagent-general-forward-");
  const externalTool: OpenAIToolDef = {
    type: "function",
    function: {
      name: "mcp_external__lookup",
      description: "External read callback",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  };
  const requests = installMockProvider(t, [
    {
      toolCalls: [
        { id: "todo-1", name: "TodoWrite", args: { items: [{ content: "one", status: "in_progress", activeForm: "doing one" }] } },
        { id: "tasks-1", name: "task_list", args: {} },
        { id: "external-1", name: "mcp_external__lookup", args: { query: "needle" } },
        { id: "external-forged", name: "mcp_external__secret", args: {} },
        { id: "write-1", name: "write_file", args: { path: "child.txt", content: "child\n" } },
      ],
    },
    { content: "general finished" },
  ]);
  let parentAuthorizeCalls = 0;
  const authorizedNames: string[] = [];
  const parentAuthorize: PermissionAuthorizer = async (request) => {
    parentAuthorizeCalls += 1;
    authorizedNames.push(request.name);
    return request.name === "write_file"
      ? { allowed: false, reason: "parent denies write" }
      : { allowed: true };
  };
  let externalCalls = 0;
  const taskManager = new TaskManager(workspaceDir);
  const messageBus = new MessageBus(workspaceDir);
  const runtime = {
    tools: [...getAllTools({ mode: "code" }), externalTool],
    context: {
      workspaceDir,
      vllmApiUrl: "http://provider.test/v1",
      vllmApiKey: "",
      modelName: "test-model",
      mode: "code",
      actorName: "parent",
      requestId: "parent-request",
      runId: "parent-run",
      filesystemSandbox: { readPaths: ["."], writePaths: ["."] },
      todoManager: new TodoManager(),
      taskManager,
      messageBus,
      teammateManager: new TeammateManager(workspaceDir, messageBus, taskManager),
      executeDelegatedTool: async (name: string) => {
        if (name === "mcp_external__lookup") {
          externalCalls += 1;
          return "external ok";
        }
        externalCalls += 100;
        return "external secret should not run";
      },
    },
  } as unknown as SubagentToolRuntime;

  const output = await runSubagent(
    "general forwarding",
    "general",
    workspaceDir,
    "http://provider.test/v1",
    "test-model",
    undefined,
    parentAuthorize,
    undefined,
    undefined,
    runtime
  );

  const published = names(requests[0]);
  assert.ok(published.includes("TodoWrite"));
  assert.ok(published.includes("task_list"));
  assert.ok(published.includes("mcp_external__lookup"));
  assert.ok(!published.includes("mcp_external__secret"));
  assert.deepEqual(authorizedNames, ["TodoWrite", "task_list", "mcp_external__lookup", "write_file"]);
  assert.equal(parentAuthorizeCalls, 4);
  assert.equal(externalCalls, 1);
  const toolOutputs = requests[1].messages.filter((message) => message.role === "tool").map((message) => String(message.content));
  assert.match(toolOutputs[0], /doing one/);
  assert.match(toolOutputs[1], /No tasks/);
  assert.equal(toolOutputs[2], "external ok");
  assert.match(toolOutputs[3], /general subagent does not expose mcp_external__secret/);
  assert.match(toolOutputs[4], /Tool denied: parent denies write/);
  assert.match(output, /^general finished\nChangeSet /);
  assert.equal(await fs.stat(path.join(workspaceDir, "child.txt")).then(() => true).catch(() => false), false);
});

test("subagent depth greater than four is rejected before LLM calls", async (t) => {
  const workspaceDir = await createWorkspace(t, "crewforge-subagent-depth-");
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("model must not be called");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const taskManager = new TaskManager(workspaceDir);
  const messageBus = new MessageBus(workspaceDir);

  const output = await runSubagent(
    "too deep",
    "general",
    workspaceDir,
    "http://provider.test/v1",
    "test-model",
    undefined,
    async () => ({ allowed: true }),
    undefined,
    undefined,
    {
      tools: [],
      context: {
        workspaceDir,
        vllmApiUrl: "http://provider.test/v1",
        vllmApiKey: "",
        modelName: "test-model",
        subagentDepth: 4,
        todoManager: new TodoManager(),
        taskManager,
        messageBus,
        teammateManager: new TeammateManager(workspaceDir, messageBus, taskManager),
      },
    } as unknown as SubagentToolRuntime
  );

  assert.match(output, /^Error: Subagent depth limit exceeded \(4\)/);
  assert.equal(fetchCalls, 0);
  assert.equal(listManagedWorktrees(workspaceDir).length, 0);
});

test("general subagent actorName is unique per child run while trace label remains stable", async (t) => {
  const workspaceDir = await createWorkspace(t, "crewforge-subagent-actor-");
  const requests = installMockProvider(t, [
    { toolCalls: [{ id: "list-1", name: "task_list", args: {} }] },
    { content: "first done" },
    { toolCalls: [{ id: "list-2", name: "task_list", args: {} }] },
    { content: "second done" },
  ]);
  const observedActors: string[] = [];
  const originalTaskList = TOOL_DISPATCH.task_list;
  TOOL_DISPATCH.task_list = (async (args, ctx) => {
    observedActors.push(String(ctx.actorName || ""));
    return originalTaskList(args, ctx);
  }) as ToolHandler;
  t.after(() => {
    TOOL_DISPATCH.task_list = originalTaskList;
  });
  const { runtime } = createGeneralRuntime(workspaceDir);
  const line = lineage("general-actors");

  await runSubagent("first actor", "general", workspaceDir, "http://provider.test/v1", "test-model", undefined, async () => ({ allowed: true }), undefined, line, runtime);
  await runSubagent("second actor", "general", workspaceDir, "http://provider.test/v1", "test-model", undefined, async () => ({ allowed: true }), undefined, line, runtime);

  assert.equal(requests.length, 4);
  assert.equal(observedActors.length, 2);
  assert.notEqual(observedActors[0], observedActors[1]);
  assert.match(observedActors[0], /^subagent:general:\d+-[a-f0-9]+/);
  assert.match(observedActors[1], /^subagent:general:\d+-[a-f0-9]+/);
  const childRuns = listChildRuns(workspaceDir, line.parentRunId);
  assert.equal(childRuns.length, 2);
  assert.deepEqual(childRuns.map((run) => run.agentName), ["subagent:general", "subagent:general"]);
});

test("general subagent can complete tasks through shared parent taskManager legacy and command paths", async (t) => {
  const workspaceDir = await createWorkspace(t, "crewforge-subagent-shared-tasks-");
  installMockProvider(t, [
    {
      toolCalls: [
        { id: "create-legacy", name: "task_create", args: { subject: "legacy", description: "legacy path" } },
        { id: "complete-legacy", name: "task_update", args: { task_id: 1, status: "completed" } },
        { id: "create-command", name: "task_command", args: { action: "create", subject: "command", description: "command path", idempotency_key: "create-command" } },
        { id: "complete-command", name: "task_command", args: { action: "update", task_id: 2, status: "completed", idempotency_key: "complete-command" } },
      ],
    },
    { content: "tasks completed" },
  ]);
  const { runtime, taskManager } = createGeneralRuntime(workspaceDir);

  const output = await runSubagent(
    "complete shared tasks",
    "general",
    workspaceDir,
    "http://provider.test/v1",
    "test-model",
    undefined,
    async () => ({ allowed: true }),
    undefined,
    undefined,
    runtime
  );

  assert.match(output, /^tasks completed\nChangeSet /);
  assert.equal(taskManager.getTask(1).status, "completed");
  assert.equal(taskManager.getTask(2).status, "completed");
});

test("review bash rejects sed write commands and does not expand variables or globs through a shell", async (t) => {
  const workspaceDir = await createWorkspace(t, "crewforge-subagent-readonly-shell-");
  const tmpWriteTarget = path.join(os.tmpdir(), `crewforge-sed-write-${Date.now()}`);
  t.after(() => fs.rm(tmpWriteTarget, { force: true }));
  const requests = installMockProvider(t, [
    {
      toolCalls: [
        { id: "sed-write", name: "bash", args: { command: `sed -n 'w ${tmpWriteTarget}' note.txt` } },
        { id: "variable-literal", name: "bash", args: { command: "rg needle $CREWFORGE_SENTINEL" } },
        { id: "glob-literal", name: "bash", args: { command: "rg needle *.txt" } },
      ],
    },
    { content: "readonly shell checked" },
  ]);

  await runSubagent("check readonly shell", "review", workspaceDir, "http://provider.test/v1", "test-model", undefined, async () => ({ allowed: true }));

  const toolOutputs = requests[1].messages.filter((message) => message.role === "tool").map((message) => String(message.content));
  assert.match(toolOutputs[0], /^Error:/);
  assert.match(toolOutputs[0], /not authorized|sed/i);
  assert.equal(await fs.stat(tmpWriteTarget).then(() => true).catch(() => false), false);
  assert.doesNotMatch(toolOutputs[1], /note\.txt.*needle|needle.*note\.txt/);
  assert.match(toolOutputs[1], /^Error:/);
  assert.doesNotMatch(toolOutputs[2], /note\.txt.*needle|needle.*note\.txt/);
  assert.match(toolOutputs[2], /^Error:/);
});

test("general write is not executed when cancellation happens in beforeToolExecute hook", async (t) => {
  const workspaceDir = await createWorkspace(t, "crewforge-subagent-hook-abort-");
  installMockProvider(t, [
    { toolCalls: [{ id: "write-after-abort", name: "write_file", args: { path: "abort-write.txt", content: "must not land\n" } }] },
    { content: "should not need a second model call" },
  ]);
  const controller = new AbortController();
  const unregister = registerAgentHooks({
    name: "abort-before-general-write",
    handlers: {
      beforeToolExecute: (context) => {
        if (context.toolName === "write_file") controller.abort();
      },
    },
  });
  t.after(unregister);
  const { runtime } = createGeneralRuntime(workspaceDir);

  await runSubagent(
    "abort before write",
    "general",
    workspaceDir,
    "http://provider.test/v1",
    "test-model",
    undefined,
    async () => ({ allowed: true }),
    controller.signal,
    undefined,
    runtime
  ).catch((error) => {
    assert.match(error instanceof Error ? error.name : String(error), /AbortError|Error/);
  });

  const childPath = listManagedWorktrees(workspaceDir)[0]?.path;
  assert.equal(await fs.stat(path.join(workspaceDir, "abort-write.txt")).then(() => true).catch(() => false), false);
  if (childPath) {
    assert.equal(await fs.stat(path.join(childPath, "abort-write.txt")).then(() => true).catch(() => false), false);
  }
});

test("inspection argv execution rejects symlink path arguments inside and outside the workspace", async (t) => {
  const workspaceDir = await createWorkspace(t, "crewforge-inspection-symlink-");
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-inspection-outside-"));
  t.after(() => fs.rm(outsideDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(outsideDir, "outside.txt"), "outside\n");
  await fs.writeFile(path.join(workspaceDir, "inside-target.txt"), "inside\n");
  await fs.symlink(path.join(outsideDir, "outside.txt"), path.join(workspaceDir, "outside-link.txt"));
  await fs.symlink(path.join(workspaceDir, "inside-target.txt"), path.join(workspaceDir, "inside-link.txt"));

  const outside = await runInspectionCommand("cat outside-link.txt", workspaceDir);
  const inside = await runInspectionCommand("cat inside-link.txt", workspaceDir);

  assert.match(outside, /^Error:/);
  assert.match(outside, /symlink|symbolic link|not authorized|filesystem/i);
  assert.match(inside, /^Error:/);
  assert.match(inside, /symlink|symbolic link|not authorized|filesystem/i);
});
