import { useCallback, useMemo } from "react";
import { FileNode } from "../types";

const API = "/api/files";

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

  const readFile = useCallback(async (path: string): Promise<string> => {
    const res = await fetch(`${API}/read?path=${encodeURIComponent(path)}`, {
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error("Failed to read file");
    const data = await res.json();
    return data.content;
  }, [authHeaders]);

  const writeFile = useCallback(async (path: string, content: string) => {
    const res = await fetch(`${API}/write`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ path, content }),
    });
    if (!res.ok) throw new Error("Failed to save file");
  }, [authHeaders]);

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

  return useMemo(
    () => ({
      fetchTree,
      readFile,
      writeFile,
      createEntry,
      deleteEntry,
      renameEntry,
      downloadEntry,
    }),
    [
      fetchTree,
      readFile,
      writeFile,
      createEntry,
      deleteEntry,
      renameEntry,
      downloadEntry,
    ]
  );
}
