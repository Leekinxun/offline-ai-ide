import { desktopNativeIdeEnabled, getDesktopNativeIde, type NativeIdeClient } from "./nativeIdeClient.js";

export interface NativeIndexEntry {
  path: string;
  size: number;
  mtimeMs: number;
  contentHash: string;
}

export interface NativeIndexContent extends NativeIndexEntry {
  content: string;
}

export interface NativeIndexScan {
  sessionId: string;
  workspaceRoot: string;
  policyFingerprint: string;
  total: number;
  truncated: boolean;
}

export interface NativeIndexPage {
  entries: NativeIndexEntry[];
  nextCursor?: number;
  done: boolean;
}

export interface NativeIndexReadBatch {
  files: NativeIndexContent[];
  truncated: boolean;
}

export interface NativeIndexPolicy {
  workspaceRoot: string;
  policyFingerprint: string;
}

export function nativeIndexEnabled(): boolean {
  return desktopNativeIdeEnabled();
}

function client(input?: NativeIdeClient): NativeIdeClient {
  return input || getDesktopNativeIde();
}

export async function scanNativeIndex(
  workspaceDir: string,
  options: { prefix?: string; signal?: AbortSignal; client?: NativeIdeClient } = {}
): Promise<NativeIndexScan> {
  return client(options.client).request("index.scan", {
    workspaceDir,
    ...(options.prefix ? { prefix: options.prefix } : {}),
  }, { signal: options.signal, timeoutMs: 120_000 });
}

export async function pageNativeIndex(
  sessionId: string,
  options: { cursor?: number; limit?: number; signal?: AbortSignal; client?: NativeIdeClient } = {}
): Promise<NativeIndexPage> {
  return client(options.client).request("index.page", {
    sessionId,
    cursor: options.cursor || 0,
    limit: Math.max(1, Math.min(options.limit || 1000, 1000)),
  }, { signal: options.signal, timeoutMs: 30_000 });
}

export async function readNativeIndexBatch(
  sessionId: string,
  paths: string[],
  options: { signal?: AbortSignal; client?: NativeIdeClient } = {}
): Promise<NativeIndexReadBatch> {
  return client(options.client).request("index.readBatch", {
    sessionId,
    paths,
  }, { signal: options.signal, timeoutMs: 60_000 });
}

export async function nativeIndexPolicy(
  workspaceDir: string,
  options: { signal?: AbortSignal; client?: NativeIdeClient } = {}
): Promise<NativeIndexPolicy> {
  return client(options.client).request("index.policy", { workspaceDir }, { signal: options.signal, timeoutMs: 30_000 });
}

export async function closeNativeIndex(sessionId: string, input?: NativeIdeClient): Promise<void> {
  await client(input).request("index.close", { sessionId }, { timeoutMs: 10_000 });
}
