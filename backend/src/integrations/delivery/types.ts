import type { IncomingHttpHeaders } from "node:http";
import type { DeliveryBindingV1, NormalizedDeliveryEventV1 } from "../types.js";

export type DeliveryProviderKind = "github" | "gitlab" | "gitea" | "mcp";
export type DeliveryState = "draft" | "open" | "closed" | "merged" | "unknown";
export type CheckState = "queued" | "running" | "success" | "failure" | "cancelled" | "skipped" | "neutral" | "unknown";
export type MergeReadiness = "ready" | "blocked_checks" | "blocked_review" | "blocked_conflict" | "checking" | "unknown";
export type ProviderHealth = "online" | "degraded" | "offline" | "unauthorized" | "rate_limited" | "unsupported";

export interface DeliveryProviderConfig {
  id: string;
  kind: Exclude<DeliveryProviderKind, "mcp">;
  baseUrl: string;
  tokenEnv: string;
  tokenKind?: "bearer" | "private-token" | "gitea-token";
  webhookSecretEnv?: string;
  gitRemoteName?: string;
  apiVersion?: string;
  disabled?: boolean;
}

export interface DeliveryRuntimeSettings {
  providers: DeliveryProviderConfig[];
  pollIntervalSeconds: number;
  requestTimeoutSeconds: number;
}

export interface RepositoryRef {
  providerConfigId: string;
  remoteRepositoryId: string;
  owner?: string;
  name?: string;
  gitRemoteName?: string;
}

export interface ChangeRequestRef extends RepositoryRef {
  number: number;
}

export interface PageCursor { value?: string; }
export interface Page<T> { items: T[]; nextCursor?: PageCursor; etag?: string; }

export interface ProviderCapabilities {
  providerConfigId: string;
  kind: DeliveryProviderKind;
  version?: string;
  health: ProviderHealth;
  authenticated: boolean;
  supports: {
    changeRequests: boolean;
    drafts: boolean;
    reviewThreads: boolean;
    reviewDecisions: boolean;
    checks: boolean;
    commitStatuses: boolean;
    actions: boolean;
    webhooks: boolean;
    signedWebhooks: boolean;
    conditionalGets: boolean;
    atomicChangeRequestUpdate: boolean;
  };
  checkedAt: number;
  error?: string;
}

export interface RemoteChangeRequest {
  providerConfigId: string;
  repositoryId: string;
  number: number;
  remoteId: string;
  url: string;
  title: string;
  body: string;
  state: DeliveryState;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  updatedAt?: string;
  remoteVersion?: string;
  mergeReadiness: MergeReadiness;
}

export interface CreateChangeRequest {
  repository: RepositoryRef;
  title: string;
  body: string;
  headBranch: string;
  baseBranch: string;
  draft?: boolean;
}

export interface UpdateChangeRequest {
  title?: string;
  body?: string;
  baseBranch?: string;
  state?: "open" | "closed";
  draft?: boolean;
}

export interface WriteOperationContext {
  idempotencyKey: string;
  requestDigest: string;
  approvalId: string;
  conversationId: string;
  planId?: string;
  runId: string;
  parentRunId?: string;
  worktreeId: string;
  changeSetId: string;
  revision: string;
  patchContentSha256?: string;
  evidenceLedgerDigest: string;
}

export interface DeliveryActor {
  username: string;
  isAdmin: boolean;
}

/** Client-selectable publication shape. All lineage and evidence fields are resolved server-side. */
export interface PrepareDeliveryInput {
  providerConfigId: string;
  repository: RepositoryRef;
  title: string;
  generatedBody: string;
  headBranch: string;
  baseBranch: string;
  changeSetId: string;
  draft?: boolean;
  existingDeliveryId?: string;
}

/** Immutable server-owned publication request persisted after preflight. */
export interface PreparedDeliveryRequest extends PrepareDeliveryInput {
  expectedRemoteVersion?: string;
  expectedHeadSha: string;
  conversationId: string;
  executionPlanId?: string;
  originRunId: string;
  parentRunId?: string;
  worktreeId: string;
  revision: string;
  patchContentSha256: string;
  evidenceLedgerDigest: string;
  reviewArtifactDigest: string;
}

export interface NormalizedCheck {
  id: string;
  name: string;
  state: CheckState;
  sha: string;
  url?: string;
  description?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface NormalizedReviewFeedback {
  id: string;
  kind: "comment" | "inline_comment" | "approval" | "change_request";
  author?: string;
  body: string;
  state?: "approved" | "changes_requested" | "commented" | "unknown";
  url?: string;
  path?: string;
  line?: number;
  headSha?: string;
  updatedAt?: string;
}

export interface OutboundReviewFeedback {
  body: string;
  path?: string;
  line?: number;
  headSha?: string;
  decision?: "approve" | "request_changes" | "comment";
}

export interface VerifiedDeliveryEvent {
  providerConfigId: string;
  deliveryId: string;
  event: string;
  action?: string;
  repositoryId?: string;
  changeRequestNumber?: number;
  headSha?: string;
  check?: NormalizedCheck;
  feedback?: NormalizedReviewFeedback;
  normalizedFeedback?: NormalizedDeliveryEventV1;
  receivedAt: number;
}

export interface DeliveryBinding extends DeliveryBindingV1 {
  repository: RepositoryRef;
  remote: RemoteChangeRequest;
  evidenceLedgerDigest: string;
  generatedBodyDigest: string;
  lastSyncedAt?: number;
  stale: boolean;
  health: ProviderHealth;
  checks: NormalizedCheck[];
  feedback: NormalizedReviewFeedback[];
}

export interface DeliveryProvider {
  readonly kind: DeliveryProviderKind;
  readonly config: DeliveryProviderConfig;
  probe(repository: RepositoryRef, signal?: AbortSignal): Promise<ProviderCapabilities>;
  findChangeRequests(repository: RepositoryRef, filter: { head?: string; base?: string; state?: DeliveryState }, page?: PageCursor, signal?: AbortSignal): Promise<Page<RemoteChangeRequest>>;
  getChangeRequest(ref: ChangeRequestRef, signal?: AbortSignal): Promise<RemoteChangeRequest>;
  createChangeRequest(request: CreateChangeRequest, context: WriteOperationContext, signal?: AbortSignal): Promise<RemoteChangeRequest>;
  updateChangeRequest(ref: ChangeRequestRef, patch: UpdateChangeRequest, precondition: { expectedHeadSha: string; expectedRemoteVersion?: string }, context: WriteOperationContext, signal?: AbortSignal): Promise<RemoteChangeRequest>;
  listChecks(repository: RepositoryRef, headSha: string, page?: PageCursor, signal?: AbortSignal): Promise<Page<NormalizedCheck>>;
  listReviewFeedback(ref: ChangeRequestRef, page?: PageCursor, signal?: AbortSignal): Promise<Page<NormalizedReviewFeedback>>;
  createReviewFeedback?(ref: ChangeRequestRef, feedback: OutboundReviewFeedback, context: WriteOperationContext, signal?: AbortSignal): Promise<NormalizedReviewFeedback>;
  verifyAndNormalizeWebhook(rawBody: Buffer, headers: IncomingHttpHeaders, secret: string): VerifiedDeliveryEvent;
}

export class DeliveryConflictError extends Error {
  constructor(public readonly code: "stale_head" | "upstream_changed" | "provider_conflict" | "binding_conflict" | "version_conflict" | "generated_body_conflict" | "idempotency_conflict" | "approval_conflict" | "ambiguous_operation", message: string) { super(message); }
}

export class DeliveryUnavailableError extends Error {
  constructor(public readonly health: ProviderHealth, message: string) { super(message); }
}
