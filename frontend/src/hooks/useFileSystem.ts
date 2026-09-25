import { useCallback, useMemo, useRef } from "react";
import { DefinitionLocation, FileNode, GitStatus, ReferenceLocation } from "../types";

const API = "/api/files";

export interface UploadFilePayload {
  path: string;
  file: File;
}

export interface UploadEntriesError extends Error {
  code?: string;
  conflicts?: string[];
  completedUploaded: number;
  completedOverwritten: number;
  remainingFiles: UploadFilePayload[];
  batchMayHaveUploaded: boolean;
}

export interface UploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  completedFiles: number;
  totalFiles: number;
  phase: "uploading" | "processing" | "complete";
}

export interface UploadEntriesOptions {
  targetPath?: string;
  overwrite?: boolean;
  overwriteFirstBatchOnly?: boolean;
  expectedWorkspaceDir?: string;
  onProgress?: (progress: UploadProgress) => void;
}

const UPLOAD_BATCH_BYTES = 8 * 1024 * 1024;
const UPLOAD_BATCH_FILES = 50;

interface UploadBatch {
  start: number;
  files: UploadFilePayload[];
}

function makeUploadBatches(files: UploadFilePayload[]): UploadBatch[] {
  const batches: UploadBatch[] = [];
  let start = 0;
  let size = 0;

  for (let index = 0; index < files.length; index++) {
    const fileSize = files[index].file.size;
    if (index > start && (index - start >= UPLOAD_BATCH_FILES || size + fileSize > UPLOAD_BATCH_BYTES)) {
      batches.push({ start, files: files.slice(start, index) });
      start = index;
      size = 0;
    }
    // A single file above 8 MiB must be sent alone; the server still enforces
    // its configured per-file limit (250 MiB by default).
    size += fileSize;
  }
  if (start < files.length) batches.push({ start, files: files.slice(start) });
  return batches;
}

function parseUploadError(payload: unknown): Error & { code?: string; conflicts?: string[] } {
  const data = payload && typeof payload === "object"
    ? payload as Record<string, unknown> : {};
  const message = typeof data.detail === "string" && data.detail.trim() ? data.detail
    : typeof data.error === "string" && data.error.trim() ? data.error
    : "Failed to upload";
  const error = new Error(message) as Error & {
    code?: string;
    conflicts?: string[];
  };
  if (typeof data.code === "string") error.code = data.code;
  if (Array.isArray(data.conflicts)) {
    error.conflicts = data.conflicts.filter(
      (item: unknown): item is string => typeof item === "string"
    );
  }
  return error;
}

async function uploadFormData(
  url: string,
  headers: Record<string, string>,
  body: FormData,
  expectedUploaded: number,
  onUploadProgress: (loaded: number, total: number | undefined) => void,
  onUploadComplete: () => void
): Promise<{ data: { uploaded: number; overwritten: number } }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    for (const [name, value] of Object.entries(headers)) {
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (event) => {
      onUploadProgress(event.loaded, event.lengthComputable ? event.total : undefined);
    };
    xhr.upload.onload = () => {
      onUploadComplete();
    };
    xhr.onload = () => {
      let payload: unknown;
      try {
        payload = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
      } catch {
        payload = undefined;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject({ error: parseUploadError(payload), status: xhr.status });
        return;
      }
      const data = payload && typeof payload === "object"
        ? payload as Record<string, unknown> : {};
      if (
        typeof data.uploaded !== "number"
        || typeof data.overwritten !== "number"
        || data.uploaded !== expectedUploaded
      ) {
        reject(new Error("Upload result could not be confirmed"));
        return;
      }
      resolve({
        data: {
          uploaded: data.uploaded,
          overwritten: data.overwritten,
        },
      });
    };
    xhr.onerror = () => {
      reject(new TypeError("Failed to fetch"));
    };
    xhr.ontimeout = () => {
      reject(new TypeError("Failed to fetch"));
    };
    xhr.onabort = () => {
      reject(new TypeError("Failed to fetch"));
    };
    xhr.send(body);
  });
}

export async function uploadEntriesInBatches(
  files: UploadFilePayload[],
  options: UploadEntriesOptions | undefined,
  headers: Record<string, string>
): Promise<{ uploaded: number; overwritten: number }> {
  let uploaded = 0;
  let overwritten = 0;
  let uploadedBytes = 0;
  const totalBytes = files.reduce((total, entry) => total + entry.file.size, 0);

  const reportProgress = (progress: UploadProgress) => {
    options?.onProgress?.({
      ...progress,
      uploadedBytes: Math.min(progress.uploadedBytes, totalBytes),
    });
  };

  if (files.length === 0) {
    reportProgress({
      uploadedBytes: 0,
      totalBytes,
      completedFiles: 0,
      totalFiles: 0,
      phase: "complete",
    });
  }

  const batches = makeUploadBatches(files);
  for (const [batchIndex, batch] of batches.entries()) {
    const batchBytes = batch.files.reduce((total, entry) => total + entry.file.size, 0);
    const confirmedBytesBeforeBatch = uploadedBytes;
    const formData = new FormData();
    formData.append("targetPath", options?.targetPath || "");
    formData.append("expectedWorkspaceDir", options?.expectedWorkspaceDir ?? "");
    formData.append("overwrite", String(Boolean(options?.overwrite && (!options.overwriteFirstBatchOnly || batchIndex === 0))));
    for (const entry of batch.files) {
      formData.append("files", entry.file, entry.file.name);
      formData.append("paths", entry.path);
    }

    let batchMayHaveUploaded = true;
    try {
      reportProgress({
        uploadedBytes,
        totalBytes,
        completedFiles: uploaded,
        totalFiles: files.length,
        phase: "uploading",
      });
      const { data } = await uploadFormData(`${API}/upload`,
        headers,
        formData,
        batch.files.length,
        (loaded, requestTotal) => {
          const batchUploadedBytes = requestTotal && requestTotal > 0
            ? Math.round(batchBytes * Math.min(loaded / requestTotal, 1))
            : Math.min(loaded, batchBytes);
          reportProgress({
            uploadedBytes: confirmedBytesBeforeBatch + batchUploadedBytes,
            totalBytes,
            completedFiles: uploaded,
            totalFiles: files.length,
            phase: "uploading",
          });
        },
        () => {
          reportProgress({
            uploadedBytes: confirmedBytesBeforeBatch + batchBytes,
            totalBytes,
            completedFiles: uploaded,
            totalFiles: files.length,
            phase: "processing",
          });
        }
      ).catch((cause) => {
        if (cause && typeof cause === "object" && "status" in cause && "error" in cause) {
          const status = (cause as { status: number }).status;
          // Conflict and request-validation responses happen before files are written.
          batchMayHaveUploaded = status >= 500 || status === 408 || status === 429;
          throw (cause as { error: Error }).error;
        }
        throw cause;
      });
      uploaded += data.uploaded;
      overwritten += data.overwritten;
      uploadedBytes = confirmedBytesBeforeBatch + batchBytes;
      if (batchIndex === batches.length - 1) {
        reportProgress({
          uploadedBytes: totalBytes,
          totalBytes,
          completedFiles: uploaded,
          totalFiles: files.length,
          phase: "complete",
        });
      }
    } catch (cause) {
      const error = (cause instanceof Error ? cause : new Error(String(cause))) as UploadEntriesError;
      error.completedUploaded = uploaded;
      error.completedOverwritten = overwritten;
      error.remainingFiles = files.slice(batch.start);
      error.batchMayHaveUploaded = batchMayHaveUploaded;
      throw error;
    }
  }

  return { uploaded, overwritten };
}

export interface WorkspaceSearchResult {
  path: string;
  line: number;
  column: number;
  matchLength: number;
  preview: string;
}

export interface WorkspaceSearchOptions {
  query: string;
  scopePath?: string;
  isRegex?: boolean;
  matchCase?: boolean;
  wholeWord?: boolean;
  include?: string;
  exclude?: string;
  useIgnoreFiles?: boolean;
}

export interface WorkspaceSearchResponse {
  results: WorkspaceSearchResult[];
  truncated: boolean;
}

export interface CopyEntryResult {
  sourcePath: string;
  path: string;
  type: FileNode["type"];
}

export interface MoveEntryResult {
  sourcePath: string;
  path: string;
  type: FileNode["type"];
}

export interface DocumentDiagnostic {
  path: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info";
  message: string;
  source: string;
  code?: string;
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
  const searchAbortControllerRef = useRef<AbortController | null>(null);
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
    async (options: WorkspaceSearchOptions): Promise<WorkspaceSearchResponse> => {
      searchAbortControllerRef.current?.abort();
      const controller = new AbortController();
      searchAbortControllerRef.current = controller;
      const params = new URLSearchParams({ query: options.query });
      if (options.scopePath) params.set("scopePath", options.scopePath);
      if (options.isRegex) params.set("isRegex", "true");
      if (options.matchCase) params.set("matchCase", "true");
      if (options.wholeWord) params.set("wholeWord", "true");
      if (options.include) params.set("include", options.include);
      if (options.exclude) params.set("exclude", options.exclude);
      if (options.useIgnoreFiles === false) params.set("useIgnoreFiles", "false");
      const res = await fetch(`${API}/search?${params.toString()}`, {
        headers: authHeaders(),
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || "Failed to search workspace");
      }
      const data = await res.json();
      return {
        results: Array.isArray(data.results) ? data.results : [],
        truncated: data.truncated === true,
      };
    },
    [authHeaders]
  );

  const cancelWorkspaceSearch = useCallback(() => {
    searchAbortControllerRef.current?.abort();
    searchAbortControllerRef.current = null;
  }, []);

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

  const checkPythonDocument = useCallback(
    async (path: string, content: string): Promise<DocumentDiagnostic[]> => {
      const res = await fetch("/api/diagnostics/document", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ path, content }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to check Python document");
      }
      const data = await res.json();
      return Array.isArray(data.diagnostics) ? data.diagnostics : [];
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

  const findReferences = useCallback(
    async (symbol: string, currentPath: string): Promise<ReferenceLocation[]> => {
      const params = new URLSearchParams({ symbol, currentPath });
      const res = await fetch(`${API}/references?${params.toString()}`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to resolve references");
      const data = await res.json() as { references?: ReferenceLocation[] };
      return Array.isArray(data.references) ? data.references : [];
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

  const moveEntry = useCallback(
    async (sourcePath: string, targetDirectory: string): Promise<MoveEntryResult> => {
      const res = await fetch(`${API}/move`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          source_path: sourcePath,
          target_directory: targetDirectory,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const error = new Error(data.detail || "Failed to move") as Error & {
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
      options?: UploadEntriesOptions
    ): Promise<{ uploaded: number; overwritten: number }> => {
      return uploadEntriesInBatches(files, options, authHeaders());
    },
    [authHeaders]
  );

  return useMemo(
    () => ({
      fetchTree,
      fetchChanges,
      fetchGitStatus,
      searchWorkspace,
      cancelWorkspaceSearch,
      readFileWithMeta,
      readFile,
      findDefinition,
      findReferences,
      writeFile,
      formatPythonDocument,
      checkPythonDocument,
      createEntry,
      copyEntry,
      moveEntry,
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
      cancelWorkspaceSearch,
      readFileWithMeta,
      readFile,
      findDefinition,
      findReferences,
      writeFile,
      formatPythonDocument,
      checkPythonDocument,
      createEntry,
      copyEntry,
      moveEntry,
      deleteEntry,
      renameEntry,
      downloadEntry,
      uploadEntries,
    ]
  );
}
