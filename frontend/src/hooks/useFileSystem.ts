import { useCallback, useMemo } from "react";
import { DefinitionLocation, FileNode, GitStatus } from "../types";

const API = "/api/files";

export interface UploadFilePayload {
  path: string;
  file: File;
}

export interface WorkspaceSearchResult {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface CopyEntryResult {
  sourcePath: string;
  path: string;
  type: FileNode["type"];
}

function fallbackDownloadName(path: string, type: FileNode["type"]): string {
  const baseName = path.split("/").pop() || "download";
  return type === "directory" ? `${baseName}.zip` : baseName;
}

function getDownloadName(
  contentDisposition: string | null,
  fallback: string
): string {
  if (!contentDisposition) return fallback;

  const encodedMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (encodedMatch) {
    try {
      return decodeURIComponent(encodedMatch[1]);
    } catch {
      return fallback;
    }
  }

  const plainMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
  return plainMatch?.[1] || fallback;
}

export function useFileSystem(token: string) {
  const authHeaders = useCallback(
    (extra?: Record<string, string>): Record<string, string> => ({
      Authorization: `Bearer ${token}`,
      ...extra,
    }),
    [token]
  );

  const fetchTree = useCallback(async (): Promise<FileNode[]> => {
    const res = await fetch(`${API}/tree`, { headers: authHeaders() });
    if (!res.ok) throw new Error("Failed to load file tree");
    return res.json();
  }, [authHeaders]);

  const fetchChanges = useCallback(
    async (
      since: number
    ): Promise<{ changed: boolean; latestMtime: number }> => {
      const params = new URLSearchParams({
        since: String(since),
      });
      const res = await fetch(`${API}/changes?${params.toString()}`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to check file changes");
      return res.json();
    },
    [authHeaders]
  );

  const fetchGitStatus = useCallback(async (): Promise<GitStatus> => {
    const res = await fetch(`${API}/git-status`, { headers: authHeaders() });
    if (!res.ok) throw new Error("Failed to load git status");
    return res.json();
  }, [authHeaders]);

  const searchWorkspace = useCallback(
    async (query: string): Promise<WorkspaceSearchResult[]> => {
      const params = new URLSearchParams({ query });
      const res = await fetch(`${API}/search?${params.toString()}`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to search workspace");
      const data = await res.json();
      return Array.isArray(data.results) ? data.results : [];
    },
    [authHeaders]
  );

  const readFileWithMeta = useCallback(
    async (
      path: string
    ): Promise<{
      content: string;
      version: string;
      updatedAt: number;
      source?: "team_member" | "external" | "assistant_tool" | "unknown";
      actor?: string;
    }> => {
      const res = await fetch(`${API}/read?path=${encodeURIComponent(path)}`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to read file");
      const data = await res.json();
      return {
        content: data.content,
        version: data.version,
        updatedAt: data.updatedAt,
        ...(typeof data.source === "string" ? { source: data.source } : {}),
        ...(typeof data.actor === "string" ? { actor: data.actor } : {}),
      };
    },
    [authHeaders]
  );

  const readFile = useCallback(async (path: string): Promise<string> => {
    const data = await readFileWithMeta(path);
    return data.content;
  }, [readFileWithMeta]);

  const writeFile = useCallback(
    async (
      path: string,
      content: string,
      force = false,
      expectedVersion?: string
    ): Promise<{ version: string; updatedAt: number }> => {
      const res = await fetch(`${API}/write`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ path, content, force, expectedVersion }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const error = new Error(data.detail || "Failed to save file") as Error & {
          code?: string;
          claim?: { path: string; username: string; updatedAt: number };
          current?: {
            content: string;
            version: string;
            updatedAt: number;
            source?: "team_member" | "external" | "assistant_tool" | "unknown";
            actor?: string;
          };
        };
        if (typeof data.code === "string") {
          error.code = data.code;
        }
        if (data.claim && typeof data.claim === "object") {
          error.claim = data.claim;
        }
        if (data.current && typeof data.current === "object") {
          error.current = data.current;
        }
        throw error;
      }
      const data = await res.json();
      return {
        version: data.version,
        updatedAt: data.updatedAt,
      };
    },
    [authHeaders]
  );

  const formatPythonDocument = useCallback(
    async (path: string, content: string): Promise<{ content: string; changed: boolean }> => {
      const res = await fetch("/api/diagnostics/format", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ path, content }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to format Python document");
      }
      const data = await res.json();
      return { content: String(data.content ?? ""), changed: Boolean(data.changed) };
    },
    [authHeaders]
  );

  const findDefinition = useCallback(
    async (symbol: string, currentPath: string): Promise<DefinitionLocation | null> => {
      const params = new URLSearchParams({
        symbol,
        currentPath,
      });
      const res = await fetch(`${API}/definition?${params.toString()}`, {
        headers: authHeaders(),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Failed to resolve definition");
      return res.json();
    },
    [authHeaders]
  );


  const createEntry = useCallback(async (path: string, isDirectory: boolean) => {
    const res = await fetch(`${API}/create`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ path, is_directory: isDirectory }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.detail || "Failed to create");
    }
  }, [authHeaders]);

  const copyEntry = useCallback(
    async (sourcePath: string, targetDirectory: string): Promise<CopyEntryResult> => {
      const res = await fetch(`${API}/copy`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          source_path: sourcePath,
          target_directory: targetDirectory,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const error = new Error(data.detail || "Failed to copy") as Error & {
          code?: string;
        };
        if (typeof data.code === "string") {
          error.code = data.code;
        }
        throw error;
      }
      const data = await res.json();
      return {
        sourcePath: data.sourcePath,
        path: data.path,
        type: data.type,
      };
    },
    [authHeaders]
  );

  const deleteEntry = useCallback(async (path: string) => {
    const res = await fetch(`${API}/delete?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error("Failed to delete");
  }, [authHeaders]);

  const renameEntry = useCallback(async (oldPath: string, newPath: string) => {
    const res = await fetch(`${API}/rename`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ old_path: oldPath, new_path: newPath }),
    });
    if (!res.ok) throw new Error("Failed to rename");
  }, [authHeaders]);

  const downloadEntry = useCallback(
    async (path: string, type: FileNode["type"]) => {
      const res = await fetch(`${API}/download?path=${encodeURIComponent(path)}`, {
        headers: authHeaders(),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || "Failed to download");
      }

      const filename = getDownloadName(
        res.headers.get("Content-Disposition"),
        fallbackDownloadName(path, type)
      );
      const blob = await res.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();

      window.setTimeout(() => {
        window.URL.revokeObjectURL(objectUrl);
      }, 0);

      return filename;
    },
    [authHeaders]
  );

  const uploadEntries = useCallback(
    async (
      files: UploadFilePayload[],
      options?: { targetPath?: string; overwrite?: boolean }
    ): Promise<{ uploaded: number; overwritten: number }> => {
      const formData = new FormData();
      formData.append("targetPath", options?.targetPath || "");
      formData.append("overwrite", String(Boolean(options?.overwrite)));
      for (const file of files) {
        formData.append("files", file.file, file.file.name);
        formData.append("paths", file.path);
      }

      const res = await fetch(`${API}/upload`, {
        method: "POST",
        headers: authHeaders(),
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const error = new Error(data.detail || "Failed to upload") as Error & {
          code?: string;
          conflicts?: string[];
        };
        if (typeof data.code === "string") {
          error.code = data.code;
        }
        if (Array.isArray(data.conflicts)) {
          error.conflicts = data.conflicts.filter(
            (item: unknown): item is string => typeof item === "string"
          );
        }
        throw error;
      }

      const data = await res.json();
      return {
        uploaded: data.uploaded,
        overwritten: data.overwritten,
      };
    },
    [authHeaders]
  );

  return useMemo(
    () => ({
      fetchTree,
      fetchChanges,
      fetchGitStatus,
      searchWorkspace,
      readFileWithMeta,
      readFile,
      findDefinition,
      writeFile,
      formatPythonDocument,
      createEntry,
      copyEntry,
      deleteEntry,
      renameEntry,
      downloadEntry,
      uploadEntries,
    }),
    [
      fetchTree,
      fetchChanges,
      fetchGitStatus,
      searchWorkspace,
      readFileWithMeta,
      readFile,
      findDefinition,
      writeFile,
      formatPythonDocument,
      createEntry,
      copyEntry,
      deleteEntry,
      renameEntry,
      downloadEntry,
      uploadEntries,
    ]
  );
}
