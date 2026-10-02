import fs from "node:fs";
import path from "node:path";
import { redactSecrets } from "./secretRedaction.js";
import type { ToolContext } from "./types.js";
import { normalizeExecutionFacts, summarizeExecutionFacts } from "../chat/executionFacts.js";
import { readRunRecord, type AgentRunRecord, type AgentToolExecution } from "../chat/runHistory.js";
import { safePath } from "../utils/safePath.js";

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_QUERY_CHARS = 200;
const MAX_RESULT_CHARS = 24_000;
const MAX_SUMMARY_CHARS = 8_000;
const MAX_SUMMARY_PREVIEW_CHARS = 1_200;
const MAX_TOOL_ID_CHARS = 240;
const MAX_TOOL_NAME_CHARS = 160;
const MAX_TOOL_SUMMARY_CHARS = 360;
const MAX_TRANSCRIPT_FILE_BYTES = 2_000_000;
const DEFAULT_TRANSCRIPT_CHARS = 12_000;
const MAX_TRANSCRIPT_CHARS = 20_000;
const TRANSCRIPT_DETAIL_MAX = 500;

type RunEvidenceView = "summary" | "tools" | "transcript";

export interface RunEvidenceArgs {
  view?: unknown;
  offset?: unknown;
  limit?: unknown;
  query?: unknown;
  transcript_index?: unknown;
}

interface BoundedPage<T> {
  items: T[];
  offset: number;
  limit: number;
  total: number;
  next_offset: number | null;
}

function integer(value: unknown, name: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function literalQuery(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("query must be a literal string");
  if (value.length > MAX_QUERY_CHARS) throw new Error(`query must be at most ${MAX_QUERY_CHARS} characters`);
  return value;
}

function assertAllowedArgs(args: RunEvidenceArgs): void {
  const allowed = new Set(["view", "offset", "limit", "query", "transcript_index"]);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) throw new Error(`Unsupported read_run_evidence input: ${key}`);
  }
}

function requestedView(value: unknown): RunEvidenceView {
  if (value === undefined) return "summary";
  if (value === "summary" || value === "tools" || value === "transcript") return value;
  throw new Error("view must be summary, tools, or transcript");
}

function currentRunRecord(ctx: ToolContext): AgentRunRecord {
  const runId = ctx.runId;
  if (!runId) throw new Error("read_run_evidence requires an active run id");
  if (!ctx.conversationId) throw new Error("read_run_evidence requires an active conversation id");
  if (!RUN_ID_PATTERN.test(runId)) throw new Error("Current run id is invalid");

  const relative = path.posix.join(".history", "runs", `${runId}.json`);
  const runPath = safePath(relative, ctx.workspaceDir);
  const workspaceRoot = path.resolve(ctx.workspaceDir);
  const controlRoot = path.join(workspaceRoot, ".history", "control");
  if (runPath === controlRoot || runPath.startsWith(controlRoot + path.sep)) throw new Error("Run evidence cannot read control records");
  const stat = fs.lstatSync(runPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Run record is not a regular file");

  const record = readRunRecord(ctx.workspaceDir, runId);
  if (record.conversationId !== ctx.conversationId) throw new Error("Run evidence belongs to a different conversation");
  return record;
}

function stableJson(value: unknown): string {
  return JSON.stringify(redactSecrets(value));
}

function boundedJson(value: unknown): string {
  const serialized = stableJson(value);
  if (serialized.length <= MAX_RESULT_CHARS) return serialized;
  const base = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return stableJson({
    view: typeof base.view === "string" ? base.view : "unknown",
    data_only: true,
    truncated: true,
    truncation: `Result exceeded ${MAX_RESULT_CHARS} characters after structured compaction; narrow query, offset, or limit`,
  });
}

function boundedPageJson<T extends Record<string, unknown>>(base: T, itemKey: "items"): string {
  let current = base;
  while (stableJson(current).length > MAX_RESULT_CHARS && Array.isArray(current[itemKey]) && (current[itemKey] as unknown[]).length > 1) {
    const nextItems = (current[itemKey] as unknown[]).slice(0, Math.floor((current[itemKey] as unknown[]).length / 2));
    const offset = typeof current.offset === "number" ? current.offset : 0;
    const total = typeof current.total === "number" ? current.total : nextItems.length;
    current = {
      ...current,
      [itemKey]: nextItems,
      next_offset: offset + nextItems.length < total ? offset + nextItems.length : null,
      truncated: true,
      truncation: `Result exceeded ${MAX_RESULT_CHARS} characters; returned fewer items, continue with next_offset`,
    };
  }
  if (stableJson(current).length > MAX_RESULT_CHARS && Array.isArray(current[itemKey]) && (current[itemKey] as unknown[]).length === 1) {
    const offset = typeof current.offset === "number" ? current.offset : 0;
    const total = typeof current.total === "number" ? current.total : offset + 1;
    current = {
      ...current,
      [itemKey]: [],
      next_offset: offset + 1 < total ? offset + 1 : null,
      truncated: true,
      truncation: `Single evidence item exceeded ${MAX_RESULT_CHARS} characters after compaction; skipped it, continue with next_offset`,
    };
  }
  return boundedJson(current);
}

function page<T>(items: T[], offset: number, limit: number): BoundedPage<T> {
  const selected = items.slice(offset, offset + limit);
  return {
    items: selected,
    offset,
    limit,
    total: items.length,
    next_offset: offset + selected.length < items.length ? offset + selected.length : null,
  };
}

function matchesLiteral(value: unknown, query: string | undefined): boolean {
  if (!query) return true;
  return JSON.stringify(value).includes(query);
}

function compactSummary(value: unknown, limit: number): unknown {
  if (typeof value !== "string") return value;
  const redacted = redactSecrets(value);
  if (redacted.length <= limit) return redacted;
  return {
    truncated: true,
    totalCharacters: redacted.length,
    preview: redacted.slice(0, Math.min(limit, MAX_SUMMARY_PREVIEW_CHARS)),
  };
}

function toolPath(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ["path", "source_path", "target_path", "target_directory", "command"] as const) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) result[key] = value.slice(0, 1_000);
  }
  return result;
}

function clipped(value: string, limit: number): string | { truncated: true; totalCharacters: number; preview: string } {
  const safe = redactSecrets(value);
  if (safe.length <= limit) return safe;
  return { truncated: true, totalCharacters: safe.length, preview: safe.slice(0, limit) };
}

function summarizeToolExecution(tool: AgentToolExecution): Record<string, unknown> {
  const pathFields = toolPath(tool.input || {});
  return redactSecrets({
    toolCallId: clipped(tool.toolCallId, MAX_TOOL_ID_CHARS),
    requestId: clipped(tool.requestId, MAX_TOOL_ID_CHARS),
    name: clipped(tool.name, MAX_TOOL_NAME_CHARS),
    status: tool.status,
    createdAt: tool.createdAt,
    updatedAt: tool.updatedAt,
    ...(tool.startedAt !== undefined ? { startedAt: tool.startedAt } : {}),
    ...(tool.endedAt !== undefined ? { endedAt: tool.endedAt } : {}),
    ...(Object.keys(pathFields).length ? { input: pathFields } : {}),
    ...(tool.resultSummary ? { resultSummary: compactSummary(tool.resultSummary, MAX_TOOL_SUMMARY_CHARS) } : {}),
    ...(tool.error ? { error: compactSummary(tool.error, MAX_TOOL_SUMMARY_CHARS) } : {}),
  });
}

function summaryView(record: AgentRunRecord, args: RunEvidenceArgs): string {
  const query = literalQuery(args.query);
  const offset = integer(args.offset, "offset", 0, 10_000, 0);
  const limit = integer(args.limit, "limit", 1, MAX_LIMIT, DEFAULT_LIMIT);
  const facts = summarizeExecutionFacts(normalizeExecutionFacts(record.executionFacts));
  const readRanges = facts.readRanges;
  const readRangePage = page(readRanges, offset, limit);
  const compactFacts = { ...facts, readRanges: readRangePage.items, readRangesTotal: readRanges.length, readRangesOffset: readRangePage.offset, readRangesLimit: readRangePage.limit, readRangesNextOffset: readRangePage.next_offset, readRangesTruncated: readRangePage.next_offset !== null };
  const compactedEvents = record.events.filter((event) => event.kind === "context_compacted").map((event, index) => ({
    index,
    timestamp: event.timestamp,
    label: event.label,
    detail: event.detail,
  }));
  const summary = redactSecrets({
    view: "summary",
    data_only: true,
    runId: record.runId,
    conversationId: record.conversationId,
    mode: record.mode,
    status: record.status,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    endedAt: record.endedAt,
    metrics: record.metrics,
    executionFacts: compactFacts,
    completionEvidence: record.completionEvidence,
    runSummary: record.summary ? compactSummary(JSON.stringify(record.summary), MAX_SUMMARY_CHARS) : undefined,
    contextCompactions: compactedEvents,
    toolExecutionCount: record.toolExecutions.length,
    eventCount: record.events.length,
  });
  return boundedJson(query && !matchesLiteral(summary, query)
    ? { view: "summary", data_only: true, query, matched: false }
    : summary);
}

function toolsView(record: AgentRunRecord, args: RunEvidenceArgs): string {
  const query = literalQuery(args.query);
  const offset = integer(args.offset, "offset", 0, 10_000, 0);
  const limit = integer(args.limit, "limit", 1, MAX_LIMIT, DEFAULT_LIMIT);
  const facts = summarizeExecutionFacts(normalizeExecutionFacts(record.executionFacts));
  const tools = record.toolExecutions.map(summarizeToolExecution).filter((tool) => matchesLiteral(tool, query));
  const paged = page(tools, offset, limit);
  const knownTotal = facts.completeness === "unknown" ? null : facts.toolCalls;
  const captureComplete = facts.completeness === "complete" && facts.toolCalls <= record.toolExecutions.length;
  return boundedPageJson({
    view: "tools", data_only: true,
    storedCount: record.toolExecutions.length,
    knownTotal,
    captureComplete,
    matchedStoredCount: tools.length,
    ...paged,
  }, "items");
}

function transcriptRefs(record: AgentRunRecord): Array<{ index: number; eventId: string; timestamp: number; transcriptPath: string }> {
  const refs: Array<{ index: number; eventId: string; timestamp: number; transcriptPath: string }> = [];
  for (const event of record.events) {
    if (event.kind !== "context_compacted" || typeof event.detail !== "string") continue;
    try {
      const value: unknown = JSON.parse(event.detail);
      if (!value || typeof value !== "object") continue;
      const transcriptPath = (value as Record<string, unknown>).transcriptPath;
      if (typeof transcriptPath !== "string" || !transcriptPath.trim()) continue;
      refs.push({ index: refs.length, eventId: event.id, timestamp: event.timestamp, transcriptPath });
    } catch {
      continue;
    }
  }
  return refs;
}

function transcriptPathFromRef(ctx: ToolContext, transcriptPath: string): string {
  if (path.isAbsolute(transcriptPath) || /^[A-Za-z]:[\\/]/.test(transcriptPath)) throw new Error("Transcript reference must be workspace-relative");
  if (!transcriptPath.replace(/\\/g, "/").startsWith(".transcripts/")) throw new Error("Transcript reference is not a transcript artifact");
  const target = safePath(transcriptPath, ctx.workspaceDir);
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Transcript artifact is not a regular file");
  if (stat.size > MAX_TRANSCRIPT_FILE_BYTES) throw new Error(`Transcript artifact is ${stat.size} bytes, above the ${MAX_TRANSCRIPT_FILE_BYTES} byte read limit`);
  return target;
}

function transcriptView(record: AgentRunRecord, ctx: ToolContext, args: RunEvidenceArgs): string {
  const refs = transcriptRefs(record);
  const query = literalQuery(args.query);
  if (refs.length === 0) return boundedJson({ view: "transcript", data_only: true, available: false, reason: "No JSON transcriptPath references were recorded for this run", refs });
  const transcriptIndex = integer(args.transcript_index, "transcript_index", 0, refs.length - 1, 0);
  const offset = integer(args.offset, "offset", 0, MAX_TRANSCRIPT_FILE_BYTES, 0);
  const limit = integer(args.limit, "limit", 1, MAX_TRANSCRIPT_CHARS, DEFAULT_TRANSCRIPT_CHARS);
  const ref = refs[transcriptIndex];
  const target = transcriptPathFromRef(ctx, ref.transcriptPath);
  const content = redactSecrets(fs.readFileSync(target, "utf8"));
  const matchOffset = query ? content.indexOf(query) : -1;
  const effectiveOffset = query && matchOffset >= 0 ? matchOffset : offset;
  const chunk = content.slice(effectiveOffset, effectiveOffset + limit);
  return boundedJson({
    view: "transcript",
    data_only: true,
    available: true,
    ref: { index: ref.index, eventId: ref.eventId, timestamp: ref.timestamp, transcriptPath: ref.transcriptPath },
    refs: refs.map(({ index, eventId, timestamp, transcriptPath }) => ({ index, eventId, timestamp, transcriptPath })),
    offset: effectiveOffset,
    requested_offset: offset,
    limit,
    total_characters: content.length,
    query_match_offset: matchOffset >= 0 ? matchOffset : null,
    matched: query ? matchOffset >= 0 : undefined,
    next_offset: effectiveOffset + chunk.length < content.length ? effectiveOffset + chunk.length : null,
    truncated: effectiveOffset + chunk.length < content.length,
    content: chunk.slice(0, TRANSCRIPT_DETAIL_MAX) === chunk ? chunk : chunk,
  });
}

export async function readRunEvidence(args: RunEvidenceArgs, ctx: ToolContext): Promise<string> {
  try {
    assertAllowedArgs(args);
    const record = currentRunRecord(ctx);
    const view = requestedView(args.view);
    if (view === "summary") return summaryView(record, args);
    if (view === "tools") return toolsView(record, args);
    return transcriptView(record, ctx, args);
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : "Failed to read run evidence"}`;
  }
}
