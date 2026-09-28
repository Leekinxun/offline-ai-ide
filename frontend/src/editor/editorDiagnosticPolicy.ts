import type { OpenFile } from "../types";
import type { EditorProblem } from "../hooks/useEditorProblems";
import { normalizeWorkspaceRelativePath } from "./fileUpdatePolicy";

export interface EditorDiagnosticModelSnapshot { uri: string; path: string; version: number; content: string; }
export interface EditorDiagnosticPayload {
  workspaceDir: string; path: string; version: string; modelVersion: number;
  publisherId: string; sequence: number; dirty: false; truncated: boolean;
  diagnostics: Array<{ line: number; column: number; severity: EditorProblem["severity"]; message: string; source: string; code?: string; modelVersion?: number }>;
}
export type DiagnosticFile = Pick<OpenFile, "path" | "content" | "version" | "modified">;

export function diagnosticModelPath(value: string, workspaceDir: string): string {
  return normalizeWorkspaceRelativePath(value.replace(/^\/(?=[A-Za-z]:[\/\\])/, ""), workspaceDir);
}

/** Unknown producer versions stay explicitly unknown; observation is not a validation result. */
export function buildEditorDiagnosticPayload(input: {
  workspaceDir: string; file: DiagnosticFile; model: EditorDiagnosticModelSnapshot;
  contentVersion: string; problems: readonly EditorProblem[]; publisherId: string; sequence: number;
}): EditorDiagnosticPayload | null {
  const { file, model } = input;
  const path = diagnosticModelPath(file.path, input.workspaceDir);
  if (file.modified || !file.version || !/^[a-f0-9]{40}$/.test(file.version)
    || file.version !== input.contentVersion || file.content !== model.content
    || !Number.isSafeInteger(model.version) || model.version < 1
    || diagnosticModelPath(model.path, input.workspaceDir) !== path) return null;
  const matching = input.problems.filter((problem) => problem.modelUri
    ? problem.modelUri === model.uri : diagnosticModelPath(problem.path, input.workspaceDir) === path);
  // A marker observed before the current model revision must not be relabelled
  // with today's disk hash, even when its producer did not publish a version.
  if (matching.some((problem) => problem.observedModelVersion !== model.version
    || (problem.modelVersion !== undefined && problem.modelVersion !== model.version))) return null;
  let truncated = matching.length > 100;
  let bytes = 0;
  const diagnostics: EditorDiagnosticPayload["diagnostics"] = [];
  for (const problem of matching.slice(0, 100)) {
    const message = problem.message.slice(0, 1000); const source = `editor:${problem.source}`.slice(0, 120); const code = problem.code?.slice(0, 100);
    if (message.length !== problem.message.length || source.length < `editor:${problem.source}`.length || code?.length !== problem.code?.length) truncated = true;
    bytes += new TextEncoder().encode(message + source + (code || "")).byteLength;
    if (bytes > 32_000) { truncated = true; break; }
    diagnostics.push({ line: problem.line, column: problem.column, severity: problem.severity, message, source,
      ...(code ? { code } : {}), ...(problem.modelVersion !== undefined ? { modelVersion: problem.modelVersion } : {}) });
  }
  return { workspaceDir: input.workspaceDir, path, version: file.version, modelVersion: model.version,
    publisherId: input.publisherId, sequence: input.sequence, dirty: false, truncated, diagnostics };
}
