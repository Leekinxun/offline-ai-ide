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
}

export interface AgentRunState extends AgentRunSummary {
  events: AgentRunEvent[];
  event?: AgentRunEvent;
}

export interface ConversationRunSummary {
  changedFiles: string[];
  toolCallCount: number;
  errorCount: number;
  commandCount: number;
  reviewFindings?: ReviewFinding[];
}

export type ReviewSeverity = "critical" | "error" | "warning" | "info";

export interface ReviewFinding {
  id: string;
  severity: ReviewSeverity;
  path: string;
  line: number;
  column?: number;
  message: string;
}

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
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
  updatedAt: number;
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
}

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

export interface AgentSnapshot {
  name: string;
  role: string;
  status: "working" | "idle" | "shutdown";
  currentTask?: string;
  startedAt?: number;
  updatedAt?: number;
}

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
