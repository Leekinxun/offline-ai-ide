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
const runMutationQueues = new Map<string, Promise<unknown>>();

export const RESUME_PROMPT =
  "Continue the interrupted task from the last recorded state. Do not repeat completed steps; inspect the current workspace and resume from the next step.";

export interface AgentRunRecord {
  runId: string;
  conversationId: string;
  mode: AgentMode;
  status: AgentRunStatus;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  resumedFromRunId?: string;
  metrics: AgentRunMetrics;
  summary?: ConversationRunSummary;
  events: AgentRunEvent[];
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
  return {
    runId: value.runId,
    conversationId: value.conversationId,
    mode: value.mode,
    status: value.status,
    startedAt,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : startedAt,
    ...(typeof value.endedAt === "number" ? { endedAt: value.endedAt } : {}),
    ...(typeof value.resumedFromRunId === "string" ? { resumedFromRunId: value.resumedFromRunId } : {}),
    metrics: normalizeMetrics(value.metrics),
    ...(summary ? { summary } : {}),
    events: events.slice(-MAX_STORED_EVENTS),
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
    resumedFromRunId?: string
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
      metrics: clone(EMPTY_RUN_METRICS),
      events: [],
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
    return this.mutate((record) => {
      record.events.push({
        id: createRunEventId(),
        timestamp: Date.now(),
        kind: "run_started",
        label: "Agent run started",
      });
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
    return this.mutate((record) => {
      const endedAt = Date.now();
      record.status = status;
      record.endedAt = endedAt;
      record.metrics = {
        ...record.metrics,
        ...metricsPatch,
        durationMs: endedAt - record.startedAt,
      };
      if (summary) record.summary = clone(summary);
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
        return readRunFile(workspaceDir, runId);
      } catch {
        return null;
      }
    })
    .filter((record): record is AgentRunRecord => record !== null)
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export function readRunRecord(workspaceDir: string, runId: string): AgentRunRecord {
  return clone(readRunFile(workspaceDir, runId));
}

export function findLatestResumableRun(
  workspaceDir: string,
  conversationId: string
): AgentRunRecord | null {
  const candidate = listRunSummaries(workspaceDir, conversationId).find(
    (run) => run.status === "running" || run.status === "stopped" || run.status === "failed"
  );
  return candidate ? readRunRecord(workspaceDir, candidate.runId) : null;
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
