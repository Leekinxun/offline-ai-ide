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
      mode: AgentMode;
      status: AgentRunStatus;
      metrics: AgentRunMetrics;
      event?: AgentRunEvent;
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
  signal?: AbortSignal;
  authorizeTool?: import("./permissionService.js").PermissionAuthorizer;
  lineage?: {
    parentRunId: string;
    parentConversationId: string;
    parentRequestId: string;
    parentToolCallId: string;
  };
  agentProfileId?: import("./agentProfiles.js").AgentProfileId;
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
  status: "pending" | "in_progress" | "completed" | "deleted";
  owner: string | null;
  blockedBy: number[];
  blocks: number[];
}

// --- Team types ---

export interface TeamConfig {
  team_name: string;
  members: TeamMember[];
}

export interface TeamMember {
  name: string;
  role: string;
  status: "working" | "idle" | "shutdown";
  currentTask?: string;
  startedAt?: number;
  updatedAt?: number;
}

export interface InboxMessage {
  type: string;
  from: string;
  content: string;
  timestamp: number;
  [key: string]: unknown;
}

// --- Helper ---

export function wsSend(ws: WebSocket, data: WsServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}
