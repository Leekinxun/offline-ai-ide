import { useCallback, useEffect, useState } from "react";

export interface RunTask { id: string; label: string; kind: "run" | "test" | "build" | "check"; source: string; }
export interface RunFailure { path: string; line: number; column: number; message: string; }
export interface RunRecord { id: string; taskId: string; label: string; status: "running" | "passed" | "failed" | "timed_out" | "cancelled"; startedAt: number; durationMs: number; endedAt?: number; exitCode: number | null; stdout: string; stderr: string; failures: RunFailure[]; }

export function useRunCenter(token: string, visible: boolean) {
  const [tasks, setTasks] = useState<RunTask[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/run", { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`Failed to discover tasks: ${response.status}`);
      const payload = await response.json();
      setTasks(Array.isArray(payload.tasks) ? payload.tasks : []);
      const nextRuns = Array.isArray(payload.runs) ? payload.runs : [];
      setRuns(nextRuns);
      setRunningTaskId(nextRuns.find((run: RunRecord) => run.status === "running")?.taskId || null);
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : "Failed to load tasks"); }
  }, [token]);

  useEffect(() => { if (visible) void refresh(); }, [refresh, visible]);

  useEffect(() => {
    if (!runs.some((run) => run.status === "running")) return;
    const timer = window.setInterval(() => void refresh(), 700);
    return () => window.clearInterval(timer);
  }, [refresh, runs]);

  const run = useCallback(async (taskId: string) => {
    setRunningTaskId(taskId); setError(null);
    try {
      const response = await fetch(`/api/run/${encodeURIComponent(taskId)}`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.error || "Task failed to start"); }
      const payload = await response.json();
      setRuns((previous) => [payload.run as RunRecord, ...previous.filter((entry) => entry.id !== payload.run.id)].slice(0, 20));
      return payload.run as RunRecord;
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : "Task failed"); return null; }
    finally { /* polling owns the running state until the child exits */ }
  }, [token]);

  const stop = useCallback(async (runId: string) => {
    setError(null);
    try {
      const response = await fetch(`/api/run/${encodeURIComponent(runId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.error || "Task failed to stop"); }
      await refresh();
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : "Task failed to stop"); }
  }, [refresh, token]);

  return { tasks, runs, runningTaskId, error, refresh, run, stop };
}
