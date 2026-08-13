import { useCallback, useEffect, useState } from "react";
import {
  parsePublicChangeSet,
  parsePublicChangeSetList,
  type ChangeSet,
  type ChangeSetDecision,
} from "./changeSetContract";
export type { ChangeSet, ChangeSetDecision, ChangeSetStatus, CurrentPublicChangeSet, LegacyPublicChangeSet, PublicChangeSetPatch } from "./changeSetContract";

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
export interface FileMutation { id: string; path: string; runId?: string; toolCallId?: string; operation: "create" | "modify" | "delete"; rollbackScope: "whole-file" | "hunks"; recordedAt: number; hunks?: Array<{ id: string }> }
export interface ChangeSetReviewRun { schemaVersion: 1; id: string; changeSetId: string; revision: string; baseSha: string; stage: "review" | "reverify"; attempt: number; status: "queued" | "running" | "completed" | "failed"; requestedBy: string; reviewer: { id: string; modelName: string; profile: "change_set_reviewer" }; verifier?: { id: string; modelName: string; profile: "change_set_verifier" }; checkoutDigest: string; createdAt: string; startedAt?: string; completedAt?: string; error?: string; findingIds: string[]; }
export interface CheckpointStorage { logicalBytes: number; blobBytes: number; manifestBytes: number; journalBytes: number; blobCount: number; checkpointCount: number; retention: { schemaVersion: 1; maxCheckpoints: number } }

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
  const [mutations, setMutations] = useState<FileMutation[]>([]);
  const [changeSets, setChangeSets] = useState<ChangeSet[]>([]);
  const [reviewRuns, setReviewRuns] = useState<Record<string, ChangeSetReviewRun[]>>({});
  const [storage, setStorage] = useState<CheckpointStorage | null>(null);

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
      const payload = await request<CheckpointListResponse & { storage?: CheckpointStorage }>("");
      setCheckpoints(payload.checkpoints || []);
      setStorage(payload.storage || null);
      const [mutationResult, changeSetResult] = await Promise.allSettled([
        request<{ mutations?: FileMutation[] }>("/mutations"),
        request<{ changeSets?: unknown }>("/change-sets"),
      ]);
      setMutations(mutationResult.status === "fulfilled" ? mutationResult.value.mutations || [] : []);
      const nextChangeSets = changeSetResult.status === "fulfilled" ? parsePublicChangeSetList(changeSetResult.value.changeSets || []) : [];
      setChangeSets(nextChangeSets);
      const reviewResults = await Promise.allSettled(nextChangeSets.map(async (changeSet) => ({ id: changeSet.id, runs: (await request<{ reviewRuns?: ChangeSetReviewRun[] }>(`/change-sets/${encodeURIComponent(changeSet.id)}/review-runs`)).reviewRuns || [] })));
      setReviewRuns(Object.fromEntries(reviewResults.flatMap((result) => result.status === "fulfilled" ? [[result.value.id, result.value.runs] as const] : [])));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load checkpoints");
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    if (visible) void refresh();
  }, [refresh, visible]);

  useEffect(() => {
    if (!visible || !Object.values(reviewRuns).some((runs) => runs.some((run) => run.status === "queued" || run.status === "running"))) return;
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [refresh, reviewRuns, visible]);

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

  const rollback = useCallback(async (input: { ids?: string[]; hunkIds?: string[]; strategy?: "refuse" | "skip-conflicts" }) => {
    setBusyId("rollback"); setError(null);
    try { const result = await request<{ applied: string[]; conflicts: unknown[] }>("/mutations/rollback", { method: "POST", body: JSON.stringify(input) }); await refresh(); return result; }
    finally { setBusyId(null); }
  }, [refresh, request]);
  const decideChangeSet = useCallback(async (id: string, decision: ChangeSetDecision) => {
    setBusyId(id); setError(null);
    try { const result = await request<{ changeSet: unknown }>(`/change-sets/${encodeURIComponent(id)}/decision`, { method: "POST", body: JSON.stringify({ decision }) }); const changeSet = parsePublicChangeSet(result.changeSet); await refresh(); return changeSet; }
    finally { setBusyId(null); }
  }, [refresh, request]);
  const recoverChangeSet = useCallback(async (id: string) => {
    setBusyId(id); setError(null);
    try { const result = await request<{ changeSet: unknown; recovery: { state: string; manualRecoveryRequired: boolean } }>(`/change-sets/${encodeURIComponent(id)}/recover`, { method: "POST", body: "{}" }); const changeSet = parsePublicChangeSet(result.changeSet); await refresh(); return { ...result, changeSet }; }
    finally { setBusyId(null); }
  }, [refresh, request]);
  const startChangeSetReview = useCallback(async (id: string, stage: "review" | "reverify") => {
    setBusyId(`review:${id}`); setError(null);
    try { const result = await request<{ reviewRun: ChangeSetReviewRun }>(`/change-sets/${encodeURIComponent(id)}/${stage === "review" ? "review" : "reverify"}`, { method: "POST", body: "{}" }); await refresh(); return result.reviewRun; }
    finally { setBusyId(null); }
  }, [refresh, request]);
  const setRetention = useCallback(async (maxCheckpoints: number) => {
    setBusyId("retention"); try { const result = await request<{ storage: CheckpointStorage }>("/retention", { method: "PUT", body: JSON.stringify({ maxCheckpoints }) }); setStorage(result.storage); await refresh(); } finally { setBusyId(null); }
  }, [refresh, request]);

  return { checkpoints, mutations, changeSets, reviewRuns, storage, loading, busyId, error, refresh, create, restore, rollback, decideChangeSet, recoverChangeSet, startChangeSetReview, setRetention };
}
