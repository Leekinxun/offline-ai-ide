import path from "node:path";
import { buildFileVersion } from "../files/mutationRegistry.js";
import { normalizeContextPath, readAuthorizedWorkspaceFile } from "../agent/contextPolicy.js";
import { redactSecrets } from "../agent/secretRedaction.js";
import type { WorkspaceDiagnostic } from "../diagnostics/service.js";

export const EDITOR_DIAGNOSTIC_LIMITS = {
  diagnostics: 100, messageCharacters: 1000, sourceCharacters: 120, textBytes: 32_000,
  entries: 256, totalBytes: 4 * 1024 * 1024, ttlMs: 180_000, readFiles: 20, readDiagnostics: 50,
} as const;

export interface EditorDiagnosticSnapshot {
  path: string;
  version: string;
  modelVersion: number;
  observedAt: number;
  provenance: "editor_advisory";
  baselineEligible: boolean;
  truncated: boolean;
  diagnostics: WorkspaceDiagnostic[];
}
interface PublisherEntry {
  workspaceDir: string; owner: string; path: string; publisherId: string;
  sequence: number; expiresAt: number; bytes: number; snapshot?: EditorDiagnosticSnapshot;
}
const entries = new Map<string, PublisherEntry>();
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const VERSION = /^[a-f0-9]{40}$/;

export class EditorDiagnosticsError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EditorDiagnosticsError(400, "Invalid editor diagnostic payload");
  return value as Record<string, unknown>;
}
function integer(value: unknown, maximum = 1_000_000_000): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) throw new EditorDiagnosticsError(400, "Invalid editor diagnostic position or version");
  return value as number;
}
function scope(auth: { workspaceDir: string; owner: string }, input: Record<string, unknown>) {
  if (!auth.owner || typeof input.workspaceDir !== "string" || path.resolve(input.workspaceDir) !== path.resolve(auth.workspaceDir)) throw new EditorDiagnosticsError(409, "Workspace changed; discard this editor snapshot");
  const relative = typeof input.path === "string" && input.path.length <= 1000 && !input.path.includes("\0") ? normalizeContextPath(input.path) : null;
  if (!relative || typeof input.publisherId !== "string" || !ID.test(input.publisherId)) throw new EditorDiagnosticsError(400, "Invalid editor diagnostic scope");
  const sequence = integer(input.sequence, Number.MAX_SAFE_INTEGER);
  const workspaceDir = path.resolve(auth.workspaceDir);
  return { workspaceDir, owner: auth.owner, path: relative, publisherId: input.publisherId, sequence,
    key: JSON.stringify([workspaceDir, auth.owner, relative, input.publisherId]) };
}
function prune(): void {
  const now = Date.now();
  for (const [key, entry] of entries) if (entry.expiresAt <= now) entries.delete(key);
  let bytes = [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  while (entries.size > EDITOR_DIAGNOSTIC_LIMITS.entries || bytes > EDITOR_DIAGNOSTIC_LIMITS.totalBytes) {
    const first = entries.keys().next().value;
    if (!first) break;
    bytes -= entries.get(first)!.bytes; entries.delete(first);
  }
}
function assertSequence(key: string, sequence: number): void {
  if (sequence <= (entries.get(key)?.sequence || 0)) throw new EditorDiagnosticsError(409, "A newer editor snapshot already replaced this request");
}

/** Authenticated client observations are hints, never command/validator pass evidence. */
export function publishEditorDiagnostics(auth: { workspaceDir: string; owner: string }, value: unknown): EditorDiagnosticSnapshot {
  prune();
  const input = object(value); const identity = scope(auth, input);
  assertSequence(identity.key, identity.sequence);
  if (input.dirty !== false) throw new EditorDiagnosticsError(409, "Unsaved editor diagnostics cannot be attached to a disk version");
  if (typeof input.version !== "string" || !VERSION.test(input.version)) throw new EditorDiagnosticsError(400, "A disk version is required");
  const modelVersion = integer(input.modelVersion);
  if (!Array.isArray(input.diagnostics) || input.diagnostics.length > EDITOR_DIAGNOSTIC_LIMITS.diagnostics) throw new EditorDiagnosticsError(400, "Too many editor diagnostics");
  let file: ReturnType<typeof readAuthorizedWorkspaceFile>;
  try { file = readAuthorizedWorkspaceFile(identity.workspaceDir, identity.path); }
  catch { throw new EditorDiagnosticsError(403, "This file is unavailable or not authorized for diagnostic feedback"); }
  if (buildFileVersion(file.content) !== input.version) throw new EditorDiagnosticsError(409, "Editor diagnostics refer to a stale disk version");
  const fileLines = file.content.split(/\r\n|\r|\n/);
  let textBytes = 0; let allMarkerVersionsKnown = input.diagnostics.length > 0;
  const diagnostics = input.diagnostics.map((raw): WorkspaceDiagnostic => {
    const diagnostic = object(raw);
    if (diagnostic.path !== undefined && diagnostic.path !== identity.path) throw new EditorDiagnosticsError(400, "A diagnostic belongs to another file");
    if (diagnostic.modelVersion !== undefined) {
      if (integer(diagnostic.modelVersion) !== modelVersion) throw new EditorDiagnosticsError(409, "A diagnostic belongs to an older editor model version");
    } else allMarkerVersionsKnown = false;
    const line = integer(diagnostic.line, fileLines.length);
    const column = Math.min(integer(diagnostic.column, 1_000_000), fileLines[line - 1].length + 1);
    if (!["error", "warning", "info"].includes(String(diagnostic.severity))) throw new EditorDiagnosticsError(400, "Invalid diagnostic severity");
    if (typeof diagnostic.message !== "string" || !diagnostic.message.trim() || diagnostic.message.length > EDITOR_DIAGNOSTIC_LIMITS.messageCharacters
      || typeof diagnostic.source !== "string" || !diagnostic.source.trim() || diagnostic.source.length > EDITOR_DIAGNOSTIC_LIMITS.sourceCharacters
      || (diagnostic.code !== undefined && (typeof diagnostic.code !== "string" || diagnostic.code.length > 100))) throw new EditorDiagnosticsError(400, "Diagnostic text exceeds its bounds");
    const message = redactSecrets(diagnostic.message); const source = redactSecrets(diagnostic.source);
    const code = typeof diagnostic.code === "string" ? redactSecrets(diagnostic.code) : undefined;
    textBytes += Buffer.byteLength(message + source + (code || ""));
    if (textBytes > EDITOR_DIAGNOSTIC_LIMITS.textBytes) throw new EditorDiagnosticsError(400, "Editor diagnostics exceed the text budget");
    return { path: identity.path, line, column, severity: diagnostic.severity as WorkspaceDiagnostic["severity"], message, source,
      ...(code ? { code } : {}) };
  });
  const snapshot: EditorDiagnosticSnapshot = {
    path: identity.path, version: input.version, modelVersion, observedAt: Date.now(), provenance: "editor_advisory",
    baselineEligible: allMarkerVersionsKnown && input.truncated !== true, truncated: input.truncated === true, diagnostics,
  };
  entries.delete(identity.key);
  entries.set(identity.key, { ...identity, expiresAt: Date.now() + EDITOR_DIAGNOSTIC_LIMITS.ttlMs,
    bytes: Buffer.byteLength(JSON.stringify(snapshot)) + identity.key.length * 2, snapshot });
  prune();
  return structuredClone(snapshot);
}

/** Keep a bounded tombstone so an aborted, late POST cannot undo a newer clear. */
export function clearEditorDiagnostics(auth: { workspaceDir: string; owner: string }, value: unknown): void {
  prune();
  const identity = scope(auth, object(value)); assertSequence(identity.key, identity.sequence);
  entries.delete(identity.key);
  entries.set(identity.key, { ...identity, bytes: identity.key.length * 2 + 128, expiresAt: Date.now() + EDITOR_DIAGNOSTIC_LIMITS.ttlMs });
  prune();
}

/** Rechecks policy and disk bytes at consumption; no cached hint grants read access. */
export function getEditorDiagnosticFeedback(input: { workspaceDir: string; owner: string; path?: string; version?: string }): EditorDiagnosticSnapshot[] {
  prune();
  if (!input.owner) return [];
  const selectedPath = input.path === undefined ? undefined : normalizeContextPath(input.path);
  if (input.path !== undefined && !selectedPath) return [];
  const latest = new Map<string, EditorDiagnosticSnapshot>();
  for (const entry of entries.values()) {
    if (entry.workspaceDir !== path.resolve(input.workspaceDir) || entry.owner !== input.owner || !entry.snapshot
      || (selectedPath && entry.path !== selectedPath) || (input.version && entry.snapshot.version !== input.version)) continue;
    if ((latest.get(entry.path)?.observedAt ?? -1) <= entry.snapshot.observedAt) latest.set(entry.path, entry.snapshot);
  }
  const result: EditorDiagnosticSnapshot[] = []; let remaining: number = EDITOR_DIAGNOSTIC_LIMITS.readDiagnostics;
  for (const snapshot of [...latest.values()].sort((a, b) => b.observedAt - a.observedAt)) {
    if (result.length >= EDITOR_DIAGNOSTIC_LIMITS.readFiles || remaining === 0) break;
    try {
      if (buildFileVersion(readAuthorizedWorkspaceFile(input.workspaceDir, snapshot.path).content) !== snapshot.version) continue;
      const truncated = snapshot.truncated || snapshot.diagnostics.length > remaining;
      const diagnostics = snapshot.diagnostics.slice(0, remaining); remaining -= diagnostics.length;
      result.push(structuredClone({ ...snapshot, diagnostics, truncated, baselineEligible: snapshot.baselineEligible && !truncated }));
    } catch { /* Protected, deleted or changed files are not model-visible. */ }
  }
  return result;
}
