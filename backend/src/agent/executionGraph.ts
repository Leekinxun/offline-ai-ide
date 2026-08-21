import { createHash } from "node:crypto";
import type { ChangeSet } from "../chat/changeSets.js";
import type { AgentRunRecord } from "../chat/runHistory.js";
import type { CausalTraceEvent } from "../chat/traceStore.js";
import type { ManagedWorktree } from "../chat/worktrees.js";
import { redactSecrets } from "./secretRedaction.js";
import type { Task, TeamMember } from "./types.js";

export type ExecutionGraphNodeKind =
  | "run"
  | "agent"
  | "task"
  | "worktree"
  | "change_set"
  | "unresolved_parent";

export type ExecutionGraphEdgeKind =
  | "spawned_by"
  | "owns_task"
  | "uses_worktree"
  | "produced_change_set"
  | "verified_by";

export interface ExecutionGraphNode {
  id: string;
  kind: ExecutionGraphNodeKind;
  ref: string;
  status?: string;
  summary: string;
  metadata: Record<string, unknown>;
  aggregateStatus?: string;
  blockingReasons?: ExecutionGraphBlockingReason[];
}

export type ExecutionGraphBlockingReason = "waiting_on_children" | "child_failed" | "awaiting_change_set_review";

export interface ExecutionGraphEdge {
  id: string;
  kind: ExecutionGraphEdgeKind;
  source: string;
  target: string;
  metadata?: Record<string, unknown>;
}

export interface ExecutionGraphEvent {
  id: string;
  timestamp: number;
  kind: string;
  nodeId?: string;
  summary: string;
  parentEventId?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentExecutionGraphSnapshot {
  schemaVersion: 1;
  revision: string;
  asOf: number;
  nodes: ExecutionGraphNode[];
  edges: ExecutionGraphEdge[];
  events: ExecutionGraphEvent[];
}

export interface ExecutionGraphSources {
  runRecords?: readonly AgentRunRecord[];
  teammates?: readonly TeamMember[];
  tasks?: readonly Task[];
  traceEvents?: readonly CausalTraceEvent[];
  managedWorktrees?: readonly ManagedWorktree[];
  changeSets?: readonly ChangeSet[];
}

type ParentRelationKind = "run" | "agent" | "task" | "tool_call" | "worktree";

const MAX_SUMMARY_LENGTH = 500;
const ABSOLUTE_PATH = /(^|[\s("'=])(?:\/(?:[^\s"'<>/]+\/)*[^\s"'<>/]+|[A-Za-z]:[\\/][^\s"'<>|?*]+|\\\\[^\s"'<>|?*]+[\\/][^\s"'<>|?*]+)/g;

function hiddenMetadataKey(key: string, value: unknown): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (normalized === "hasverificationevidence") return typeof value !== "boolean";
  return normalized.endsWith("path")
    || normalized.endsWith("paths")
    || normalized.includes("prompt")
    || normalized.includes("reasoning")
    || normalized.includes("thinking")
    || normalized.includes("chainofthought")
    || /(?:^|raw|tool)(?:input|output)$/.test(normalized)
    || normalized === "command"
    || normalized.endsWith("command")
    || normalized === "detail"
    || normalized.endsWith("detail")
    || normalized.includes("evidence");
}

function safeText(value: unknown, maximum = MAX_SUMMARY_LENGTH): string {
  return typeof value === "string"
    ? redactSecrets(value).replace(ABSOLUTE_PATH, (_match, prefix: string) => `${prefix}[ABS_PATH]`).trim().slice(0, maximum)
    : "";
}

function safeRef(value: string | number): string {
  return safeText(String(value), 160) || "unknown";
}

function nodeId(kind: Exclude<ExecutionGraphNodeKind, "unresolved_parent">, ref: string | number): string {
  return `${kind}:${safeRef(ref)}`;
}

function unresolvedNodeId(kind: ParentRelationKind, ref: string | number, reason: "missing" | "cycle"): string {
  return `unresolved_parent:${reason}:${kind}:${safeRef(ref)}`;
}

function sanitizeMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const sanitize = (entry: unknown): unknown => {
    if (typeof entry === "string") return safeText(entry, 500);
    if (Array.isArray(entry)) return entry.slice(0, 100).map(sanitize);
    if (!entry || typeof entry !== "object") return entry;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(entry as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))) {
      if (!hiddenMetadataKey(key, child) && child !== undefined) result[key] = sanitize(child);
    }
    return result;
  };
  return sanitize(redactSecrets(value)) as Record<string, unknown>;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value) ?? "null";
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`)
    .join(",")}}`;
}

function freshest<T>(values: readonly T[], key: (value: T) => string, timestamp: (value: T) => number): T[] {
  const selected = new Map<string, T>();
  for (const value of values) {
    const id = key(value);
    const current = selected.get(id);
    if (!current || timestamp(value) > timestamp(current) || (
      timestamp(value) === timestamp(current) && stableSerialize(value) > stableSerialize(current)
    )) selected.set(id, value);
  }
  return [...selected.values()].sort((left, right) => key(left).localeCompare(key(right)));
}

function cyclicChildren(parentByChild: ReadonlyMap<string, string>): Set<string> {
  const cyclic = new Set<string>();
  const done = new Set<string>();
  const children = [...parentByChild.keys()].sort();
  for (const start of children) {
    if (done.has(start)) continue;
    const path: string[] = [];
    const position = new Map<string, number>();
    let current: string | undefined = start;
    while (current !== undefined && parentByChild.has(current) && !done.has(current)) {
      const previous = position.get(current);
      if (previous !== undefined) {
        for (const member of path.slice(previous)) cyclic.add(member);
        break;
      }
      position.set(current, path.length);
      path.push(current);
      current = parentByChild.get(current);
    }
    for (const member of path) done.add(member);
  }
  return cyclic;
}

function statusEvent(
  entityKind: "agent" | "task" | "change_set",
  entityRef: string | number,
  status: string,
  timestamp: number | undefined,
  targetNodeId: string,
): ExecutionGraphEvent | undefined {
  if (!Number.isFinite(timestamp)) return undefined;
  return {
    id: `event:state:${entityKind}:${safeRef(entityRef)}:${timestamp}:${safeRef(status)}`,
    timestamp: timestamp!,
    kind: `${entityKind}_status`,
    nodeId: targetNodeId,
    summary: safeText(`${entityKind.replace("_", " ")} ${safeRef(entityRef)} is ${status}`),
    metadata: { status: safeText(status, 80) },
  };
}

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled", "deleted"]);
const TERMINAL_RUN_STATUSES = new Set(["completed", "stopped", "failed"]);
const CHANGE_SET_REVIEW_STATUSES = new Set(["ready_for_review", "needs_revision", "needs_attention"]);

function changeSetLifecycleKind(status: ChangeSet["status"]): string {
  switch (status) {
    case "ready_for_review": return "change_set_awaiting_review";
    case "needs_revision":
    case "needs_attention": return "change_set_needs_attention";
    case "applied": return "change_set_applied";
    case "rejected": return "change_set_rejected";
    default: return "change_set_status";
  }
}

/**
 * Produces a deterministic, read-only graph projection. It never mutates or
 * persists any source record; callers remain responsible for obtaining current
 * snapshots from the existing stores.
 */
export function buildExecutionGraphSnapshot(sources: ExecutionGraphSources): AgentExecutionGraphSnapshot {
  const runs = freshest(sources.runRecords ?? [], (run) => run.runId, (run) => run.updatedAt);
  const teammates = freshest(
    sources.teammates ?? [],
    (member) => member.id || `teammate:${member.name}`,
    (member) => member.updatedAt ?? member.startedAt ?? 0,
  );
  const tasks = freshest(sources.tasks ?? [], (task) => String(task.id), (task) => task.updatedAt ?? task.createdAt ?? 0);
  const worktrees = freshest(sources.managedWorktrees ?? [], (worktree) => worktree.id, () => 0);
  const changeSets = freshest(
    sources.changeSets ?? [],
    (changeSet) => changeSet.id,
    (changeSet) => Date.parse(changeSet.appliedAt ?? changeSet.failedAt ?? changeSet.reviewedAt ?? changeSet.createdAt) || 0,
  );

  const nodes = new Map<string, ExecutionGraphNode>();
  const edges = new Map<string, ExecutionGraphEdge>();
  const events = new Map<string, ExecutionGraphEvent>();

  const addNode = (node: ExecutionGraphNode): void => {
    const safe: ExecutionGraphNode = {
      ...node,
      ref: safeRef(node.ref),
      status: node.status ? safeText(node.status, 80) : undefined,
      summary: safeText(node.summary),
      metadata: sanitizeMetadata(node.metadata),
    };
    const current = nodes.get(safe.id);
    if (!current || stableSerialize(safe) > stableSerialize(current)) nodes.set(safe.id, safe);
  };
  const addUnresolved = (kind: ParentRelationKind, ref: string | number, reason: "missing" | "cycle"): string => {
    const id = unresolvedNodeId(kind, ref, reason);
    addNode({
      id,
      kind: "unresolved_parent",
      ref: safeRef(ref),
      status: reason,
      summary: `${reason === "cycle" ? "Cyclic" : "Missing"} ${kind.replace("_", " ")} parent ${safeRef(ref)}`,
      metadata: { referenceKind: kind, reason },
    });
    return id;
  };
  const addEdge = (
    kind: ExecutionGraphEdgeKind,
    source: string,
    target: string,
    metadata?: Record<string, unknown>,
  ): void => {
    const safeMetadata = metadata ? sanitizeMetadata(metadata) : undefined;
    const discriminator = safeMetadata && Object.keys(safeMetadata).length ? createHash("sha256").update(stableSerialize(safeMetadata)).digest("hex").slice(0, 12) : "";
    const id = `edge:${kind}:${source}:${target}${discriminator ? `:${discriminator}` : ""}`;
    edges.set(id, { id, kind, source, target, ...(safeMetadata ? { metadata: safeMetadata } : {}) });
  };
  const addEvent = (event: ExecutionGraphEvent | undefined): void => {
    if (!event || !Number.isFinite(event.timestamp)) return;
    const safe: ExecutionGraphEvent = {
      ...event,
      kind: safeText(event.kind, 120),
      summary: safeText(event.summary),
      parentEventId: event.parentEventId ? safeRef(event.parentEventId) : undefined,
      metadata: event.metadata ? sanitizeMetadata(event.metadata) : undefined,
    };
    const current = events.get(safe.id);
    if (!current || stableSerialize(safe) > stableSerialize(current)) events.set(safe.id, safe);
  };

  const runById = new Map(runs.map((run) => [run.runId, run]));
  const taskById = new Map(tasks.map((task) => [String(task.id), task]));
  const worktreeById = new Map(worktrees.map((worktree) => [worktree.id, worktree]));
  const changeSetById = new Map(changeSets.map((changeSet) => [changeSet.id, changeSet]));
  const agentByRef = new Map<string, TeamMember>();
  for (const member of teammates) {
    const id = member.id || `teammate:${member.name}`;
    agentByRef.set(id, member);
    agentByRef.set(member.name, member);
    agentByRef.set(`teammate:${member.name}`, member);
  }

  for (const run of runs) {
    const id = nodeId("run", run.runId);
    const changedFiles = run.summary?.changedFiles.length ?? 0;
    addNode({
      id,
      kind: "run",
      ref: run.runId,
      status: run.status,
      summary: `${run.agentName || run.mode} run is ${run.status}; ${changedFiles} changed file${changedFiles === 1 ? "" : "s"}, ${run.metrics.toolCalls} tool call${run.metrics.toolCalls === 1 ? "" : "s"}, ${run.metrics.toolErrors + run.metrics.modelErrors} error${run.metrics.toolErrors + run.metrics.modelErrors === 1 ? "" : "s"}`,
      metadata: {
        mode: run.mode,
        agentName: run.agentName,
        modelName: run.modelName,
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
        endedAt: run.endedAt,
        parentRunId: run.parentRunId,
        parentTaskId: run.parentTaskId,
        parentToolCallId: run.parentToolCallId,
      },
    });
    for (const event of run.events) addEvent({
      id: `event:run:${safeRef(run.runId)}:${safeRef(event.id)}`,
      timestamp: event.timestamp,
      kind: event.kind,
      nodeId: id,
      summary: event.label,
      metadata: {
        requestId: event.requestId,
        toolName: event.toolName,
        durationMs: event.durationMs,
        isError: event.isError,
        detail: event.detail,
      },
    });
  }

  for (const member of teammates) {
    const ref = member.id || `teammate:${member.name}`;
    const id = nodeId("agent", ref);
    const task = safeText(member.currentTask, 180);
    addNode({
      id,
      kind: "agent",
      ref,
      status: member.status,
      summary: `${member.name} (${member.role}) is ${member.status}${task ? `: ${task}` : ""}`,
      metadata: {
        name: member.name,
        role: member.role,
        childRunId: member.childRunId,
        parentAgentId: member.parentAgentId,
        parentRunId: member.parentRunId,
        parentTaskId: member.parentTaskId,
        worktreeId: member.worktreeId,
        version: member.version,
        updatedAt: member.updatedAt,
      },
    });
    addEvent(statusEvent("agent", ref, member.status, member.updatedAt ?? member.startedAt, id));
  }

  for (const task of tasks) {
    const id = nodeId("task", task.id);
    addNode({
      id,
      kind: "task",
      ref: String(task.id),
      status: task.status,
      summary: `${task.subject} is ${task.status}`,
      metadata: {
        owner: task.owner,
        parentTaskId: task.parentId,
        blockedBy: [...new Set(task.blockedBy)].sort((left, right) => left - right),
        blocks: [...new Set(task.blocks)].sort((left, right) => left - right),
        required: task.required,
        version: task.version,
        updatedAt: task.updatedAt,
      },
    });
    addEvent(statusEvent("task", task.id, task.status, task.updatedAt ?? task.createdAt, id));
  }

  for (const worktree of worktrees) {
    const id = nodeId("worktree", worktree.id);
    addNode({
      id,
      kind: "worktree",
      ref: worktree.id,
      status: worktree.status,
      summary: `Managed worktree ${worktree.id} is ${worktree.status || "active"}${worktree.reviewState ? `; review ${worktree.reviewState}` : ""}`,
      metadata: {
        branch: worktree.branch,
        head: worktree.head,
        baseSha: worktree.baseSha,
        ownerId: worktree.ownerId,
        parentRunId: worktree.parentRunId,
        runId: worktree.runId,
        toolCallId: worktree.toolId,
        reviewState: worktree.reviewState,
      },
    });
  }

  for (const changeSet of changeSets) {
    const id = nodeId("change_set", changeSet.id);
    addNode({
      id,
      kind: "change_set",
      ref: changeSet.id,
      status: changeSet.status,
      summary: `ChangeSet ${changeSet.id} is ${changeSet.status}; ${changeSet.changedFiles.length} changed file${changeSet.changedFiles.length === 1 ? "" : "s"}`,
      metadata: {
        worktreeId: changeSet.worktreeId,
        ownerId: changeSet.ownerId,
        parentRunId: changeSet.parentRunId,
        parentTaskId: changeSet.parentTaskId,
        childRunId: changeSet.childRunId,
        toolCallId: changeSet.toolCallId,
        agentName: changeSet.agentName,
        memberName: changeSet.memberName,
        decision: changeSet.decision,
        createdAt: changeSet.createdAt,
        reviewedAt: changeSet.reviewedAt,
        appliedAt: changeSet.appliedAt,
        failedAt: changeSet.failedAt,
        changedFileCount: changeSet.changedFiles.length,
        hasVerificationEvidence: changeSet.verificationEvidence !== undefined,
      },
    });
    const timestamp = Date.parse(changeSet.appliedAt ?? changeSet.failedAt ?? changeSet.reviewedAt ?? changeSet.createdAt);
    const lifecycleEvent = statusEvent("change_set", changeSet.id, changeSet.status, timestamp, id);
    if (lifecycleEvent) addEvent({
      ...lifecycleEvent,
      kind: changeSetLifecycleKind(changeSet.status),
      metadata: {
        status: changeSet.status,
        reviewState: CHANGE_SET_REVIEW_STATUSES.has(changeSet.status) ? "pending" : changeSet.status === "applied" ? "verified" : changeSet.status === "rejected" ? "rejected" : undefined,
        verificationState: changeSet.status === "needs_attention" ? "failed" : changeSet.verificationEvidence !== undefined ? "recorded" : "unavailable",
      },
    });
  }

  const runParents = new Map(runs.filter((run) => run.parentRunId).map((run) => [run.runId, run.parentRunId!]));
  const taskParents = new Map(tasks.filter((task) => task.parentId !== undefined).map((task) => [String(task.id), String(task.parentId)]));
  const agentParents = new Map(teammates.filter((member) => member.parentAgentId).map((member) => [member.id || `teammate:${member.name}`, member.parentAgentId!]));
  const cyclicRuns = cyclicChildren(runParents);
  const cyclicTasks = cyclicChildren(taskParents);
  const cyclicAgents = cyclicChildren(agentParents);

  for (const run of runs) {
    const child = nodeId("run", run.runId);
    if (run.parentRunId) {
      const reason = cyclicRuns.has(run.runId) ? "cycle" : runById.has(run.parentRunId) ? undefined : "missing";
      const parent = reason ? addUnresolved("run", run.parentRunId, reason) : nodeId("run", run.parentRunId);
      addEdge("spawned_by", parent, child, { parentToolCallId: run.parentToolCallId });
    }
    if (run.parentTaskId !== undefined) {
      const task = taskById.has(String(run.parentTaskId))
        ? nodeId("task", run.parentTaskId)
        : addUnresolved("task", run.parentTaskId, "missing");
      addEdge("owns_task", child, task, { relationship: "parent_task" });
    }
    if (run.parentToolCallId) {
      const parentHasTool = run.parentRunId && runById.get(run.parentRunId)?.toolExecutions.some((tool) => tool.toolCallId === run.parentToolCallId);
      if (!parentHasTool) addEdge("spawned_by", addUnresolved("tool_call", run.parentToolCallId, "missing"), child, { relationship: "parent_tool_call" });
    }
  }

  for (const member of teammates) {
    const ref = member.id || `teammate:${member.name}`;
    const agent = nodeId("agent", ref);
    if (member.parentAgentId) {
      const parentMember = agentByRef.get(member.parentAgentId);
      const reason = cyclicAgents.has(ref) ? "cycle" : parentMember ? undefined : "missing";
      const parent = reason ? addUnresolved("agent", member.parentAgentId, reason) : nodeId("agent", parentMember!.id || `teammate:${parentMember!.name}`);
      addEdge("spawned_by", parent, agent, { relationship: "parent_agent" });
    }
    if (member.parentRunId) {
      const parent = runById.has(member.parentRunId)
        ? nodeId("run", member.parentRunId)
        : addUnresolved("run", member.parentRunId, "missing");
      addEdge("spawned_by", parent, agent, { parentToolCallId: member.parentToolCallId });
    }
    if (member.childRunId) {
      const childRun = runById.has(member.childRunId)
        ? nodeId("run", member.childRunId)
        : addUnresolved("run", member.childRunId, "missing");
      addEdge("spawned_by", agent, childRun, { relationship: "agent_execution" });
    }
    if (member.parentTaskId !== undefined) {
      const task = taskById.has(String(member.parentTaskId))
        ? nodeId("task", member.parentTaskId)
        : addUnresolved("task", member.parentTaskId, "missing");
      addEdge("owns_task", agent, task, { relationship: "parent_task" });
    }
    if (member.worktreeId) {
      const worktree = worktreeById.has(member.worktreeId)
        ? nodeId("worktree", member.worktreeId)
        : addUnresolved("worktree", member.worktreeId, "missing");
      addEdge("uses_worktree", agent, worktree);
    }
  }

  for (const task of tasks) {
    const child = nodeId("task", task.id);
    if (task.parentId !== undefined) {
      const reason = cyclicTasks.has(String(task.id)) ? "cycle" : taskById.has(String(task.parentId)) ? undefined : "missing";
      const parent = reason ? addUnresolved("task", task.parentId, reason) : nodeId("task", task.parentId);
      addEdge("owns_task", parent, child, { relationship: "parent_task" });
    }
    if (task.owner) {
      const owner = agentByRef.get(task.owner);
      if (owner) addEdge("owns_task", nodeId("agent", owner.id || `teammate:${owner.name}`), child, { relationship: "owner" });
    }
  }

  for (const worktree of worktrees) {
    const target = nodeId("worktree", worktree.id);
    if (worktree.runId) {
      const run = runById.has(worktree.runId) ? nodeId("run", worktree.runId) : addUnresolved("run", worktree.runId, "missing");
      addEdge("uses_worktree", run, target);
    }
    if (worktree.ownerId) {
      const owner = agentByRef.get(worktree.ownerId);
      if (owner) addEdge("uses_worktree", nodeId("agent", owner.id || `teammate:${owner.name}`), target);
    }
  }

  for (const changeSet of changeSets) {
    const target = nodeId("change_set", changeSet.id);
    const worktree = worktreeById.has(changeSet.worktreeId)
      ? nodeId("worktree", changeSet.worktreeId)
      : addUnresolved("worktree", changeSet.worktreeId, "missing");
    addEdge("produced_change_set", worktree, target);
    if (changeSet.childRunId) {
      const run = runById.has(changeSet.childRunId) ? nodeId("run", changeSet.childRunId) : addUnresolved("run", changeSet.childRunId, "missing");
      addEdge("produced_change_set", run, target);
    }
    const producer = [changeSet.ownerId, changeSet.agentName, changeSet.memberName].find((candidate) => candidate && agentByRef.has(candidate));
    if (producer) {
      const member = agentByRef.get(producer!)!;
      addEdge("produced_change_set", nodeId("agent", member.id || `teammate:${member.name}`), target);
    }
    if (changeSet.decisionActorId) {
      const verifier = agentByRef.get(changeSet.decisionActorId);
      if (verifier) addEdge("verified_by", target, nodeId("agent", verifier.id || `teammate:${verifier.name}`), { decision: changeSet.decision });
    }
  }

  for (const trace of sources.traceEvents ?? []) {
    const targetNode = trace.runId && runById.has(trace.runId)
      ? nodeId("run", trace.runId)
      : trace.agentId && agentByRef.has(trace.agentId)
        ? nodeId("agent", agentByRef.get(trace.agentId)!.id || `teammate:${agentByRef.get(trace.agentId)!.name}`)
        : undefined;
    addEvent({
      id: `event:trace:${safeRef(trace.eventId)}`,
      timestamp: trace.timestamp,
      kind: trace.kind,
      nodeId: targetNode,
      summary: trace.action,
      parentEventId: trace.parentEventId,
      metadata: {
        correlationId: trace.correlationId,
        causationId: trace.causationId,
        runId: trace.runId,
        agentId: trace.agentId,
        requestId: trace.requestId,
        toolCallId: trace.toolCallId,
        evidence: trace.evidence,
        decision: trace.decision,
        ...(trace.metadata ?? {}),
      },
    });
    const changeSetId = typeof trace.metadata?.changeSetId === "string" ? trace.metadata.changeSetId : undefined;
    if ((trace.kind === "validation" || trace.kind === "review") && changeSetId && changeSetById.has(changeSetId) && targetNode) {
      addEdge("verified_by", nodeId("change_set", changeSetId), targetNode, { traceEventId: trace.eventId });
    }
  }

  const childrenByTask = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task.parentId === undefined) continue;
    const children = childrenByTask.get(String(task.parentId)) ?? [];
    children.push(task);
    childrenByTask.set(String(task.parentId), children);
  }
  const childRunsByRun = new Map<string, AgentRunRecord[]>();
  const childRunsByTask = new Map<string, AgentRunRecord[]>();
  for (const run of runs) {
    if (run.parentRunId) {
      const values = childRunsByRun.get(run.parentRunId) ?? [];
      values.push(run);
      childRunsByRun.set(run.parentRunId, values);
    }
    if (run.parentTaskId !== undefined) {
      const values = childRunsByTask.get(String(run.parentTaskId)) ?? [];
      values.push(run);
      childRunsByTask.set(String(run.parentTaskId), values);
    }
  }
  const changeSetsByTask = new Map<string, ChangeSet[]>();
  const changeSetsByRun = new Map<string, ChangeSet[]>();
  for (const changeSet of changeSets) {
    if (changeSet.parentTaskId !== undefined) {
      const values = changeSetsByTask.get(String(changeSet.parentTaskId)) ?? [];
      values.push(changeSet);
      changeSetsByTask.set(String(changeSet.parentTaskId), values);
    }
    for (const runId of [changeSet.parentRunId, changeSet.childRunId]) {
      if (!runId) continue;
      const values = changeSetsByRun.get(runId) ?? [];
      values.push(changeSet);
      changeSetsByRun.set(runId, values);
    }
  }
  const applyAggregate = (id: string, childFacts: readonly { status: string; terminal: boolean; required: boolean }[], relatedChangeSets: readonly ChangeSet[]): void => {
    const target = nodes.get(id);
    if (!target) return;
    const requiredChildren = childFacts.filter((child) => child.required);
    const reasons: ExecutionGraphBlockingReason[] = [];
    if (requiredChildren.some((child) => child.status === "failed")) reasons.push("child_failed");
    else if (requiredChildren.some((child) => !child.terminal)) reasons.push("waiting_on_children");
    if (relatedChangeSets.some((changeSet) => CHANGE_SET_REVIEW_STATUSES.has(changeSet.status))) reasons.push("awaiting_change_set_review");
    if (!reasons.length) return;
    target.blockingReasons = reasons;
    target.aggregateStatus = reasons[0];
  };
  for (const task of tasks) applyAggregate(nodeId("task", task.id), [
    ...(childrenByTask.get(String(task.id)) ?? []).map((child) => ({ status: child.status, terminal: TERMINAL_TASK_STATUSES.has(child.status), required: child.required !== false })),
    ...(childRunsByTask.get(String(task.id)) ?? []).map((child) => ({ status: child.status, terminal: TERMINAL_RUN_STATUSES.has(child.status), required: true })),
  ], changeSetsByTask.get(String(task.id)) ?? []);
  for (const run of runs) applyAggregate(nodeId("run", run.runId), (childRunsByRun.get(run.runId) ?? []).map((child) => ({
    status: child.status,
    terminal: TERMINAL_RUN_STATUSES.has(child.status),
    required: true,
  })), changeSetsByRun.get(run.runId) ?? []);

  const sortedNodes = [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id));
  const sortedEdges = [...edges.values()].sort((left, right) => left.id.localeCompare(right.id));
  const sortedEvents = [...events.values()].sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
  const asOf = sortedEvents.reduce((maximum, event) => Math.max(maximum, event.timestamp), 0);
  const revision = createHash("sha256")
    .update(stableSerialize({ nodes: sortedNodes, edges: sortedEdges, events: sortedEvents }))
    .digest("hex");
  return { schemaVersion: 1, revision, asOf, nodes: sortedNodes, edges: sortedEdges, events: sortedEvents };
}
