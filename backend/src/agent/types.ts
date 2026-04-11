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
  finish_reason: "stop" | "tool_calls" | "length" | null;
}

export interface OpenAIResponse {
  choices: OpenAIChoice[];
}

// --- WebSocket message types (server -> client) ---

export type WsServerMessage =
  | { type: "thinking"; content: string }
  | { type: "tool_call"; toolCallId: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolCallId: string; name: string; result: string; isError?: boolean }
  | { type: "token"; content: string }
  | { type: "done" }
  | { type: "error"; content: string };

// --- Tool context ---

export interface ToolContext {
  workspaceDir: string;
  vllmApiUrl: string;
  vllmApiKey: string;
  modelName: string;
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
