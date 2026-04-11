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
}

export interface ToolCallStep {
  toolCallId: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  toolCalls?: ToolCallStep[];
  thinking?: string;
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

export const LANGUAGE_MAP: Record<string, string> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
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
  ".vue": "html",
  ".svelte": "html",
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
