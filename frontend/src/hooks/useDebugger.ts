import { useCallback, useEffect, useState } from "react";

export interface DebugBreakpoint { path: string; line: number; verified: boolean; }
export interface DebugFrame { id: string; functionName: string; path: string; line: number; column: number; }
export interface DebugSession { id: string; path: string; status: "starting" | "running" | "paused" | "stopped" | "failed"; startedAt: number; updatedAt: number; breakpoints: DebugBreakpoint[]; frames: DebugFrame[]; stdout: string; stderr: string; error?: string; }
export type DebugAction = "continue" | "step_over" | "step_into" | "step_out";

export function useDebugger(token: string, visible: boolean) {
  const [session, setSession] = useState<DebugSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/debug", { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error("Failed to load debug session");
      setSession((await response.json()).session || null);
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : "Failed to load debug session"); }
  }, [token]);

  useEffect(() => { if (visible) void refresh(); }, [refresh, visible]);
  useEffect(() => {
    if (!session || !["starting", "running", "paused"].includes(session.status)) return;
    const timer = window.setInterval(() => void refresh(), 500);
    return () => window.clearInterval(timer);
  }, [refresh, session?.id, session?.status]);

  const start = useCallback(async (path: string, breakpoints: number[]) => {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/debug/start", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ path, breakpoints }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Failed to start debugger");
      setSession(payload.session);
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : "Failed to start debugger"); }
    finally { setBusy(false); }
  }, [token]);

  const command = useCallback(async (action: DebugAction) => {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/debug/command", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Debug command failed");
      setSession(payload.session);
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : "Debug command failed"); }
    finally { setBusy(false); }
  }, [token]);

  const stop = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/debug", { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Failed to stop debugger");
      setSession(payload.session);
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : "Failed to stop debugger"); }
    finally { setBusy(false); }
  }, [token]);

  return { session, busy, error, refresh, start, command, stop };
}
