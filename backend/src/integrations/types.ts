export type DeliveryFeedbackSourceKind = "ci_check" | "review_comment";
export type DeliveryFeedbackLifecycle =
  | "received"
  | "linked"
  | "pending_approval"
  | "task_created"
  | "in_progress"
  | "fixed"
  | "verified"
  | "ignored"
  | "stale"
  | "failed";

/** Immutable local correlation established when a ChangeSet is published. */
export interface DeliveryBindingV1 {
  schemaVersion: 1;
  id: string;
  providerConfigId: string;
  repositoryId: string;
  proposalKey: string;
  headSha: string;
  conversationId: string;
  executionPlanId?: string;
  originRunId: string;
  parentRunId?: string;
  worktreeId: string;
  changeSetId: string;
  revision: string;
  patchContentSha256?: string;
  createdAt: number;
  updatedAt: number;
}

/** Provider adapters may add fields, but these server-owned fields are required. */
export interface NormalizedDeliveryEventV1 {
  schemaVersion: 1;
  providerConfigId: string;
  deliveryId: string;
  repositoryId: string;
  proposalKey: string;
  headSha: string;
  receivedAt: number;
  source:
    | { kind: "ci_check"; id: string; name: string; conclusion: string; url?: string; evidence?: string[] }
    | { kind: "review_comment"; id: string; threadId?: string; author?: string; body: string; url?: string; path?: string; line?: number; resolved?: boolean };
}

export interface DeliveryFeedbackTransitionV1 {
  from: DeliveryFeedbackLifecycle;
  to: DeliveryFeedbackLifecycle;
  at: number;
  actorId: string;
  reason?: string;
  version: number;
}

/** Durable normalized feedback. External identity never grants verifier authority. */
export interface DeliveryFeedbackV1 {
  schemaVersion: 1;
  id: string;
  version: number;
  providerConfigId: string;
  deliveryId: string;
  repositoryId: string;
  proposalKey: string;
  source: NormalizedDeliveryEventV1["source"];
  sourceDigest: string;
  headSha: string;
  conversationId?: string;
  executionPlanId?: string;
  originRunId?: string;
  parentRunId?: string;
  worktreeId?: string;
  changeSetId?: string;
  revision?: string;
  taskId?: number;
  taskIds?: number[];
  followUpRunId?: string;
  lifecycle: DeliveryFeedbackLifecycle;
  stale: boolean;
  createdAt: number;
  updatedAt: number;
  transitions: DeliveryFeedbackTransitionV1[];
}
