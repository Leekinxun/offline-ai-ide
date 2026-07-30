import { useCallback, useEffect, useRef, useState } from "react";

export interface DebugBreakpoint { path: string; line: number; verified: boolean; }
export interface DebugFrame { id: string; functionName: string; path: string; line: number; column: number; }
export interface DebugScope { name: string; variablesReference: number; expensive?: boolean; namedVariables?: number; indexedVariables?: number; }
export interface DebugVariable { name: string; value: string; type?: string; variablesReference?: number; evaluateName?: string; namedVariables?: number; indexedVariables?: number; }
export interface DebugEvaluation { result: string; type?: string; variablesReference?: number; }
export interface DebugSession { id: string; path: string; runtime: "node" | "python"; status: "starting" | "running" | "paused" | "stopped" | "failed"; startedAt: number; updatedAt: number; pauseVersion: number; breakpoints: DebugBreakpoint[]; frames: DebugFrame[]; stdout: string; stderr: string; error?: string; }
export type DebugAction = "continue" | "step_over" | "step_into" | "step_out";

export function useDebugger(token: string, visible: boolean) {
  const [session, setSession] = useState<DebugSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshSequenceRef = useRef(0);

  const adoptSession = useCallback((next: DebugSession | null) => {
    setSession((current) => {
      if (!next || !current || current.id !== next.id) return next;
      return next.updatedAt >= current.updatedAt ? next : current;
    });
  }, []);

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequenceRef.current;
    try {
      const response = await fetch("/api/debug", { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error("Failed to load debug session");
      const next = (await response.json()).session || null;
      if (sequence === refreshSequenceRef.current) adoptSession(next);
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : "Failed to load debug session"); }
  }, [adoptSession, token]);

  useEffect(() => { if (visible) void refresh(); }, [refresh, visible]);
  useEffect(() => {
    if (!session || !["starting", "running", "paused"].includes(session.status)) return;
    const timer = window.setInterval(() => void refresh(), session.status === "running" ? 150 : 400);
    return () => window.clearInterval(timer);
  }, [refresh, session?.id, session?.status]);

  const start = useCallback(async (path: string, breakpoints: number[]) => {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/debug/start", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ path, breakpoints }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Failed to start debugger");
      adoptSession(payload.session);
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : "Failed to start debugger"); }
    finally { setBusy(false); }
  }, [adoptSession, token]);

  const command = useCallback(async (action: DebugAction) => {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/debug/command", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Debug command failed");
      adoptSession(payload.session);
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : "Debug command failed"); }
    finally { setBusy(false); }
  }, [adoptSession, token]);

  const loadScopes = useCallback(async (frameId: string): Promise<DebugScope[]> => {
    const response = await fetch(`/api/debug/scopes?frameId=${encodeURIComponent(frameId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Failed to load variable scopes");
    return Array.isArray(payload.scopes) ? payload.scopes : [];
  }, [token]);

  const loadVariables = useCallback(async (reference: number): Promise<DebugVariable[]> => {
    const response = await fetch(`/api/debug/variables?reference=${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Failed to load variables");
    return Array.isArray(payload.variables) ? payload.variables : [];
  }, [token]);

  const evaluate = useCallback(async (expression: string, frameId: string): Promise<DebugEvaluation> => {
    const response = await fetch("/api/debug/evaluate", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expression, frameId }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Expression evaluation failed");
    return payload.result;
  }, [token]);

  const stop = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/debug", { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Failed to stop debugger");
      adoptSession(payload.session);
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : "Failed to stop debugger"); }
    finally { setBusy(false); }
  }, [adoptSession, token]);

  return { session, busy, error, refresh, start, command, loadScopes, loadVariables, evaluate, stop };
}
