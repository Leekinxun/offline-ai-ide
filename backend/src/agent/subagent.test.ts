import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { listChildRuns, readRunRecord } from "../chat/runHistory.js";
import { clearModelCapabilityCache } from "./modelCapabilities.js";
import { runSubagent } from "./subagent.js";
import { listChangeSets } from "../chat/changeSets.js";
import { listManagedWorktrees } from "../chat/worktrees.js";
import { listFileMutations } from "../files/mutationRegistry.js";
import { registerAgentHooks } from "./agentHooks.js";
import { TraceStore } from "../chat/traceStore.js";

function initializeGitWorkspace(workspaceDir: string): void {
  execFileSync("git", ["init", "-q", workspaceDir]);
  execFileSync("git", ["-C", workspaceDir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", workspaceDir, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", workspaceDir, "commit", "--allow-empty", "-qm", "initial"]);
}

test("records a queryable child run for a delegated subagent", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-subagent-"));
  const originalFetch = globalThis.fetch;
  initializeGitWorkspace(workspaceDir);
  clearModelCapabilityCache();
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/models")) {
      return Response.json({ data: [{ id: "test-model", max_output_tokens: 1024 }] });
    }
    if (url.endsWith("/chat/completions")) {
      return Response.json({
        choices: [{
          message: { role: "assistant", content: "delegated result" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });
    }
    return new Response("not found", { status: 404 });
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    clearModelCapabilityCache();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  const output = await runSubagent(
    "inspect password=subagent-prompt-secret",
    "Explore",
    workspaceDir,
    "http://provider.test/v1",
    "test-model",
    undefined,
    undefined,
    undefined,
    {
      parentRunId: "parent-run",
      parentTaskId: 23,
      parentConversationId: "conversation-1",
      parentRequestId: "request-1",
      parentToolCallId: "tool-call-1",
    }
  );

  assert.match(output, /^delegated result\nChangeSet [a-f0-9]+ \(no_changes\)$/);
  const children = listChildRuns(workspaceDir, "parent-run");
  assert.equal(children.length, 1);
  assert.equal(children[0].status, "completed");
  assert.equal(children[0].agentName, "subagent:Explore");
  assert.equal(children[0].parentTaskId, 23);
  assert.equal(children[0].metrics.totalTokens, 7);
  const lifecycle = new TraceStore(workspaceDir).list().filter((event) => event.action.startsWith("collaboration."));
  const started = lifecycle.find((event) => event.action === "collaboration.spawn_started");
  const captured = lifecycle.find((event) => event.action === "collaboration.change_set_capture_succeeded");
  const completed = lifecycle.find((event) => event.action === "collaboration.agent_state_transition" && event.metadata?.status === "completed");
  assert.ok(started && captured && completed);
  for (const event of [started, captured]) {
    assert.equal(event.metadata?.runId, children[0].runId);
    assert.equal(event.metadata?.agentId, "subagent:Explore");
    assert.equal(event.metadata?.parentRunId, "parent-run");
    assert.equal(event.metadata?.parentTaskId, 23);
    assert.equal(event.metadata?.requestId, "request-1");
    assert.equal(event.metadata?.toolCallId, "tool-call-1");
    assert.ok(event.metadata?.worktreeId);
  }
  assert.ok(captured.metadata?.changeSetId);
  assert.doesNotMatch(JSON.stringify(lifecycle), /subagent-prompt-secret|delegated result/);
});

test("subagent spawn stops and surfaces a critical audit append failure", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-subagent-trace-fail-"));
  initializeGitWorkspace(workspaceDir);
  await fs.mkdir(path.join(workspaceDir, ".history"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, ".history", "traces"), "not-a-directory");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("model must not run"); };
  t.after(async () => { globalThis.fetch = originalFetch; await fs.rm(workspaceDir, { recursive: true, force: true }); });
  await assert.rejects(runSubagent("secret prompt", "Explore", workspaceDir, "http://provider.test/v1", "test-model"));
});

test("write-capable child writes only its managed worktree and emits a ChangeSet", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-subagent-git-"));
  initializeGitWorkspace(workspaceDir);
  await fs.writeFile(path.join(workspaceDir, "note.txt"), "parent\n");
  execFileSync("git", ["-C", workspaceDir, "add", "note.txt"]);
  execFileSync("git", ["-C", workspaceDir, "commit", "-qm", "note"]);
  const originalFetch = globalThis.fetch;
  let completion = 0;
  clearModelCapabilityCache();
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "test-model", max_output_tokens: 1024 }] });
    if (String(input).endsWith("/chat/completions")) {
      completion += 1;
      return Response.json({ choices: [{ message: completion === 1
        ? { role: "assistant", content: null, tool_calls: [{ id: "write-1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "note.txt", content: "child\n" }) } }] }
        : { role: "assistant", content: "done" }, finish_reason: completion === 1 ? "tool_calls" : "stop" }], usage: {} });
    }
    return new Response("not found", { status: 404 });
  };
  t.after(async () => { globalThis.fetch = originalFetch; clearModelCapabilityCache(); await fs.rm(workspaceDir, { recursive: true, force: true }); });

  const output = await runSubagent("change note", "Code", workspaceDir, "http://provider.test/v1", "test-model", undefined, async () => ({ allowed: true }));
  assert.match(output, /ChangeSet [a-f0-9]+ \(ready_for_review\)$/);
  assert.equal(await fs.readFile(path.join(workspaceDir, "note.txt"), "utf8"), "parent\n");
  const changes = listChangeSets(workspaceDir);
  assert.equal(changes.length, 1);
  assert.ok(changes[0].changedFiles.includes("note.txt"));
});

test("write-capable child fails before mutation when its required checkpoint cannot be created", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-subagent-checkpoint-fail-"));
  initializeGitWorkspace(workspaceDir);
  await fs.writeFile(path.join(workspaceDir, ".checkpoints"), "tracked blocker\n");
  execFileSync("git", ["-C", workspaceDir, "add", ".checkpoints"]);
  execFileSync("git", ["-C", workspaceDir, "commit", "-qm", "checkpoint blocker"]);
  const originalFetch = globalThis.fetch;
  let completion = 0;
  clearModelCapabilityCache();
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "test-model", max_output_tokens: 1024 }] });
    completion += 1;
    if (completion === 2) {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string }> };
      assert.match(body.messages.find((message) => message.role === "tool")?.content || "", /Required mutation checkpoint unavailable/);
    }
    return Response.json({ choices: [{ message: completion === 1
      ? { role: "assistant", content: null, tool_calls: [{ id: "blocked-write", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "blocked.txt", content: "must not exist\n" }) } }] }
      : { role: "assistant", content: "checkpoint blocked" }, finish_reason: completion === 1 ? "tool_calls" : "stop" }], usage: {} });
  };
  t.after(async () => { globalThis.fetch = originalFetch; clearModelCapabilityCache(); await fs.rm(workspaceDir, { recursive: true, force: true }); });

  const output = await runSubagent("blocked write", "Code", workspaceDir, "http://provider.test/v1", "test-model", undefined, async () => ({ allowed: true }));
  assert.match(output, /ChangeSet capture failed: Mutation journal evidence is invalid or unreadable/);
  const child = listManagedWorktrees(workspaceDir)[0];
  assert.equal(await fs.stat(path.join(child.path, "blocked.txt")).then(() => true).catch(() => false), false);
  assert.equal(child.status, "needs_attention");
  assert.equal(completion, 2);
});

test("child allocation failure fails closed before a bash-capable child can run", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-subagent-nogit-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("model must not run"); };
  t.after(async () => { globalThis.fetch = originalFetch; await fs.rm(workspaceDir, { recursive: true, force: true }); });
  const output = await runSubagent("inspect", "Explore", workspaceDir, "http://provider.test/v1", "test-model");
  assert.match(output, /isolated worktree allocation failed; refusing to run/);
});

test("denied child write leaves the parent unchanged", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-subagent-denied-"));
  initializeGitWorkspace(workspaceDir);
  await fs.writeFile(path.join(workspaceDir, "protected.txt"), "parent\n");
  execFileSync("git", ["-C", workspaceDir, "add", "protected.txt"]);
  execFileSync("git", ["-C", workspaceDir, "commit", "-qm", "protected"]);
  const originalFetch = globalThis.fetch;
  let completion = 0;
  clearModelCapabilityCache();
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "test-model", max_output_tokens: 1024 }] });
    completion += 1;
    return Response.json({ choices: [{ message: completion === 1
      ? { role: "assistant", content: null, tool_calls: [{ id: "denied-write", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "protected.txt", content: "child\n" }) } }] }
      : { role: "assistant", content: "done" }, finish_reason: completion === 1 ? "tool_calls" : "stop" }], usage: {} });
  };
  t.after(async () => { globalThis.fetch = originalFetch; clearModelCapabilityCache(); await fs.rm(workspaceDir, { recursive: true, force: true }); });

  const output = await runSubagent("attempt", "Code", workspaceDir, "http://provider.test/v1", "test-model", undefined, async () => ({ allowed: false, reason: "denied for test" }));
  assert.match(output, /ChangeSet .*\(no_changes\)$/);
  assert.equal(await fs.readFile(path.join(workspaceDir, "protected.txt"), "utf8"), "parent\n");
  assert.equal(listChangeSets(workspaceDir).at(0)?.changedFiles.includes("protected.txt"), false);
});

test("two children receive separate managed worktrees", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-subagent-isolation-"));
  initializeGitWorkspace(workspaceDir);
  const originalFetch = globalThis.fetch;
  let call = 0;
  clearModelCapabilityCache();
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "test-model", max_output_tokens: 1024 }] });
    call += 1;
    const write = call === 1 || call === 3;
    const filename = call === 1 ? "one.txt" : "two.txt";
    return Response.json({ choices: [{ message: write
      ? { role: "assistant", content: null, tool_calls: [{ id: `write-${filename}`, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: filename, content: filename }) } }] }
      : { role: "assistant", content: "done" }, finish_reason: write ? "tool_calls" : "stop" }], usage: {} });
  };
  t.after(async () => { globalThis.fetch = originalFetch; clearModelCapabilityCache(); await fs.rm(workspaceDir, { recursive: true, force: true }); });
  const allow = async () => ({ allowed: true });
  await runSubagent("one", "Code", workspaceDir, "http://provider.test/v1", "test-model", undefined, allow);
  await runSubagent("two", "Code", workspaceDir, "http://provider.test/v1", "test-model", undefined, allow);
  const worktrees = listManagedWorktrees(workspaceDir);
  assert.equal(worktrees.length, 2);
  assert.notEqual(worktrees[0].path, worktrees[1].path);
  assert.equal(await fs.readFile(path.join(workspaceDir, "one.txt")).catch(() => "missing"), "missing");
  assert.equal(await fs.readFile(path.join(workspaceDir, "two.txt")).catch(() => "missing"), "missing");
});

test("authorized child bash can use a compatibility-shell pipe", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-subagent-pipe-"));
  initializeGitWorkspace(workspaceDir);
  const originalFetch = globalThis.fetch;
  let completion = 0;
  clearModelCapabilityCache();
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "test-model", max_output_tokens: 1024 }] });
    completion += 1;
    if (completion === 2) {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string }> };
      assert.match(body.messages.find((message) => message.role === "tool")?.content || "", /PIPE/);
    }
    return Response.json({ choices: [{ message: completion === 1
      ? { role: "assistant", content: null, tool_calls: [{ id: "bash-pipe", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf pipe | tr a-z A-Z" }) } }] }
      : { role: "assistant", content: "pipe complete" }, finish_reason: completion === 1 ? "tool_calls" : "stop" }], usage: {} });
  };
  t.after(async () => { globalThis.fetch = originalFetch; clearModelCapabilityCache(); await fs.rm(workspaceDir, { recursive: true, force: true }); });

  const output = await runSubagent("pipe", "Code", workspaceDir, "http://provider.test/v1", "test-model", undefined, async () => ({ allowed: true }));
  assert.match(output, /^pipe complete\nChangeSet /);
});

test("denied child bash never executes", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-subagent-bash-denied-"));
  initializeGitWorkspace(workspaceDir);
  const originalFetch = globalThis.fetch;
  let completion = 0;
  clearModelCapabilityCache();
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "test-model", max_output_tokens: 1024 }] });
    completion += 1;
    return Response.json({ choices: [{ message: completion === 1
      ? { role: "assistant", content: null, tool_calls: [{ id: "bash-denied", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "touch denied.txt" }) } }] }
      : { role: "assistant", content: "denied complete" }, finish_reason: completion === 1 ? "tool_calls" : "stop" }], usage: {} });
  };
  t.after(async () => { globalThis.fetch = originalFetch; clearModelCapabilityCache(); await fs.rm(workspaceDir, { recursive: true, force: true }); });

  await runSubagent("deny bash", "Code", workspaceDir, "http://provider.test/v1", "test-model", undefined, async () => ({ allowed: false, reason: "denied for test" }));
  const child = listManagedWorktrees(workspaceDir)[0];
  assert.equal(await fs.stat(path.join(child.path, "denied.txt")).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(path.join(workspaceDir, "denied.txt")).then(() => true).catch(() => false), false);
});

test("empty child run returns no_changes and does not create a review gate", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-subagent-empty-"));
  initializeGitWorkspace(workspaceDir);
  const originalFetch = globalThis.fetch;
  clearModelCapabilityCache();
  globalThis.fetch = async (input) => String(input).endsWith("/models")
    ? Response.json({ data: [{ id: "test-model", max_output_tokens: 1024 }] })
    : Response.json({ choices: [{ message: { role: "assistant", content: "nothing to change" }, finish_reason: "stop" }], usage: {} });
  t.after(async () => { globalThis.fetch = originalFetch; clearModelCapabilityCache(); await fs.rm(workspaceDir, { recursive: true, force: true }); });

  const first = await runSubagent("inspect", "Explore", workspaceDir, "http://provider.test/v1", "test-model");
  const second = await runSubagent("inspect again", "Explore", workspaceDir, "http://provider.test/v1", "test-model");
  assert.match(first, /ChangeSet [a-f0-9]+ \(no_changes\)$/);
  assert.match(second, /ChangeSet [a-f0-9]+ \(no_changes\)$/);
  assert.equal(listManagedWorktrees(workspaceDir).every((entry) => entry.status === "integrated" && entry.reviewState === "approved"), true);
});

test("failed child bash records partial file mutations with child attribution", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-subagent-partial-bash-"));
  initializeGitWorkspace(workspaceDir);
  const originalFetch = globalThis.fetch;
  let completion = 0;
  clearModelCapabilityCache();
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "test-model", max_output_tokens: 1024 }] });
    completion += 1;
    return Response.json({ choices: [{ message: completion === 1
      ? { role: "assistant", content: null, tool_calls: [{ id: "bash-partial", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "touch partial.txt && false" }) } }] }
      : { role: "assistant", content: "observed failure" }, finish_reason: completion === 1 ? "tool_calls" : "stop" }], usage: {} });
  };
  t.after(async () => { globalThis.fetch = originalFetch; clearModelCapabilityCache(); await fs.rm(workspaceDir, { recursive: true, force: true }); });

  await runSubagent("partial bash", "Code", workspaceDir, "http://provider.test/v1", "test-model", undefined, async () => ({ allowed: true }));
  const child = listManagedWorktrees(workspaceDir)[0];
  const mutations = listFileMutations(child.path, { toolCallId: "bash-partial" });
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].path, "partial.txt");
  assert.equal(mutations[0].operation, "create");
  assert.equal(mutations[0].runId, child.runId);
});

test("child mutation evidence gaps fail tool lifecycle, hooks, run result, and worktree consistently", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-subagent-evidence-gap-"));
  initializeGitWorkspace(workspaceDir);
  const originalFetch = globalThis.fetch;
  let completion = 0;
  let hookError = "";
  clearModelCapabilityCache();
  const unregister = registerAgentHooks({ name: "observe-subagent-gap", handlers: { afterToolExecute: (context) => { if (context.toolCallId === "bash-gap") hookError = context.error || ""; } } });
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "test-model", max_output_tokens: 1024 }] });
    completion += 1;
    return Response.json({ choices: [{ message: completion === 1
      ? { role: "assistant", content: null, tool_calls: [{ id: "bash-gap", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf OK && printf '\\0binary' > evidence.bin" }) } }] }
      : { role: "assistant", content: "handled evidence gap" }, finish_reason: completion === 1 ? "tool_calls" : "stop" }], usage: {} });
  };
  t.after(async () => { unregister(); globalThis.fetch = originalFetch; clearModelCapabilityCache(); await fs.rm(workspaceDir, { recursive: true, force: true }); });

  const output = await runSubagent("binary evidence", "Code", workspaceDir, "http://provider.test/v1", "test-model", undefined, async () => ({ allowed: true }), undefined, {
    parentRunId: "parent-gap", parentConversationId: "conversation-gap", parentRequestId: "request-gap", parentToolCallId: "task-gap",
  });
  const child = listManagedWorktrees(workspaceDir)[0];
  const run = readRunRecord(workspaceDir, child.runId!);
  assert.match(output, /^Error: .*mutation evidence/i);
  assert.equal(run.toolExecutions.find((tool) => tool.toolCallId === "bash-gap")?.status, "failed");
  assert.match(hookError, /mutation evidence incomplete/i);
  assert.equal(run.status, "failed");
  assert.equal(child.status, "needs_attention");
  assert.equal(listChangeSets(workspaceDir)[0]?.status, "needs_attention");
  assert.doesNotMatch(output, /ready for review/i);
});
