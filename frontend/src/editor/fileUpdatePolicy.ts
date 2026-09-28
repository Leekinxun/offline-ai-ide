import type { OpenFile } from "../types";

export function normalizeWorkspaceRelativePath(rawPath: string, workspaceDir?: string): string {
  if (!rawPath) return "";
  let normalized = rawPath.replace(/\\/g, "/").trim();
  if (workspaceDir) {
    const root = workspaceDir.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
      normalized = normalized.slice(root.length + 1);
    }
  }
  return normalized.replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
}

export function isSameWorkspacePath(
  left: string | null | undefined,
  right: string | null | undefined,
  workspaceDir?: string,
): boolean {
  if (!left || !right) return left === right;
  return normalizeWorkspaceRelativePath(left, workspaceDir) === normalizeWorkspaceRelativePath(right, workspaceDir);
}

export function buildClearedRemoteState(): Pick<
  OpenFile,
  "remoteUpdated" | "remoteContent" | "remoteVersion" | "remoteUpdatedAt"
  | "remoteConflictReason" | "remoteConflictSource" | "remoteConflictActor"
> {
  return {
    remoteUpdated: false,
    remoteContent: undefined,
    remoteVersion: undefined,
    remoteUpdatedAt: undefined,
    remoteConflictReason: undefined,
    remoteConflictSource: undefined,
    remoteConflictActor: undefined,
  };
}

export interface FileSnapshot {
  content: string;
  version?: string;
  updatedAt?: number;
  source?: OpenFile["remoteConflictSource"];
  actor?: string;
}

/** Remote writes never replace a dirty editor model or clear its unsaved flag. */
export function applyRemoteFileSnapshot(file: OpenFile, snapshot: FileSnapshot): OpenFile {
  if (file.modified && file.content !== snapshot.content) {
    // Polling an unchanged disk baseline is not a conflicting external edit.
    if (snapshot.version !== undefined && snapshot.version === file.version && file.remoteContent === undefined) {
      return file;
    }
    const sameRemote = file.remoteContent === snapshot.content;
    return {
      ...file,
      remoteUpdated: sameRemote ? file.remoteUpdated : true,
      remoteContent: snapshot.content,
      remoteVersion: snapshot.version ?? (sameRemote ? file.remoteVersion : undefined),
      remoteUpdatedAt: snapshot.updatedAt ?? (sameRemote ? file.remoteUpdatedAt : undefined),
      remoteConflictReason: sameRemote ? file.remoteConflictReason : "background",
      remoteConflictSource: snapshot.source ?? file.remoteConflictSource ?? "external",
      remoteConflictActor: snapshot.actor,
    };
  }
  return {
    ...file,
    content: snapshot.content,
    // Equal content can be a coincidence; only an explicit save/reload clears dirty.
    modified: file.modified,
    version: snapshot.version ?? (file.content === snapshot.content ? file.version : undefined),
    updatedAt: snapshot.updatedAt ?? (file.content === snapshot.content ? file.updatedAt : undefined),
    ...buildClearedRemoteState(),
  };
}

/** A save acknowledgement belongs to the submitted text, not subsequent typing. */
export function applyFileSaveResult(
  current: OpenFile,
  submitted: OpenFile,
  result: { version: string; updatedAt: number },
): OpenFile {
  if (current.version !== submitted.version) return current;
  const remoteUnchanged = current.remoteContent === submitted.remoteContent
    && current.remoteVersion === submitted.remoteVersion;
  return {
    ...current,
    modified: current.content !== submitted.content || !remoteUnchanged,
    version: result.version,
    updatedAt: result.updatedAt,
    ...(remoteUnchanged ? buildClearedRemoteState() : {}),
  };
}

export interface FileReadScope {
  workspaceDir: string;
  sequence: number;
  requests: Map<string, number>;
}

export interface FileReadTicket {
  scope: FileReadScope;
  path: string;
  sequence: number;
}

export function createFileReadScope(workspaceDir: string): FileReadScope {
  return { workspaceDir, sequence: 0, requests: new Map() };
}

export function beginFileRead(scope: FileReadScope, rawPath: string): FileReadTicket {
  const path = normalizeWorkspaceRelativePath(rawPath, scope.workspaceDir);
  const sequence = ++scope.sequence;
  scope.requests.set(path, sequence);
  return { scope, path, sequence };
}

export function isCurrentFileRead(ticket: FileReadTicket, currentScope: FileReadScope): boolean {
  return ticket.scope === currentScope && currentScope.requests.get(ticket.path) === ticket.sequence;
}

export function invalidateFileRead(scope: FileReadScope, path: string): void {
  scope.requests.delete(normalizeWorkspaceRelativePath(path, scope.workspaceDir));
}

export function retainOpenFilesAfterTreeRefresh(
  files: OpenFile[],
  visiblePaths: ReadonlySet<string>,
  workspaceDir: string,
): OpenFile[] {
  return files.filter((file) => file.modified || visiblePaths.has(normalizeWorkspaceRelativePath(file.path, workspaceDir)));
}
