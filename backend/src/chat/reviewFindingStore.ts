import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactSecrets } from "../agent/secretRedaction.js";
import { normalizeReviewFinding, type ReviewActor, type ReviewFindingLifecycle, type ReviewSeverity, type StructuredReviewFinding } from "./reviewFindings.js";

export interface ReviewFindingBinding { runId?: string; conversationId?: string; }
export interface ReviewFindingFilter { runId?: string; conversationId?: string; changeSetId?: string; reviewRunId?: string; status?: ReviewFindingLifecycle; severity?: ReviewSeverity; }
export interface StoredReviewFinding extends StructuredReviewFinding { schemaVersion: 1; version: number; createdAt: number; updatedAt: number; transitions: ReviewTransition[]; fixRef?: string; verifier?: ReviewActor; dismissalReason?: string; runId?: string; conversationId?: string; changeSetId?: string; reviewRunId?: string; }
export interface ReviewTransition { from: ReviewFindingLifecycle; to: ReviewFindingLifecycle; at: number; actor: ReviewActor; reason?: string; fixRef?: string; evidence?: string[]; version: number; }
const allowed: Record<ReviewFindingLifecycle, ReviewFindingLifecycle[]> = { open: ["accepted", "disputed", "fixed", "dismissed"], accepted: ["disputed", "fixed", "dismissed"], disputed: ["accepted", "dismissed"], fixed: ["verified", "open"], verified: [], dismissed: [] };
export function allowedReviewFindingTransitions(item: StoredReviewFinding, options: { isAdmin?: boolean } = {}): ReviewFindingLifecycle[] {
  return allowed[item.lifecycle].filter((to) => to !== "verified" && (to !== "dismissed" || (item.severity !== "critical" && item.severity !== "error") || options.isAdmin));
}
export class ReviewFindingVersionConflictError extends Error { readonly code = "review_finding_version_conflict"; constructor(readonly findingId: string, readonly expectedVersion: number, readonly actualVersion: number) { super(`Review finding version conflict: expected ${expectedVersion}, got ${actualVersion}`); } }
export class ReviewFindingStoreCorruptionError extends Error {
  readonly code = "review_finding_store_corrupt";
  constructor(readonly storePath: string, reason: string, cause?: unknown) {
    super(`Review finding store is corrupt or unreadable: ${reason}`, { cause });
    this.name = "ReviewFindingStoreCorruptionError";
  }
}
function file(workspace: string) { return path.join(path.resolve(workspace), ".history", "review-findings.json"); }
function identifier(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined; }
function normalizeStored(raw: unknown): StoredReviewFinding | null {
  const finding = normalizeReviewFinding(raw);
  if (!finding || !raw || typeof raw !== "object") return null;
  const value = raw as Partial<StoredReviewFinding>;
  const runId = identifier(value.runId);
  const conversationId = identifier(value.conversationId);
  // Promote legacy actor-bound ChangeSet correlation to the top level when the
  // record predates the queryable correlation fields.
  const changeSetId = identifier(value.changeSetId) || identifier(finding.reviewer?.changeSetId);
  const reviewRunId = identifier(value.reviewRunId) || identifier(finding.reviewer?.reviewRunId);
  const createdAt = Number.isSafeInteger(value.createdAt) && (value.createdAt || 0) >= 0 ? value.createdAt as number : 0;
  const updatedAt = Number.isSafeInteger(value.updatedAt) && (value.updatedAt || 0) >= 0 ? value.updatedAt as number : createdAt;
  const version = Number.isSafeInteger(value.version) && (value.version || 0) >= 1 ? value.version as number : 1;
  return {
    ...finding,
    schemaVersion: 1,
    version,
    createdAt,
    updatedAt,
    transitions: Array.isArray(value.transitions) ? value.transitions : [],
    ...(typeof value.fixRef === "string" ? { fixRef: value.fixRef.slice(0, 300) } : {}),
    ...(value.verifier && typeof value.verifier === "object" ? { verifier: value.verifier } : {}),
    ...(typeof value.dismissalReason === "string" ? { dismissalReason: value.dismissalReason.slice(0, 2000) } : {}),
    ...(runId ? { runId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(changeSetId ? { changeSetId } : {}),
    ...(reviewRunId ? { reviewRunId } : {}),
  };
}
function read(workspace: string): StoredReviewFinding[] {
  const target = file(workspace);
  let source: string;
  try {
    source = fs.readFileSync(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new ReviewFindingStoreCorruptionError(target, "persisted source cannot be read", error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new ReviewFindingStoreCorruptionError(target, "persisted source is not valid JSON", error);
  }
  if (!Array.isArray(parsed)) throw new ReviewFindingStoreCorruptionError(target, "persisted root must be an array");
  return parsed.map((entry, index) => {
    if (entry && typeof entry === "object" && "schemaVersion" in entry && (entry as { schemaVersion?: unknown }).schemaVersion !== 1) {
      throw new ReviewFindingStoreCorruptionError(target, `unsupported schema version at record ${index}`);
    }
    const finding = normalizeStored(entry);
    if (!finding) throw new ReviewFindingStoreCorruptionError(target, `invalid review finding at record ${index}`);
    return finding;
  });
}
function matches(item: StoredReviewFinding, filter: ReviewFindingFilter): boolean {
  return (!filter.runId || item.runId === filter.runId) &&
    (!filter.conversationId || item.conversationId === filter.conversationId) &&
    (!filter.changeSetId || item.changeSetId === filter.changeSetId) &&
    (!filter.reviewRunId || item.reviewRunId === filter.reviewRunId) &&
    (!filter.status || item.lifecycle === filter.status) &&
    (!filter.severity || item.severity === filter.severity);
}
function write(workspace: string, items: StoredReviewFinding[]) { const target = file(workspace); fs.mkdirSync(path.dirname(target), { recursive: true }); const temporary = `${target}.${crypto.randomUUID()}.tmp`; fs.writeFileSync(temporary, JSON.stringify(redactSecrets(items), null, 2) + "\n"); fs.renameSync(temporary, target); }
function withReviewLock<T>(workspace: string, operation: () => T): T { const lock = `${file(workspace)}.lock`; fs.mkdirSync(path.dirname(lock), { recursive: true }); const token = crypto.randomUUID(); let descriptor: number | undefined; for (let attempt = 0; attempt < 400; attempt += 1) { try { descriptor = fs.openSync(lock, "wx"); fs.writeFileSync(descriptor, token); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); } } if (descriptor === undefined) throw new Error("Review finding store is busy"); try { return operation(); } finally { fs.closeSync(descriptor); try { if (fs.readFileSync(lock, "utf8") === token) fs.rmSync(lock, { force: true }); } catch { /* lock may have been externally removed */ } } }
export class ReviewFindingStore {
  constructor(private readonly workspace: string) {}
  list(filter: ReviewFindingFilter = {}): StoredReviewFinding[] { return read(this.workspace).filter((item) => matches(item, filter)); }
  ingest(raw: unknown, reviewer?: ReviewActor, binding: ReviewFindingBinding = {}): StoredReviewFinding | null {
    const normalized = normalizeReviewFinding(raw, `review-${crypto.randomUUID()}`);
    if (!normalized) return null;
    // Correlation is always constructed from trusted server arguments. Never
    // copy top-level or nested correlation supplied by a model/tool payload.
    const runId = identifier(binding.runId);
    const conversationId = identifier(binding.conversationId);
    const changeSetId = identifier(reviewer?.changeSetId);
    const reviewRunId = identifier(reviewer?.reviewRunId);
    const trustedReviewer = reviewer ? {
      ...reviewer,
      ...(changeSetId ? { changeSetId } : {}),
      ...(reviewRunId ? { reviewRunId } : {}),
    } : normalized.reviewer ? {
      ...normalized.reviewer,
      changeSetId: undefined,
      reviewRunId: undefined,
    } : undefined;
    const scope = { runId, conversationId, changeSetId, reviewRunId };
    return withReviewLock(this.workspace, () => {
      const all = read(this.workspace);
      const existing = all.find(item => item.fingerprint === normalized.fingerprint && item.lifecycle !== "dismissed" &&
        item.runId === scope.runId && item.conversationId === scope.conversationId &&
        item.changeSetId === scope.changeSetId && item.reviewRunId === scope.reviewRunId);
      if (existing) {
        const revision = reviewer?.revision || normalized.reviewer?.revision;
        if (existing.lifecycle === "verified" && revision && revision !== existing.verifier?.revision) {
          const now = Date.now(); existing.transitions.push({ from: "verified", to: "open", at: now, actor: reviewer || { id: "system", revision }, reason: "Source revision changed after verification", version: existing.version + 1 }); existing.lifecycle = "open"; existing.version += 1; existing.updatedAt = now; write(this.workspace, all);
        }
        return existing;
      }
      const now = Date.now();
      const item: StoredReviewFinding = {
        ...normalized,
        reviewer: trustedReviewer,
        schemaVersion: 1,
        version: 1,
        createdAt: now,
        updatedAt: now,
        transitions: [],
        ...(runId ? { runId } : {}),
        ...(conversationId ? { conversationId } : {}),
        ...(changeSetId ? { changeSetId } : {}),
        ...(reviewRunId ? { reviewRunId } : {}),
      };
      all.push(item); write(this.workspace, all); return item;
    });
  }
  transition(id: string, to: ReviewFindingLifecycle, actor: ReviewActor, options: { reason?: string; fixRef?: string; evidence?: string[]; revision?: string; expectedVersion?: number; internalReviewRun?: boolean } = {}): StoredReviewFinding { return withReviewLock(this.workspace, () => { const all = read(this.workspace); const item = all.find(entry => entry.id === id); if (!item) throw new Error("Review finding not found"); if (options.expectedVersion !== undefined && options.expectedVersion !== item.version) throw new ReviewFindingVersionConflictError(id, options.expectedVersion, item.version); if (!allowed[item.lifecycle].includes(to)) throw new Error(`Invalid review transition: ${item.lifecycle} -> ${to}`); const evidence = (options.evidence || []).map(value => redactSecrets(value).slice(0, 2000)); if (to === "verified" && !options.internalReviewRun) throw new Error("Verification of change-set findings is reserved for an independent review run"); if ((item.severity === "critical" || item.severity === "error") && to === "verified" && evidence.length === 0) throw new Error("Verification evidence is required for critical and error findings"); if (to === "verified" && item.reviewer?.id === actor.id) throw new Error("A finding cannot be verified by its reviewer"); if (to === "dismissed" && !options.reason?.trim()) throw new Error("A dismissal reason is required"); if (to === "open" && !options.reason?.trim() && evidence.length === 0) throw new Error("Reopening a finding requires a reason or evidence"); const now = Date.now(); item.transitions.push({ from: item.lifecycle, to, at: now, actor, ...(options.reason ? { reason: redactSecrets(options.reason).slice(0, 2000) } : {}), ...(options.fixRef ? { fixRef: options.fixRef.slice(0, 300) } : {}), ...(evidence.length ? { evidence } : {}), version: item.version + 1 }); item.lifecycle = to; item.version += 1; item.updatedAt = now; if (options.fixRef) item.fixRef = options.fixRef.slice(0, 300); if (to === "verified") item.verifier = { ...actor, ...(options.revision ? { revision: options.revision.slice(0, 160) } : {}) }; if (to === "dismissed") item.dismissalReason = redactSecrets(options.reason!).slice(0, 2000); write(this.workspace, all); return item; }); }
  hasBlockingFindings(filter: ReviewFindingFilter = {}): boolean { return this.list(filter).some(item => (item.severity === "critical" || item.severity === "error") && !["verified", "dismissed"].includes(item.lifecycle)); }
  canIntegrate(filter: ReviewFindingFilter = {}): boolean { return !this.hasBlockingFindings(filter); }
  export(filter: ReviewFindingFilter = {}): { schemaVersion: 1; findings: StoredReviewFinding[] } { return { schemaVersion: 1, findings: this.list(filter) }; }
  delete(_id: string): never {
    throw new Error("Review findings are append-only; use a lifecycle transition with a reason and expectedVersion");
  }
}
