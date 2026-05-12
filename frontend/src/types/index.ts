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

export interface ChatMessage {
  requestId?: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  toolCalls?: ToolCallStep[];
  thinking?: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  preview: string;
  updatedAt: number;
  messageCount: number;
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

export interface LlmSettings {
  vllmApiUrl: string;
  vllmApiKey: string;
  modelName: string;
  maxTokens: number;
  maxAgentIterations: number;
  systemPrompt?: string;
}

export interface PluginOverrideSettings {
  enabled: boolean;
}

export interface AdminSettings {
  users: AdminUser[];
  allowedRoots: string[];
  llm: LlmSettings;
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
