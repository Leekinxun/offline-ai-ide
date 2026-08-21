import assert from "node:assert/strict";
import test from "node:test";
import type { ChangeSet } from "../chat/changeSets.js";
import type { AgentRunRecord } from "../chat/runHistory.js";
import type { CausalTraceEvent } from "../chat/traceStore.js";
import type { ManagedWorktree } from "../chat/worktrees.js";
import { buildExecutionGraphSnapshot, type ExecutionGraphSources } from "./executionGraph.js";
import type { Task, TeamMember } from "./types.js";

const metrics = {
  iterations: 1,
  modelCalls: 1,
  toolCalls: 1,
  toolErrors: 0,
  modelErrors: 0,
  promptTokens: 10,
  completionTokens: 5,
  totalTokens: 15,
  estimatedCostUsd: 0,
  estimatedTokensPeak: 15,
  compactionCount: 0,
};

function run(overrides: Partial<AgentRunRecord> & Pick<AgentRunRecord, "runId">): AgentRunRecord {
  const { runId, ...rest } = overrides;
  return {
    runId,
    conversationId: "conversation",
    mode: "code",
    status: "completed",
    startedAt: 10,
    updatedAt: 20,
    metrics,
    events: [],
    toolExecutions: [],
    contextManifestIds: [],
    ...rest,
  };
}

function task(overrides: Partial<Task> & Pick<Task, "id" | "subject">): Task {
  const { id, subject, ...rest } = overrides;
  return {
    id,
    subject,
    description: "",
    status: "pending",
    owner: null,
    blockedBy: [],
    blocks: [],
    ...rest,
  };
}

function changeSet(overrides: Partial<ChangeSet> & Pick<ChangeSet, "id" | "worktreeId">): ChangeSet {
  const { id, worktreeId, ...rest } = overrides;
  return {
    schemaVersion: 1,
    id,
    worktreeId,
    baseSha: "a".repeat(40),
    branch: "branch",
    headSha: "b".repeat(40),
    dirty: true,
    changedFiles: ["src/file.ts"],
    patchSha256: "c".repeat(64),
    status: "ready_for_review",
    createdAt: "2026-08-21T00:00:00.000Z",
    ...rest,
  };
}

test("projects existing records into stable nodes, relationships, and a merged timeline", () => {
  const parent = run({
    runId: "parent",
    status: "running",
    toolExecutions: [{
      toolCallId: "spawn-1",
      requestId: "request-1",
      name: "task",
      input: {},
      status: "completed",
      createdAt: 10,
      updatedAt: 11,
    }],
  });
  const child = run({
    runId: "child",
    parentRunId: "parent",
    parentTaskId: 7,
    parentToolCallId: "spawn-1",
    agentName: "teammate:builder",
    events: [{ id: "started", timestamp: 30, kind: "run_started", label: "Child started" }],
  });
  const teammate: TeamMember = {
    id: "teammate:builder",
    name: "builder",
    role: "executor",
    status: "idle",
    parentAgentId: "lead",
    parentRunId: "parent",
    parentTaskId: 7,
    parentToolCallId: "spawn-1",
    childRunId: "child",
    worktreeId: "wt-1",
    updatedAt: 40,
  };
  const worktree: ManagedWorktree = { id: "wt-1", path: "/private/managed", status: "ready_for_review", ownerId: teammate.id, runId: "child", reviewState: "pending" };
  const delivery = changeSet({ id: "cs-1", worktreeId: worktree.id, childRunId: "child", ownerId: teammate.id, parentTaskId: 7 });
  const trace: CausalTraceEvent = {
    schemaVersion: 1,
    eventId: "review-1",
    timestamp: 50,
    kind: "review",
    action: "Review completed",
    correlationId: "child",
    runId: "child",
    agentId: teammate.id,
    metadata: { changeSetId: delivery.id },
  };
  const sources: ExecutionGraphSources = {
    runRecords: [child, parent],
    teammates: [teammate],
    tasks: [task({ id: 7, subject: "Implement graph", owner: teammate.name, updatedAt: 35 })],
    traceEvents: [trace],
    managedWorktrees: [worktree],
    changeSets: [delivery],
  };

  const graph = buildExecutionGraphSnapshot(sources);
  assert.deepEqual(graph.nodes.map((node) => node.id), [...graph.nodes.map((node) => node.id)].sort());
  assert.equal(graph.nodes.some((node) => node.id === "run:child"), true);
  assert.equal(graph.nodes.some((node) => node.id === "agent:teammate:builder"), true);
  assert.equal(graph.nodes.some((node) => node.id === "task:7"), true);
  assert.equal(graph.nodes.some((node) => node.id === "worktree:wt-1"), true);
  assert.equal(graph.nodes.some((node) => node.id === "change_set:cs-1"), true);
  assert.equal(graph.edges.some((edge) => edge.kind === "spawned_by" && edge.source === "run:parent" && edge.target === "run:child"), true);
  assert.equal(graph.edges.some((edge) => edge.kind === "owns_task" && edge.source === "agent:teammate:builder" && edge.target === "task:7"), true);
  assert.equal(graph.edges.some((edge) => edge.kind === "uses_worktree" && edge.source === "run:child" && edge.target === "worktree:wt-1"), true);
  assert.equal(graph.edges.some((edge) => edge.kind === "produced_change_set" && edge.source === "worktree:wt-1" && edge.target === "change_set:cs-1"), true);
  assert.equal(graph.edges.some((edge) => edge.kind === "verified_by" && edge.source === "change_set:cs-1" && edge.target === "run:child"), true);
  assert.deepEqual(graph.events.map((event) => event.timestamp), [...graph.events.map((event) => event.timestamp)].sort((left, right) => left - right));
  assert.equal(graph.events.some((event) => event.id === "event:run:child:started"), true);
  assert.equal(graph.events.some((event) => event.id === "event:trace:review-1"), true);
  assert.equal(graph.asOf, Date.parse(delivery.createdAt));
});

test("deduplicates records and events and is deterministic regardless of source ordering", () => {
  const older = run({ runId: "same", updatedAt: 10, status: "running", events: [{ id: "event", timestamp: 5, kind: "run_started", label: "old" }] });
  const newer = run({ runId: "same", updatedAt: 20, status: "completed", events: [{ id: "event", timestamp: 5, kind: "run_started", label: "new" }] });
  const duplicateTrace: CausalTraceEvent = { schemaVersion: 1, eventId: "same-trace", timestamp: 30, kind: "run", action: "done", correlationId: "same", runId: "same" };
  const first = buildExecutionGraphSnapshot({ runRecords: [older, newer, newer], traceEvents: [duplicateTrace, duplicateTrace] });
  const second = buildExecutionGraphSnapshot({ runRecords: [newer, older], traceEvents: [duplicateTrace] });

  assert.deepEqual(first, second);
  assert.equal(first.nodes.filter((node) => node.id === "run:same").length, 1);
  assert.equal(first.nodes.find((node) => node.id === "run:same")?.status, "completed");
  assert.equal(first.events.filter((event) => event.id === "event:run:same:event").length, 1);
  assert.equal(first.events.filter((event) => event.id === "event:trace:same-trace").length, 1);
});

test("routes missing and cyclic lineage to unresolved parents without creating hierarchy cycles", () => {
  const graph = buildExecutionGraphSnapshot({
    runRecords: [
      run({ runId: "a", parentRunId: "b" }),
      run({ runId: "b", parentRunId: "a" }),
      run({ runId: "orphan", parentRunId: "missing", parentTaskId: 99, parentToolCallId: "missing-tool" }),
    ],
    tasks: [task({ id: 1, subject: "one", parentId: 2 }), task({ id: 2, subject: "two", parentId: 1 })],
  });

  const unresolved = graph.nodes.filter((node) => node.kind === "unresolved_parent");
  assert.equal(unresolved.some((node) => node.id === "unresolved_parent:missing:run:missing"), true);
  assert.equal(unresolved.some((node) => node.id === "unresolved_parent:missing:task:99"), true);
  assert.equal(unresolved.some((node) => node.id === "unresolved_parent:missing:tool_call:missing-tool"), true);
  assert.equal(unresolved.some((node) => node.status === "cycle" && node.ref === "a"), true);
  assert.equal(unresolved.some((node) => node.status === "cycle" && node.ref === "b"), true);
  assert.equal(graph.edges.some((edge) => edge.source === "run:a" && edge.target === "run:b"), false);
  assert.equal(graph.edges.some((edge) => edge.source === "run:b" && edge.target === "run:a"), false);
  assert.equal(graph.edges.some((edge) => edge.source === "task:1" && edge.target === "task:2"), false);
  assert.equal(graph.edges.some((edge) => edge.source === "task:2" && edge.target === "task:1"), false);
});

test("browser projection redacts secrets and paths and omits sensitive metadata payloads", () => {
  const graph = buildExecutionGraphSnapshot({
    teammates: [{
      id: "teammate:safe",
      name: "safe",
      role: "executor",
      status: "working",
      currentTask: "use api_key=top-secret-value at /Users/alice/private/plan.md and C:\\Users\\alice\\secret.txt",
      updatedAt: 10,
    }],
    tasks: [task({ id: 1, subject: "deploy sk-test_SUPER_SECRET_123456", updatedAt: 11 })],
    traceEvents: [{
      schemaVersion: 1,
      eventId: "secret-event",
      timestamp: 12,
      kind: "tool",
      action: "called with token=top-secret-value from /private/tmp/tool.log",
      correlationId: "safe",
      evidence: "free-form proof from /private/evidence.txt",
      metadata: {
        reasoning: "never expose",
        prompt: "private prompt",
        command: "cat /private/command.txt",
        detail: "private event detail",
        filePath: "/private/file.ts",
        worktreePath: "C:\\worktrees\\private",
        activePath: "/private/active",
        input: { token: "raw tool input" },
        rawToolInput: "another raw tool input",
        output: "plain raw output",
        toolOutput: "raw tool output",
        evidence: { transcript: "free-form evidence" },
        hasVerificationEvidence: true,
        nested: { raw_output: "hidden", retained: "visible" },
        password: "hunter2",
        status: "completed",
        count: 3,
      },
    }],
  });

  const serialized = JSON.stringify(graph);
  assert.doesNotMatch(serialized, /top-secret-value|SUPER_SECRET|never expose|private prompt|private event detail|raw tool input|raw output|free-form proof|free-form evidence|hunter2/);
  assert.doesNotMatch(serialized, /reasoning|raw_output|filePath|worktreePath|activePath|"command"|"detail"|"input"|rawToolInput|"output"|toolOutput|"evidence"/);
  assert.doesNotMatch(serialized, /\/Users\/alice|\/private\/|C:\\\\Users|C:\\\\worktrees/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.match(serialized, /\[ABS_PATH\]/);
  assert.match(serialized, /retained/);
  const traceMetadata = graph.events.find((event) => event.id === "event:trace:secret-event")?.metadata;
  assert.equal(traceMetadata?.hasVerificationEvidence, true);
  assert.equal(traceMetadata?.status, "completed");
  assert.equal(traceMetadata?.count, 3);
});

test("derives parent aggregate blockers without mutating task or change set facts", () => {
  const parent = task({ id: 1, subject: "parent", status: "in_progress" });
  const pendingChild = task({ id: 2, subject: "pending child", parentId: 1, status: "in_progress" });
  const optionalFailure = task({ id: 3, subject: "optional child", parentId: 1, status: "failed", required: false });
  const awaitingReview = changeSet({ id: "review", worktreeId: "wt", parentTaskId: 1, parentRunId: "parent-run" });
  const graph = buildExecutionGraphSnapshot({
    tasks: [parent, pendingChild, optionalFailure],
    runRecords: [run({ runId: "parent-run", status: "completed" })],
    changeSets: [awaitingReview],
  });

  assert.deepEqual(graph.nodes.find((node) => node.id === "task:1")?.blockingReasons, ["waiting_on_children", "awaiting_change_set_review"]);
  assert.equal(graph.nodes.find((node) => node.id === "task:1")?.aggregateStatus, "waiting_on_children");
  assert.deepEqual(graph.nodes.find((node) => node.id === "run:parent-run")?.blockingReasons, ["awaiting_change_set_review"]);
  assert.equal(parent.status, "in_progress");
  assert.equal(awaitingReview.status, "ready_for_review");

  const failed = buildExecutionGraphSnapshot({ tasks: [parent, task({ id: 2, subject: "failed child", parentId: 1, status: "failed" })] });
  assert.deepEqual(failed.nodes.find((node) => node.id === "task:1")?.blockingReasons, ["child_failed"]);
  assert.equal(failed.nodes.find((node) => node.id === "task:1")?.aggregateStatus, "child_failed");

  const runParent = buildExecutionGraphSnapshot({ runRecords: [
    run({ runId: "parent", status: "running" }),
    run({ runId: "child", parentRunId: "parent", status: "failed" }),
  ] });
  assert.deepEqual(runParent.nodes.find((node) => node.id === "run:parent")?.blockingReasons, ["child_failed"]);
});

test("projects safe ChangeSet review and verification lifecycle events", () => {
  const values: ChangeSet[] = [
    changeSet({ id: "review", worktreeId: "wt-review", status: "ready_for_review" }),
    changeSet({ id: "attention", worktreeId: "wt-attention", status: "needs_attention", verificationEvidence: { raw_output: "secret output", passed: false } }),
    changeSet({ id: "applied", worktreeId: "wt-applied", status: "applied", appliedAt: "2026-08-21T01:00:00.000Z", decision: "apply" }),
    changeSet({ id: "rejected", worktreeId: "wt-rejected", status: "rejected", reviewedAt: "2026-08-21T02:00:00.000Z", decision: "reject" }),
  ];
  const graph = buildExecutionGraphSnapshot({ changeSets: values });

  assert.equal(graph.events.some((event) => event.kind === "change_set_awaiting_review"), true);
  assert.equal(graph.events.some((event) => event.kind === "change_set_needs_attention" && event.metadata?.verificationState === "failed"), true);
  assert.equal(graph.events.some((event) => event.kind === "change_set_applied"), true);
  assert.equal(graph.events.some((event) => event.kind === "change_set_rejected"), true);
  assert.doesNotMatch(JSON.stringify(graph), /secret output|raw_output/);
});
