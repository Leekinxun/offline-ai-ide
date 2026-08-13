import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { listManagedWorktrees, updateManagedWorktreeMetadata } from "./worktrees.js";
import { ReviewFindingStore, type StoredReviewFinding } from "./reviewFindingStore.js";
import { hasCompletedChangeSetReview } from "./changeSetReviewRun.js";
import { CollaborationStore, type CollaborationConflict } from "../collaboration/collaborationStore.js";
import { safePath } from "../utils/safePath.js";
import { isProcessAlive } from "../utils/processLiveness.js";
import { collectChangeEvidenceGaps, type ChangeEvidenceGap } from "./changeEvidence.js";
import { CURRENT_CHANGE_SET_SCHEMA_VERSION, CURRENT_CHANGE_SET_WAL_SCHEMA_VERSION } from "./changeSetSchema.js";

export type ChangeSetDecision = "apply" | "cherry_pick" | "merge" | "reject" | "request_revision";
export type ChangeSetStatus = "running" | "ready_for_review" | "applying" | "applied" | "rejected" | "needs_revision" | "needs_attention" | "failed" | "no_changes";

export interface ChangeSet {
  schemaVersion: 1 | 2 | typeof CURRENT_CHANGE_SET_SCHEMA_VERSION;
  id: string;
  worktreeId: string;
  baseSha: string;
  branch: string;
  headSha: string;
  dirty: boolean;
  changedFiles: string[];
  patchSha256: string;
  /** Relative immutable content-addressed blob, introduced in schema v2. */
  patchBlob?: string;
  patchManifest?: Array<{ path: string; sha256: string; kind: "patch" | "untracked" }>;
  status: ChangeSetStatus;
  ownerId?: string;
  parentRunId?: string;
  parentTaskId?: number;
  childRunId?: string;
  toolCallId?: string;
  agentName?: string;
  memberName?: string;
  checks?: unknown;
  verificationEvidence?: unknown;
  createdAt: string;
  reviewedAt?: string;
  appliedAt?: string;
  failedAt?: string;
  decision?: ChangeSetDecision;
  decisionActorId?: string;
  decisionActorIsAdmin?: boolean;
  /** Legacy schema-v2 checksum. New captures use immutable + transition envelopes. */
  integritySha256?: string;
  captureIntegritySha256?: string;
  transitionVersion?: number;
  transitionIntegritySha256?: string;
}

export interface ChangeSetPreflight {
  decision: ChangeSetDecision;
  applicable: boolean;
  reasons: string[];
  overlappingWorktrees: Array<{ worktreeId: string; changedFiles: string[] }>;
  threeWayConflict: boolean;
  /** Critical/error review findings that prevent this immutable revision being integrated. */
  blockingFindings?: ChangeSetReviewBlock[];
  /** Human buffer/saved/upstream conflicts not covered by an exact CAS merge decision. */
  collaborationConflicts?: CollaborationConflict[];
  /** Persisted mutation/change evidence gaps that require revision before integration. */
  changeEvidenceGaps?: ChangeEvidenceGap[];
}

export interface ChangeSetDecisionActor { id?: string; isAdmin?: boolean; }
export interface ChangeSetReviewBlock { id: string; severity: "critical" | "error"; lifecycle: string; reason: string; fixRef?: string; }
export type ChangeSetEvidenceGap = ChangeEvidenceGap;
export class ChangeSetEvidenceGapError extends Error {
  readonly code = "change_set_evidence_gap";
  readonly recoverableDecisions = ["request_revision", "reject"] as const;
  constructor(public readonly gaps: ChangeSetEvidenceGap[]) {
    super(`Change set mutation evidence is incomplete: ${gaps.map((gap) => `${gap.path ? `${gap.path}:` : ""}${gap.reason}`).join(", ")}`);
    this.name = "ChangeSetEvidenceGapError";
  }
}
export class ChangeSetCaptureGitError extends Error {
  readonly code = "change_set_capture_git_failed";
  constructor(readonly worktreeId: string, readonly command: string, cause: unknown) {
    super(`Change set capture requires successful git inspection (${command})`, { cause });
    this.name = "ChangeSetCaptureGitError";
  }
}
export class ChangeSetReviewGateError extends Error {
  constructor(public readonly blockingFindings: ChangeSetReviewBlock[]) { super("Change set review gate failed"); }
}
export class ChangeSetCollaborationGateError extends Error {
  constructor(public readonly collaborationConflicts: CollaborationConflict[]) { super("Change set human collaboration gate failed"); }
}
export class ChangeSetStoreCorruptionError extends Error {
  readonly code = "change_set_store_corrupt";
  readonly recoveryStatus = "needs_attention" as const;
  constructor(readonly storePath: string, reason: string, cause?: unknown) {
    super(`Change set store is corrupt or unreadable: ${reason}`, { cause });
    this.name = "ChangeSetStoreCorruptionError";
  }
}

export type ChangeSetIntegrationStage = "after_write_ahead" | "after_parent_mutation";
type ChangeSetIntegrationHook = (stage: ChangeSetIntegrationStage) => void;
let integrationHookForTests: ChangeSetIntegrationHook | undefined;
export function setChangeSetIntegrationHookForTests(hook: ChangeSetIntegrationHook | undefined): void { integrationHookForTests = hook; }
export class ChangeSetIntegrationCrashError extends Error {
  constructor(message = "Simulated integration process crash") { super(message); this.name = "ChangeSetIntegrationCrashError"; }
}
export class ChangeSetIntegrationConflictError extends Error { readonly code = "change_set_integration_conflict"; constructor() { super("Change set integration or recovery is already in progress"); this.name = "ChangeSetIntegrationConflictError"; } }
export class ChangeSetLockRecoveryRequiredError extends Error {
  readonly code = "change_set_lock_recovery_required";
  readonly recoveryStatus = "needs_attention" as const;
  constructor(readonly lockKind: "integration" | "transition", reason: string) { super(`Change set ${lockKind} lock requires explicit recovery: ${reason}`); this.name = "ChangeSetLockRecoveryRequiredError"; }
}
export interface ChangeSetRecoveryResult {
  changeSet: ChangeSet;
  recovery: {
    state: "recovered" | "not_required" | "needs_attention";
    transactionStatus: "recovered" | "applied" | "failed" | "needs_attention" | "unchanged";
    manualRecoveryRequired: boolean;
  };
}

interface IntegrationTransactionV3 extends Record<string, unknown> {
  schemaVersion: typeof CURRENT_CHANGE_SET_WAL_SCHEMA_VERSION;
  changeSetId: string;
  decision: ChangeSetDecision;
  originalHead: string;
  expectedParentHead: string;
  expectedParentRef: string;
  intendedHead: string;
  phase: "prepared" | "mutating" | "applied" | "failed" | "recovered" | "needs_attention";
  resultHead?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  integritySha256?: string;
}

type ChangeSetGitCommandHook = (directory: string, args: readonly string[]) => void;
let gitCommandHookForTests: ChangeSetGitCommandHook | undefined;
export function setChangeSetGitCommandHookForTests(hook: ChangeSetGitCommandHook | undefined): void { gitCommandHookForTests = hook; }
class GitCommandError extends Error {
  constructor(readonly args: readonly string[], readonly exitCode: number | undefined, readonly stdout: string, message: string, cause: unknown) {
    super(message, { cause }); this.name = "GitCommandError";
  }
}
function gitOutputStrict(dir: string, args: string[]): string {
  try {
    gitCommandHookForTests?.(dir, args);
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const failure = error as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    const stderr = failure.stderr?.toString().trim();
    throw new GitCommandError(args, failure.status, failure.stdout?.toString() || "", stderr || (error instanceof Error ? error.message : "Git command failed"), error);
  }
}
function git(dir: string, args: string[]): string { return gitOutputStrict(dir, args).trim(); }
function gitDiffNoIndex(dir: string, args: string[]): string {
  try { return gitOutputStrict(dir, args); }
  catch (error) { if (error instanceof GitCommandError && error.exitCode === 1) return error.stdout; throw error; }
}
function gitResult(dir: string, args: string[]): boolean { try { git(dir, args); return true; } catch { return false; } }
function repositoryRoot(dir: string): string { return path.resolve(git(dir, ["rev-parse", "--show-toplevel"])); }
function storeDir(repository: string): string { return path.join(repository, ".history", "change-sets"); }
function storePath(repository: string, id: string): string { return path.join(storeDir(repository), `${id}.json`); }
function blobPath(repository: string, id: string): string { return path.join(storeDir(repository), "blobs", `${id}.patch`); }
function hash(value: string | Buffer): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function safeId(id: string): string { if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid change set id"); return id; }
function integration(decision: ChangeSetDecision): boolean { return decision === "apply" || decision === "cherry_pick" || decision === "merge"; }
const REVIEW_GATE_REASON = "Review findings block integration";
function reviewIsSolePreflightBlock(preflight: ChangeSetPreflight): boolean {
  return Boolean(preflight.blockingFindings?.length) && preflight.reasons.length === 1 && preflight.reasons[0] === REVIEW_GATE_REASON;
}
function hasEvidence(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value !== "string" || value.trim().length > 0;
}

function reviewRevision(changeSet: ChangeSet): string { return changeSetReviewRevision(changeSet); }
function reviewBlocks(repository: string, changeSet: ChangeSet, actor?: ChangeSetDecisionActor): ChangeSetReviewBlock[] {
  const revision = reviewRevision(changeSet);
  const findings = new ReviewFindingStore(repository).list().filter((item) => item.severity === "critical" || item.severity === "error");
  const blocks: ChangeSetReviewBlock[] = [];
  if (!hasCompletedChangeSetReview(repository, changeSet.id, revision)) blocks.push({ id: "change-set-independent-review", severity: "error", lifecycle: "open", reason: "Completed independent review is required for this immutable revision" });
  if (!hasEvidence(changeSet.verificationEvidence)) blocks.push({ id: "change-set-evidence", severity: "error", lifecycle: "open", reason: "Integration evidence is required" });
  for (const finding of findings) {
    const block = reviewBlock(finding, changeSet, revision, actor);
    if (block) blocks.push(block);
  }
  return blocks;
}
function reviewBlock(finding: StoredReviewFinding, changeSet: ChangeSet, revision: string, actor?: ChangeSetDecisionActor): ChangeSetReviewBlock | undefined {
  const base = { id: finding.id, severity: finding.severity as "critical" | "error", lifecycle: finding.lifecycle, ...(finding.fixRef ? { fixRef: finding.fixRef } : {}) };
  // Only server-bound evidence for this exact immutable ChangeSet revision is relevant.
  if (finding.reviewer?.changeSetId !== changeSet.id || finding.reviewer.revision !== revision) return undefined;
  if (finding.lifecycle === "dismissed") {
    const dismissal = [...finding.transitions].reverse().find((transition) => transition.to === "dismissed");
    if (!dismissal?.actor?.id || !dismissal.reason?.trim()) return { ...base, reason: "Dismissal/waiver requires an authorized actor and reason" };
    if (dismissal.actor.id === changeSet.ownerId) return { ...base, reason: "Change set writer cannot waive their own finding" };
    if (!actor?.isAdmin) return { ...base, reason: "An authorized actor must approve the dismissal/waiver" };
    return undefined;
  }
  if (finding.lifecycle !== "verified") return { ...base, reason: "Critical/error finding remains unresolved" };
  if (!finding.reviewer?.id || !finding.verifier?.id) return { ...base, reason: "Independent reviewer and verifier records are required" };
  if (finding.reviewer.id === changeSet.ownerId || finding.verifier.id === changeSet.ownerId) return { ...base, reason: "Change set writer cannot review or verify their own finding" };
  if (finding.reviewer.id === finding.verifier.id) return { ...base, reason: "Reviewer and verifier must be independent" };
  if (finding.verifier.revision !== revision) return { ...base, reason: "Verification is stale for this immutable change set revision" };
  const verification = [...finding.transitions].reverse().find((transition) => transition.to === "verified");
  if (!verification?.evidence?.length) return { ...base, reason: "Verification evidence is required" };
  return undefined;
}
function integrationLock(repository: string): { release: () => void } {
  const file = path.join(storeDir(repository), "integration.lock"); fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = crypto.randomUUID();
  try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }), { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new ChangeSetLockRecoveryRequiredError("integration", "lock acquisition failed");
    try {
      const owner = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number; token?: string; createdAt?: number };
      if (!Number.isSafeInteger(owner.pid) || !owner.token || !Number.isFinite(owner.createdAt)) throw new ChangeSetLockRecoveryRequiredError("integration", "owner metadata is malformed");
      if (Date.now() - owner.createdAt! > 60_000 || !isProcessAlive(owner.pid!)) throw new ChangeSetLockRecoveryRequiredError("integration", "owner identity is stale or cannot be proven safe to replace");
    } catch (ownerError) { if (ownerError instanceof ChangeSetLockRecoveryRequiredError) throw ownerError; throw new ChangeSetLockRecoveryRequiredError("integration", "owner metadata cannot be read safely"); }
    throw new ChangeSetIntegrationConflictError();
  }
  return { release: () => { try { const owner = JSON.parse(fs.readFileSync(file, "utf8")) as { token?: string }; if (owner.token === token) fs.rmSync(file); } catch { /* already released */ } } };
}
function transactionIntegrity(value: Record<string, unknown>): string { const { integritySha256: _integrity, ...envelope } = value; return hash(canonicalJson({ kind: "crewforge-change-set-integration-v3", ...envelope })); }
function writeTransaction<T extends { changeSetId: string; schemaVersion?: number }>(repository: string, value: T): void {
  const persisted = value.schemaVersion === CURRENT_CHANGE_SET_WAL_SCHEMA_VERSION ? { ...value, integritySha256: transactionIntegrity(value) } : value;
  const file = path.join(storeDir(repository), "transactions", `${value.changeSetId}.json`); fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`; fs.writeFileSync(temporary, `${JSON.stringify(persisted, null, 2)}\n`, { flag: "wx" }); fs.renameSync(temporary, file);
}
const PROTECTED = new Set([".git", ".history", ".checkpoints", ".team", ".codex", ".omx", ".crewforge", ".crownforge-worktrees"]);
function validateChangedPath(value: string): string {
  if (!value || value.includes("\0") || value.includes("\n") || value.includes("\r") || path.isAbsolute(value) || value.includes("\\")) throw new Error("Ambiguous or absolute changed path");
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === ".." || normalized.startsWith("../") || PROTECTED.has(normalized.split("/")[0])) throw new Error(`Protected or unsafe changed path: ${value}`);
  return value;
}
function nulPaths(output: string): string[] { return output.split("\0").filter(Boolean).map(validateChangedPath); }
function parentIsClean(repository: string): boolean {
  return git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]).split("\n").filter(Boolean)
    .every((line) => PROTECTED.has(line.slice(3).split("/")[0]));
}
function parentDirtyPaths(repository: string): string[] { return git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]).split("\n").filter(Boolean).map((line) => line.slice(3)).filter((relative) => !PROTECTED.has(relative.split("/")[0])).map((relative) => relative.includes(" -> ") ? relative.slice(relative.indexOf(" -> ") + 4) : relative); }
function agentFileDigests(repository: string, changeSet: ChangeSet): Record<string, string> { const worktree = listManagedWorktrees(repository).find((item) => item.id === changeSet.worktreeId); if (!worktree) return {}; const result: Record<string, string> = {}; for (const relative of changeSet.changedFiles) { try { const target = safePath(relative, path.resolve(worktree.path)); const stat = fs.lstatSync(target); if (!stat.isFile() || stat.isSymbolicLink()) continue; result[relative] = hash(fs.readFileSync(target)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") result[relative] = hash(""); } } return result; }

function normalize(value: ChangeSet): ChangeSet {
  if (value.schemaVersion === 2 || value.schemaVersion === CURRENT_CHANGE_SET_SCHEMA_VERSION) return value;
  if (value.schemaVersion !== 1) throw new Error("Unsupported change set schema version");
  const legacy = value.status as string;
  const current = new Set<ChangeSetStatus>(["running", "ready_for_review", "applying", "applied", "rejected", "needs_revision", "needs_attention", "failed", "no_changes"]);
  return { ...value, status: legacy === "revision_requested" ? "needs_revision" : current.has(legacy as ChangeSetStatus) ? legacy as ChangeSetStatus : "ready_for_review" };
}
function canonicalJson(value: unknown): string {
  const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
  const normalizeValue = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalizeValue);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => compare(left, right))
      .map(([key, nested]) => [key, normalizeValue(nested)]));
  };
  return JSON.stringify(normalizeValue(value));
}
function captureEnvelope(changeSet: ChangeSet): unknown {
  return {
    kind: "crewforge-change-set-capture-v3", schemaVersion: changeSet.schemaVersion,
    id: changeSet.id, worktreeId: changeSet.worktreeId, baseSha: changeSet.baseSha, branch: changeSet.branch,
    headSha: changeSet.headSha, dirty: changeSet.dirty, changedFiles: [...changeSet.changedFiles].sort(),
    patch: { sha256: changeSet.patchSha256, blob: changeSet.patchBlob, manifest: [...(changeSet.patchManifest || [])].sort((a, b) => canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0) },
    identity: { ownerId: changeSet.ownerId, parentRunId: changeSet.parentRunId, parentTaskId: changeSet.parentTaskId, childRunId: changeSet.childRunId, toolCallId: changeSet.toolCallId, agentName: changeSet.agentName, memberName: changeSet.memberName },
    evidence: { checks: changeSet.checks, verificationEvidence: changeSet.verificationEvidence }, createdAt: changeSet.createdAt,
  };
}
function transitionEnvelope(changeSet: ChangeSet): unknown {
  return {
    kind: "crewforge-change-set-transition-v1", schemaVersion: changeSet.schemaVersion,
    captureIntegritySha256: changeSet.captureIntegritySha256, version: changeSet.transitionVersion,
    status: changeSet.status, decision: changeSet.decision, reviewedAt: changeSet.reviewedAt,
    decisionActorId: changeSet.decisionActorId, decisionActorIsAdmin: changeSet.decisionActorIsAdmin,
    appliedAt: changeSet.appliedAt, failedAt: changeSet.failedAt,
  };
}
function captureIntegrity(changeSet: ChangeSet): string { return hash(canonicalJson(captureEnvelope(changeSet))); }
export function changeSetReviewRevision(changeSet: ChangeSet): string {
  if (changeSet.schemaVersion !== CURRENT_CHANGE_SET_SCHEMA_VERSION || !changeSet.captureIntegritySha256) throw new Error("Legacy ChangeSet must be recaptured before independent review");
  if (captureIntegrity(changeSet) !== changeSet.captureIntegritySha256) throw new Error("ChangeSet capture integrity is invalid");
  return changeSet.captureIntegritySha256;
}
export function computeChangeSetTransitionIntegrity(changeSet: ChangeSet): string { return hash(canonicalJson(transitionEnvelope(changeSet))); }
function legacyIntegrity(changeSet: ChangeSet): string {
  return hash(JSON.stringify({ v: changeSet.schemaVersion, id: changeSet.id, worktreeId: changeSet.worktreeId, base: changeSet.baseSha, head: changeSet.headSha, patch: changeSet.patchSha256, files: [...changeSet.changedFiles].sort(), evidence: changeSet.verificationEvidence, status: changeSet.status }));
}
const V3_FIELDS = new Set(["schemaVersion", "id", "worktreeId", "baseSha", "branch", "headSha", "dirty", "changedFiles", "patchSha256", "patchBlob", "patchManifest", "status", "ownerId", "parentRunId", "parentTaskId", "childRunId", "toolCallId", "agentName", "memberName", "checks", "verificationEvidence", "createdAt", "reviewedAt", "appliedAt", "failedAt", "decision", "decisionActorId", "decisionActorIsAdmin", "captureIntegritySha256", "transitionVersion", "transitionIntegritySha256"]);
function validateV3(changeSet: ChangeSet): void {
  const unknown = Object.keys(changeSet).filter((key) => !V3_FIELDS.has(key));
  if (unknown.length) throw new Error(`Unknown schema-v3 fields: ${unknown.join(", ")}`);
  const statuses = new Set<ChangeSetStatus>(["running", "ready_for_review", "applying", "applied", "rejected", "needs_revision", "needs_attention", "failed", "no_changes"]);
  const decisions = new Set<ChangeSetDecision>(["apply", "cherry_pick", "merge", "reject", "request_revision"]);
  if (!/^[a-f0-9]{64}$/.test(changeSet.id) || !changeSet.worktreeId || !/^[a-f0-9]{40,64}$/.test(changeSet.baseSha) || !changeSet.branch.trim() || !/^[a-f0-9]{40,64}$/.test(changeSet.headSha) || typeof changeSet.dirty !== "boolean" || !Array.isArray(changeSet.changedFiles) || !changeSet.changedFiles.every((item) => typeof item === "string") || !/^[a-f0-9]{64}$/.test(changeSet.patchSha256) || !changeSet.patchBlob || !Array.isArray(changeSet.patchManifest) || !statuses.has(changeSet.status) || !changeSet.createdAt || !Number.isFinite(Date.parse(changeSet.createdAt)) || !Number.isSafeInteger(changeSet.transitionVersion) || changeSet.transitionVersion! < 1) throw new Error("Change set schema-v3 required fields are missing or invalid");
  if (new Set(changeSet.changedFiles).size !== changeSet.changedFiles.length) throw new Error("Change set changedFiles must be unique");
  for (const entry of changeSet.patchManifest) if (!entry || typeof entry.path !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256) || (entry.kind !== "patch" && entry.kind !== "untracked")) throw new Error("Invalid patch manifest entry");
  for (const field of ["ownerId", "parentRunId", "childRunId", "toolCallId", "agentName", "memberName"] as const) if (changeSet[field] !== undefined && (typeof changeSet[field] !== "string" || !changeSet[field]!.trim())) throw new Error(`Invalid ${field}`);
  if (changeSet.parentTaskId !== undefined && (!Number.isSafeInteger(changeSet.parentTaskId) || changeSet.parentTaskId < 0)) throw new Error("Invalid parentTaskId");
  if (changeSet.decision !== undefined && !decisions.has(changeSet.decision)) throw new Error("Invalid decision");
  if (changeSet.decisionActorId !== undefined && (typeof changeSet.decisionActorId !== "string" || !changeSet.decisionActorId.trim())) throw new Error("Invalid decisionActorId");
  if (changeSet.decisionActorIsAdmin !== undefined && typeof changeSet.decisionActorIsAdmin !== "boolean") throw new Error("Invalid decisionActorIsAdmin");
  for (const field of ["reviewedAt", "appliedAt", "failedAt"] as const) if (changeSet[field] !== undefined && (typeof changeSet[field] !== "string" || !Number.isFinite(Date.parse(changeSet[field]!)))) throw new Error(`Invalid ${field}`);
  if (changeSet.status === "applying" && !changeSet.decision?.match(/^(apply|cherry_pick|merge)$/)) throw new Error("Applying ChangeSet is missing its integration decision");
  if (changeSet.status === "applied" && (!changeSet.decision?.match(/^(apply|cherry_pick|merge)$/) || !changeSet.reviewedAt || !changeSet.appliedAt)) throw new Error("Applied ChangeSet is missing transition evidence");
  if (changeSet.status === "rejected" && (changeSet.decision !== "reject" || !changeSet.reviewedAt)) throw new Error("Rejected ChangeSet is missing transition evidence");
  if (changeSet.status === "needs_revision" && (changeSet.decision !== "request_revision" || !changeSet.reviewedAt)) throw new Error("Revision request is missing transition evidence");
  if (changeSet.status === "failed" && !changeSet.failedAt) throw new Error("Failed ChangeSet is missing failure evidence");
  if (changeSet.captureIntegritySha256 !== captureIntegrity(changeSet)) throw new Error("Change set capture integrity checksum mismatch");
  if (changeSet.transitionIntegritySha256 !== computeChangeSetTransitionIntegrity(changeSet)) throw new Error("Change set transition integrity checksum mismatch");
}
function writeChangeSet(repository: string, changeSet: ChangeSet): void {
  fs.mkdirSync(storeDir(repository), { recursive: true });
  const target = storePath(repository, changeSet.id); const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(changeSet, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); fs.renameSync(temporary, target);
}
function transitionLock(repository: string, id: string): { release: () => void } {
  const file = path.join(storeDir(repository), `${id}.transition.lock`); fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = crypto.randomUUID();
  try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }), { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new ChangeSetLockRecoveryRequiredError("transition", "lock acquisition failed");
    try {
      const owner = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number; token?: string; createdAt?: number };
      if (!Number.isSafeInteger(owner.pid) || !owner.token || !Number.isFinite(owner.createdAt)) throw new ChangeSetLockRecoveryRequiredError("transition", "owner metadata is malformed");
      if (Date.now() - owner.createdAt! > 60_000 || !isProcessAlive(owner.pid!)) throw new ChangeSetLockRecoveryRequiredError("transition", "owner identity is stale or cannot be proven safe to replace");
    } catch (ownerError) { if (ownerError instanceof ChangeSetLockRecoveryRequiredError) throw ownerError; throw new ChangeSetLockRecoveryRequiredError("transition", "owner metadata cannot be read safely"); }
    throw new Error("Change set transition is already in progress");
  }
  return { release: () => { try { const owner = JSON.parse(fs.readFileSync(file, "utf8")) as { token?: string }; if (owner.token === token) fs.rmSync(file); } catch { /* already released */ } } };
}
function saveCaptured(repository: string, changeSet: ChangeSet): ChangeSet {
  const lock = transitionLock(repository, changeSet.id);
  try {
    const target = storePath(repository, changeSet.id);
    if (fs.existsSync(target)) {
      const current = readStoredChangeSet(target);
      if (current.schemaVersion !== CURRENT_CHANGE_SET_SCHEMA_VERSION) throw new Error("Existing legacy ChangeSet id must be explicitly recaptured as a new revision");
      const candidate = { ...changeSet, createdAt: current.createdAt };
      candidate.captureIntegritySha256 = captureIntegrity(candidate);
      if (candidate.captureIntegritySha256 !== current.captureIntegritySha256) throw new Error("Change set id collision has different capture semantics");
      return current;
    }
    changeSet.captureIntegritySha256 = captureIntegrity(changeSet);
    changeSet.transitionVersion = 1;
    changeSet.transitionIntegritySha256 = computeChangeSetTransitionIntegrity(changeSet);
    validateV3(changeSet); writeChangeSet(repository, changeSet); return changeSet;
  } finally { lock.release(); }
}
function saveTransition(repository: string, changeSet: ChangeSet): ChangeSet {
  if (changeSet.schemaVersion !== CURRENT_CHANGE_SET_SCHEMA_VERSION) throw new Error("Legacy ChangeSet is read-only and must be recaptured before state transitions");
  const lock = transitionLock(repository, changeSet.id);
  try {
    const current = readStoredChangeSet(storePath(repository, changeSet.id));
    if (current.schemaVersion !== CURRENT_CHANGE_SET_SCHEMA_VERSION || current.transitionVersion !== changeSet.transitionVersion || current.transitionIntegritySha256 !== changeSet.transitionIntegritySha256) throw new Error("Change set transition version conflict");
    if (current.captureIntegritySha256 !== changeSet.captureIntegritySha256 || captureIntegrity(changeSet) !== current.captureIntegritySha256) throw new Error("Change set capture semantics changed during transition");
    const allowed: Partial<Record<ChangeSetStatus, ChangeSetStatus[]>> = { ready_for_review: ["applying", "rejected", "needs_revision", "needs_attention", "failed"], applying: ["ready_for_review", "applied", "failed", "needs_attention"], needs_attention: ["needs_attention", "ready_for_review", "applied", "rejected", "needs_revision", "failed"], no_changes: ["rejected", "needs_revision"] };
    if (changeSet.status !== current.status && !allowed[current.status]?.includes(changeSet.status)) throw new Error(`Invalid ChangeSet transition: ${current.status} -> ${changeSet.status}`);
    const next = { ...changeSet, transitionVersion: current.transitionVersion! + 1 };
    next.transitionIntegritySha256 = computeChangeSetTransitionIntegrity(next);
    validateV3(next); writeChangeSet(repository, next); Object.assign(changeSet, next); return changeSet;
  } finally { lock.release(); }
}
function validateInput(repository: string, changeSet: ChangeSet): ChangeSet {
  try {
    const normalized = validateIntegrity(normalize(changeSet));
    if (normalized.schemaVersion === CURRENT_CHANGE_SET_SCHEMA_VERSION) patchFor(repository, normalized);
    return normalized;
  } catch (error) {
    throw new ChangeSetStoreCorruptionError(storePath(repository, changeSet.id), error instanceof Error ? error.message : "invalid change set metadata", error);
  }
}
function validateIntegrity(changeSet: ChangeSet): ChangeSet {
  if (changeSet.schemaVersion === 2 && changeSet.integritySha256 !== legacyIntegrity(changeSet)) throw new Error("Change set metadata integrity checksum mismatch");
  if (changeSet.schemaVersion === CURRENT_CHANGE_SET_SCHEMA_VERSION) validateV3(changeSet);
  return changeSet;
}
function readStoredChangeSet(target: string): ChangeSet {
  let source: string;
  try {
    source = fs.readFileSync(target, "utf8");
  } catch (error) {
    throw new ChangeSetStoreCorruptionError(target, "persisted source cannot be read", error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new ChangeSetStoreCorruptionError(target, "persisted source is not valid JSON", error);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ChangeSetStoreCorruptionError(target, "persisted root must be an object");
  const value = parsed as ChangeSet;
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== CURRENT_CHANGE_SET_SCHEMA_VERSION) throw new ChangeSetStoreCorruptionError(target, "unsupported schema version");
  try {
    const changeSet = validateIntegrity(normalize(value));
    if (changeSet.schemaVersion === CURRENT_CHANGE_SET_SCHEMA_VERSION) patchFor(path.resolve(path.dirname(target), "../.."), changeSet);
    return changeSet;
  } catch (error) {
    throw new ChangeSetStoreCorruptionError(target, error instanceof Error ? error.message : "invalid persisted metadata", error);
  }
}
function patchFor(repository: string, changeSet: ChangeSet): Buffer {
  if (!changeSet.patchBlob) throw new Error("Legacy change set has no persisted patch blob");
  const file = path.resolve(storeDir(repository), changeSet.patchBlob);
  if (!file.startsWith(path.resolve(storeDir(repository), "blobs") + path.sep)) throw new Error("Invalid patch blob path");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Patch blob must be a regular non-symlink file");
  const realRoot = fs.realpathSync(path.join(storeDir(repository), "blobs"));
  if (!fs.realpathSync(file).startsWith(realRoot + path.sep)) throw new Error("Patch blob escapes its content store");
  const content = fs.readFileSync(file);
  if (hash(content) !== changeSet.patchSha256) throw new Error("Persisted change set patch digest mismatch");
  if (changeSet.patchManifest?.length !== 1 || changeSet.patchManifest[0].path !== changeSet.patchBlob || changeSet.patchManifest[0].sha256 !== changeSet.patchSha256 || changeSet.patchManifest[0].kind !== "patch") throw new Error("Patch manifest does not match persisted blob");
  return content;
}

function validatePatchScope(repository: string, changeSet: ChangeSet, patchFile: string): void {
  const output = gitOutputStrict(repository, ["apply", "--numstat", "-z", patchFile]);
  const touched = [...new Set(output.split("\0").filter(Boolean).map((entry) => validateChangedPath(entry.slice(entry.indexOf("\t", entry.indexOf("\t") + 1) + 1))))].sort();
  const declared = [...new Set(changeSet.changedFiles.map(validateChangedPath))].sort();
  if (!touched.length) throw new Error("No-op change sets cannot be applied");
  if (JSON.stringify(touched) !== JSON.stringify(declared)) throw new Error("Persisted patch scope does not match change set metadata");
}
function updateWorktreeMetadata(repository: string, id: string, status: Parameters<typeof updateManagedWorktreeMetadata>[2], reviewState: Parameters<typeof updateManagedWorktreeMetadata>[3]): void {
  updateManagedWorktreeMetadata(repository, id, status, reviewState);
}

function prepareIntegrationCommit(repository: string, changeSet: ChangeSet, decision: ChangeSetDecision, expectedParentHead: string): string {
  const temporaryRoot = fs.mkdtempSync(path.join(path.dirname(repository), ".crewforge-integration-"));
  const temporaryWorktree = path.join(temporaryRoot, "worktree");
  let added = false;
  try {
    git(repository, ["worktree", "add", "--detach", temporaryWorktree, expectedParentHead]);
    added = true;
    if (decision === "merge") {
      if (changeSet.dirty) throw new Error("Merge requires a committed-only change set");
      git(temporaryWorktree, ["merge", "--no-ff", "--no-edit", changeSet.headSha]);
    } else if (decision === "cherry_pick") {
      if (changeSet.dirty) throw new Error("Cherry-pick requires a committed-only change set");
      git(temporaryWorktree, ["cherry-pick", `${changeSet.baseSha}..${changeSet.headSha}`]);
    } else {
      const patch = patchFor(repository, changeSet);
      const patchFile = path.join(storeDir(repository), "blobs", `.prepare-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.patch`);
      fs.writeFileSync(patchFile, patch, { flag: "wx" });
      try { validatePatchScope(repository, changeSet, patchFile); git(temporaryWorktree, ["apply", "--index", "--3way", patchFile]); }
      finally { fs.rmSync(patchFile, { force: true }); }
      git(temporaryWorktree, ["commit", "-m", `Apply change set ${changeSet.id.slice(0, 12)}`]);
    }
    return git(temporaryWorktree, ["rev-parse", "HEAD"]);
  } finally {
    if (added) try { git(repository, ["worktree", "remove", "--force", temporaryWorktree]); } catch { /* recovery can prune an orphaned temporary worktree */ }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function symbolicHead(repository: string): string | undefined {
  try { return git(repository, ["symbolic-ref", "HEAD"]); } catch { return undefined; }
}

function assertParentCas(repository: string, expectedParentRef: string, expectedParentHead: string): void {
  if (symbolicHead(repository) !== expectedParentRef) throw new Error("Parent ref changed after integration write-ahead record");
  if (git(repository, ["rev-parse", expectedParentRef]) !== expectedParentHead || git(repository, ["rev-parse", "HEAD"]) !== expectedParentHead) throw new Error("Parent HEAD changed after integration write-ahead record");
  if (!parentIsClean(repository)) throw new Error("Parent worktree changed after integration write-ahead record");
}

function workingStateMatchesCommit(repository: string, commit: string): boolean {
  if (!gitResult(repository, ["diff", "--quiet", commit, "--"])) return false;
  return git(repository, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean).every((relative) => PROTECTED.has(relative.split("/")[0]));
}

function transactionPath(repository: string, id: string): string { return path.join(storeDir(repository), "transactions", `${id}.json`); }

function readIntegrationTransaction(repository: string, id: string): IntegrationTransactionV3 | { schemaVersion?: 1 | 2; originalHead?: string; phase?: string } {
  const file = transactionPath(repository, id);
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw new ChangeSetStoreCorruptionError(file, "interrupted integration has no valid transaction record", error); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Interrupted integration transaction is not recoverable");
  const record = value as { schemaVersion?: unknown; originalHead?: unknown; phase?: unknown };
  if (record.schemaVersion !== undefined && record.schemaVersion !== 1 && record.schemaVersion !== 2 && record.schemaVersion !== CURRENT_CHANGE_SET_WAL_SCHEMA_VERSION) throw new ChangeSetStoreCorruptionError(file, "unsupported integration transaction schema");
  if (record.schemaVersion !== CURRENT_CHANGE_SET_WAL_SCHEMA_VERSION) return { schemaVersion: record.schemaVersion as 1 | 2 | undefined, originalHead: typeof record.originalHead === "string" ? record.originalHead : undefined, phase: typeof record.phase === "string" ? record.phase : undefined };
  const transaction = value as Partial<IntegrationTransactionV3>;
  if (transaction.changeSetId !== id || !integration(transaction.decision as ChangeSetDecision) || !transaction.originalHead || !transaction.expectedParentHead || !transaction.expectedParentRef || !transaction.intendedHead || !transaction.phase || !transaction.createdAt || !transaction.updatedAt || transaction.integritySha256 !== transactionIntegrity(transaction as Record<string, unknown>)) throw new ChangeSetStoreCorruptionError(file, "integration transaction integrity check failed");
  return transaction as IntegrationTransactionV3;
}

export function listChangeSets(workspaceDir: string): ChangeSet[] {
  const repository = repositoryRoot(workspaceDir);
  const directory = storeDir(repository);
  let files: string[];
  try {
    files = fs.readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new ChangeSetStoreCorruptionError(directory, "store directory cannot be read", error);
  }
  return files.filter((file) => file.endsWith(".json")).map((file) => readStoredChangeSet(path.join(directory, file))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function getChangeSet(workspaceDir: string, id: string): ChangeSet {
  const repository = repositoryRoot(workspaceDir); const normalized = safeId(id);
  try {
    return readStoredChangeSet(storePath(repository, normalized));
  } catch (error) {
    if (error instanceof ChangeSetStoreCorruptionError && (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT") throw new Error("Change set not found");
    throw error;
  }
}

/** Returns the integrity-checked immutable patch bytes for artifact export. */
export function readChangeSetPatch(workspaceDir: string, id: string): Buffer {
  const repository = repositoryRoot(workspaceDir);
  return Buffer.from(patchFor(repository, getChangeSet(repository, id)));
}

function recoverInterruptedChangeSetLocked(repository: string, id: string, allowRetry: boolean): ChangeSet {
  const changeSet = getChangeSet(repository, id);
  if (changeSet.status !== "applying" && changeSet.status !== "needs_attention") return changeSet;
  if (changeSet.status === "needs_attention" && collectChangeEvidenceGaps(changeSet.checks, changeSet.verificationEvidence).length) return changeSet;
  const transaction = readIntegrationTransaction(repository, id);
  if (transaction.schemaVersion !== CURRENT_CHANGE_SET_WAL_SCHEMA_VERSION) {
    if (!transaction.originalHead || transaction.phase !== "applying") throw new Error("Interrupted integration transaction is not recoverable");
    if (git(repository, ["rev-parse", "HEAD"]) !== transaction.originalHead || !parentIsClean(repository)) throw new Error("Interrupted integration requires manual recovery; parent state may contain changes");
    changeSet.status = "failed"; changeSet.failedAt = new Date().toISOString();
    writeTransaction(repository, { schemaVersion: 1, changeSetId: id, phase: "failed", originalHead: transaction.originalHead, error: "interrupted before parent mutation", failedAt: changeSet.failedAt });
    return saveTransition(repository, changeSet);
  }

  const currentRef = symbolicHead(repository);
  const currentHead = git(repository, ["rev-parse", "HEAD"]);
  const exactRef = currentRef === transaction.expectedParentRef;
  if (exactRef && currentHead === transaction.intendedHead) {
    if (!parentIsClean(repository)) {
      if (!workingStateMatchesCommit(repository, transaction.expectedParentHead)) {
        changeSet.status = "needs_attention";
        updateWorktreeMetadata(repository, changeSet.worktreeId, "needs_attention", "pending");
        writeTransaction(repository, { ...transaction, phase: "needs_attention", error: "parent working state is ambiguous after branch mutation", updatedAt: new Date().toISOString() });
        return saveTransition(repository, changeSet);
      }
      git(repository, ["reset", "--hard", transaction.intendedHead]);
    }
    const now = new Date().toISOString();
    changeSet.status = "applied"; changeSet.decision = transaction.decision; changeSet.reviewedAt ||= now; changeSet.appliedAt ||= now; delete changeSet.failedAt;
    updateWorktreeMetadata(repository, changeSet.worktreeId, "integrated", "approved");
    saveTransition(repository, changeSet);
    writeTransaction(repository, { ...transaction, phase: "applied", resultHead: transaction.intendedHead, updatedAt: now });
    return changeSet;
  }

  if (exactRef && currentHead === transaction.expectedParentHead && parentIsClean(repository)) {
    changeSet.status = allowRetry ? "ready_for_review" : "failed"; if (allowRetry) delete changeSet.failedAt; else changeSet.failedAt = new Date().toISOString();
    updateWorktreeMetadata(repository, changeSet.worktreeId, allowRetry ? "ready_for_review" : "needs_attention", "pending");
    saveTransition(repository, changeSet);
    writeTransaction(repository, { ...transaction, phase: allowRetry ? "recovered" : "failed", updatedAt: new Date().toISOString() });
    return changeSet;
  }

  changeSet.status = "needs_attention";
  updateWorktreeMetadata(repository, changeSet.worktreeId, "needs_attention", "pending");
  writeTransaction(repository, { ...transaction, phase: "needs_attention", error: "parent ref, HEAD, or working state diverged from the write-ahead record", updatedAt: new Date().toISOString() });
  return saveTransition(repository, changeSet);
}
export function recoverInterruptedChangeSet(workspaceDir: string, id: string): ChangeSet {
  return recoverInterruptedChangeSetWithOutcome(workspaceDir, id).changeSet;
}
export function recoverInterruptedChangeSetWithOutcome(workspaceDir: string, id: string): ChangeSetRecoveryResult {
  const repository = repositoryRoot(workspaceDir); const lock = integrationLock(repository);
  try {
    const previous = getChangeSet(repository, id); const interrupted = previous.status === "applying" || previous.status === "needs_attention";
    const changeSet = recoverInterruptedChangeSetLocked(repository, id, true); const changed = changeSet.transitionVersion !== previous.transitionVersion || changeSet.status !== previous.status;
    if (!interrupted && !changed) return { changeSet, recovery: { state: "not_required", transactionStatus: changeSet.status === "failed" ? "failed" : "unchanged", manualRecoveryRequired: false } };
    if (changeSet.status === "needs_attention") return { changeSet, recovery: { state: "needs_attention", transactionStatus: "needs_attention", manualRecoveryRequired: true } };
    const transactionStatus = changeSet.status === "applied" ? "applied" : changeSet.status === "ready_for_review" ? "recovered" : changeSet.status === "failed" ? "failed" : "unchanged";
    return { changeSet, recovery: { state: "recovered", transactionStatus, manualRecoveryRequired: false } };
  } finally { lock.release(); }
}

/** Captures an immutable binary patch including committed, tracked dirty, and untracked files. */
export function captureChangeSet(workspaceDir: string, worktreeId: string, evidence?: unknown): ChangeSet {
  const repository = repositoryRoot(workspaceDir);
  const worktree = listManagedWorktrees(repository).find((entry) => entry.id === worktreeId);
  if (!worktree?.baseSha || !worktree.branch) throw new Error("Managed worktree metadata not found");
  try {
    const headSha = git(worktree.path, ["rev-parse", "HEAD"]);
    const status = gitOutputStrict(worktree.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const committedPatch = git(worktree.path, ["diff", "--binary", `${worktree.baseSha}...HEAD`]);
    const dirtyPatch = git(worktree.path, ["diff", "--binary", "HEAD"]);
    const untracked = status.split("\0").filter((line) => line.startsWith("?? ")).map((line) => line.slice(3));
    const untrackedPatch = untracked.map((file) => gitDiffNoIndex(worktree.path, ["diff", "--no-index", "--binary", "--", "/dev/null", file])).join("\n");
    const patch = Buffer.from(`${committedPatch}\n${dirtyPatch}\n${untrackedPatch}`, "utf8");
    const committedFiles = nulPaths(gitOutputStrict(worktree.path, ["diff", "--name-only", "-z", `${worktree.baseSha}...HEAD`]));
    const dirtyFiles = nulPaths(gitOutputStrict(worktree.path, ["diff", "--name-only", "-z", "HEAD"]));
    const changedFiles = [...new Set([...committedFiles, ...dirtyFiles, ...untracked])].sort();
    const patchSha256 = hash(patch); const noChanges = changedFiles.length === 0;
    const evidenceRecord = evidence && typeof evidence === "object" && !Array.isArray(evidence) ? evidence as Record<string, unknown> : {};
    const agentName = typeof evidenceRecord.agentName === "string" && evidenceRecord.agentName.trim() ? evidenceRecord.agentName.trim() : undefined;
    const parentTaskId = typeof evidenceRecord.parentTaskId === "number" && Number.isSafeInteger(evidenceRecord.parentTaskId) ? evidenceRecord.parentTaskId : undefined;
    const memberName = typeof evidenceRecord.memberName === "string" && evidenceRecord.memberName.trim() ? evidenceRecord.memberName.trim() : agentName?.startsWith("teammate:") ? agentName.slice("teammate:".length) : undefined;
    const id = hash(canonicalJson({ kind: "crewforge-change-set-id-v3", worktreeId: worktree.id, baseSha: worktree.baseSha, branch: worktree.branch, headSha, dirty: Boolean(status), changedFiles, patchSha256, identity: { ownerId: worktree.ownerId, parentRunId: worktree.parentRunId, parentTaskId, childRunId: worktree.runId, toolCallId: worktree.toolId, agentName, memberName }, evidence }));
    const blob = blobPath(repository, id); fs.mkdirSync(path.dirname(blob), { recursive: true });
    if (!fs.existsSync(blob)) fs.writeFileSync(blob, patch, { flag: "wx" });
    const manifest = [{ path: path.relative(storeDir(repository), blob), sha256: patchSha256, kind: "patch" as const }];
    const changeSet: ChangeSet = { schemaVersion: CURRENT_CHANGE_SET_SCHEMA_VERSION, id, worktreeId, baseSha: worktree.baseSha, branch: worktree.branch, headSha, dirty: Boolean(status), changedFiles, patchSha256, patchBlob: manifest[0].path, patchManifest: manifest, status: noChanges ? "no_changes" : "ready_for_review", ownerId: worktree.ownerId, parentRunId: worktree.parentRunId, ...(parentTaskId !== undefined ? { parentTaskId } : {}), childRunId: worktree.runId, toolCallId: worktree.toolId, ...(agentName ? { agentName } : {}), ...(memberName ? { memberName } : {}), checks: evidence, verificationEvidence: evidence, createdAt: new Date().toISOString() };
    const evidenceGaps = collectChangeEvidenceGaps(changeSet.checks, changeSet.verificationEvidence);
    if (evidenceGaps.length) changeSet.status = "needs_attention";
    const saved = saveCaptured(repository, changeSet);
    updateWorktreeMetadata(repository, worktreeId, saved.status === "needs_attention" ? "needs_attention" : saved.status === "no_changes" ? "integrated" : saved.status === "ready_for_review" ? "ready_for_review" : "needs_attention", saved.status === "no_changes" ? "approved" : "pending");
    return saved;
  } catch (error) {
    updateWorktreeMetadata(repository, worktreeId, "needs_attention", "pending");
    if (error instanceof GitCommandError) throw new ChangeSetCaptureGitError(worktreeId, `git ${error.args.join(" ")}`, error);
    throw error;
  }
}

/** Pure preflight. It writes nothing, including when the patch is corrupt. */
export function preflightChangeSetDecision(workspaceDir: string, changeSetOrId: ChangeSet | string, decision: ChangeSetDecision, actor?: ChangeSetDecisionActor): ChangeSetPreflight {
  const repository = repositoryRoot(workspaceDir); const changeSet = typeof changeSetOrId === "string" ? getChangeSet(repository, changeSetOrId) : validateInput(repository, changeSetOrId); const reasons: string[] = [];
  const evidenceGaps = collectChangeEvidenceGaps(changeSet.checks, changeSet.verificationEvidence);
  const collaborationFiles = changeSet.changedFiles.filter((relative) => !PROTECTED.has(relative.split("/")[0]));
  const collaboration = integration(decision) ? new CollaborationStore(repository).integrationAssessment({ id: changeSet.id, patchSha256: changeSet.patchSha256, baseSha: changeSet.baseSha, changedFiles: collaborationFiles, agentDigests: agentFileDigests(repository, changeSet) }) : { conflicts: [], resolved: [] };
  const resolvedPaths = new Set(collaboration.resolved.map((item) => item.path));
  const overlappingWorktrees = listChangeSets(repository).filter((other) => other.id !== changeSet.id && !["rejected", "applied", "failed"].includes(other.status)).map((other) => ({ worktreeId: other.worktreeId, changedFiles: other.changedFiles.filter((file) => changeSet.changedFiles.includes(file)) })).filter((x) => x.changedFiles.length);
  if (integration(decision) && overlappingWorktrees.length) reasons.push("Overlapping write scopes exist in another unintegrated change set");
  if (integration(decision) && evidenceGaps.length) reasons.push(`Mutation evidence is incomplete: ${evidenceGaps.map((gap) => `${gap.path ? `${gap.path}:` : ""}${gap.reason}`).join(", ")}`);
  if (integration(decision) && parentDirtyPaths(repository).some((relative) => !resolvedPaths.has(relative))) reasons.push("Parent worktree is not clean");
  if (collaboration.conflicts.length) reasons.push("Human or upstream collaboration state requires an explicit exact-digest merge decision");
  if (integration(decision) && changeSet.schemaVersion !== CURRENT_CHANGE_SET_SCHEMA_VERSION) reasons.push("Legacy ChangeSet is read-only and must be recaptured before integration or review");
  if ((decision === "merge" || decision === "cherry_pick") && changeSet.dirty) reasons.push(`${decision === "merge" ? "Merge" : "Cherry-pick"} requires a committed-only ChangeSet; use apply to preserve tracked and untracked working-tree bytes`);
  const blockingFindings = integration(decision) && changeSet.schemaVersion === CURRENT_CHANGE_SET_SCHEMA_VERSION ? reviewBlocks(repository, changeSet, actor) : [];
  if (blockingFindings.length) reasons.push(REVIEW_GATE_REASON);
  let threeWayConflict = false;
  if (integration(decision)) {
    if (changeSet.status === "no_changes") reasons.push("No-change completion requires no integration decision");
    try {
      if (git(repository, ["rev-parse", "HEAD"]) !== changeSet.baseSha && !collaboration.resolved.some((item) => item.code === "upstream_drift")) {
        threeWayConflict = true;
        reasons.push("Parent HEAD drifted from the change set base");
      }
      const patch = patchFor(repository, changeSet);
      const temporary = path.join(storeDir(repository), "blobs", `.check-${process.pid}-${Date.now()}.patch`); fs.writeFileSync(temporary, patch);
      try { validatePatchScope(repository, changeSet, temporary); threeWayConflict = threeWayConflict || !gitResult(repository, ["apply", "--check", "--3way", temporary]); } finally { fs.rmSync(temporary, { force: true }); }
      if (threeWayConflict) reasons.push("Patch cannot be applied cleanly with a three-way merge");
    } catch (error) { reasons.push(error instanceof Error ? error.message : "Invalid persisted patch"); }
  }
  return { decision, applicable: reasons.length === 0, reasons, overlappingWorktrees, threeWayConflict, ...(blockingFindings.length ? { blockingFindings } : {}), ...(collaboration.conflicts.length ? { collaborationConflicts: collaboration.conflicts } : {}), ...(evidenceGaps.length ? { changeEvidenceGaps: evidenceGaps } : {}) };
}

function failForEvidenceGaps(repository: string, changeSet: ChangeSet, preflight: ChangeSetPreflight): never {
  changeSet.status = "needs_attention";
  delete changeSet.failedAt;
  saveTransition(repository, changeSet);
  updateWorktreeMetadata(repository, changeSet.worktreeId, "needs_attention", "pending");
  throw new ChangeSetEvidenceGapError(preflight.changeEvidenceGaps || []);
}

/** Explicitly applies an immutable dirty patch or committed history. It never touches the parent before this call. */
export function applyChangeSetDecision(workspaceDir: string, changeSetOrId: ChangeSet | string, decision: ChangeSetDecision, actor?: ChangeSetDecisionActor): { changeSet: ChangeSet; preflight: ChangeSetPreflight } {
  const repository = repositoryRoot(workspaceDir); const changeSet = typeof changeSetOrId === "string" ? getChangeSet(repository, changeSetOrId) : validateInput(repository, changeSetOrId);
  if (changeSet.schemaVersion !== CURRENT_CHANGE_SET_SCHEMA_VERSION) throw new Error("Legacy ChangeSet is read-only and must be recaptured before a decision");
  const preflight = preflightChangeSetDecision(repository, changeSet, decision, actor);
  if (!preflight.applicable) { if (integration(decision) && preflight.changeEvidenceGaps?.length) failForEvidenceGaps(repository, changeSet, preflight); if (preflight.collaborationConflicts?.length) throw new ChangeSetCollaborationGateError(preflight.collaborationConflicts); if (reviewIsSolePreflightBlock(preflight)) throw new ChangeSetReviewGateError(preflight.blockingFindings!); throw new Error(`Change set preflight failed: ${preflight.reasons.join("; ")}`); }
  const now = new Date().toISOString();
  if (decision === "reject") { listManagedWorktrees(repository); changeSet.status = "rejected"; changeSet.decision = decision; changeSet.decisionActorId = actor?.id || "system"; changeSet.decisionActorIsAdmin = actor?.isAdmin === true; changeSet.reviewedAt = now; const saved = saveTransition(repository, changeSet); updateWorktreeMetadata(repository, changeSet.worktreeId, "rejected", "rejected"); return { changeSet: saved, preflight }; }
  if (decision === "request_revision") { listManagedWorktrees(repository); changeSet.status = "needs_revision"; changeSet.decision = decision; changeSet.decisionActorId = actor?.id || "system"; changeSet.decisionActorIsAdmin = actor?.isAdmin === true; changeSet.reviewedAt = now; const saved = saveTransition(repository, changeSet); updateWorktreeMetadata(repository, changeSet.worktreeId, "needs_revision", "revision_requested"); return { changeSet: saved, preflight }; }
  const lock = integrationLock(repository);
  let originalHead = "";
  let expectedParentRef = "";
  let intendedHead = "";
  let transaction: IntegrationTransactionV3 | undefined;
  let activeChangeSet = changeSet;
  try {
    const current = getChangeSet(repository, changeSet.id);
    activeChangeSet = current;
    if (current.status !== "ready_for_review" || current.captureIntegritySha256 !== changeSet.captureIntegritySha256 || current.transitionVersion !== changeSet.transitionVersion || current.transitionIntegritySha256 !== changeSet.transitionIntegritySha256) throw new Error("Change set changed after preflight");
    const lockedPreflight = preflightChangeSetDecision(repository, current, decision, actor);
    if (!lockedPreflight.applicable) { if (lockedPreflight.changeEvidenceGaps?.length) failForEvidenceGaps(repository, current, lockedPreflight); if (lockedPreflight.collaborationConflicts?.length) throw new ChangeSetCollaborationGateError(lockedPreflight.collaborationConflicts); if (reviewIsSolePreflightBlock(lockedPreflight)) throw new ChangeSetReviewGateError(lockedPreflight.blockingFindings!); throw new Error(`Change set locked preflight failed: ${lockedPreflight.reasons.join("; ")}`); }
    originalHead = git(repository, ["rev-parse", "HEAD"]);
    expectedParentRef = symbolicHead(repository) || "";
    if (!expectedParentRef) throw new Error("Change set integration requires a checked-out parent branch");
    intendedHead = prepareIntegrationCommit(repository, current, decision, originalHead);
    const createdAt = new Date().toISOString();
    transaction = { schemaVersion: CURRENT_CHANGE_SET_WAL_SCHEMA_VERSION, changeSetId: current.id, decision, originalHead, expectedParentHead: originalHead, expectedParentRef, intendedHead, phase: "prepared", createdAt, updatedAt: createdAt };
    writeTransaction(repository, transaction);
    current.status = "applying"; current.decision = decision; current.decisionActorId = actor?.id || "system"; current.decisionActorIsAdmin = actor?.isAdmin === true; saveTransition(repository, current);
    transaction = { ...transaction, phase: "mutating", updatedAt: new Date().toISOString() };
    writeTransaction(repository, transaction);
    integrationHookForTests?.("after_write_ahead");
    assertParentCas(repository, expectedParentRef, originalHead);
    git(repository, ["update-ref", expectedParentRef, intendedHead, originalHead]);
    git(repository, ["reset", "--hard", intendedHead]);
    integrationHookForTests?.("after_parent_mutation");
    current.status = "applied"; current.decision = decision; current.reviewedAt = now; current.appliedAt = now; delete current.failedAt;
    saveTransition(repository, current); updateWorktreeMetadata(repository, current.worktreeId, "integrated", "approved");
    transaction = { ...transaction, phase: "applied", resultHead: intendedHead, updatedAt: new Date().toISOString() };
    writeTransaction(repository, transaction);
    lock.release(); return { changeSet: current, preflight };
  } catch (error) {
    if (error instanceof ChangeSetIntegrationCrashError || error instanceof ChangeSetEvidenceGapError) { lock.release(); throw error; }
    try {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (transaction) { writeTransaction(repository, { ...transaction, error: errorMessage, updatedAt: new Date().toISOString() }); recoverInterruptedChangeSetLocked(repository, activeChangeSet.id, false); }
      else { const current = getChangeSet(repository, activeChangeSet.id); current.status = "failed"; current.failedAt = new Date().toISOString(); saveTransition(repository, current); }
    } finally {
      lock.release();
    }
    throw error;
  }
}
