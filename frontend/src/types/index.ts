export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
}

export interface OpenFile {
  path: string;
  name: string;
  content: string;
  language: string;
  modified: boolean;
  version?: string;
  updatedAt?: number;
  remoteUpdated?: boolean;
  remoteContent?: string;
  remoteVersion?: string;
  remoteUpdatedAt?: number;
  remoteConflictReason?: "background" | "save";
  remoteConflictSource?: "team_member" | "external" | "assistant_tool" | "unknown";
  remoteConflictActor?: string;
}

export interface FileSelectionRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface DefinitionLocation {
  path: string;
  selection: FileSelectionRange;
}

export interface FileUpdate {
  path: string;
  content: string;
  selection?: FileSelectionRange;
}

export interface ToolCallStep {
  toolCallId: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  fileUpdate?: FileUpdate;
}

export type ChatMessagePart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | ({
      type: "tool";
      status: "completed" | "failed";
    } & ToolCallStep);

export interface ToolApprovalRequest {
  conversationId?: string;
  approvalId: string;
  requestId: string;
  toolCallId: string;
  name: string;
  input: Record<string, unknown>;
  risk: "medium" | "high";
  reason: string;
  scope: string;
  canAllowSession: boolean;
}

export type ToolApprovalDecision = "allow_once" | "allow_session" | "deny";

export interface ChatMessage {
  requestId?: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  toolCalls?: ToolCallStep[];
  thinking?: string;
  parts?: ChatMessagePart[];
}

export type AgentMode = "ask" | "code" | "review" | "plan";
export type ConversationStatus = "queued" | "running" | "completed" | "stopped" | "failed";

export type AgentRunStatus = ConversationStatus;

export type AgentRunEventKind =
  | "run_started"
  | "model_call"
  | "model_response"
  | "tool_call"
  | "tool_result"
  | "context_compacted"
  | "steering"
  | "error"
  | "run_finished";

export interface AgentRunMetrics {
  iterations: number;
  modelCalls: number;
  toolCalls: number;
  toolErrors: number;
  modelErrors: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  estimatedTokensPeak: number;
  compactionCount: number;
  durationMs?: number;
}

export interface AgentRunEvent {
  id: string;
  timestamp: number;
  kind: AgentRunEventKind;
  label: string;
  requestId?: string;
  toolName?: string;
  durationMs?: number;
  isError?: boolean;
  detail?: string;
}

export interface AgentRunSummary {
  runId: string;
  conversationId: string;
  mode: AgentMode;
  modelName?: string;
  status: AgentRunStatus;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  resumedFromRunId?: string;
  parentRunId?: string;
  parentToolCallId?: string;
  parentRequestId?: string;
  agentName?: string;
  metrics: AgentRunMetrics;
  eventCount: number;
  summary?: ConversationRunSummary;
  executionContract?: ExecutionContract;
  executionContractKind?: ExecutionContract["kind"];
  completionEvidence?: CompletionEvidence;
  qualityGate?: CompletionQualityGateEvidence;
  executionPlan?: ExecutionPlan;
  executionPlanId?: string;
}

export interface AgentRunState extends AgentRunSummary {
  events: AgentRunEvent[];
  event?: AgentRunEvent;
}

export interface ExecutionContract { kind: "direct_code" | "approved_plan"; planId?: string; }
export type VerificationStatus = "pending" | "passed" | "failed" | "timed_out" | "cancelled";
export interface CompletionEvidence {
  schemaVersion: number;
  outcome: "completed" | "validation_failed" | "needs_attention" | "failed" | "stopped";
  ledger: {
    changedFiles: string[];
    verification: Array<{ command: string; status: VerificationStatus; toolCallId?: string; exitCode?: number; outputDigest?: string }>;
    criteria: Array<{ criterion: string; state: "pending" | "passed" | "failed"; evidenceRefs: string[] }>;
    blockers: string[];
  };
}
export interface CompletionQualityGateEvidence {
  schemaVersion: 1;
  status: "passed" | "passed_with_warnings" | "blocked";
  runId: string;
  scopeId: string;
  hookGeneration: number;
  attemptToken: string;
  /** @deprecated Use attemptToken. */
  token: string;
  warnings: Array<{ name: string; error: string }>;
  error?: string;
  timestamp: string;
}
export interface ExecutionPlanAmendmentRequest {
  id: string; reason: string; requestedFiles: string[]; requestedVerificationCommands: string[];
  status: "pending" | "approved" | "rejected"; requestedAt: number; requestedByRunId: string; resolvedAt?: number;
}
export interface ExecutionPlan {
  id: string; status: string; amendmentRequests?: ExecutionPlanAmendmentRequest[];
  [key: string]: unknown;
}

export interface ConversationRunSummary {
  changedFiles: string[];
  toolCallCount: number;
  errorCount: number;
  commandCount: number;
  reviewFindings?: ReviewFinding[];
  executionContract?: ExecutionContract;
  executionContractKind?: ExecutionContract["kind"];
  completionEvidence?: CompletionEvidence;
  qualityGate?: CompletionQualityGateEvidence;
  executionPlan?: ExecutionPlan;
}

export type ReviewSeverity = "critical" | "error" | "warning" | "info";

export interface ReviewFinding {
  id: string;
  severity: ReviewSeverity;
  path: string;
  line: number;
  column?: number;
  message: string;
  lifecycle?: "open" | "accepted" | "disputed" | "fixed" | "verified" | "dismissed";
  version?: number;
  reviewer?: ReviewActor;
  verifier?: ReviewActor;
  runId?: string;
  changeSetId?: string;
  reviewRunId?: string;
  revision?: string;
  evidence?: string[];
  fingerprint?: string;
  fixRef?: string;
  dismissalReason?: string;
  allowedTransitions?: ReviewFindingLifecycle[];
  transitions?: ReviewFindingTransition[];
  createdAt?: number;
  updatedAt?: number;
}

export interface ReviewActor { id: string; modelName?: string; profile?: string; revision?: string; changeSetId?: string; reviewRunId?: string; }
export type ReviewFindingLifecycle = "open" | "accepted" | "disputed" | "fixed" | "verified" | "dismissed";
export interface ReviewFindingTransition {
  from: ReviewFindingLifecycle;
  to: ReviewFindingLifecycle;
  at: number;
  actor: ReviewActor;
  reason?: string;
  fixRef?: string;
  evidence?: string[];
  version: number;
}

export type TraceEventKind = "run" | "agent" | "model" | "tool" | "approval" | "checkpoint" | "validation" | "git" | "review" | "error" | "decision";
export interface CausalTraceEvent { eventId: string; timestamp: number; kind: TraceEventKind; action: string; correlationId: string; causationId?: string; parentEventId?: string; runId?: string; conversationId?: string; agentId?: string; toolCallId?: string; evidence?: string; decision?: string; metadata?: Record<string, unknown>; }
export interface TraceRetention { maxEvents: number; maxArchiveEvents: number; maxAgeMs: number; maxArchiveAgeMs: number; archive: boolean; }
export interface TraceMetrics { eventCount: number; archivedEventCount: number; totalBytes: number; oldestAt?: number; newestAt?: number; }
export interface TracePrunePreview { hotBefore: number; archiveBefore: number; hotAfter: number; archiveAfter: number; wouldArchive: number; wouldDelete: number; }

export interface ContextState {
  estimatedTokens: number;
  estimatedTokensAfter?: number;
  threshold: number;
  status: "ready" | "compacting" | "warning";
  compactionCount: number;
  lastCompactedAt?: number;
  transcriptPath?: string;
  preview?: {
    strategy: "summary";
    estimatedTokensBefore: number;
    estimatedTokensAfter: number;
    transcriptPath: string;
    protectedMessageCount: number;
    compactedMessageCount: number;
    preservedMessageCount: number;
  };
  message?: string;
}

/** Immutable evidence describing the exact sources supplied to one model call. */
export type ContextSourceKind =
  | "active_file"
  | "selection"
  | "pinned_file"
  | "definition"
  | "reference"
  | "import"
  | "test"
  | "diagnostic"
  | "git_history"
  | "memory"
  | "transcript"
  | "repository"
  | "other";

export type ContextSourceDecision = "included" | "excluded" | "redacted" | "truncated" | "omitted";
export type ContextFreshnessState = "fresh" | "stale" | "dirty" | "unavailable";
export type ContextTrustLevel = "high" | "medium" | "low";

export interface ContextSource {
  id: string;
  sourceKey: string;
  kind: ContextSourceKind;
  label?: string;
  path?: string;
  symbol?: string;
  range?: { startLine: number; endLine: number };
  reasonCode: string;
  reasonDetail?: string;
  estimatedTokens: number;
  tokenCountSource?: "tokenizer" | "provider" | "estimate";
  decision: ContextSourceDecision;
  pinned: boolean;
  freshness: {
    state: ContextFreshnessState;
    observedAt?: number;
    contentDigest?: string;
  };
  trust: {
    level: ContextTrustLevel;
    basis: "workspace_verified" | "user_buffer" | "derived" | "external" | "unknown";
  };
  integrity?: "verified_digest" | "observed" | "unknown";
  /** Server-authorized, redacted and bounded preview. Never derive this client-side. */
  preview?: string;
  actions?: {
    canPin?: boolean;
    canExclude?: boolean;
    canRefresh?: boolean;
    disabledReasonCode?: string;
  };
}

export interface ContextManifest {
  schemaVersion: number;
  id: string;
  runId?: string;
  conversationId?: string;
  requestId?: string;
  modelCallId?: string;
  purpose?: ContextManifestWire["purpose"];
  modelName?: string;
  providerId?: string;
  attemptCount?: number;
  revision: number;
  createdAt: number;
  indexRevision?: string;
  status: "building" | "ready" | "stale" | "error";
  sources: ContextSource[];
  totals: {
    includedSources: number;
    excludedSources: number;
    estimatedTokens: number;
    reportedTokens?: number;
  };
  message?: string;
}

export interface ContextIndexState {
  status: "idle" | "indexing" | "ready" | "stale" | "error" | "unavailable";
  revision?: string;
  indexedFiles?: number;
  pendingFiles?: number;
  updatedAt?: number;
  message?: string;
}

export interface ContextControlState {
  version: number;
  pinnedSourceKeys: string[];
  pinnedPaths: string[];
  excludedSourceKeys: string[];
}

export interface ContextPreferencePin {
  id: string;
  path: string;
  reason?: string;
  createdAt: number;
}

export interface ContextPreferences {
  schemaVersion: 1;
  conversationId: string;
  version: number;
  pins: ContextPreferencePin[];
  excludes: string[];
  updatedAt: number;
}

export interface ContextManifestWireItem {
  itemId: string;
  kind: string;
  source: {
    type: string;
    path?: string;
    messageId?: string;
    toolCallId?: string;
    skillName?: string;
    planId?: string;
    revision?: string;
    indexDocumentId?: string;
  };
  reason: string;
  estimatedTokens: number;
  chars: number;
  contentDigest: string;
  observedAt: number;
  sourceUpdatedAt?: number;
  freshness: "fresh" | "possibly_stale" | "stale" | "unknown";
  trust:
    | "platform" | "authenticated_user" | "approved_user_artifact"
    | "workspace_instruction" | "local_tool_output" | "external_tool_output"
    | "model_generated" | "generated_file";
  integrity: "verified_digest" | "observed" | "unknown";
  decision: "included" | "excluded" | "redacted" | "truncated";
  ruleIds: string[];
  pinned: boolean;
}

export interface ContextManifestWire {
  schemaVersion: 1;
  manifestId: string;
  logicalRequestId: string;
  createdAt: number;
  updatedAt: number;
  status: "prepared" | "sent" | "completed" | "failed" | "aborted";
  purpose: "agent_turn" | "compaction" | "subagent" | "teammate" | "change_set_review" | "title";
  runId?: string;
  conversationId?: string;
  requestId?: string;
  agentId: string;
  providerId: string;
  modelName: string;
  scope: {
    kind: "workspace" | "managed_worktree" | "review_checkout";
    auditWorkspaceId: string;
    effectiveScopeId: string;
    worktreeId?: string;
    baseSha?: string;
    headSha?: string;
    indexGeneration?: string;
  };
  policyVersion: number;
  controlsVersion: number;
  payloadDigest: string;
  items: ContextManifestWireItem[];
  estimatedPromptTokens: number;
  actualPromptTokens?: number;
  excludedCount: number;
  redactedCount: number;
  truncatedCount: number;
  attempts: Array<{
    attempt: number;
    startedAt: number;
    endedAt?: number;
    status: "sent" | "retrying" | "completed" | "failed" | "aborted";
    httpStatus?: number;
    errorCode?: string;
  }>;
  errorCode?: string;
}

export type ContextSourceMutation = "pin" | "unpin" | "exclude" | "restore" | "refresh";

export interface McpState {
  status: "ready" | "warning";
  serverCount: number;
  toolCount: number;
  message?: string;
  servers?: McpServerPreview[];
}

export interface KnowledgeState {
  memoryFiles: number;
  skillCount: number;
}

export interface GitStatusEntry {
  path: string;
  previousPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  kind: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
}

export interface GitDiffPayload {
  path: string;
  diff: string;
  hasChanges: boolean;
  original: string;
  modified: string;
  isBinary: boolean;
  isTooLarge: boolean;
  updatedAt: number;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  headSha?: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
  updatedAt: number;
}

export type GitDeliveryAction = "create_branch" | "commit_change_set" | "fast_forward" | "rebase" | "cherry_pick" | "push";
export type GitOperationStatus = "awaiting_approval" | "queued" | "running" | "completed" | "conflicted" | "failed" | "cancelled" | "manual_recovery";
export type GitDeliveryInput =
  | { action: "create_branch"; branch: string; baseSha: string; expectedRefSha?: string | null }
  | { action: "commit_change_set"; branch: string; changeSetId: string; expectedRefSha?: string | null; subject?: string }
  | { action: "fast_forward"; branch: string; sourceSha: string; expectedHeadSha: string }
  | { action: "rebase"; branch: string; expectedHeadSha: string; upstreamSha: string; ontoSha: string }
  | { action: "cherry_pick"; branch: string; expectedHeadSha: string; commits: string[] }
  | { action: "push"; remote: string; localSha: string; remoteRef: string; expectedRemoteSha: string | null };
export interface GitPreflight {
  applicable: boolean;
  approvalDigest: string;
  reasons: string[];
  warnings: string[];
  exactArgs: string[];
  repositoryId: string;
  before: Record<string, unknown>;
  evidenceSummary?: {
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
  };
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
  actor: { username: string; isAdmin: boolean; teamRole?: "owner" | "admin" | "member" | "viewer" };
  input: GitDeliveryInput;
  provenance: { conversationId?: string; planId?: string; runId?: string; worktreeId?: string; changeSetId?: string };
  preflight: GitPreflight;
  approval?: { digest: string; approvedBy: string; approvedAt: number; reason?: string };
  before: Record<string, unknown>;
  after?: Record<string, unknown>;
  conflicts?: Array<Record<string, unknown>>;
  error?: string;
  traceEventIds: string[];
  createdAt: number;
  updatedAt: number;
}
export interface GitDeliveryStatus extends GitStatus { headSha: string | null; }
export interface GitDeliveryCapabilities { canPrepare: boolean; canPush: boolean; }

export type ProviderHealth = "online" | "degraded" | "offline" | "unauthorized" | "rate_limited" | "unsupported";
export type DeliveryStatus = "draft" | "open" | "closed" | "merged" | "unknown";
export type DeliveryCheckStatus = "queued" | "running" | "success" | "failure" | "cancelled" | "skipped" | "neutral" | "unknown";
export type MergeReadiness = "ready" | "blocked_checks" | "blocked_review" | "blocked_conflict" | "checking" | "unknown";
export type DeliveryProviderKind = "github" | "gitlab" | "gitea" | "mcp";
export interface ProviderConfigSummary {
  id: string;
  kind: Exclude<DeliveryProviderKind, "mcp">;
  baseUrl: string;
  gitRemoteName?: string;
  disabled?: boolean;
  credentialConfigured: boolean;
  webhookConfigured: boolean;
}
export interface ProviderCapability {
  providerConfigId: string;
  kind: DeliveryProviderKind;
  version?: string;
  health: ProviderHealth;
  authenticated: boolean;
  supports: { changeRequests: boolean; drafts: boolean; reviewThreads: boolean; reviewDecisions: boolean; checks: boolean; commitStatuses: boolean; actions: boolean; webhooks: boolean; signedWebhooks: boolean; conditionalGets: boolean; atomicChangeRequestUpdate: boolean };
  checkedAt: number;
  error?: string;
}
export interface DeliveryCheck {
  id: string;
  name: string;
  state: DeliveryCheckStatus;
  sha: string;
  url?: string;
  description?: string;
  startedAt?: string;
  completedAt?: string;
}
export interface DeliveryComment {
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
export interface ProviderDelivery {
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
  repository: { providerConfigId: string; remoteRepositoryId: string; owner?: string; name?: string; gitRemoteName?: string };
  remote: { providerConfigId: string; repositoryId: string; number: number; remoteId: string; url: string; title: string; body: string; state: DeliveryStatus; headBranch: string; baseBranch: string; headSha: string; updatedAt?: string; remoteVersion?: string; mergeReadiness: MergeReadiness };
  evidenceLedgerDigest: string;
  generatedBodyDigest: string;
  lastSyncedAt?: number;
  stale: boolean;
  health: ProviderHealth;
  checks: DeliveryCheck[];
  feedback: DeliveryComment[];
}
export type ProviderDeliveryOperationStatus = "awaiting_approval" | "approved" | "in_flight" | "succeeded" | "ambiguous" | "failed";
export interface ProviderDeliveryPrepareInput {
  providerConfigId: string;
  repository: { providerConfigId: string; remoteRepositoryId: string; owner?: string; name?: string; gitRemoteName?: string };
  title: string;
  generatedBody: string;
  headBranch: string;
  baseBranch: string;
  changeSetId: string;
  draft?: boolean;
  existingDeliveryId?: string;
}
export interface ProviderDeliveryPreparedRequest extends ProviderDeliveryPrepareInput {
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
export interface ProviderDeliveryOperation {
  id: string;
  version: number;
  idempotencyKeyHash: string;
  requestDigest: string;
  approvalDigest: string;
  status: ProviderDeliveryOperationStatus;
  providerConfigId: string;
  preparedBy: string;
  request: ProviderDeliveryPreparedRequest;
  approval?: { digest: string; approvedBy: string; approvedAt: number };
  deliveryId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}
export type DeliveryFeedbackLifecycle = "received" | "linked" | "pending_approval" | "task_created" | "in_progress" | "fixed" | "verified" | "ignored" | "stale" | "failed";
export interface DeliveryFeedback {
  schemaVersion: 1; id: string; version: number; providerConfigId: string; deliveryId: string; repositoryId: string; proposalKey: string;
  source: { kind: "ci_check"; id: string; name: string; conclusion: string; url?: string; evidence?: string[] } | { kind: "review_comment"; id: string; threadId?: string; author?: string; body: string; url?: string; path?: string; line?: number; resolved?: boolean };
  sourceDigest: string; headSha: string; conversationId?: string; executionPlanId?: string; originRunId?: string; parentRunId?: string; worktreeId?: string; changeSetId?: string; revision?: string; taskId?: number; taskIds?: number[]; followUpRunId?: string; lifecycle: DeliveryFeedbackLifecycle; stale: boolean; createdAt: number; updatedAt: number;
  transitions: Array<{ from: DeliveryFeedbackLifecycle; to: DeliveryFeedbackLifecycle; at: number; actorId: string; reason?: string; version: number }>;
}

export type BundleExportStatus = "queued" | "building" | "verifying" | "ready" | "failed" | "interrupted";
export interface OfflineBundleExport {
  exportId: string;
  changeSetId: string;
  revision: string;
  status: BundleExportStatus;
  options?: { includeTrace: boolean; includeTestOutput: boolean; requireSignature: boolean };
  requestDigest?: string;
  phase?: string;
  progress?: number;
  manifestDigest?: string;
  bundleId?: string;
  bytes?: number;
  errorCode?: string;
  error?: string;
  createdAt?: number;
  updatedAt?: number;
}
export interface OfflineBundleVerification {
  uploadId?: string;
  bundleId?: string;
  manifestDigest?: string;
  integrity: "verified" | "failed";
  authenticity: "unsigned" | "verified" | "untrusted" | "invalid";
  bindings: "verified" | "failed";
  applicability: { baseAvailable: boolean; patchApplies: boolean; changedFilesMatch: boolean };
  issues: Array<{ code?: string; message: string; path?: string }>;
}

export interface ConversationSummary {
  id: string;
  title: string;
  preview: string;
  updatedAt: number;
  messageCount: number;
  mode?: AgentMode;
  status?: ConversationStatus;
  lastRunId?: string;
  summary?: ConversationRunSummary;
}

export interface FileContext {
  path: string;
  content: string;
  language: string;
  selection?: string;
  dirty?: boolean;
  selectionRange?: { startLine: number; endLine: number };
}

export interface SelectionInfo {
  text: string;
  startLine: number;
  endLine: number;
}

export interface AdminUser {
  username: string;
  defaultWorkspace: string;
  isAdmin: boolean;
}

export interface AdminRegistrationRequest {
  username: string;
  requestedAt: number;
}

export interface LlmSettings {
  vllmApiUrl: string;
  vllmApiKey: string;
  modelName: string;
  maxTokens: number;
  maxAgentIterations: number;
  systemPrompt?: string;
}

export interface ModelCapabilities {
  modelName: string;
  contextWindow?: number;
  maxOutputTokens: number;
  source: "model_metadata" | "context_window" | "fallback";
  fetchedAt: number;
  warning?: string;
  supports?: Record<"streaming" | "tool_calling" | "structured_output" | "reasoning_controls" | "cancellation" | "usage_reporting", boolean>;
}

export type ModelRole = "ask" | "plan" | "code" | "review" | "explore" | "verifier";
export interface ModelSuitability { suitable: boolean; required: string[]; missing: string[]; }
export interface ModelBudgetEntry { scope: { kind: "workspace" | "team" | "task" | "agent"; id: string }; version: number; policy: { maxTokens?: number; maxCostUsd?: number; warningRatio?: number }; usedTokens: number; usedCostUsd: number; updatedAt: number; lastUsage?: { tokens: number; costUsd: number; provenance: { source: "provider_reported" | "estimated"; providerId: string; modelName: string; runId?: string; requestId?: string }; recordedAt: number }; }

export type MemoryScope = "user" | "workspace";

export interface MemoryEntry {
  scope: MemoryScope;
  path: string;
  content: string;
  exists: boolean;
  characters: number;
  updatedAt?: number;
  limit: number;
}

export interface SkillSummary {
  name: string;
  description: string;
  trigger: string;
  tags: string;
  path: string;
  metadata: Record<string, string>;
  enabled: boolean;
  characters: number;
  updatedAt?: number;
  usageCount: number;
  lastUsedAt?: number;
}

export interface SkillDetail extends SkillSummary {
  body: string;
}

export interface SkillUsageRecord {
  runId: string;
  conversationId: string;
  mode: string;
  status: string;
  timestamp: number;
  detail?: string;
}

export interface McpSettings {
  baseUrls: string[];
  lazyUrls: string[];
  disabledUrls: string[];
  servers?: McpServerConfig[];
  timeout: number;
  connectTimeout: number;
}

export type McpServerConfig =
  | {
      id: string;
      transport: "remote";
      url: string;
      headers?: Record<string, string>;
      oauthTokenEnv?: string;
      lazy?: boolean;
      disabled?: boolean;
    }
  | {
      id: string;
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      lazy?: boolean;
      disabled?: boolean;
    };

export type AgentProfileId = AgentMode | "explore" | "subagent" | "teammate";

export interface AgentProfileOverride {
  modelName?: string;
  providerId?: string;
  budget?: Partial<{
    maxSteps: number;
    maxToolCalls: number;
    maxDurationMs: number;
    maxOutputTokens: number;
    maxCostUsd: number;
  }>;
  permissions?: Partial<{ allow: string[]; deny: string[] }>;
  pricing?: Partial<{ inputPerMillionUsd: number; outputPerMillionUsd: number }>;
  stepSnapshots?: boolean;
}

export type AgentProfileOverrides = Partial<Record<AgentProfileId, AgentProfileOverride>>;

export interface McpServerPreview {
  endpoint: string;
  endpointKey: string;
  configId: string;
  transport: McpServerConfig["transport"];
  disabled: boolean;
  ok: boolean;
  toolCount: number;
  tools: Array<{ name: string; description: string }>;
  latencyMs?: number;
  attempts?: number;
  lastCheckedAt?: number;
  error?: string;
}

export interface PluginOverrideSettings {
  enabled: boolean;
}

export interface PermissionLayer { id: string; allow: string[]; deny?: string[]; signed?: boolean; }
export interface SandboxGrant { readPaths?: string[]; writePaths?: string[]; networkOrigins?: string[]; secretEnv?: string[]; }
export interface AdminExtensionPolicy { schemaVersion: 1; version: number; permissions: PermissionLayer; sandbox: SandboxGrant; trustedSigningKeys?: Record<string, string>; updatedAt: string; }
export interface WorkspaceExtensionPolicy { schemaVersion: 1; version: number; adminPolicyVersion: number; permissions: PermissionLayer; sandbox: SandboxGrant; updatedAt: string; }
export interface PermissionExplanation { permission: string; allowed: boolean; layers: Array<{ id: string; allowed: boolean; reason: string }>; effectiveSandbox: SandboxGrant; }
export interface RegisteredExtensionPolicyHook { id: string; event: string; failureMode: "open" | "closed"; blocksCompletion: boolean; profileId?: string; skillIds: string[]; }
export interface RegisteredExtensionPolicyPlugin { id: string; hooks: RegisteredExtensionPolicyHook[]; profiles: string[]; skills: string[]; }
export interface ExtensionPolicyBinding { pluginId: string; profileId?: string; skillIds?: string[]; hookId?: string; }
export type ExtensionHookTransport = { kind: "command"; command: string; args: Array<string | number | boolean>; cwd?: string } | { kind: "http"; url: string; method: "POST" | "PUT" | "PATCH" } | { kind: "mcp"; serverId: string; toolName: string };
export interface ExtensionHookDeclaration { id: string; event: string; permissions: string[]; transport: ExtensionHookTransport; sandbox: SandboxGrant; failureMode: "open" | "closed"; timeoutMs: number; maxRetries: number; maxOutputBytes: number; blocksCompletion?: boolean; }

export interface AppSettings {
  uploadMaxFileSizeMb: number;
}

export interface AdminSettings {
  users: AdminUser[];
  pendingRegistrations: AdminRegistrationRequest[];
  allowedRoots: string[];
  llm: LlmSettings;
  agents: AgentProfileOverrides;
  mcp: McpSettings;
  app: AppSettings;
  plugins?: {
    overrides: Record<string, PluginOverrideSettings>;
  };
}

export type TeamRole = "owner" | "admin" | "member" | "viewer";

export interface TeamMember {
  username: string;
  role: TeamRole;
  joinedAt: number;
}

export interface TeamInvite {
  code: string;
  role: TeamRole;
  createdBy: string;
  createdAt: number;
  usedBy?: string;
  usedAt?: number;
}

export interface TeamClaim {
  path: string;
  username: string;
  updatedAt: number;
}

export interface TeamPresence {
  username: string;
  online: boolean;
  activeFilePath?: string;
  cursorLine?: number;
  cursorColumn?: number;
  activity?: string;
  updatedAt: number;
}

export interface TeamActivity {
  id: string;
  type:
    | "team_created"
    | "member_joined"
    | "member_left"
    | "member_removed"
    | "member_role_updated"
    | "ownership_transferred"
    | "invite_created"
    | "file_saved"
    | "entry_created"
    | "entry_copied"
    | "entry_deleted"
    | "entry_renamed"
    | "claim_updated";
  username: string;
  createdAt: number;
  payload?: Record<string, unknown>;
}

export interface TeamSummary {
  id: string;
  name: string;
  workspaceDir: string;
  memberCount: number;
  onlineCount: number;
  role: TeamRole | null;
}

export interface TeamDetails extends TeamSummary {
  members: TeamMember[];
  invites: TeamInvite[];
  claims: TeamClaim[];
  presence: TeamPresence[];
  activity: TeamActivity[];
}

export type CollaborationSubject = { kind: "human" | "agent"; id: string };
export interface CollaborationAnchor { path: string; startLine: number; endLine: number; fileDigest: string; revision: string; selectedText?: string; status: "active" | "relocated" | "stale"; }
export interface CollaborationClaim { id: string; subject: CollaborationSubject; anchor: CollaborationAnchor; createdAt: number; updatedAt: number; }
export interface CollaborationComment { id: string; author: CollaborationSubject; body: string; anchor: CollaborationAnchor; mentions: CollaborationSubject[]; evidenceLinks: string[]; createdAt: number; updatedAt: number; resolvedAt?: number; }
export interface CollaborationReviewRequest { id: string; createdBy: CollaborationSubject; assignees: CollaborationSubject[]; anchor: CollaborationAnchor; message?: string; status: "open" | "completed" | "stale"; commentIds: string[]; createdAt: number; updatedAt: number; }
export interface CollaborationBuffer { id: string; username: string; path: string; version: number; digest: string; savedDigest: string; baseDigest: string; revision: string; dirty: boolean; updatedAt: number; }
export type CollaborationMergeChoice = "apply-human" | "apply-agent" | "manual";
export type CollaborationMergeDecisionStatus = "resolution_pending" | "resolved" | "stale";
export interface CollaborationMergeAllowedAction { choice: CollaborationMergeChoice; enabled: boolean; requiresSave: boolean; requiresNewRevision: boolean; reason?: string; }
export interface CollaborationMergePreview { id: string; changeSetId: string; path: string; version: number; revision: string; baseDigest: string; humanDigest: string; upstreamDigest: string; agentDigest: string; humanBufferVersion?: number; allowedActions: CollaborationMergeAllowedAction[]; hunks: Array<{ id: string; base: string; human?: string; upstream: string; agent: string; conflict: boolean }>; createdBy: string; createdAt: number; updatedAt: number; }
export interface CollaborationMergeDecision { id: string; previewId: string; previewVersion: number; changeSetId: string; path: string; revision: string; baseDigest: string; humanDigest: string; upstreamDigest: string; agentDigest: string; humanBufferVersion?: number; choice: CollaborationMergeChoice; status: CollaborationMergeDecisionStatus; actorId: string; reason?: string; resolvedDigest?: string; supersedesDecisionId?: string; createdAt: number; }
export interface CollaborationActivity { id: string; type: "claim" | "presence" | "comment" | "review_request" | "mention" | "buffer" | "merge_preview" | "merge_decision" | "mutation"; actorId: string; createdAt: number; path?: string; targetId?: string; evidenceLinks?: string[]; detail?: string; }
export interface CollaborationOwnership {
  claims: Array<{ source: "team" | "agent" | "collaboration"; path: string; subject: CollaborationSubject; updatedAt: number; range?: { startLine: number; endLine: number }; status?: CollaborationAnchor["status"] }>;
  changeSets: Array<{ changeSetId: string; revision: string; worktreeId: string; subject: CollaborationSubject; paths: string[]; status: string }>;
  tasks: Array<{ taskId: string; subject: CollaborationSubject; status: string; version: number }>;
}
export interface CollaborationState { schemaVersion: 1; version: number; claims: CollaborationClaim[]; presence: Array<{ subject: CollaborationSubject; online: boolean; activePath?: string; cursorLine?: number; cursorColumn?: number; activity?: string; updatedAt: number }>; comments: CollaborationComment[]; reviewRequests: CollaborationReviewRequest[]; buffers: CollaborationBuffer[]; mergePreviews: CollaborationMergePreview[]; mergeDecisions: CollaborationMergeDecision[]; activity: CollaborationActivity[]; ownership?: CollaborationOwnership; }

export interface AgentSnapshot {
  /** Stable server identifier. Older servers used the display name only. */
  id?: string;
  name: string;
  role: string;
  status: "working" | "idle" | "paused" | "queued" | "blocked" | "failed" | "shutdown" | "interrupted" | "orphaned" | "awaiting_review" | "finalizing";
  currentTask?: string;
  startedAt?: number;
  updatedAt?: number;
  version?: number;
  capabilities?: string[];
  canManageBudget?: boolean;
  budget?: OrchestrationBudget;
  metrics?: Partial<AgentRunMetrics> & { successRate?: number };
  blockers?: string[];
}

export type AgentGraphNodeKind = "run" | "agent" | "task" | "worktree" | "change_set" | "unresolved_parent";
export type AgentGraphEdgeKind = "spawned_by" | "owns_task" | "uses_worktree" | "produced_change_set" | "verified_by";
export type AgentGraphBlockingReason = "waiting_on_children" | "child_failed" | "awaiting_change_set_review";
export interface AgentGraphNode { id: string; kind: AgentGraphNodeKind; ref: string; status?: string; aggregateStatus?: string; blockingReasons?: AgentGraphBlockingReason[]; summary: string; metadata: Record<string, unknown>; }
export interface AgentGraphEdge { id: string; kind: AgentGraphEdgeKind; source: string; target: string; metadata?: Record<string, unknown>; }
export interface AgentGraphEvent { id: string; timestamp: number; kind: string; nodeId?: string; summary: string; parentEventId?: string; metadata?: Record<string, unknown>; }
export interface AgentGraphSnapshot { schemaVersion: 1; revision: string; asOf: number; nodes: AgentGraphNode[]; edges: AgentGraphEdge[]; events: AgentGraphEvent[]; }
export interface AgentGraphWsMessage { type: "agent_graph_snapshot" | "agent_graph_event"; sequence: number; cursor: number; revision: string; graph: AgentGraphSnapshot; }
export interface LegacyAgentWsMessage { type: "agent_snapshot" | "agent_update"; sequence: number; agents: AgentSnapshot[]; }

export interface OrchestrationBudget {
  maxConcurrentAgents?: number;
  maxTokens?: number;
  maxCostUsd?: number;
  maxDurationMs?: number;
}

export function canUpdateAgentBudget(agent: Pick<AgentSnapshot, "capabilities" | "canManageBudget">): boolean {
  // This authorization bit is derived server-side from both the canonical
  // capability and the current user's owner/admin role.
  return agent.canManageBudget === true;
}

export type AgentControlAction = "stop" | "steer" | "pause" | "resume" | "retry" | "reassign" | "replace";

export const LANGUAGE_MAP: Record<string, string> = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescript",
  ".py": "python",
  ".json": "json",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".md": "markdown",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".xml": "xml",
  ".sh": "shell",
  ".bash": "shell",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".rb": "ruby",
  ".php": "php",
  ".sql": "sql",
  ".toml": "ini",
  ".ini": "ini",
  ".env": "plaintext",
  ".txt": "plaintext",
  ".vue": "vue",
  ".svelte": "svelte",
  ".dockerfile": "dockerfile",
  ".r": "r",
  ".swift": "swift",
  ".kt": "kotlin",
  ".lua": "lua",
  ".pl": "perl",
};

export function getLanguage(filename: string): string {
  const ext = "." + filename.split(".").pop()?.toLowerCase();
  return LANGUAGE_MAP[ext] || "plaintext";
}
