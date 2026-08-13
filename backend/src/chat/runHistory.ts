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
import {
  normalizeCompletionEvidence,
  normalizeConversationRunSummary,
  type ConversationRunSummary,
  type ExecutionContractKind,
} from "./history.js";
import type { CompletionEvidence } from "./completionEvidence.js";
import { redactSecrets } from "../agent/secretRedaction.js";
import { TraceStore } from "./traceStore.js";
import { beginCompletionAttempt, CompletionQualityGateError, runRepositoryCompletionGate, type CompletionGateEvidence } from "../extensions/policy/completionGate.js";

const RUNS_DIR_NAME = "runs";
const RUN_FILE_EXTENSION = ".json";
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_STORED_RUNS = 100;
const MAX_STORED_EVENTS = 250;
const MAX_STORED_TOOL_EXECUTIONS = 250;
export const CURRENT_RUN_SCHEMA_VERSION = 3;
const runMutationQueues = new Map<string, Promise<unknown>>();
const activeRunPaths = new Set<string>();

export class RunLineageError extends Error {
  readonly code = "run_lineage_invalid";

  constructor(message: string) {
    super(message);
    this.name = "RunLineageError";
  }
}

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
  parentTaskId?: number;
  parentToolCallId?: string;
  parentRequestId?: string;
  agentName?: string;
}

export interface AgentRunFollowUpBinding {
  feedbackId: string;
  taskId: number;
  deliveryId: string;
  externalId: string;
  headSha: string;
  revision: string;
  changeSetId: string;
  providerConfigId: string;
}

export interface AgentRunRecord {
  /** Persisted-record schema version. Optional for source compatibility with legacy callers. */
  schemaVersion?: number;
  runId: string;
  conversationId: string;
  mode: AgentMode;
  modelName?: string;
  status: AgentRunStatus | "interrupted";
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  resumedFromRunId?: string;
  parentRunId?: string;
  parentTaskId?: number;
  parentToolCallId?: string;
  parentRequestId?: string;
  agentName?: string;
  executionPlanId?: string;
  executionContractKind?: ExecutionContractKind;
  followUp?: AgentRunFollowUpBinding;
  completionEvidence?: CompletionEvidence;
  qualityGate?: CompletionGateEvidence;
  metrics: AgentRunMetrics;
  summary?: ConversationRunSummary;
  events: AgentRunEvent[];
  toolExecutions: AgentToolExecution[];
  /** Durable request-level context provenance references, bounded with run events. */
  contextManifestIds: string[];
}

export interface AgentRunSummary {
  runId: string;
  conversationId: string;
  mode: AgentMode;
  modelName?: string;
  status: AgentRunStatus | "interrupted";
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  resumedFromRunId?: string;
  parentRunId?: string;
  parentTaskId?: number;
  parentToolCallId?: string;
  parentRequestId?: string;
  agentName?: string;
  executionPlanId?: string;
  executionContractKind?: ExecutionContractKind;
  followUp?: AgentRunFollowUpBinding;
  completionEvidence?: CompletionEvidence;
  qualityGate?: CompletionGateEvidence;
  metrics: AgentRunMetrics;
  eventCount: number;
  summary?: ConversationRunSummary;
  contextManifestIds: string[];
  contextManifestCount: number;
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
  // Every persistence and legacy-read path enters here, keeping returned and exported records safe.
  const value = redactSecrets(raw) as Partial<AgentRunRecord>;
  const schemaVersion = normalizeRunSchemaVersion(value.schemaVersion);
  if (schemaVersion === null) return null;
  if (
    typeof value.runId !== "string" ||
    typeof value.conversationId !== "string" ||
    (value.mode !== "ask" && value.mode !== "code" && value.mode !== "review" && value.mode !== "plan") ||
    (value.status !== "queued" && value.status !== "running" && value.status !== "completed" && value.status !== "stopped" && value.status !== "failed" && value.status !== "interrupted")
  ) {
    return null;
  }
  const events = Array.isArray(value.events)
    ? value.events.map(normalizeEvent).filter((event): event is AgentRunEvent => event !== null)
    : [];
  const startedAt = typeof value.startedAt === "number" ? value.startedAt : Date.now();
  const summary = normalizeConversationRunSummary(value.summary);
  const completionEvidence = normalizeCompletionEvidence(value.completionEvidence);
  const qualityGate = value.qualityGate && typeof value.qualityGate === "object" &&
    value.qualityGate.schemaVersion === 1 &&
    ["passed", "passed_with_warnings", "blocked"].includes(value.qualityGate.status) &&
    typeof value.qualityGate.runId === "string" && typeof value.qualityGate.scopeId === "string"
    ? value.qualityGate as CompletionGateEvidence : undefined;
  const toolExecutions = Array.isArray(value.toolExecutions)
    ? value.toolExecutions
        .map(normalizeToolExecution)
        .filter((tool): tool is AgentToolExecution => tool !== null)
        .slice(-MAX_STORED_TOOL_EXECUTIONS)
    : [];
  const contextManifestIds = Array.isArray(value.contextManifestIds)
    ? [...new Set(value.contextManifestIds.filter((item): item is string => typeof item === "string" && /^ctx-[A-Za-z0-9-]+$/.test(item)))].slice(-250)
    : [];
  const followUpValue = value.followUp && typeof value.followUp === "object" ? value.followUp as Partial<AgentRunFollowUpBinding> : undefined;
  const followUp = followUpValue && typeof followUpValue.feedbackId === "string" && Number.isSafeInteger(followUpValue.taskId) && typeof followUpValue.deliveryId === "string" && typeof followUpValue.externalId === "string" && typeof followUpValue.headSha === "string" && typeof followUpValue.revision === "string" && typeof followUpValue.changeSetId === "string" && typeof followUpValue.providerConfigId === "string" ? {
    feedbackId: followUpValue.feedbackId.slice(0, 200),
    taskId: followUpValue.taskId as number,
    deliveryId: followUpValue.deliveryId.slice(0, 200),
    externalId: followUpValue.externalId.slice(0, 500),
    headSha: followUpValue.headSha.slice(0, 160),
    revision: followUpValue.revision.slice(0, 160),
    changeSetId: followUpValue.changeSetId.slice(0, 200),
    providerConfigId: followUpValue.providerConfigId.slice(0, 200),
  } : undefined;
  return {
    schemaVersion,
    runId: value.runId,
    conversationId: value.conversationId,
    mode: value.mode,
    ...(typeof value.modelName === "string" && value.modelName.trim()
      ? { modelName: value.modelName.trim().slice(0, 200) }
      : {}),
    status: value.status,
    startedAt,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : startedAt,
    ...(typeof value.endedAt === "number" ? { endedAt: value.endedAt } : {}),
    ...(typeof value.resumedFromRunId === "string" ? { resumedFromRunId: value.resumedFromRunId } : {}),
    ...(typeof value.parentRunId === "string" && value.parentRunId ? { parentRunId: value.parentRunId } : {}),
    ...(Number.isSafeInteger(value.parentTaskId) && (value.parentTaskId as number) > 0 ? { parentTaskId: value.parentTaskId as number } : {}),
    ...(typeof value.parentToolCallId === "string" && value.parentToolCallId ? { parentToolCallId: value.parentToolCallId } : {}),
    ...(typeof value.parentRequestId === "string" && value.parentRequestId ? { parentRequestId: value.parentRequestId } : {}),
    ...(typeof value.agentName === "string" && value.agentName ? { agentName: value.agentName.slice(0, 160) } : {}),
    ...(typeof value.executionPlanId === "string" && value.executionPlanId
      ? { executionPlanId: value.executionPlanId.slice(0, 160) }
      : {}),
    executionContractKind: value.executionContractKind === "approved_plan" ||
      (!value.executionContractKind && typeof value.executionPlanId === "string" && value.executionPlanId)
      ? "approved_plan"
      : "direct_code",
    ...(followUp ? { followUp } : {}),
    ...(completionEvidence ? { completionEvidence } : {}),
    ...(qualityGate ? { qualityGate } : {}),
    metrics: normalizeMetrics(value.metrics),
    ...(summary ? { summary } : {}),
    events: events.slice(-MAX_STORED_EVENTS),
    toolExecutions,
    contextManifestIds,
  };
}

function normalizeRunSchemaVersion(raw: unknown): number | null {
  if (raw === undefined) return CURRENT_RUN_SCHEMA_VERSION;
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < 1 ||
    raw > CURRENT_RUN_SCHEMA_VERSION
  ) return null;
  return CURRENT_RUN_SCHEMA_VERSION;
}

function normalizeToolExecution(raw: unknown): AgentToolExecution | null {
  if (!raw || typeof raw !== "object") return null;
  const value = redactSecrets(raw) as Partial<AgentToolExecution>;
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
    input: value.input && typeof value.input === "object" ? redactSecrets(value.input) : {},
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

function assertLineageRecord(record: AgentRunRecord, persistedRunId = record.runId): void {
  if (!RUN_ID_PATTERN.test(record.runId) || record.runId !== persistedRunId) {
    throw new RunLineageError("Run lineage node id is invalid or does not match its persisted record");
  }
  if (record.parentRunId && !RUN_ID_PATTERN.test(record.parentRunId)) {
    throw new RunLineageError(`Run lineage parent id is invalid for ${record.runId}`);
  }
}

function storedLineageRecords(workspaceDir: string): Map<string, AgentRunRecord> {
  const directory = getRunsDir(workspaceDir);
  const records = new Map<string, AgentRunRecord>();
  if (!fs.existsSync(directory)) return records;
  for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith(RUN_FILE_EXTENSION))) {
    const runId = name.slice(0, -RUN_FILE_EXTENSION.length);
    if (!RUN_ID_PATTERN.test(runId)) continue;
    try {
      const record = readRunFile(workspaceDir, runId);
      assertLineageRecord(record, runId);
      records.set(record.runId, record);
    } catch (error) {
      if (error instanceof RunLineageError) throw error;
      // Existing compatibility behavior ignores unrelated corrupt run records.
      // A referenced missing record terminates lineage like a pruned ancestor.
    }
  }
  return records;
}

function assertLineageGraph(records: ReadonlyMap<string, AgentRunRecord>): void {
  for (const origin of records.keys()) {
    assertLineageRecord(records.get(origin)!);
    const visited = new Set<string>();
    const chain: string[] = [];
    let cursor: string | undefined = origin;
    while (cursor) {
      if (visited.has(cursor)) {
        throw new RunLineageError(`Run lineage cycle detected: ${[...chain, cursor].join(" -> ")}`);
      }
      visited.add(cursor);
      chain.push(cursor);
      cursor = records.get(cursor)?.parentRunId;
    }
  }
}

function assertStoredLineageGraph(workspaceDir: string): void {
  assertLineageGraph(storedLineageRecords(workspaceDir));
}

function writeRunFile(workspaceDir: string, record: AgentRunRecord): void {
  const normalized = normalizeRecord(record);
  if (!normalized) throw new Error("Run record is invalid");
  assertLineageRecord(normalized);
  const lineage = storedLineageRecords(workspaceDir);
  lineage.set(normalized.runId, normalized);
  assertLineageGraph(lineage);
  normalized.schemaVersion = CURRENT_RUN_SCHEMA_VERSION;
  const directory = ensureRunsDir(workspaceDir);
  const runPath = getRunPath(workspaceDir, normalized.runId);
  const tempPath = path.join(directory, `.${normalized.runId}.tmp`);
  fs.writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
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
  private completionAttemptToken: string | undefined;

  constructor(
    private readonly workspaceDir: string,
    runId: string,
    conversationId: string,
    mode: AgentMode,
    resumedFromRunId?: string,
    lineage?: AgentRunLineage,
    executionPlanId?: string,
    modelName?: string,
    executionContractKind: ExecutionContractKind = executionPlanId ? "approved_plan" : "direct_code"
  ) {
    const now = Date.now();
    this.record = {
      schemaVersion: CURRENT_RUN_SCHEMA_VERSION,
      runId,
      conversationId,
      mode,
      ...(modelName?.trim() ? { modelName: modelName.trim().slice(0, 200) } : {}),
      status: "running",
      startedAt: now,
      updatedAt: now,
      ...(resumedFromRunId ? { resumedFromRunId } : {}),
      ...(lineage?.parentRunId ? { parentRunId: lineage.parentRunId } : {}),
      ...(lineage?.parentTaskId ? { parentTaskId: lineage.parentTaskId } : {}),
      ...(lineage?.parentToolCallId ? { parentToolCallId: lineage.parentToolCallId } : {}),
      ...(lineage?.parentRequestId ? { parentRequestId: lineage.parentRequestId } : {}),
      ...(lineage?.agentName ? { agentName: lineage.agentName.slice(0, 160) } : {}),
      ...(executionPlanId ? { executionPlanId: executionPlanId.slice(0, 160) } : {}),
      ...(executionContractKind ? { executionContractKind } : {}),
      metrics: clone(EMPTY_RUN_METRICS),
      events: [],
      toolExecutions: [],
      contextManifestIds: [],
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

  beginCompletionAttempt(scopeId = `run:${this.record.runId}`): string {
    this.completionAttemptToken = beginCompletionAttempt({ workspaceDir: this.workspaceDir, runId: this.record.runId, scopeId });
    return this.completionAttemptToken;
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
        execution.resultSummary = redactSecrets(input.resultSummary).slice(0, 2000);
      }
      if (input.error !== undefined) execution.error = redactSecrets(input.error).slice(0, 2000);
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
        label: redactSecrets(input.label).slice(0, 120),
        ...(input.requestId ? { requestId: input.requestId } : {}),
        ...(input.toolName ? { toolName: redactSecrets(input.toolName).slice(0, 160) } : {}),
        ...(typeof input.durationMs === "number" ? { durationMs: Math.max(0, input.durationMs) } : {}),
        ...(typeof input.isError === "boolean" ? { isError: input.isError } : {}),
        ...(input.detail ? { detail: redactSecrets(input.detail).slice(0, 500) } : {}),
      };
      record.events = [...record.events, event].slice(-MAX_STORED_EVENTS);
      return record;
    });
  }

  async attachContextManifest(manifestId: string): Promise<AgentRunRecord> {
    if (!/^ctx-[A-Za-z0-9-]+$/.test(manifestId)) throw new Error("Invalid context manifest id");
    return this.mutate((record) => {
      record.contextManifestIds = [...new Set([...(record.contextManifestIds || []), manifestId])].slice(-250);
      return record;
    });
  }

  async finish(
    status: Exclude<AgentRunStatus, "queued" | "running">,
    metricsPatch: Partial<AgentRunMetrics> = {},
    summary?: ConversationRunSummary,
    completionEvidence?: CompletionEvidence,
    suppliedQualityGate?: CompletionGateEvidence
  ): Promise<AgentRunRecord> {
    let effectiveStatus = status;
    let qualityGate: CompletionGateEvidence | undefined = suppliedQualityGate;
    const childRunBlocked = status === "completed" && listDescendantRuns(this.workspaceDir, this.record.runId)
      .some((run) => !isTerminalRunStatus(run.status));
    if (childRunBlocked) effectiveStatus = "failed";
    if (status === "completed" && !childRunBlocked) {
      try {
        const attemptToken = this.completionAttemptToken || this.beginCompletionAttempt();
        qualityGate = await runRepositoryCompletionGate({ workspaceDir: this.workspaceDir, runId: this.record.runId, attemptToken, agentId: this.record.agentName || this.record.mode, conversationId: this.record.conversationId });
      } catch (error) {
        if (!(error instanceof CompletionQualityGateError)) throw error;
        qualityGate = error.evidence;
        effectiveStatus = "failed";
      }
    }
    const evidenceBlockers = [
      ...(completionEvidence?.ledger.blockers || []),
      ...(childRunBlocked ? ["childRun" as const] : []),
      ...(qualityGate?.status === "blocked" ? ["quality" as const] : []),
    ];
    const effectiveCompletionEvidence = completionEvidence && (childRunBlocked || qualityGate?.status === "blocked")
      ? { ...completionEvidence, outcome: qualityGate?.status === "blocked" ? "failed" as const : "needs_attention" as const, ledger: { ...completionEvidence.ledger, blockers: [...new Set(evidenceBlockers)] } }
      : completionEvidence;
    const effectiveSummary = qualityGate ? { ...(summary || { changedFiles: [], toolCallCount: 0, errorCount: 0, commandCount: 0 }), qualityGate, ...(effectiveCompletionEvidence ? { completionEvidence: effectiveCompletionEvidence } : {}) } : summary;
    try {
      return await this.mutate((record) => {
        const endedAt = Date.now();
        record.status = effectiveStatus;
        if (qualityGate) record.qualityGate = redactSecrets(clone(qualityGate));
        record.endedAt = endedAt;
        record.metrics = {
          ...record.metrics,
          ...metricsPatch,
          durationMs: endedAt - record.startedAt,
        };
        if (effectiveSummary) record.summary = redactSecrets(clone(effectiveCompletionEvidence
          ? { ...effectiveSummary, completionEvidence: effectiveCompletionEvidence }
          : effectiveSummary));
        if (effectiveCompletionEvidence) record.completionEvidence = redactSecrets(clone(effectiveCompletionEvidence));
        interruptNonterminalTools(record, endedAt);
        record.events = [
          ...record.events,
          {
            id: createRunEventId(),
            timestamp: endedAt,
            kind: "run_finished" as const,
            label:
              effectiveStatus === "completed"
                ? "Agent run completed"
                : effectiveStatus === "stopped"
                  ? "Agent run stopped"
                  : "Agent run failed",
            isError: effectiveStatus === "failed",
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
      mutation(persisted);
      const normalized = normalizeRecord(persisted);
      if (!normalized) throw new Error("Run record is invalid");
      this.record = normalized;
      writeRunFile(this.workspaceDir, normalized);
      this.appendTrace(normalized);
      pruneRunHistory(this.workspaceDir);
      return clone(normalized) as T;
    });
  }

  private appendTrace(record: AgentRunRecord): void {
    try {
      const event = record.events.at(-1);
      if (!event) return;
      new TraceStore(this.workspaceDir).append({
        kind: event.kind === "error" ? "error" : event.kind.startsWith("tool_") ? "tool" : event.kind.startsWith("model_") ? "model" : "run",
        action: event.label,
        correlationId: record.runId,
        causationId: event.requestId,
        runId: record.runId,
        conversationId: record.conversationId,
        requestId: event.requestId,
        evidence: event.detail,
        metadata: { eventKind: event.kind, isError: event.isError, toolName: event.toolName },
      });
    } catch { /* telemetry must not break the agent caller */ }
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
    ...(record.modelName ? { modelName: record.modelName } : {}),
    status: record.status,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.endedAt ? { endedAt: record.endedAt } : {}),
    ...(record.resumedFromRunId ? { resumedFromRunId: record.resumedFromRunId } : {}),
    ...(record.parentRunId ? { parentRunId: record.parentRunId } : {}),
    ...(record.parentTaskId ? { parentTaskId: record.parentTaskId } : {}),
    ...(record.parentToolCallId ? { parentToolCallId: record.parentToolCallId } : {}),
    ...(record.parentRequestId ? { parentRequestId: record.parentRequestId } : {}),
    ...(record.agentName ? { agentName: record.agentName } : {}),
    ...(record.executionPlanId ? { executionPlanId: record.executionPlanId } : {}),
    ...(record.executionContractKind ? { executionContractKind: record.executionContractKind } : {}),
    ...(record.followUp ? { followUp: record.followUp } : {}),
    ...(record.completionEvidence ? { completionEvidence: record.completionEvidence } : {}),
    ...(record.qualityGate ? { qualityGate: record.qualityGate } : {}),
    metrics: record.metrics,
    eventCount: record.events.length,
    ...(record.summary ? { summary: record.summary } : {}),
    contextManifestIds: [...record.contextManifestIds],
    contextManifestCount: record.contextManifestIds.length,
  }));
}

export function listRunRecords(workspaceDir: string): AgentRunRecord[] {
  const directory = ensureRunsDir(workspaceDir);
  assertStoredLineageGraph(workspaceDir);
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(RUN_FILE_EXTENSION))
    .map((name) => name.slice(0, -RUN_FILE_EXTENSION.length))
    .map((runId) => {
      try {
        return readRunRecord(workspaceDir, runId);
      } catch (error) {
        if (error instanceof RunLineageError) throw error;
        return null;
      }
    })
    .filter((record): record is AgentRunRecord => record !== null)
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export function hasActiveRunForConversation(
  workspaceDir: string,
  conversationId: string
): boolean {
  return listRunRecords(workspaceDir).some(
    (record) =>
      record.conversationId === conversationId &&
      activeRunPaths.has(getRunPath(workspaceDir, record.runId))
  );
}

export function readRunRecord(workspaceDir: string, runId: string): AgentRunRecord {
  assertStoredLineageGraph(workspaceDir);
  const record = readRunFile(workspaceDir, runId);
  const runPath = getRunPath(workspaceDir, runId);
  if (record.status === "running" && !activeRunPaths.has(runPath)) {
    const timestamp = Date.now();
    interruptNonterminalTools(record, timestamp);
    record.status = "interrupted";
    record.endedAt = timestamp;
    record.updatedAt = timestamp;
    record.metrics.durationMs = Math.max(0, timestamp - record.startedAt);
    record.events = [...record.events, {
      id: createRunEventId(), timestamp, kind: "run_finished" as const,
      label: "Agent run interrupted after orphan recovery", isError: true,
    }].slice(-MAX_STORED_EVENTS);
    writeRunFile(workspaceDir, record);
    try { new TraceStore(workspaceDir).append({ kind: "run", action: "Run interrupted after orphan recovery", correlationId: record.runId, runId: record.runId, conversationId: record.conversationId, decision: "interrupted" }); } catch { /* best effort */ }
  }
  return clone(record);
}

/** Explicitly resolves an orphan-recovered run; active in-process runs cannot be rewritten. */
export function terminalizeInterruptedRun(
  workspaceDir: string,
  runId: string,
  status: "stopped" | "failed"
): AgentRunRecord {
  const record = readRunRecord(workspaceDir, runId);
  if (record.status !== "interrupted") return record;
  const timestamp = Date.now();
  record.status = status;
  record.endedAt = timestamp;
  record.updatedAt = timestamp;
  record.events = [...record.events, { id: createRunEventId(), timestamp, kind: "run_finished" as const, label: status === "stopped" ? "Interrupted run explicitly stopped" : "Interrupted run marked failed", isError: status === "failed" }].slice(-MAX_STORED_EVENTS);
  writeRunFile(workspaceDir, record);
  return clone(record);
}

export function createQueuedFollowUpRun(
  workspaceDir: string,
  input: {
    runId: string;
    conversationId: string;
    executionPlanId?: string;
    parentRunId: string;
    binding: AgentRunFollowUpBinding;
  }
): AgentRunRecord {
  const existingPath = getRunPath(workspaceDir, input.runId);
  if (fs.existsSync(existingPath)) {
    const existing = readRunFile(workspaceDir, input.runId);
    if (existing.status !== "queued" || existing.parentRunId !== input.parentRunId || existing.followUp?.feedbackId !== input.binding.feedbackId) throw new Error("Follow-up run id is already bound to different work");
    return clone(existing);
  }
  const now = Date.now();
  const record: AgentRunRecord = {
    schemaVersion: CURRENT_RUN_SCHEMA_VERSION,
    runId: input.runId,
    conversationId: input.conversationId,
    mode: "code",
    status: "queued",
    startedAt: now,
    updatedAt: now,
    parentRunId: input.parentRunId,
    agentName: "delivery-follow-up",
    ...(input.executionPlanId ? { executionPlanId: input.executionPlanId } : {}),
    executionContractKind: input.executionPlanId ? "approved_plan" : "direct_code",
    followUp: input.binding,
    metrics: { ...EMPTY_RUN_METRICS },
    events: [],
    toolExecutions: [],
    contextManifestIds: [],
  };
  writeRunFile(workspaceDir, record);
  pruneRunHistory(workspaceDir);
  try { new TraceStore(workspaceDir).append({ kind: "run", action: "Follow-up run queued after explicit approval", correlationId: record.runId, causationId: input.binding.feedbackId, runId: record.runId, conversationId: record.conversationId, decision: "queued", metadata: { taskId: input.binding.taskId, deliveryId: input.binding.deliveryId, changeSetId: input.binding.changeSetId, revision: input.binding.revision } }); } catch { /* telemetry must not break persisted approval */ }
  return clone(record);
}

export function findLatestResumableRun(
  workspaceDir: string,
  conversationId: string
): AgentRunRecord | null {
  const candidate = listRunSummaries(workspaceDir, conversationId).find(
    (run) =>
      !run.parentRunId &&
      (run.status === "interrupted" || run.status === "stopped" || run.status === "failed")
  );
  return candidate ? readRunRecord(workspaceDir, candidate.runId) : null;
}

export function listChildRuns(
  workspaceDir: string,
  parentRunId: string
): AgentRunSummary[] {
  return listRunSummaries(workspaceDir).filter((run) => run.parentRunId === parentRunId);
}

export function listDescendantRuns(workspaceDir: string, parentRunId: string): AgentRunSummary[] {
  const all = listRunSummaries(workspaceDir);
  const descendants: AgentRunSummary[] = [];
  const pending = [parentRunId];
  const visited = new Set(pending);
  while (pending.length) {
    const current = pending.shift()!;
    for (const candidate of all) {
      if (candidate.parentRunId !== current || visited.has(candidate.runId)) continue;
      visited.add(candidate.runId);
      descendants.push(candidate);
      pending.push(candidate.runId);
    }
  }
  return descendants;
}

export function isTerminalRunStatus(status: AgentRunSummary["status"]): boolean {
  return status === "completed" || status === "stopped" || status === "failed";
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
    const serialized = JSON.stringify(redactSecrets(input));
    if (serialized.length <= 20_000) {
      return JSON.parse(serialized) as Record<string, unknown>;
    }
    return { _truncated: serialized.slice(0, 20_000) };
  } catch {
    return { _unserializable: true };
  }
}
