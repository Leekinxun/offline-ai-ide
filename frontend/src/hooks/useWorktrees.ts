import { useCallback, useEffect, useState } from "react";

export interface ManagedWorktree {
  id: string;
  path: string;
  branch?: string;
  head?: string;
  bare?: boolean;
  detached?: boolean;
}

interface WorktreeListResponse {
  worktrees?: ManagedWorktree[];
}

interface WorktreeResponse {
  worktree?: ManagedWorktree;
  removed?: boolean;
}

export function useWorktrees(token: string, enabled: boolean) {
  const [worktrees, setWorktrees] = useState<ManagedWorktree[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const request = useCallback(
    async <T,>(path = "", init?: RequestInit): Promise<T> => {
      const response = await fetch(`/api/chat/worktrees${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...init?.headers,
        },
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Worktree request failed: ${response.status}`);
      }
      return (await response.json()) as T;
    },
    [token]
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await request<WorktreeListResponse>();
      setWorktrees(Array.isArray(payload.worktrees) ? payload.worktrees : []);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load worktrees");
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  const create = useCallback(
    async (input: { name?: string; revision?: string }) => {
      setBusyId("create");
      setError(null);
      try {
        const payload = await request<WorktreeResponse>("", {
          method: "POST",
          body: JSON.stringify(input),
        });
        if (!payload.worktree) throw new Error("Worktree creation did not return a worktree");
        await refresh();
        return payload.worktree;
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to create worktree");
        throw nextError;
      } finally {
        setBusyId(null);
      }
    },
    [refresh, request]
  );

  const remove = useCallback(
    async (id: string) => {
      setBusyId(id);
      setError(null);
      try {
        const payload = await request<WorktreeResponse>(`/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        if (!payload.removed) throw new Error("Worktree removal did not complete");
        await refresh();
        return payload.worktree || null;
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to remove worktree");
        throw nextError;
      } finally {
        setBusyId(null);
      }
    },
    [refresh, request]
  );

  return { worktrees, loading, busyId, error, refresh, create, remove };
}
