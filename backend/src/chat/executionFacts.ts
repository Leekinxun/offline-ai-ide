import crypto from "node:crypto";
import path from "node:path";
import { redactSecrets } from "../agent/secretRedaction.js";

const MAX_FACTS = 10_000;
const MAX_READ_RANGES = 5_000;
const digest = (value: string) => `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;

export interface FileReadFact {
  path: string;
  version: string;
  start: number;
  end: number;
  complete: boolean;
  count: number;
  firstToolCallId: string;
  lastToolCallId: string;
}

export interface ExecutionFactsSummary {
  schemaVersion: 1;
  completeness: "complete" | "unknown";
  toolCalls: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  deniedToolCalls: number;
  fileReads: number;
  duplicateFileReads: number;
  pagedFileReads: number;
  updatedFileReads: number;
  unclassifiedFileReads: number;
  readRanges: FileReadFact[];
  compactions: {
    summaryCount: number;
    fallbackTrimCount: number;
    failedCount: number;
    last?: { outcome: "summary" | "fallback_trim" | "failed"; tokensBefore?: number; tokensAfter?: number };
  };
}

/** Counters are independent of the bounded tool/event history. IDs make recording idempotent. */
export interface ExecutionFacts extends ExecutionFactsSummary {
  observedFactIds: string[];
}

export type ExecutionFactInput = {
  kind: "tool_result";
  requestId: string;
  toolCallId: string;
  toolName: string;
  /** Distinct dispatches may reuse a provider tool ID. Replayed receipts reuse this ID. */
  executionId?: string;
  /** Supply the complete result before the display/history character limits. */
  output: string;
  isError: boolean;
  denied?: boolean;
} | {
  kind: "compaction";
  attemptId: string;
  outcome: "summary" | "fallback_trim" | "failed";
  tokensBefore?: number;
  tokensAfter?: number;
};

export function createExecutionFacts(completeness: ExecutionFacts["completeness"] = "complete"): ExecutionFacts {
  return {
    schemaVersion: 1, completeness,
    toolCalls: 0, successfulToolCalls: 0, failedToolCalls: 0, deniedToolCalls: 0,
    fileReads: 0, duplicateFileReads: 0, pagedFileReads: 0, updatedFileReads: 0, unclassifiedFileReads: 0,
    readRanges: [], compactions: { summaryCount: 0, fallbackTrimCount: 0, failedCount: 0 }, observedFactIds: [],
  };
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBinaryMetadata(output: string): boolean {
  try {
    const value: unknown = JSON.parse(output);
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const metadata = value as Record<string, unknown>;
    return typeof metadata.path === "string" && metadata.path.length > 0
      && metadata.read_only === true && metadata.content_kind === "binary" && metadata.inspection_only === true
      && integer(metadata.size_bytes) && typeof metadata.sha256 === "string" && /^[a-f0-9]{64}$/.test(metadata.sha256)
      && !("content" in metadata) && !("version" in metadata);
  } catch { return false; }
}

function readFact(input: Extract<ExecutionFactInput, { kind: "tool_result" }>): Omit<FileReadFact, "count" | "firstToolCallId" | "lastToolCallId"> | null {
  try {
    const value: unknown = JSON.parse(input.output);
    if (!value || typeof value !== "object") return null;
    const read = value as Record<string, unknown>;
    if (typeof read.path !== "string" || !read.path || typeof read.version !== "string" || !read.version
      || typeof read.content !== "string" || !integer(read.character_offset) || !integer(read.total_characters)
      || read.character_offset + read.content.length > read.total_characters
      || typeof read.complete !== "boolean" || typeof read.truncated !== "boolean") return null;
    const start = read.character_offset;
    const end = start + read.content.length;
    if (read.complete !== (start === 0 && end === read.total_characters) || read.truncated !== (end < read.total_characters)) return null;
    return {
      path: redactSecrets(path.posix.normalize(read.path.replace(/\\/g, "/"))).slice(0, 2_000),
      version: redactSecrets(read.version).slice(0, 200), start, end, complete: read.complete,
    };
  } catch { return null; }
}

export function recordExecutionFact(state: ExecutionFacts, input: ExecutionFactInput): void {
  const id = digest(input.kind === "tool_result" ? JSON.stringify([input.kind, input.requestId, input.toolCallId, input.executionId || null]) : JSON.stringify([input.kind, input.attemptId]));
  if (state.observedFactIds.includes(id)) return;
  // Never evict deduplication identities and subsequently overcount an old result.
  // At the bound the known counts remain a lower bound and the UI must say unknown.
  if (state.observedFactIds.length >= MAX_FACTS) { state.completeness = "unknown"; return; }
  state.observedFactIds.push(id);
  if (input.kind === "compaction") {
    if (input.outcome === "summary") state.compactions.summaryCount += 1;
    else if (input.outcome === "fallback_trim") { state.compactions.fallbackTrimCount += 1; state.compactions.failedCount += 1; }
    else state.compactions.failedCount += 1;
    state.compactions.last = {
      outcome: input.outcome,
      ...(integer(input.tokensBefore) ? { tokensBefore: input.tokensBefore } : {}),
      ...(integer(input.tokensAfter) ? { tokensAfter: input.tokensAfter } : {}),
    };
    return;
  }
  state.toolCalls += 1;
  if (input.denied) state.deniedToolCalls += 1;
  else if (input.isError) state.failedToolCalls += 1;
  else state.successfulToolCalls += 1;
  if (input.toolName !== "read_file" || input.isError || input.denied) return;
  // Metadata confirms only a successful inspection, not a text-content read.
  if (isBinaryMetadata(input.output)) return;
  state.fileReads += 1;
  const read = readFact(input);
  if (!read) { state.unclassifiedFileReads += 1; state.completeness = "unknown"; return; }
  const prior = state.readRanges.find((item) => item.path === read.path && item.version === read.version && item.start === read.start && item.end === read.end);
  if (prior) {
    prior.count += 1;
    prior.lastToolCallId = redactSecrets(input.toolCallId).slice(0, 200);
    state.duplicateFileReads += 1;
    return;
  }
  if (state.readRanges.length >= MAX_READ_RANGES) { state.unclassifiedFileReads += 1; state.completeness = "unknown"; return; }
  const samePath = state.readRanges.filter((item) => item.path === read.path);
  if (samePath.some((item) => item.version === read.version)) state.pagedFileReads += 1;
  else if (samePath.length) state.updatedFileReads += 1;
  state.readRanges.push({ ...read, count: 1, firstToolCallId: redactSecrets(input.toolCallId).slice(0, 200), lastToolCallId: redactSecrets(input.toolCallId).slice(0, 200) });
}

export function summarizeExecutionFacts(state: ExecutionFacts): ExecutionFactsSummary {
  const { observedFactIds: _ids, ...summary } = state;
  return structuredClone(summary);
}

/** Legacy/malformed records cannot establish zero duplicates or successful compaction. */
export function normalizeExecutionFacts(raw: unknown): ExecutionFacts {
  if (!raw || typeof raw !== "object") return createExecutionFacts("unknown");
  const value = raw as Partial<ExecutionFacts>;
  const counters = ["toolCalls", "successfulToolCalls", "failedToolCalls", "deniedToolCalls", "fileReads", "duplicateFileReads", "pagedFileReads", "updatedFileReads", "unclassifiedFileReads"] as const;
  if (value.schemaVersion !== 1 || !["complete", "unknown"].includes(value.completeness || "")
    || counters.some((key) => !integer(value[key])) || !Array.isArray(value.observedFactIds) || value.observedFactIds.length > MAX_FACTS
    || value.observedFactIds.some((id) => typeof id !== "string" || !/^sha256:[a-f0-9]{64}$/.test(id))
    || new Set(value.observedFactIds).size !== value.observedFactIds.length
    || !Array.isArray(value.readRanges) || value.readRanges.length > MAX_READ_RANGES
    || value.readRanges.some((read) => !read || typeof read.path !== "string" || !read.path || read.path.length > 2_000 || typeof read.version !== "string" || !read.version || read.version.length > 200
      || !integer(read.start) || !integer(read.end) || read.end < read.start || !integer(read.count) || read.count < 1
      || typeof read.complete !== "boolean" || typeof read.firstToolCallId !== "string" || read.firstToolCallId.length > 200 || typeof read.lastToolCallId !== "string" || read.lastToolCallId.length > 200)
    || !value.compactions || !integer(value.compactions.summaryCount) || !integer(value.compactions.fallbackTrimCount) || !integer(value.compactions.failedCount)) return createExecutionFacts("unknown");
  if (value.compactions.last && (!["summary", "fallback_trim", "failed"].includes(value.compactions.last.outcome)
    || value.compactions.last.tokensBefore !== undefined && !integer(value.compactions.last.tokensBefore)
    || value.compactions.last.tokensAfter !== undefined && !integer(value.compactions.last.tokensAfter))) return createExecutionFacts("unknown");
  const state = createExecutionFacts(value.completeness);
  for (const key of counters) state[key] = value[key]!;
  state.observedFactIds = [...value.observedFactIds];
  state.readRanges = value.readRanges.map((read) => ({
    path: redactSecrets(read.path), version: redactSecrets(read.version), start: read.start, end: read.end,
    complete: read.complete, count: read.count, firstToolCallId: redactSecrets(read.firstToolCallId), lastToolCallId: redactSecrets(read.lastToolCallId),
  }));
  state.compactions = {
    summaryCount: value.compactions.summaryCount, fallbackTrimCount: value.compactions.fallbackTrimCount, failedCount: value.compactions.failedCount,
    ...(value.compactions.last ? { last: {
      outcome: value.compactions.last.outcome,
      ...(value.compactions.last.tokensBefore !== undefined ? { tokensBefore: value.compactions.last.tokensBefore } : {}),
      ...(value.compactions.last.tokensAfter !== undefined ? { tokensAfter: value.compactions.last.tokensAfter } : {}),
    } } : {}),
  };
  if (state.successfulToolCalls + state.failedToolCalls + state.deniedToolCalls !== state.toolCalls
    || state.fileReads > state.successfulToolCalls
    || state.duplicateFileReads + state.pagedFileReads + state.updatedFileReads + state.unclassifiedFileReads > state.fileReads
    || state.readRanges.reduce((sum, read) => sum + read.count, 0) + state.unclassifiedFileReads !== state.fileReads
    || state.readRanges.reduce((sum, read) => sum + read.count - 1, 0) !== state.duplicateFileReads
    || new Set(state.readRanges.map((read) => JSON.stringify([read.path, read.version, read.start, read.end]))).size !== state.readRanges.length
    || state.compactions.fallbackTrimCount > state.compactions.failedCount) return createExecutionFacts("unknown");
  return state;
}
