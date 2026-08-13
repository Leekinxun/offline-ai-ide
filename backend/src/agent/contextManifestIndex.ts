import type { ContextPreferencesV1 } from "./contextManifestStore.js";

export interface ContextIndexStatus { status: "unavailable" | "idle" | "indexing" | "ready" | "error"; generation?: string; indexedFiles?: number; updatedAt?: number; error?: string; }
export interface ContextPreviewCandidate { id: string; path?: string; reason: string; estimatedTokens: number; freshness: "fresh" | "possibly_stale" | "stale" | "unknown"; trust: string; decision: "included" | "excluded"; ruleIds: string[]; pinned?: boolean; sourceUpdatedAt?: number; }
export interface ContextRetrievalCandidate extends ContextPreviewCandidate {
  /** Bounded live content. It is model-visible but never persisted in a manifest. */
  content?: string;
  contentDigest?: string;
}
export interface ContextRetrievalInput {
  query: string;
  currentPath?: string;
  changedPaths?: string[];
  maxResults: number;
  maxTokens: number;
  preferences: ContextPreferencesV1;
  viewer: { username: string; isAdmin: boolean };
  scope: { kind: "workspace" | "managed_worktree" | "review_checkout"; scopeId: string };
  signal?: AbortSignal;
}
export interface ContextIndexAdapter {
  status(workspaceDir: string): Promise<ContextIndexStatus> | ContextIndexStatus;
  preview(workspaceDir: string, input: { query: string; limit: number; preferences: ContextPreferencesV1 }): Promise<ContextPreviewCandidate[]>;
  retrieve(workspaceDir: string, input: ContextRetrievalInput): Promise<ContextRetrievalCandidate[]>;
  refresh(workspaceDir: string, paths?: string[]): Promise<ContextIndexStatus>;
  rebuild(workspaceDir: string): Promise<ContextIndexStatus>;
}

const unavailable: ContextIndexAdapter = {
  status: () => ({ status: "unavailable" }),
  preview: async () => [],
  retrieve: async () => [],
  refresh: async () => ({ status: "unavailable" }),
  rebuild: async () => ({ status: "unavailable" }),
};
let adapter: ContextIndexAdapter = unavailable;
export function getContextIndexAdapter(): ContextIndexAdapter { return adapter; }
export function registerContextIndexAdapter(value: ContextIndexAdapter): () => void { const previous = adapter; adapter = value; return () => { if (adapter === value) adapter = previous; }; }
