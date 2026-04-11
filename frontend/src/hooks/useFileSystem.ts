import { useCallback } from "react";
import { FileNode } from "../types";

const API = "/api/files";

export function useFileSystem() {
  const fetchTree = useCallback(async (): Promise<FileNode[]> => {
    const res = await fetch(`${API}/tree`);
    if (!res.ok) throw new Error("Failed to load file tree");
    return res.json();
  }, []);

  const readFile = useCallback(async (path: string): Promise<string> => {
    const res = await fetch(`${API}/read?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error("Failed to read file");
    const data = await res.json();
    return data.content;
  }, []);

  const writeFile = useCallback(async (path: string, content: string) => {
    const res = await fetch(`${API}/write`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, content }),
    });
    if (!res.ok) throw new Error("Failed to save file");
  }, []);

  const createEntry = useCallback(async (path: string, isDirectory: boolean) => {
    const res = await fetch(`${API}/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, is_directory: isDirectory }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.detail || "Failed to create");
    }
  }, []);

  const deleteEntry = useCallback(async (path: string) => {
    const res = await fetch(`${API}/delete?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error("Failed to delete");
  }, []);

  const renameEntry = useCallback(async (oldPath: string, newPath: string) => {
    const res = await fetch(`${API}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ old_path: oldPath, new_path: newPath }),
    });
    if (!res.ok) throw new Error("Failed to rename");
  }, []);

  return { fetchTree, readFile, writeFile, createEntry, deleteEntry, renameEntry };
}
