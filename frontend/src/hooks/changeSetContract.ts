export type ChangeSetDecision = "apply" | "cherry_pick" | "merge" | "reject" | "request_revision";
export type ChangeSetStatus = "running" | "ready_for_review" | "applying" | "applied" | "rejected" | "needs_revision" | "needs_attention" | "failed" | "no_changes";

export interface PublicChangeSetPatch {
  /** Public projection of the server's patchSha256: the immutable patch content digest. */
  sha256: string;
  available: boolean;
  files: Array<{ path: string; sha256: string; kind: "patch" | "untracked" }>;
}

interface PublicChangeSetBase {
  id: string;
  worktreeId: string;
  baseSha: string;
  branch: string;
  headSha: string;
  dirty: boolean;
  changedFiles: string[];
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
  recovery: { state: "interrupted" | "failed" | "not_required"; actionAvailable: boolean; inspectionRequired: boolean };
  patch: PublicChangeSetPatch;
}

export interface LegacyPublicChangeSet extends PublicChangeSetBase {
  schemaVersion: 1 | 2;
  /** Legacy schema-v2 checksum. Legacy ChangeSets remain display-only in the frontend. */
  integritySha256?: string;
}

export interface CurrentPublicChangeSet extends PublicChangeSetBase {
  schemaVersion: 3;
  captureIntegritySha256: string;
  transitionVersion: number;
  transitionIntegritySha256: string;
}

export type ChangeSet = LegacyPublicChangeSet | CurrentPublicChangeSet;

const STATUSES = new Set<ChangeSetStatus>(["running", "ready_for_review", "applying", "applied", "rejected", "needs_revision", "needs_attention", "failed", "no_changes"]);
const RECOVERY_STATES = new Set(["interrupted", "failed", "not_required"]);
const PATCH_KINDS = new Set(["patch", "untracked"]);
const SHA256 = /^[a-f0-9]{64}$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ChangeSet ${label}`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.length) throw new Error(`Invalid ChangeSet ${label}`);
}

function digest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`Invalid ChangeSet ${label}`);
}

export function parsePublicChangeSet(value: unknown): ChangeSet {
  const candidate = record(value, "payload");
  if (candidate.schemaVersion !== 1 && candidate.schemaVersion !== 2 && candidate.schemaVersion !== 3) throw new Error("Unsupported ChangeSet schema version");
  for (const key of ["id", "worktreeId", "baseSha", "branch", "headSha", "createdAt"] as const) requiredString(candidate[key], key);
  if (typeof candidate.dirty !== "boolean") throw new Error("Invalid ChangeSet dirty flag");
  if (!Array.isArray(candidate.changedFiles) || !candidate.changedFiles.every((entry) => typeof entry === "string" && entry.length > 0)) throw new Error("Invalid ChangeSet changed files");
  if (typeof candidate.status !== "string" || !STATUSES.has(candidate.status as ChangeSetStatus)) throw new Error("Invalid ChangeSet status");

  const recovery = record(candidate.recovery, "recovery");
  if (typeof recovery.state !== "string" || !RECOVERY_STATES.has(recovery.state) || typeof recovery.actionAvailable !== "boolean" || typeof recovery.inspectionRequired !== "boolean") throw new Error("Invalid ChangeSet recovery state");

  const patch = record(candidate.patch, "patch");
  digest(patch.sha256, "patch content digest");
  if (typeof patch.available !== "boolean" || !Array.isArray(patch.files)) throw new Error("Invalid ChangeSet patch projection");
  for (const entry of patch.files) {
    const file = record(entry, "patch file");
    requiredString(file.path, "patch file path");
    digest(file.sha256, "patch file digest");
    if (typeof file.kind !== "string" || !PATCH_KINDS.has(file.kind)) throw new Error("Invalid ChangeSet patch file kind");
  }

  if (candidate.schemaVersion === 3) {
    digest(candidate.captureIntegritySha256, "capture integrity digest");
    if (!Number.isSafeInteger(candidate.transitionVersion) || (candidate.transitionVersion as number) < 1) throw new Error("Invalid ChangeSet transition version");
    digest(candidate.transitionIntegritySha256, "transition integrity digest");
  } else if (candidate.integritySha256 !== undefined) digest(candidate.integritySha256, "legacy integrity digest");

  return candidate as unknown as ChangeSet;
}

export function parsePublicChangeSetList(value: unknown): ChangeSet[] {
  if (!Array.isArray(value)) throw new Error("Invalid ChangeSet list");
  return value.map(parsePublicChangeSet);
}

export function isCurrentChangeSet(changeSet: ChangeSet): changeSet is CurrentPublicChangeSet {
  return changeSet.schemaVersion === 3;
}

/** Exact revision used by review, artifact, bundle, and provider-delivery APIs. */
export function changeSetReviewRevision(changeSet: ChangeSet): string | undefined {
  return isCurrentChangeSet(changeSet) ? changeSet.captureIntegritySha256 : undefined;
}

/** Exact patch-content binding exposed publicly as patch.sha256. */
export function changeSetPatchContentSha256(changeSet: ChangeSet): string {
  return changeSet.patch.sha256;
}
