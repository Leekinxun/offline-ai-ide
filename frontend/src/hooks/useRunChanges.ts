import { useCallback, useEffect, useRef, useState } from "react";
import { parseReviewChanges, reviewSelection, runChangesUrl, type ReviewChanges, type ReviewFile, type ReviewHunk } from "../components/runReviewPolicy";

interface Options {
  token: string; workspaceDir?: string; runId?: string; requestId?: string;
  running?: boolean; refreshKey?: string | number; onChanged?: () => void;
}
const REVIEW_CHANGED_EVENT = "crewforge:run-review-changed";
interface ReviewChanged { workspaceDir?: string; runId: string; source: symbol; }
export function useRunChanges({ token, workspaceDir, runId, requestId, running = false, refreshKey, onChanged }: Options) {
  const instanceRef = useRef(Symbol("run-review"));
  const [changes, setChanges] = useState<ReviewChanges | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [file, setFile] = useState<ReviewFile | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailRetry, setDetailRetry] = useState(0);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const scope = JSON.stringify([token, workspaceDir, runId, requestId]);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const listController = useRef<AbortController | null>(null);
  const loadingScope = useRef<string | null>(null);
  const actionScope = useRef<string | null>(null);
  const changedRef = useRef(onChanged); changedRef.current = onChanged;
  const headers = useCallback(() => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(workspaceDir ? { "X-Workspace-Dir": encodeURIComponent(workspaceDir) } : {}) }), [token, workspaceDir]);

  const refresh = useCallback(async (force = false) => {
    if (!runId) return;
    if (!force && loadingScope.current === scope) return;
    listController.current?.abort();
    const controller = new AbortController(); listController.current = controller;
    loadingScope.current = scope;
    setLoading(true);
    try {
      const response = await fetch(runChangesUrl(runId, requestId), { headers: headers(), signal: controller.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Failed to load run changes");
      const result = parseReviewChanges(body, runId, requestId);
      if (controller.signal.aborted || scopeRef.current !== scope) return;
      setChanges(result);
      setLoadedScope(scope);
      setSelectedPath((current) => result.files.some((entry) => entry.path === current) ? current : result.files[0]?.path || null);
    } catch (cause) {
      if (!controller.signal.aborted && scopeRef.current === scope) setError(cause instanceof Error ? cause.message : "Failed to load run changes");
    } finally {
      if (listController.current === controller) loadingScope.current = null;
      if (!controller.signal.aborted && scopeRef.current === scope) setLoading(false);
    }
  }, [headers, requestId, runId, scope]);

  useEffect(() => {
    setChanges(null); setFile(null); setSelectedPath(null); setError(null); setBusy(false);
    void refresh(true);
    return () => { listController.current?.abort(); loadingScope.current = null; actionScope.current = null; };
  }, [refresh]);
  useEffect(() => { if (refreshKey !== undefined) void refresh(); }, [refresh, refreshKey]);
  useEffect(() => {
    const handleReviewChanged = (event: Event) => {
      const detail = (event as CustomEvent<ReviewChanged>).detail;
      if (detail?.source !== instanceRef.current && detail?.runId === runId && detail?.workspaceDir === workspaceDir) void refresh(true);
    };
    window.addEventListener(REVIEW_CHANGED_EVENT, handleReviewChanged);
    return () => window.removeEventListener(REVIEW_CHANGED_EVENT, handleReviewChanged);
  }, [refresh, runId, workspaceDir]);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => { if (actionScope.current !== scope) void refresh(); }, 1800);
    return () => window.clearInterval(timer);
  }, [refresh, running, scope]);

  const selectedRevision = changes?.files.find((entry) => entry.path === selectedPath)?.revision;
  useEffect(() => {
    if (!runId || !selectedPath) { setFile(null); return; }
    const controller = new AbortController();
    setDetailLoading(true);
    setFile((current) => current?.path === selectedPath ? current : null);
    void (async () => {
      try {
        const response = await fetch(runChangesUrl(runId, requestId, selectedPath), { headers: headers(), signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Failed to load run change");
        const result = parseReviewChanges(body, runId, requestId).files.find((entry) => entry.path === selectedPath);
        if (!result) throw new Error("Change evidence is unavailable");
        if (!controller.signal.aborted && scopeRef.current === scope) setFile(result);
      } catch (cause) {
        if (!controller.signal.aborted && scopeRef.current === scope) setError(cause instanceof Error ? cause.message : "Failed to load run change");
      } finally { if (!controller.signal.aborted && scopeRef.current === scope) setDetailLoading(false); }
    })();
    return () => controller.abort();
  }, [headers, requestId, runId, scope, selectedPath, selectedRevision, detailRetry]);

  const decide = useCallback(async (target: ReviewFile, decision: "keep" | "revert", hunk?: ReviewHunk) => {
    if (!runId || actionScope.current === scope) return false;
    actionScope.current = scope;
    setBusy(true); setError(null);
    try {
      const suffix = decision === "keep" ? "changes/keep" : "revert";
      const response = await fetch(`/api/chat/runs/${encodeURIComponent(runId)}/${suffix}`, { method: "POST", headers: headers(), body: JSON.stringify(reviewSelection(target, requestId, hunk)) });
      const body = await response.json();
      if (scopeRef.current !== scope) return false;
      if (decision === "revert" && body.rollback?.applied?.length) changedRef.current?.();
      if (!response.ok) {
        const reasons = (body.rollback?.unavailable || []).map((entry: { path: string; reason: string }) => `${entry.path}: ${entry.reason}`);
        const conflicts = (body.rollback?.conflicts || []).map((entry: { path: string }) => entry.path);
        throw new Error([body.error || "Review action failed", ...reasons, ...conflicts].join("\n"));
      }
      // The editor and the Changes panel own separate readers of the same run.
      // Refresh each reader through its own authenticated/request-scoped URL.
      window.dispatchEvent(new CustomEvent<ReviewChanged>(REVIEW_CHANGED_EVENT, { detail: { workspaceDir, runId, source: instanceRef.current } }));
      await refresh(true);
      return true;
    } catch (cause) {
      if (scopeRef.current === scope) { setError(cause instanceof Error ? cause.message : "Review action failed"); await refresh(true); }
      return false;
    } finally {
      if (scopeRef.current === scope) { setBusy(false); actionScope.current = null; }
    }
  }, [headers, refresh, requestId, runId, scope, workspaceDir]);
  const retry = useCallback(async () => { setDetailRetry((value) => value + 1); await refresh(true); }, [refresh]);
  return { changes: loadedScope === scope ? changes : null, file: loadedScope === scope && file?.path === selectedPath ? file : null, selectedPath, setSelectedPath, loading, detailLoading, busy, error, clearError: () => setError(null), refresh, retry, decide, stale: Boolean(file && selectedRevision !== file.revision) };
}
