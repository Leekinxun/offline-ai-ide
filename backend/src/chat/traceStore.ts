import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactSecrets } from "../agent/secretRedaction.js";
import { isProcessAlive } from "../utils/processLiveness.js";

/** Durable, append-only causal audit trail.  It deliberately accepts every actor
 * class so routes, websocket code, and agent hooks can use one representation. */
export type TraceEventKind = "run" | "agent" | "model" | "tool" | "approval" | "checkpoint" | "validation" | "git" | "review" | "error" | "decision";
export interface CausalTraceEvent {
  schemaVersion: 1;
  eventId: string;
  timestamp: number;
  kind: TraceEventKind;
  action: string;
  correlationId: string;
  causationId?: string;
  parentEventId?: string;
  runId?: string;
  conversationId?: string;
  agentId?: string;
  requestId?: string;
  toolCallId?: string;
  evidence?: string;
  decision?: string;
  metadata?: Record<string, unknown>;
}
export interface TraceRetentionOptions { maxEvents?: number; maxArchiveEvents?: number; maxAgeMs?: number; maxArchiveAgeMs?: number; archive?: boolean; }
export interface TraceRetentionPolicy { maxEvents: number; maxArchiveEvents: number; maxAgeMs: number; maxArchiveAgeMs: number; archive: boolean; }
export interface TraceMetrics { eventCount: number; archivedEventCount: number; bytes: number; archiveBytes: number; totalBytes: number; oldestAt?: number; newestAt?: number; }
export interface TracePrunePreview { hotBefore: number; archiveBefore: number; hotAfter: number; archiveAfter: number; wouldArchive: number; wouldDelete: number; }

const DIR = ".history/traces";
const FILE = "events.jsonl";
const DEFAULT_MAX = 10_000;
const LIMIT = 10_000;
function tracePath(workspace: string) { return path.join(path.resolve(workspace), DIR, FILE); }
function archivePath(workspace: string) { return path.join(path.resolve(workspace), DIR, "archive.jsonl"); }
function metaPath(workspace: string) { return path.join(path.resolve(workspace), DIR, "events.meta.json"); }
function policyPath(workspace: string) { return path.join(path.resolve(workspace), DIR, "retention.json"); }
const DEFAULT_POLICY: TraceRetentionPolicy = { maxEvents: DEFAULT_MAX, maxArchiveEvents: DEFAULT_MAX * 10, maxAgeMs: 0, maxArchiveAgeMs: 0, archive: true };
function cut(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? redactSecrets(value).trim().slice(0, max) : undefined;
}
function normalize(raw: unknown): CausalTraceEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const v = redactSecrets(raw) as Partial<CausalTraceEvent>;
  const kinds: TraceEventKind[] = ["run", "agent", "model", "tool", "approval", "checkpoint", "validation", "git", "review", "error", "decision"];
  if (typeof v.eventId !== "string" || typeof v.timestamp !== "number" || !kinds.includes(v.kind as TraceEventKind) || typeof v.action !== "string" || typeof v.correlationId !== "string") return null;
  return { schemaVersion: 1, eventId: v.eventId.slice(0, 160), timestamp: v.timestamp, kind: v.kind as TraceEventKind, action: redactSecrets(v.action).slice(0, 500), correlationId: v.correlationId.slice(0, 160), ...(cut(v.causationId, 160) ? { causationId: cut(v.causationId, 160) } : {}), ...(cut(v.parentEventId, 160) ? { parentEventId: cut(v.parentEventId, 160) } : {}), ...(cut(v.runId, 160) ? { runId: cut(v.runId, 160) } : {}), ...(cut(v.conversationId, 160) ? { conversationId: cut(v.conversationId, 160) } : {}), ...(cut(v.agentId, 160) ? { agentId: cut(v.agentId, 160) } : {}), ...(cut(v.requestId, 160) ? { requestId: cut(v.requestId, 160) } : {}), ...(cut(v.toolCallId, 160) ? { toolCallId: cut(v.toolCallId, 160) } : {}), ...(cut(v.evidence, 4_000) ? { evidence: cut(v.evidence, 4_000) } : {}), ...(cut(v.decision, 2_000) ? { decision: cut(v.decision, 2_000) } : {}), ...(v.metadata && typeof v.metadata === "object" ? { metadata: sanitizeMetadata(v.metadata) } : {}) };
}
function sanitizeMetadata(value: Record<string, unknown>): Record<string, unknown> { const sanitize = (entry: unknown): unknown => { if (Array.isArray(entry)) return entry.map(sanitize); if (!entry || typeof entry !== "object") return entry; const result: Record<string, unknown> = {}; for (const [key, child] of Object.entries(entry as Record<string, unknown>)) if (!/(reasoning|thinking|chain.?of.?thought|prompt|raw_?output)/i.test(key)) result[key] = sanitize(child); return result; }; return sanitize(redactSecrets(value)) as Record<string, unknown>; }
function read(file: string): CausalTraceEvent[] { try { return fs.readFileSync(file, "utf8").split("\n").flatMap(line => { try { const e = normalize(JSON.parse(line)); return e ? [e] : []; } catch { return []; } }); } catch { return []; } }
function write(file: string, events: CausalTraceEvent[]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, events.map(e => JSON.stringify(e)).join(events.length ? "\n" : "") + (events.length ? "\n" : "")); }
function readCount(workspace: string): number { try { const parsed = JSON.parse(fs.readFileSync(metaPath(workspace), "utf8")) as { count?: unknown }; if (typeof parsed.count === "number" && parsed.count >= 0) return parsed.count; } catch { /* derive once for legacy stores */ } return read(tracePath(workspace)).length; }
function writeCount(workspace: string, count: number) { fs.mkdirSync(path.dirname(metaPath(workspace)), { recursive: true }); fs.writeFileSync(metaPath(workspace), JSON.stringify({ count, updatedAt: Date.now() }) + "\n"); }
interface TraceLockOwner { pid: number; token: string; createdAt: number; }
const TRACE_LOCK_WAIT_MS = 2_000;
const TRACE_LOCK_STALE_MS = 1_000;
const TRACE_LOCK_POLL_MS = 5;
function readLockOwner(lock: string): TraceLockOwner | null { try { const serialized = fs.lstatSync(lock).isSymbolicLink() ? fs.readlinkSync(lock) : fs.readFileSync(lock, "utf8"); const owner = JSON.parse(serialized) as Partial<TraceLockOwner>; return typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && typeof owner.token === "string" && typeof owner.createdAt === "number" ? owner as TraceLockOwner : null; } catch { return null; } }
function reclaimDeadTraceLock(lock: string): void { const reaper = `${lock}.reaper`; let descriptor: number | undefined; try { descriptor = fs.openSync(reaper, "wx"); const owner = readLockOwner(lock); if (!owner || Date.now() - owner.createdAt < TRACE_LOCK_STALE_MS || isProcessAlive(owner.pid)) return; const confirmed = readLockOwner(lock); if (confirmed?.token === owner.token && confirmed.pid === owner.pid) fs.rmSync(lock, { force: true }); } catch { /* another process is reclaiming or the owner recovered */ } finally { if (descriptor !== undefined) { fs.closeSync(descriptor); fs.rmSync(reaper, { force: true }); } } }
function withTraceLock<T>(workspace: string, operation: () => T): T { const lock = path.join(path.resolve(workspace), DIR, ".events.lock"); fs.mkdirSync(path.dirname(lock), { recursive: true }); const owner: TraceLockOwner = { pid: process.pid, token: crypto.randomUUID(), createdAt: Date.now() }; let acquired = false; const deadline = Date.now() + TRACE_LOCK_WAIT_MS; try { while (Date.now() <= deadline) { try { fs.symlinkSync(JSON.stringify(owner), lock); acquired = true; break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; reclaimDeadTraceLock(lock); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, TRACE_LOCK_POLL_MS); } } if (!acquired) throw new Error("Trace store is busy"); return operation(); } finally { if (acquired) { const current = readLockOwner(lock); if (current?.token === owner.token && current.pid === owner.pid) fs.rmSync(lock, { force: true }); } } }
function normalizePolicy(raw: TraceRetentionOptions, base = DEFAULT_POLICY): TraceRetentionPolicy { const positive = (value: unknown, fallback: number, maximum: number, allowZero = false) => typeof value === "number" && Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1) && value <= maximum ? value : fallback; return { maxEvents: positive(raw.maxEvents, base.maxEvents, LIMIT), maxArchiveEvents: positive(raw.maxArchiveEvents, base.maxArchiveEvents, LIMIT * 10, true), maxAgeMs: positive(raw.maxAgeMs, base.maxAgeMs, 365 * 24 * 60 * 60_000, true), maxArchiveAgeMs: positive(raw.maxArchiveAgeMs, base.maxArchiveAgeMs, 365 * 24 * 60 * 60_000, true), archive: typeof raw.archive === "boolean" ? raw.archive : base.archive }; }
export function getTraceRetention(workspace: string): TraceRetentionPolicy { try { return normalizePolicy(JSON.parse(fs.readFileSync(policyPath(workspace), "utf8")) as TraceRetentionOptions); } catch { return { ...DEFAULT_POLICY }; } }
export function setTraceRetention(workspace: string, patch: TraceRetentionOptions): TraceRetentionPolicy { return withTraceLock(workspace, () => { const policy = normalizePolicy(patch, getTraceRetention(workspace)); fs.writeFileSync(policyPath(workspace), JSON.stringify(policy, null, 2) + "\n"); return policy; }); }
export class TraceStore {
  constructor(private readonly workspace: string, private readonly retention: TraceRetentionOptions = {}) {}
  getRetention(): TraceRetentionPolicy { return normalizePolicy(this.retention, getTraceRetention(this.workspace)); }
  setRetention(patch: TraceRetentionOptions): TraceRetentionPolicy { return setTraceRetention(this.workspace, patch); }
  append(input: Omit<CausalTraceEvent, "schemaVersion" | "eventId" | "timestamp"> & Partial<Pick<CausalTraceEvent, "eventId" | "timestamp">>): CausalTraceEvent {
    const event = normalize({ ...input, schemaVersion: 1, eventId: input.eventId || `trace-${crypto.randomUUID()}`, timestamp: input.timestamp || Date.now() });
    if (!event) throw new Error("Invalid trace event");
    return withTraceLock(this.workspace, () => {
      const file = tracePath(this.workspace); fs.mkdirSync(path.dirname(file), { recursive: true });
      const existing = event.parentEventId ? this.list() : [];
      if (event.parentEventId && (event.parentEventId === event.eventId || !existing.some(item => item.eventId === event.parentEventId))) throw new Error("Trace parent event is missing or cyclic");
      let count = readCount(this.workspace); fs.appendFileSync(file, `${JSON.stringify(event)}\n`); count += 1;
      const policy = this.getRetention();
      if (count > policy.maxEvents || policy.maxAgeMs > 0) count = this.enforce(read(file), policy);
      writeCount(this.workspace, count); return event;
    });
  }
  list(filter: Partial<Pick<CausalTraceEvent, "runId" | "correlationId" | "kind">> = {}): CausalTraceEvent[] { return read(tracePath(this.workspace)).filter(e => (!filter.runId || e.runId === filter.runId) && (!filter.correlationId || e.correlationId === filter.correlationId) && (!filter.kind || e.kind === filter.kind)); }
  export(filter: Parameters<TraceStore["list"]>[0] = {}): { schemaVersion: 1; events: CausalTraceEvent[] } { return { schemaVersion: 1, events: this.list(filter) }; }
  delete(filter: Parameters<TraceStore["list"]>[0] = {}): number { return withTraceLock(this.workspace, () => { const all = read(tracePath(this.workspace)); const keep = all.filter(e => !((!filter.runId || e.runId === filter.runId) && (!filter.correlationId || e.correlationId === filter.correlationId) && (!filter.kind || e.kind === filter.kind))); write(tracePath(this.workspace), keep); writeCount(this.workspace, keep.length); return all.length - keep.length; }); }
  metrics(): TraceMetrics { const events = this.list(); const file = tracePath(this.workspace); const archive = archivePath(this.workspace); const bytes = fs.existsSync(file) ? fs.statSync(file).size : 0; const archiveBytes = fs.existsSync(archive) ? fs.statSync(archive).size : 0; return { eventCount: events.length, archivedEventCount: read(archive).length, bytes, archiveBytes, totalBytes: bytes + archiveBytes, ...(events[0] ? { oldestAt: events[0].timestamp } : {}), ...(events.at(-1) ? { newestAt: events.at(-1)!.timestamp } : {}) }; }
  previewPrune(now = Date.now()): TracePrunePreview { return this.preview(read(tracePath(this.workspace)), read(archivePath(this.workspace)), this.getRetention(), now); }
  prune(now = Date.now()): TracePrunePreview { return withTraceLock(this.workspace, () => { const hot = read(tracePath(this.workspace)); const archive = read(archivePath(this.workspace)); const preview = this.preview(hot, archive, this.getRetention(), now); this.applyRetention(hot, archive, this.getRetention(), now); write(tracePath(this.workspace), hot); write(archivePath(this.workspace), archive); writeCount(this.workspace, hot.length); return preview; }); }
  private preview(hot: CausalTraceEvent[], archive: CausalTraceEvent[], policy: TraceRetentionPolicy, now: number): TracePrunePreview { const hotResult = this.retain(hot, policy.maxEvents, policy.maxAgeMs, now); const nextArchive = policy.archive ? [...archive, ...hotResult.removed] : archive; const archiveResult = this.retain(nextArchive, policy.archive ? policy.maxArchiveEvents : 0, policy.maxArchiveAgeMs, now); return { hotBefore: hot.length, archiveBefore: archive.length, hotAfter: hotResult.kept.length, archiveAfter: archiveResult.kept.length, wouldArchive: policy.archive ? hotResult.removed.length : 0, wouldDelete: (policy.archive ? 0 : hotResult.removed.length) + archiveResult.removed.length }; }
  private retain(events: CausalTraceEvent[], max: number, age: number, now: number) { const fresh = age > 0 ? events.filter(event => event.timestamp >= now - age) : [...events]; const kept = max === 0 ? [] : fresh.slice(-max); return { kept, removed: events.filter(event => !kept.some(candidate => candidate.eventId === event.eventId)) }; }
  private applyRetention(hot: CausalTraceEvent[], archive: CausalTraceEvent[], policy: TraceRetentionPolicy, now: number): void { const hotKeep = this.retain(hot, policy.maxEvents, policy.maxAgeMs, now).kept; const hotRemoved = hot.filter(event => !hotKeep.some(kept => kept.eventId === event.eventId)); hot.splice(0, hot.length, ...hotKeep); if (policy.archive) archive.push(...hotRemoved); const archiveKeep = this.retain(archive, policy.archive ? policy.maxArchiveEvents : 0, policy.maxArchiveAgeMs, now).kept; archive.splice(0, archive.length, ...archiveKeep); }
  private enforce(events: CausalTraceEvent[], policy: TraceRetentionPolicy): number { const archive = read(archivePath(this.workspace)); this.applyRetention(events, archive, policy, Date.now()); write(archivePath(this.workspace), archive); write(tracePath(this.workspace), events); return events.length; }
}
export function traceEvent(workspace: string, input: ConstructorParameters<typeof TraceStore>[1] extends never ? never : Parameters<TraceStore["append"]>[0]): CausalTraceEvent { return new TraceStore(workspace).append(input); }
