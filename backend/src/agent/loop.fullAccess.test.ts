import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { config } from "../config.js";
import { AgentRunRecorder } from "../chat/runHistory.js";
import type { UserSession } from "../auth/sessionManager.js";
import { ExtensionPolicyStore } from "../extensions/policy/store.js";
import { listFileMutations } from "../files/mutationRegistry.js";
import { registerAgentHooks, type AgentHookContext } from "./agentHooks.js";
import { runAgentLoop } from "./loop.js";
import { MessageBus } from "./messageBus.js";
import { consumeNetworkExecutionGrant, networkGrantForTool } from "./networkAccess.js";
import { TaskManager } from "./taskManager.js";
import { TeammateManager } from "./teammateManager.js";
import { TOOL_DISPATCH } from "./tools.js";

function fullAccessFixture(
  t: test.TestContext,
  filenames = ["synthetic.txt"],
  tools = filenames.map((filename, index) => ({
    id: `full-access-write-${index}`, name: "write_file",
    arguments: { path: filename, content: `synthetic ${index}\n` } as Record<string, unknown>,
  })),
) {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-loop-full-access-"));
  const originalFetch = globalThis.fetch;
  const taskManager = new TaskManager(workspaceDir);
  const messageBus = new MessageBus(workspaceDir);
  const session: UserSession = {
    token: "full-access-test-session", username: "synthetic-user", workspaceDir, workspaceRoot: workspaceDir,
    isAdmin: false, isolated: false, taskManager, messageBus,
    teammateManager: new TeammateManager(workspaceDir, messageBus, taskManager),
  };
  const recorder = new AgentRunRecorder(workspaceDir, "run-full-access", "conversation-full-access", "code");
  let grant: { grantId: string; revision: number } | null = { grantId: "synthetic-grant", revision: 1 };
  let approvals = 0;
  let completions = 0;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "test-model" }] });
    completions += 1;
    return Response.json({ choices: [{ finish_reason: completions === 1 ? "tool_calls" : "stop", message: completions === 1
      ? { role: "assistant", content: null, tool_calls: tools.map((tool) => ({
        id: tool.id, type: "function", function: {
          name: tool.name, arguments: JSON.stringify(tool.arguments),
        },
      })) }
      : { role: "assistant", content: "Synthetic test complete." } }] });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });
  return {
    workspaceDir, recorder,
    revoke: () => { grant = null; },
    replace: () => { grant = { grantId: "replacement-grant", revision: 2 }; },
    approvals: () => approvals,
    execute: async () => {
      await recorder.start();
      return runAgentLoop(
        { readyState: WebSocket.OPEN, send() {} } as unknown as WebSocket,
        "Write the synthetic fixture files", "request-full-access", session,
        undefined, undefined, undefined, undefined, undefined, undefined,
        {
          isStopped: () => false, createAbortSignal: () => undefined, mode: "code", modelName: "test-model",
          conversationId: "conversation-full-access", runRecorder: recorder,
          getFullAccessGrant: () => grant,
          requestToolApproval: async () => { approvals += 1; return "deny"; },
        },
      );
    },
  };
}

test("active full access executes an ordinary primary write without a per-tool prompt", async (t) => {
  const fixture = fullAccessFixture(t);
  const messages = await fixture.execute();
  assert.equal(fixture.approvals(), 0);
  assert.equal(fs.readFileSync(path.join(fixture.workspaceDir, "synthetic.txt"), "utf8"), "synthetic 0\n");
  assert.equal(messages.flatMap((message) => message.toolCalls || []).find((call) => call.toolCallId === "full-access-write-0")?.isError, false);
  assert.equal(listFileMutations(fixture.workspaceDir, { toolCallId: "full-access-write-0" }).length, 1);
});

test("closing full access restores approval for the next primary tool in the same response", async (t) => {
  const fixture = fullAccessFixture(t, ["first.txt", "second.txt"]);
  const unregister = registerAgentHooks({
    name: "revoke-primary-full-access-after-first-tool",
    handlers: { afterToolExecute: (context) => { if (context.toolCallId === "full-access-write-0") fixture.revoke(); } },
  });
  t.after(unregister);
  const messages = await fixture.execute();
  assert.equal(fixture.approvals(), 1);
  assert.equal(fs.readFileSync(path.join(fixture.workspaceDir, "first.txt"), "utf8"), "synthetic 0\n");
  assert.equal(fs.existsSync(path.join(fixture.workspaceDir, "second.txt")), false);
  assert.equal(messages.flatMap((message) => message.toolCalls || []).find((call) => call.toolCallId === "full-access-write-1")?.isError, true);
  assert.equal(listFileMutations(fixture.workspaceDir, { toolCallId: "full-access-write-1" }).length, 0);
});

for (const hook of ["afterPermissionDecision", "beforeToolExecute"] as const) {
  test(`primary full access revoked during ${hook} cannot execute its authorized write`, async (t) => {
    const fixture = fullAccessFixture(t);
    let hookReached = false;
    const unregister = registerAgentHooks({
      name: `revoke-primary-full-access-${hook}`,
      handlers: { [hook]: async (context: AgentHookContext) => {
        if (context.toolCallId !== "full-access-write-0") return;
        hookReached = true;
        await Promise.resolve();
        fixture.revoke();
      } },
    });
    t.after(unregister);
    const messages = await fixture.execute();
    const call = messages.flatMap((message) => message.toolCalls || []).find((entry) => entry.toolCallId === "full-access-write-0");
    assert.equal(hookReached, true);
    assert.equal(fixture.approvals(), 0);
    assert.equal(fs.existsSync(path.join(fixture.workspaceDir, "synthetic.txt")), false);
    assert.equal(call?.isError, true);
    assert.match(call?.result || "", /denied/i);
    assert.equal(fixture.recorder.snapshot().toolExecutions.find((entry) => entry.toolCallId === "full-access-write-0")?.status, "denied");
    assert.equal(listFileMutations(fixture.workspaceDir, { toolCallId: "full-access-write-0" }).length, 0);
  });
}

test("primary full access revoked during the running recorder await cannot reach the tool handler", async (t) => {
  const fixture = fullAccessFixture(t);
  const toolState = fixture.recorder.toolState.bind(fixture.recorder);
  let runningReached = false;
  fixture.recorder.toolState = async (entry) => {
    const result = await toolState(entry);
    if (entry.toolCallId === "full-access-write-0" && entry.status === "running") {
      runningReached = true;
      fixture.revoke();
    }
    return result;
  };
  const messages = await fixture.execute();
  assert.equal(runningReached, true);
  assert.equal(fixture.approvals(), 0);
  assert.equal(fs.existsSync(path.join(fixture.workspaceDir, "synthetic.txt")), false);
  assert.equal(messages.flatMap((message) => message.toolCalls || []).find((call) => call.toolCallId === "full-access-write-0")?.isError, true);
  assert.equal(fixture.recorder.snapshot().toolExecutions.find((entry) => entry.toolCallId === "full-access-write-0")?.status, "denied");
  assert.equal(listFileMutations(fixture.workspaceDir, { toolCallId: "full-access-write-0" }).length, 0);
});

test("re-enabling full access during execution cannot revive a previous primary grant", async (t) => {
  const fixture = fullAccessFixture(t);
  const unregister = registerAgentHooks({
    name: "replace-primary-full-access-grant",
    handlers: { beforeToolExecute: (context) => { if (context.toolCallId === "full-access-write-0") fixture.replace(); } },
  });
  t.after(unregister);
  await fixture.execute();
  assert.equal(fixture.approvals(), 0);
  assert.equal(fs.existsSync(path.join(fixture.workspaceDir, "synthetic.txt")), false);
  assert.equal(fixture.recorder.snapshot().toolExecutions.find((entry) => entry.toolCallId === "full-access-write-0")?.status, "denied");
  assert.equal(listFileMutations(fixture.workspaceDir, { toolCallId: "full-access-write-0" }).length, 0);
});

function networkFullAccessFixture(t: test.TestContext, toolName: "bash" | "process_start") {
  const command = "curl http://127.0.0.1/synthetic";
  const fixture = fullAccessFixture(t, [], [{
    id: "full-access-network-0", name: toolName, arguments: { command, allow_network: true },
  }]);
  const originalProfiles = config.agentProfiles;
  const originalAdminPolicy = process.env.CREWFORGE_ADMIN_POLICY;
  const originalHandler = TOOL_DISPATCH[toolName];
  process.env.CREWFORGE_ADMIN_POLICY = path.join(fixture.workspaceDir, "synthetic-admin-policy.json");
  config.agentProfiles = {
    ...originalProfiles,
    code: { ...originalProfiles.code, isolation: { ...originalProfiles.code?.isolation, network: true } },
  };
  new ExtensionPolicyStore(fixture.workspaceDir).putAdminPolicy({
    permissions: { allow: ["*"] },
    sandbox: { readPaths: ["."], writePaths: ["."], networkOrigins: ["*"] },
  }, 1);
  t.after(() => {
    config.agentProfiles = originalProfiles;
    TOOL_DISPATCH[toolName] = originalHandler;
    if (originalAdminPolicy === undefined) delete process.env.CREWFORGE_ADMIN_POLICY;
    else process.env.CREWFORGE_ADMIN_POLICY = originalAdminPolicy;
  });
  return { ...fixture, command };
}

for (const toolName of ["bash", "process_start"] as const) {
  test(`primary full access ${toolName} accepts recorder self-lineage and consumes a synthetic network grant without a prompt`, async (t) => {
    const fixture = networkFullAccessFixture(t, toolName);
    let consumed = 0;
    TOOL_DISPATCH[toolName] = async (args, context) => {
      assert.equal(context.runId, fixture.recorder.runId);
      assert.equal(context.lineage?.parentRunId, fixture.recorder.runId);
      assert.equal(context.agentProfileId, "code");
      assert.equal(context.subagentDepth || 0, 0);
      assert.deepEqual(context.filesystemSandbox?.networkOrigins, ["*"]);
      const grant = networkGrantForTool(context, args);
      assert.ok(grant);
      consumeNetworkExecutionGrant(grant, context.workspaceDir, String(args.command), toolName);
      consumed += 1;
      assert.throws(() => consumeNetworkExecutionGrant(grant, context.workspaceDir, String(args.command), toolName), /missing, expired/);
      return "SYNTHETIC_NETWORK_ADMISSION_OK";
    };
    const messages = await fixture.execute();
    const call = messages.flatMap((message) => message.toolCalls || []).find((entry) => entry.toolCallId === "full-access-network-0");
    assert.equal(fixture.approvals(), 0);
    assert.equal(consumed, 1);
    assert.equal(call?.isError, false);
    assert.match(call?.result || "", /SYNTHETIC_NETWORK_ADMISSION_OK/);
    assert.equal(fixture.recorder.snapshot().toolExecutions.find((entry) => entry.toolCallId === "full-access-network-0")?.status, "completed");
    assert.equal(listFileMutations(fixture.workspaceDir, { toolCallId: "full-access-network-0" }).length, 0);
  });

  test(`primary full access ${toolName} revoked beforeToolExecute cannot reach the network handler`, async (t) => {
    const fixture = networkFullAccessFixture(t, toolName);
    let handlerReached = false;
    TOOL_DISPATCH[toolName] = async (args, context) => {
      handlerReached = true;
      const grant = networkGrantForTool(context, args);
      assert.ok(grant);
      consumeNetworkExecutionGrant(grant, context.workspaceDir, String(args.command), toolName);
      return "network handler must not run";
    };
    const unregister = registerAgentHooks({
      name: `revoke-primary-network-${toolName}-before-execute`,
      handlers: { beforeToolExecute: async (context) => {
        if (context.toolCallId !== "full-access-network-0") return;
        await Promise.resolve();
        fixture.revoke();
      } },
    });
    t.after(unregister);
    await fixture.execute();
    assert.equal(fixture.approvals(), 0);
    assert.equal(handlerReached, false);
    assert.equal(fixture.recorder.snapshot().toolExecutions.find((entry) => entry.toolCallId === "full-access-network-0")?.status, "denied");
    assert.equal(listFileMutations(fixture.workspaceDir, { toolCallId: "full-access-network-0" }).length, 0);
  });

  test(`primary full access ${toolName} revoked during handler preparation cannot consume its network grant`, async (t) => {
    const fixture = networkFullAccessFixture(t, toolName);
    let handlerReached = false;
    let consumptionRejected = false;
    TOOL_DISPATCH[toolName] = async (args, context) => {
      handlerReached = true;
      assert.equal(context.lineage?.parentRunId, context.runId);
      const grant = networkGrantForTool(context, args);
      assert.ok(grant);
      await Promise.resolve();
      fixture.revoke();
      try {
        consumeNetworkExecutionGrant(grant, context.workspaceDir, String(args.command), toolName);
      } catch (error) {
        consumptionRejected = true;
        assert.match(String(error), /full access was disabled or changed/);
        fixture.replace();
        assert.throws(() => consumeNetworkExecutionGrant(grant, context.workspaceDir, String(args.command), toolName), /missing, expired/);
        throw error;
      }
      return "network grant must not be consumed";
    };
    const messages = await fixture.execute();
    const call = messages.flatMap((message) => message.toolCalls || []).find((entry) => entry.toolCallId === "full-access-network-0");
    assert.equal(fixture.approvals(), 0);
    assert.equal(handlerReached, true);
    assert.equal(consumptionRejected, true);
    assert.equal(call?.isError, true);
    assert.match(call?.result || "", /full access was disabled or changed/);
    assert.equal(listFileMutations(fixture.workspaceDir, { toolCallId: "full-access-network-0" }).length, 0);
  });
}
