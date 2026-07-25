import { useCallback, useEffect, useState } from "react";

export interface WorkspaceDiagnostic {
  path: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info";
  message: string;
  source: string;
  code?: string;
}

interface DiagnosticsResult {
  diagnostics: WorkspaceDiagnostic[];
  tools: string[];
  startedAt: number;
  durationMs: number;
  session: { status: "stopped" | "watching" | "running" | "error"; generation: number; startedAt?: number; lastRunAt?: number; error?: string };
}

const EMPTY_RESULT: DiagnosticsResult = { diagnostics: [], tools: [], startedAt: 0, durationMs: 0, session: { status: "stopped", generation: 0 } };

export function useDiagnostics(token: string, visible: boolean) {
  const [result, setResult] = useState<DiagnosticsResult>(EMPTY_RESULT);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const request = useCallback(async (run: boolean) => {
    setRunning(run);
    setError(null);
    try {
      const response = await fetch(run ? "/api/diagnostics/run" : "/api/diagnostics", {
        method: run ? "POST" : "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Diagnostics request failed: ${response.status}`);
      }
      setResult((await response.json()) as DiagnosticsResult);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Diagnostics failed");
    } finally {
      setRunning(false);
    }
  }, [token]);

  useEffect(() => {
    if (!visible) return;
    void fetch("/api/diagnostics/watch", { method: "POST", headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Failed to start diagnostics");
        setResult((await response.json()) as DiagnosticsResult);
      })
      .catch((nextError) => setError(nextError instanceof Error ? nextError.message : "Failed to start diagnostics"));
  }, [request, visible]);

  useEffect(() => {
    if (result.session.status === "stopped") return;
    const timer = window.setInterval(() => void request(false), 1_000);
    return () => window.clearInterval(timer);
  }, [request, result.session.status]);

  const stopWatching = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/diagnostics/watch", { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error("Failed to stop diagnostics");
      setResult((await response.json()) as DiagnosticsResult);
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : "Failed to stop diagnostics"); }
  }, [token]);

  const startWatching = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/diagnostics/watch", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error("Failed to start diagnostics");
      setResult((await response.json()) as DiagnosticsResult);
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : "Failed to start diagnostics"); }
  }, [token]);

  return { ...result, running: running || result.session.status === "running", error, refresh: () => request(false), run: () => request(true), startWatching, stopWatching };
}
