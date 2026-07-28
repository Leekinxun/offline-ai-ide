import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type {
  AgentMode,
  AgentRunEvent,
  AgentRunEventKind,
  AgentRunMetrics,
  AgentRunStatus,
} from "../agent/types.js";
import { normalizeConversationRunSummary, type ConversationRunSummary } from "./history.js";

const RUNS_DIR_NAME = "runs";
const RUN_FILE_EXTENSION = ".json";
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_STORED_RUNS = 100;
const MAX_STORED_EVENTS = 250;
const MAX_STORED_TOOL_EXECUTIONS = 250;
const runMutationQueues = new Map<string, Promise<unknown>>();
const activeRunPaths = new Set<string>();

export type AgentToolExecutionStatus =
  | "pending"
  | "awaiting_permission"
  | "running"
  | "completed"
  | "failed"
  | "denied"
  | "interrupted";

export interface AgentToolExecution {
  toolCallId: string;
  requestId: string;
  name: string;
  input: Record<string, unknown>;
  status: AgentToolExecutionStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  endedAt?: number;
  resultSummary?: string;
  error?: string;
  snapshotId?: string;
}

export const RESUME_PROMPT =
  "Continue the interrupted task from the last recorded state. Do not repeat completed steps; inspect the current workspace and resume from the next step.";

export interface AgentRunLineage {
  parentRunId: string;
  parentToolCallId?: string;
  parentRequestId?: string;
  agentName?: string;
}

export interface AgentRunRecord {
  runId: string;
  conversationId: string;
  mode: AgentMode;
  status: AgentRunStatus;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  resumedFromRunId?: string;
  parentRunId?: string;
  parentToolCallId?: string;
  parentRequestId?: string;
  agentName?: string;
  metrics: AgentRunMetrics;
  summary?: ConversationRunSummary;
  events: AgentRunEvent[];
  toolExecutions: AgentToolExecution[];
}

export interface AgentRunSummary {
  runId: string;
  conversationId: string;
  mode: AgentMode;
  status: AgentRunStatus;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  resumedFromRunId?: string;
  parentRunId?: string;
  parentToolCallId?: string;
  parentRequestId?: string;
  agentName?: string;
  metrics: AgentRunMetrics;
  eventCount: number;
  summary?: ConversationRunSummary;
}

export interface AgentRunEventInput {
  kind: AgentRunEventKind;
  label: string;
  requestId?: string;
  toolName?: string;
  durationMs?: number;
  isError?: boolean;
  detail?: string;
}

export const EMPTY_RUN_METRICS: AgentRunMetrics = {
  iterations: 0,
  modelCalls: 0,
  toolCalls: 0,
  toolErrors: 0,
  modelErrors: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  estimatedCostUsd: 0,
  estimatedTokensPeak: 0,
  compactionCount: 0,
};

export function createRunId(): string {
  return `${Date.now()}-${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

export function getRunsDir(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), ".history", RUNS_DIR_NAME);
}

function getRunPath(workspaceDir: string, runId: string): string {
  const normalized = runId.trim();
  if (!RUN_ID_PATTERN.test(normalized)) {
    throw new Error("Invalid run id");
  }
  return path.join(getRunsDir(workspaceDir), `${normalized}${RUN_FILE_EXTENSION}`);
}

function ensureRunsDir(workspaceDir: string): string {
  const directory = getRunsDir(workspaceDir);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeMetrics(raw: unknown): AgentRunMetrics {
  const value = raw && typeof raw === "object" ? (raw as Partial<AgentRunMetrics>) : {};
  const metric = (key: keyof AgentRunMetrics): number =>
    typeof value[key] === "number" && Number.isFinite(value[key])
      ? Math.max(0, value[key] as number)
      : 0;
  return {
    iterations: metric("iterations"),
    modelCalls: metric("modelCalls"),
    toolCalls: metric("toolCalls"),
    toolErrors: metric("toolErrors"),
    modelErrors: metric("modelErrors"),
    promptTokens: metric("promptTokens"),
    completionTokens: metric("completionTokens"),
    totalTokens: metric("totalTokens"),
    estimatedCostUsd: metric("estimatedCostUsd"),
    estimatedTokensPeak: metric("estimatedTokensPeak"),
    compactionCount: metric("compactionCount"),
    ...(typeof value.durationMs === "number" && Number.isFinite(value.durationMs)
      ? { durationMs: Math.max(0, value.durationMs) }
      : {}),
  };
}

function normalizeEvent(raw: unknown): AgentRunEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<AgentRunEvent>;
  const kinds: AgentRunEventKind[] = [
    "run_started",
    "model_call",
    "model_response",
    "tool_call",
    "tool_result",
    "context_compacted",
    "steering",
    "error",
    "run_finished",
  ];
  if (
    typeof value.id !== "string" ||
    typeof value.timestamp !== "number" ||
    !kinds.includes(value.kind as AgentRunEventKind) ||
    typeof value.label !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    timestamp: value.timestamp,
    kind: value.kind as AgentRunEventKind,
    label: value.label.slice(0, 120),
    ...(typeof value.requestId === "string" ? { requestId: value.requestId } : {}),
    ...(typeof value.toolName === "string" ? { toolName: value.toolName.slice(0, 160) } : {}),
    ...(typeof value.durationMs === "number" ? { durationMs: Math.max(0, value.durationMs) } : {}),
    ...(typeof value.isError === "boolean" ? { isError: value.isError } : {}),
    ...(typeof value.detail === "string" ? { detail: value.detail.slice(0, 500) } : {}),
  };
}

function normalizeRecord(raw: unknown): AgentRunRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<AgentRunRecord>;
  if (
    typeof value.runId !== "string" ||
    typeof value.conversationId !== "string" ||
    (value.mode !== "ask" && value.mode !== "code" && value.mode !== "review" && value.mode !== "plan") ||
    (value.status !== "queued" && value.status !== "running" && value.status !== "completed" && value.status !== "stopped" && value.status !== "failed")
  ) {
    return null;
  }
  const events = Array.isArray(value.events)
    ? value.events.map(normalizeEvent).filter((event): event is AgentRunEvent => event !== null)
    : [];
  const startedAt = typeof value.startedAt === "number" ? value.startedAt : Date.now();
  const summary = normalizeConversationRunSummary(value.summary);
  const toolExecutions = Array.isArray(value.toolExecutions)
    ? value.toolExecutions
        .map(normalizeToolExecution)
        .filter((tool): tool is AgentToolExecution => tool !== null)
        .slice(-MAX_STORED_TOOL_EXECUTIONS)
    : [];
  return {
    runId: value.runId,
    conversationId: value.conversationId,
    mode: value.mode,
    status: value.status,
    startedAt,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : startedAt,
    ...(typeof value.endedAt === "number" ? { endedAt: value.endedAt } : {}),
    ...(typeof value.resumedFromRunId === "string" ? { resumedFromRunId: value.resumedFromRunId } : {}),
    ...(typeof value.parentRunId === "string" && value.parentRunId ? { parentRunId: value.parentRunId } : {}),
    ...(typeof value.parentToolCallId === "string" && value.parentToolCallId ? { parentToolCallId: value.parentToolCallId } : {}),
    ...(typeof value.parentRequestId === "string" && value.parentRequestId ? { parentRequestId: value.parentRequestId } : {}),
    ...(typeof value.agentName === "string" && value.agentName ? { agentName: value.agentName.slice(0, 160) } : {}),
    metrics: normalizeMetrics(value.metrics),
    ...(summary ? { summary } : {}),
    events: events.slice(-MAX_STORED_EVENTS),
    toolExecutions,
  };
}

function normalizeToolExecution(raw: unknown): AgentToolExecution | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<AgentToolExecution>;
  const statuses: AgentToolExecutionStatus[] = [
    "pending",
    "awaiting_permission",
    "running",
    "completed",
    "failed",
    "denied",
    "interrupted",
  ];
  if (
    typeof value.toolCallId !== "string" ||
    typeof value.requestId !== "string" ||
    typeof value.name !== "string" ||
    !statuses.includes(value.status as AgentToolExecutionStatus)
  ) return null;
  const createdAt = typeof value.createdAt === "number" ? value.createdAt : Date.now();
  return {
    toolCallId: value.toolCallId,
    requestId: value.requestId,
    name: value.name.slice(0, 160),
    input: value.input && typeof value.input === "object" ? value.input : {},
    status: value.status as AgentToolExecutionStatus,
    createdAt,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : createdAt,
    ...(typeof value.startedAt === "number" ? { startedAt: value.startedAt } : {}),
    ...(typeof value.endedAt === "number" ? { endedAt: value.endedAt } : {}),
    ...(typeof value.resultSummary === "string" ? { resultSummary: value.resultSummary.slice(0, 2000) } : {}),
    ...(typeof value.error === "string" ? { error: value.error.slice(0, 2000) } : {}),
    ...(typeof value.snapshotId === "string" ? { snapshotId: value.snapshotId.slice(0, 120) } : {}),
  };
}

function readRunFile(workspaceDir: string, runId: string): AgentRunRecord {
  const runPath = getRunPath(workspaceDir, runId);
  if (!fs.existsSync(runPath)) throw new Error("Run not found");
  const parsed = normalizeRecord(JSON.parse(fs.readFileSync(runPath, "utf8")));
  if (!parsed) throw new Error("Run record is invalid");
  return parsed;
}

function writeRunFile(workspaceDir: string, record: AgentRunRecord): void {
  const directory = ensureRunsDir(workspaceDir);
  const runPath = getRunPath(workspaceDir, record.runId);
  const tempPath = path.join(directory, `.${record.runId}.tmp`);
  fs.writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, runPath);
}

function queueRunMutation<T>(
  workspaceDir: string,
  runId: string,
  mutation: () => T
): Promise<T> {
  const runPath = getRunPath(workspaceDir, runId);
  const previous = runMutationQueues.get(runPath) || Promise.resolve();
  const next = previous.catch(() => undefined).then(mutation);
  const wrapped = next.finally(() => {
    if (runMutationQueues.get(runPath) === wrapped) runMutationQueues.delete(runPath);
  });
  runMutationQueues.set(runPath, wrapped);
  return wrapped as Promise<T>;
}

export class AgentRunRecorder {
  private record: AgentRunRecord;

  constructor(
    private readonly workspaceDir: string,
    runId: string,
    conversationId: string,
    mode: AgentMode,
    resumedFromRunId?: string,
    lineage?: AgentRunLineage
  ) {
    const now = Date.now();
    this.record = {
      runId,
      conversationId,
      mode,
      status: "running",
      startedAt: now,
      updatedAt: now,
      ...(resumedFromRunId ? { resumedFromRunId } : {}),
      ...(lineage?.parentRunId ? { parentRunId: lineage.parentRunId } : {}),
      ...(lineage?.parentToolCallId ? { parentToolCallId: lineage.parentToolCallId } : {}),
      ...(lineage?.parentRequestId ? { parentRequestId: lineage.parentRequestId } : {}),
      ...(lineage?.agentName ? { agentName: lineage.agentName.slice(0, 160) } : {}),
      metrics: clone(EMPTY_RUN_METRICS),
      events: [],
      toolExecutions: [],
    };
  }

  get runId(): string {
    return this.record.runId;
  }

  get conversationId(): string {
    return this.record.conversationId;
  }

  snapshot(): AgentRunRecord {
    return clone(this.record);
  }

  async start(): Promise<AgentRunRecord> {
    activeRunPaths.add(getRunPath(this.workspaceDir, this.record.runId));
    try {
      return await this.mutate((record) => {
        record.events.push({
          id: createRunEventId(),
          timestamp: Date.now(),
          kind: "run_started",
          label: "Agent run started",
        });
        return record;
      });
    } catch (error) {
      activeRunPaths.delete(getRunPath(this.workspaceDir, this.record.runId));
      throw error;
    }
  }

  async toolState(input: {
    toolCallId: string;
    requestId: string;
    name: string;
    toolInput?: Record<string, unknown>;
    status: AgentToolExecutionStatus;
    resultSummary?: string;
    error?: string;
    snapshotId?: string;
  }): Promise<AgentRunRecord> {
    return this.mutate((record) => {
      const now = Date.now();
      const existing = record.toolExecutions.find(
        (tool) =>
          tool.toolCallId === input.toolCallId && tool.requestId === input.requestId
      );
      const execution: AgentToolExecution = existing || {
        toolCallId: input.toolCallId,
        requestId: input.requestId,
        name: input.name,
        input: sanitizeToolInput(input.toolInput || {}),
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
      execution.status = input.status;
      execution.updatedAt = now;
      if (input.status === "running" && !execution.startedAt) execution.startedAt = now;
      if (["completed", "failed", "denied", "interrupted"].includes(input.status)) {
        execution.endedAt = now;
      }
      if (input.resultSummary !== undefined) {
        execution.resultSummary = input.resultSummary.slice(0, 2000);
      }
      if (input.error !== undefined) execution.error = input.error.slice(0, 2000);
      if (input.snapshotId !== undefined) execution.snapshotId = input.snapshotId.slice(0, 120);
      if (!existing) record.toolExecutions.push(execution);
      record.toolExecutions = record.toolExecutions.slice(-MAX_STORED_TOOL_EXECUTIONS);
      return record;
    });
  }

  async event(
    input: AgentRunEventInput,
    metricsPatch: Partial<AgentRunMetrics> = {}
  ): Promise<AgentRunRecord> {
    return this.mutate((record) => {
      record.metrics = {
        ...record.metrics,
        ...metricsPatch,
      };
      const event: AgentRunEvent = {
        id: createRunEventId(),
        timestamp: Date.now(),
        kind: input.kind,
        label: input.label.slice(0, 120),
        ...(input.requestId ? { requestId: input.requestId } : {}),
        ...(input.toolName ? { toolName: input.toolName.slice(0, 160) } : {}),
        ...(typeof input.durationMs === "number" ? { durationMs: Math.max(0, input.durationMs) } : {}),
        ...(typeof input.isError === "boolean" ? { isError: input.isError } : {}),
        ...(input.detail ? { detail: input.detail.slice(0, 500) } : {}),
      };
      record.events = [...record.events, event].slice(-MAX_STORED_EVENTS);
      return record;
    });
  }

  async finish(
    status: Exclude<AgentRunStatus, "queued" | "running">,
    metricsPatch: Partial<AgentRunMetrics> = {},
    summary?: ConversationRunSummary
  ): Promise<AgentRunRecord> {
    try {
      return await this.mutate((record) => {
        const endedAt = Date.now();
        record.status = status;
        record.endedAt = endedAt;
        record.metrics = {
          ...record.metrics,
          ...metricsPatch,
          durationMs: endedAt - record.startedAt,
        };
        if (summary) record.summary = clone(summary);
        interruptNonterminalTools(record, endedAt);
        record.events = [
          ...record.events,
          {
            id: createRunEventId(),
            timestamp: endedAt,
            kind: "run_finished" as const,
            label:
              status === "completed"
                ? "Agent run completed"
                : status === "stopped"
                  ? "Agent run stopped"
                  : "Agent run failed",
            isError: status === "failed",
          },
        ].slice(-MAX_STORED_EVENTS);
        return record;
      });
    } finally {
      activeRunPaths.delete(getRunPath(this.workspaceDir, this.record.runId));
    }
  }

  private mutate<T>(mutation: (record: AgentRunRecord) => T): Promise<T> {
    return queueRunMutation(this.workspaceDir, this.record.runId, () => {
      const persisted = fs.existsSync(getRunPath(this.workspaceDir, this.record.runId))
        ? readRunFile(this.workspaceDir, this.record.runId)
        : this.record;
      const result = mutation(persisted);
      this.record = persisted;
      writeRunFile(this.workspaceDir, persisted);
      pruneRunHistory(this.workspaceDir);
      return clone(result);
    });
  }
}

function createRunEventId(): string {
  return `${Date.now()}-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

export function listRunSummaries(
  workspaceDir: string,
  conversationId?: string
): AgentRunSummary[] {
  const records = listRunRecords(workspaceDir)
    .filter((record) => !conversationId || record.conversationId === conversationId)
    .sort((left, right) => right.updatedAt - left.updatedAt);

  return records.map((record) => ({
    runId: record.runId,
    conversationId: record.conversationId,
    mode: record.mode,
    status: record.status,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.endedAt ? { endedAt: record.endedAt } : {}),
    ...(record.resumedFromRunId ? { resumedFromRunId: record.resumedFromRunId } : {}),
    ...(record.parentRunId ? { parentRunId: record.parentRunId } : {}),
    ...(record.parentToolCallId ? { parentToolCallId: record.parentToolCallId } : {}),
    ...(record.parentRequestId ? { parentRequestId: record.parentRequestId } : {}),
    ...(record.agentName ? { agentName: record.agentName } : {}),
    metrics: record.metrics,
    eventCount: record.events.length,
    ...(record.summary ? { summary: record.summary } : {}),
  }));
}

export function listRunRecords(workspaceDir: string): AgentRunRecord[] {
  const directory = ensureRunsDir(workspaceDir);
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(RUN_FILE_EXTENSION))
    .map((name) => name.slice(0, -RUN_FILE_EXTENSION.length))
    .map((runId) => {
      try {
        return readRunRecord(workspaceDir, runId);
      } catch {
        return null;
      }
    })
    .filter((record): record is AgentRunRecord => record !== null)
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export function readRunRecord(workspaceDir: string, runId: string): AgentRunRecord {
  const record = readRunFile(workspaceDir, runId);
  const runPath = getRunPath(workspaceDir, runId);
  if (record.status === "running" && !activeRunPaths.has(runPath)) {
    const changed = interruptNonterminalTools(record, Date.now());
    if (changed) writeRunFile(workspaceDir, record);
  }
  return clone(record);
}

export function findLatestResumableRun(
  workspaceDir: string,
  conversationId: string
): AgentRunRecord | null {
  const candidate = listRunSummaries(workspaceDir, conversationId).find(
    (run) =>
      !run.parentRunId &&
      (run.status === "running" || run.status === "stopped" || run.status === "failed")
  );
  return candidate ? readRunRecord(workspaceDir, candidate.runId) : null;
}

export function listChildRuns(
  workspaceDir: string,
  parentRunId: string
): AgentRunSummary[] {
  return listRunSummaries(workspaceDir).filter((run) => run.parentRunId === parentRunId);
}

function pruneRunHistory(workspaceDir: string): void {
  const directory = ensureRunsDir(workspaceDir);
  const files = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(RUN_FILE_EXTENSION))
    .map((name) => {
      const fullPath = path.join(directory, name);
      return { fullPath, updatedAt: fs.statSync(fullPath).mtimeMs };
    })
    .sort((left, right) => right.updatedAt - left.updatedAt);
  for (const entry of files.slice(MAX_STORED_RUNS)) fs.rmSync(entry.fullPath, { force: true });
}

function interruptNonterminalTools(record: AgentRunRecord, timestamp: number): boolean {
  let changed = false;
  for (const tool of record.toolExecutions) {
    if (["pending", "awaiting_permission", "running"].includes(tool.status)) {
      tool.status = "interrupted";
      tool.updatedAt = timestamp;
      tool.endedAt = timestamp;
      tool.error ||= "Tool execution was interrupted before a terminal result was recorded";
      changed = true;
    }
  }
  return changed;
}

function sanitizeToolInput(input: Record<string, unknown>): Record<string, unknown> {
  try {
    const serialized = JSON.stringify(input, (key, value) =>
      /(?:password|secret|token|api[_-]?key|authorization|cookie)/i.test(key)
        ? "[REDACTED]"
        : value
    );
    if (serialized.length <= 20_000) {
      return JSON.parse(serialized) as Record<string, unknown>;
    }
    return { _truncated: serialized.slice(0, 20_000) };
  } catch {
    return { _unserializable: true };
  }
}
