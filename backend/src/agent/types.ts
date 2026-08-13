import { WebSocket } from "ws";

// --- OpenAI-compatible API types ---

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenAIChoice {
  message: {
    role: string;
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason?: "stop" | "tool_calls" | "length" | null;
}

export interface OpenAIResponse {
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface FileSelectionRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface ToolFileUpdate {
  path: string;
  content: string;
  selection?: FileSelectionRange;
}

export type AgentMode = "ask" | "code" | "review" | "plan";

export type AgentRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "stopped"
  | "failed";

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

export interface AgentRunEventInput {
  kind: AgentRunEventKind;
  label: string;
  requestId?: string;
  toolName?: string;
  durationMs?: number;
  isError?: boolean;
  detail?: string;
}

// --- WebSocket message types (server -> client) ---

export type WsServerMessage =
  | { type: "conversation"; conversationId: string; created: boolean }
  | { type: "conversation_updated"; conversationId: string; title: string }
  | {
      type: "conversation_state";
      conversationId: string;
      mode: AgentMode;
      status: "queued" | "running" | "completed" | "stopped" | "failed";
    }
  | {
      type: "run_state";
      conversationId: string;
      runId: string;
      requestId?: string;
      mode: AgentMode;
      modelName?: string;
      status: AgentRunStatus;
      /** Monotonic trace ordering and optimistic state revision for WS consumers. */
      sequence?: number;
      version?: number;
      metrics: AgentRunMetrics;
      event?: AgentRunEvent;
      executionContractKind?: "direct_code" | "approved_plan";
      completionEvidence?: import("../chat/completionEvidence.js").CompletionEvidence;
      qualityGate?: import("../extensions/policy/completionGate.js").CompletionGateEvidence;
      executionPlan?: import("../chat/executionPlans.js").ExecutionPlan;
    }
  | {
      type: "context_state";
      requestId: string;
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
  | ({ type: "context_manifest_state" } & import("./contextManifest.js").ContextManifestState)
  | {
      type: "context_index_state";
      requestId?: string;
      status: "unavailable" | "idle" | "indexing" | "ready" | "error";
      generation?: string;
      indexedFiles?: number;
      updatedAt?: number;
      error?: string;
    }
  | {
      type: "mcp_state";
      requestId: string;
      status: "ready" | "warning";
      serverCount: number;
      toolCount: number;
      servers?: Array<{
        endpoint: string;
        endpointKey: string;
        ok: boolean;
        toolCount: number;
        latencyMs?: number;
        attempts?: number;
        lastCheckedAt?: number;
        error?: string;
      }>;
      message?: string;
    }
  | {
      type: "knowledge_state";
      requestId: string;
      memoryFiles: number;
      skillCount: number;
    }
  | {
      type: "summary";
      conversationId: string;
      requestId: string;
      runId?: string;
      metrics?: AgentRunMetrics;
      changedFiles: string[];
      toolCallCount: number;
      errorCount: number;
      commandCount: number;
      executionContractKind?: "direct_code" | "approved_plan";
      completionEvidence?: import("../chat/completionEvidence.js").CompletionEvidence;
      qualityGate?: import("../extensions/policy/completionGate.js").CompletionGateEvidence;
      executionPlan?: import("../chat/executionPlans.js").ExecutionPlan;
    }
  | { type: "stopped"; requestId?: string; content?: string }
  | { type: "steering"; requestId: string; content: string }
  | { type: "thinking"; requestId: string; content: string }
  | {
      type: "tool_call";
      requestId: string;
      toolCallId: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_approval_request";
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
  | {
      type: "tool_result";
      requestId: string;
      toolCallId: string;
      name: string;
      result: string;
      isError?: boolean;
      fileUpdate?: ToolFileUpdate;
    }
  | { type: "token"; requestId: string; content: string }
  | { type: "done"; requestId: string; interrupted?: boolean }
  | { type: "error"; requestId?: string; content: string };

// --- Tool context ---

export interface ToolContext {
  workspaceDir: string;
  vllmApiUrl: string;
  vllmApiKey: string;
  modelName: string;
  actorName?: string;
  /** Correlates a primary tool mutation with its request and tool execution. */
  requestId?: string;
  toolCallId?: string;
  /** Set only by the approved primary bash dispatch. */
  compatibilityShellAuthorized?: boolean;
  /** Effective filesystem ceiling resolved from admin/profile/workspace policy. */
  filesystemSandbox?: import("../extensions/policy/types.js").SandboxGrant;
  signal?: AbortSignal;
  authorizeTool?: import("./permissionService.js").PermissionAuthorizer;
  lineage?: {
    parentRunId: string;
    parentTaskId?: number;
    parentConversationId: string;
    parentRequestId: string;
    parentToolCallId: string;
  };
  agentProfileId?: import("./agentProfiles.js").AgentProfileId;
  mode?: AgentMode;
  conversationId?: string;
  runId?: string;
  executionPlan?: import("../chat/executionPlans.js").ExecutionPlan;
}

// --- Todo types ---

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

// --- Task types ---

export interface Task {
  id: number;
  subject: string;
  description: string;
  status: TaskStatus;
  owner: string | null;
  blockedBy: number[];
  blocks: number[];
  parentId?: number;
  required?: boolean;
  lease?: TaskLease;
  version?: number;
  createdAt?: number;
  updatedAt?: number;
  completionEvidence?: string[];
  budget?: OrchestrationBudget;
  requiresPlanApproval?: boolean;
  planApproved?: boolean;
  minimumCompletionQuality?: number;
  completionQuality?: number;
}

export type TaskStatus = "pending" | "blocked" | "in_progress" | "paused" | "completed" | "failed" | "cancelled" | "deleted";
export interface TaskLease { owner: string; token: string; expiresAt: number; claimedAt: number; }
export type AgentLifecycleStatus = "queued" | "working" | "paused" | "idle" | "stopped" | "interrupted" | "orphaned" | "failed" | "shutdown";
export interface OrchestrationBudget { maxConcurrentAgents?: number; maxTokens?: number; maxCostUsd?: number; maxDurationMs?: number; usedTokens?: number; usedCostUsd?: number; startedAt?: number; }

// --- Team types ---

export interface TeamConfig {
  schemaVersion?: 1;
  team_name: string;
  members: TeamMember[];
  budget?: OrchestrationBudget;
  workspaceBudget?: OrchestrationBudget;
  version?: number;
}

export interface TeamMember {
  name: string;
  role: string;
  status: AgentLifecycleStatus;
  currentTask?: string;
  startedAt?: number;
  updatedAt?: number;
  id?: string;
  parentAgentId?: string;
  parentRunId?: string;
  parentTaskId?: number;
  parentConversationId?: string;
  parentRequestId?: string;
  parentToolCallId?: string;
  childRunId?: string;
  worktreePath?: string;
  worktreeId?: string;
  model?: string;
  permissions?: string[];
  capabilities?: string[];
  budget?: OrchestrationBudget;
  evidence?: string[];
  checkpoint?: string;
  version?: number;
  heartbeatAt?: number;
  leaseExpiresAt?: number;
  steering?: string[];
  requiresPlanApproval?: boolean;
  planApproved?: boolean;
  minimumCompletionQuality?: number;
  completionQuality?: number;
  executionId?: string;
  processId?: number;
  /** Bounded durable inbox receipt set used to make lease redelivery idempotent. */
  handledMessageIds?: string[];
}

/** Canonical teammate capability identifiers shared by runtime and transports. */
export const TEAMMATE_CAPABILITY = {
  READ_FILE: "read_file",
  WRITE_FILE: "write_file",
  EDIT_FILE: "edit_file",
  BASH: "bash",
  SEND_MESSAGE: "send_message",
  CLAIM_TASK: "claim_task",
  UPDATE_BUDGET: "budget.update",
} as const;

export const DEFAULT_TEAMMATE_CAPABILITIES = Object.freeze(Object.values(TEAMMATE_CAPABILITY));

export interface InboxMessage {
  id?: string;
  type: string;
  from: string;
  content: string;
  timestamp: number;
  recipient?: string;
  sequence?: number;
  delivery?: "available" | "leased" | "acked";
  lease?: { consumer: string; token: string; expiresAt: number };
  [key: string]: unknown;
}

// --- Helper ---

export function wsSend(ws: WebSocket, data: WsServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}
