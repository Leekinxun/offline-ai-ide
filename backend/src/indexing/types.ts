export type RepositoryContextKind =
  | "path"
  | "lexical"
  | "definition"
  | "reference"
  | "import"
  | "test"
  | "diagnostic"
  | "git"
  | "ownership";

export interface RepositoryRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface RepositoryContextCandidate {
  sourceKey: string;
  kind: RepositoryContextKind;
  path?: string;
  symbol?: string;
  range?: RepositoryRange;
  reasons: string[];
  estimatedTokens: number;
  freshness: {
    indexRevision: number;
    indexedAt: number;
    verifiedAt: number;
    contentHash?: string;
  };
  trust: "workspace" | "generated";
  contentDigest?: string;
  generated: boolean;
  score: number;
  /** Bounded live content, populated only after policy and hash revalidation. */
  content?: string;
}

export interface IndexedSymbol {
  name: string;
  kind: "function" | "class" | "type" | "variable" | "module" | "unknown";
  range: RepositoryRange;
  exported: boolean;
  confidence: "exact" | "heuristic" | "lexical";
}

export interface IndexedImport {
  source: string;
  names: string[];
  line: number;
  resolvedPath?: string;
  confidence: "exact" | "heuristic";
}

export interface IndexedReference {
  symbol: string;
  line: number;
  column: number;
  confidence: "heuristic" | "lexical";
}

export interface GitFileSignal {
  commit?: string;
  committedAt?: number;
  author?: string;
  changeCount: number;
  dirty?: boolean;
}

export interface IndexedRepositoryFile {
  path: string;
  language: string;
  size: number;
  mtimeMs: number;
  contentHash: string;
  indexedAt: number;
  generated: boolean;
  test: boolean;
  symbols: IndexedSymbol[];
  imports: IndexedImport[];
  references: IndexedReference[];
  git?: GitFileSignal;
}

export interface RepositoryIndexMeta {
  schemaVersion: 1;
  partitionId: string;
  workspaceRoot: string;
  revision: number;
  policyVersion: 1;
  adapterVersions: Record<string, number>;
  ignoreFingerprint?: string;
  headSha?: string;
  indexedAt: number;
  updatedAt: number;
  fileCount: number;
  status: "ready" | "stale" | "rebuilding" | "error";
  error?: string;
}

export interface RepositoryIndexStatus {
  schemaVersion: 1;
  partitionId: string;
  revision: number;
  status: "missing" | "ready" | "stale" | "rebuilding" | "error";
  fileCount: number;
  indexedAt?: number;
  updatedAt?: number;
  headSha?: string;
  semanticMode: "off" | "local";
  lastError?: string;
}

export interface RepositoryMutation {
  path: string;
  operation: "create" | "modify" | "delete" | "rename";
  previousPath?: string;
  scope?: "file" | "prefix";
}

export interface RepositoryOwnershipSignal {
  path: string;
  owner: string;
  source: "claim" | "presence" | "change_set" | "worktree";
  updatedAt?: number;
}

export interface RepositoryDiagnosticSignal {
  path: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info";
  message: string;
}

export interface RetrieveRepositoryContextOptions {
  workspaceDir: string;
  query: string;
  currentPath?: string;
  changedPaths?: string[];
  pinnedPaths?: string[];
  excludedPaths?: string[];
  maxResults?: number;
  maxTokens?: number;
  diagnostics?: RepositoryDiagnosticSignal[];
  ownership?: RepositoryOwnershipSignal[];
  semantic?: {
    mode: "off" | "local";
    rerank?: (query: string, candidates: RepositoryContextCandidate[]) => Promise<string[]>;
  };
  signal?: AbortSignal;
}
