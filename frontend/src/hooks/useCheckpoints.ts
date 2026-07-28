import { useCallback, useEffect, useState } from "react";

export interface WorkspaceCheckpoint {
  id: string;
  label: string;
  createdAt: number;
  conversationId?: string;
  runId?: string;
  kind?: "manual" | "run" | "step" | "revert";
  toolCallId?: string;
  fileCount: number;
  totalBytes: number;
}

interface CheckpointListResponse {
  checkpoints?: WorkspaceCheckpoint[];
}

interface CheckpointResponse {
  checkpoint?: WorkspaceCheckpoint;
  restored?: boolean;
}

export function useCheckpoints(token: string, visible: boolean) {
  const [checkpoints, setCheckpoints] = useState<WorkspaceCheckpoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const request = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const response = await fetch(`/api/checkpoints${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...init?.headers,
        },
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || payload.detail || `Checkpoint request failed: ${response.status}`);
      }
      return (await response.json()) as T;
    },
    [token]
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await request<CheckpointListResponse>("");
      setCheckpoints(payload.checkpoints || []);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load checkpoints");
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    if (visible) void refresh();
  }, [refresh, visible]);

  const create = useCallback(
    async (input?: { label?: string; conversationId?: string; runId?: string }) => {
      setBusyId("create");
      setError(null);
      try {
        const payload = await request<CheckpointResponse>("/create", {
          method: "POST",
          body: JSON.stringify(input || {}),
        });
        await refresh();
        return payload.checkpoint || null;
      } finally {
        setBusyId(null);
      }
    },
    [refresh, request]
  );

  const restore = useCallback(
    async (checkpointId: string) => {
      setBusyId(checkpointId);
      setError(null);
      try {
        const payload = await request<CheckpointResponse>(
          `/${encodeURIComponent(checkpointId)}/restore`,
          { method: "POST", body: "{}" }
        );
        if (!payload.restored) throw new Error("Checkpoint restore did not complete");
        await refresh();
        return payload.checkpoint || null;
      } finally {
        setBusyId(null);
      }
    },
    [refresh, request]
  );

  return { checkpoints, loading, busyId, error, refresh, create, restore };
}
