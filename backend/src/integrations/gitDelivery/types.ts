export type GitDeliveryAction =
  | "create_branch"
  | "commit_change_set"
  | "fast_forward"
  | "rebase"
  | "cherry_pick"
  | "push";

export type GitOperationStatus =
  | "awaiting_approval"
  | "queued"
  | "running"
  | "completed"
  | "conflicted"
  | "failed"
  | "cancelled"
  | "manual_recovery";

export interface GitDeliveryActor {
  username: string;
  isAdmin: boolean;
  teamRole?: "owner" | "admin" | "member" | "viewer";
}

export interface GitDeliveryProvenance {
  conversationId?: string;
  planId?: string;
  runId?: string;
  worktreeId?: string;
  changeSetId?: string;
}

export type GitDeliveryInput =
  | { action: "create_branch"; branch: string; baseSha: string; expectedRefSha?: string | null }
  | { action: "commit_change_set"; branch: string; changeSetId: string; expectedRefSha?: string | null; subject?: string }
  | { action: "fast_forward"; branch: string; sourceSha: string; expectedHeadSha: string }
  | { action: "rebase"; branch: string; expectedHeadSha: string; upstreamSha: string; ontoSha: string }
  | { action: "cherry_pick"; branch: string; expectedHeadSha: string; commits: string[] }
  | { action: "push"; remote: string; localSha: string; remoteRef: string; expectedRemoteSha: string | null };

export interface GitOperationPreflight {
  applicable: boolean;
  approvalDigest: string;
  reasons: string[];
  warnings: string[];
  exactArgs: string[];
  repositoryId: string;
  before: Record<string, unknown>;
  evidenceSummary?: GitEvidenceSummary;
}

export interface GitEvidenceSummary {
  schemaVersion: 1;
  changeSetId: string;
  revision: string;
  baseSha: string;
  headSha: string;
  changedFiles: string[];
  verificationDigest: string;
  reviewRunIds: string[];
  runId?: string;
  conversationId?: string;
  planId?: string;
}

export interface GitOperation {
  schemaVersion: 1;
  id: string;
  version: number;
  idempotencyKeyHash: string;
  requestDigest: string;
  action: GitDeliveryAction;
  risk: "medium" | "high";
  status: GitOperationStatus;
  actor: GitDeliveryActor;
  input: GitDeliveryInput;
  provenance: GitDeliveryProvenance;
  preflight: GitOperationPreflight;
  approval?: { digest: string; approvedBy: string; approvedAt: number; reason?: string };
  lease?: { ownerPid: number; ownerToken: string; expiresAt: number };
  before: Record<string, unknown>;
  after?: Record<string, unknown>;
  conflicts?: Array<Record<string, unknown>>;
  error?: string;
  traceEventIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface GitDeliveryPrepareRequest {
  idempotencyKey: string;
  input: GitDeliveryInput;
  provenance?: GitDeliveryProvenance;
}
