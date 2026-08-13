import { useCallback, useEffect, useRef, useState } from "react";
import type { GitDeliveryCapabilities, GitDeliveryInput, GitDeliveryStatus, GitOperation } from "../types";

const API = "/api/git-delivery";
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const terminal = new Set<GitOperation["status"]>(["completed", "conflicted", "failed", "cancelled", "manual_recovery"]);

export class GitDeliveryConflictError extends Error {
  constructor(message: string, readonly code: string, readonly current?: GitOperation) {
    super(message);
    this.name = "GitDeliveryConflictError";
  }
}

async function responseError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => ({})) as { error?: string; code?: string; current?: GitOperation };
  if (response.status === 409) return new GitDeliveryConflictError(body.error || "Git state changed", body.code || "CONFLICT", body.current);
  return new Error(body.error || `Git delivery request failed: ${response.status}`);
}

export interface PrepareGitOperationInput {
  idempotencyKey: string;
  input: GitDeliveryInput;
  provenance?: { conversationId?: string; planId?: string; runId?: string; worktreeId?: string; changeSetId?: string };
}

export function useGitDelivery(token: string, workspaceDir: string, enabled: boolean) {
  const [status, setStatus] = useState<GitDeliveryStatus | null>(null);
  const [capabilities, setCapabilities] = useState<GitDeliveryCapabilities>({ canPrepare: false, canPush: false });
  const [operations, setOperations] = useState<GitOperation[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<GitDeliveryConflictError | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const sequenceRef = useRef(0);
  const scopeRef = useRef(workspaceDir);

  useEffect(() => {
    scopeRef.current = workspaceDir;
    controllerRef.current?.abort();
    setStatus(null);
    setCapabilities({ canPrepare: false, canPush: false });
    setOperations([]);
    setError(null);
    setConflict(null);
  }, [workspaceDir]);
  useEffect(() => () => controllerRef.current?.abort(), []);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const requestSequence = ++sequenceRef.current;
    const requestScope = workspaceDir;
    setLoading(true);
    setError(null);
    try {
      const [statusResponse, operationsResponse] = await Promise.all([
        fetch(`${API}/status`, { headers: auth(token), signal: controller.signal }),
        fetch(`${API}/operations`, { headers: auth(token), signal: controller.signal }),
      ]);
      if (!statusResponse.ok) throw await responseError(statusResponse);
      if (!operationsResponse.ok) throw await responseError(operationsResponse);
      const statusBody = await statusResponse.json() as { status: GitDeliveryStatus; capabilities: GitDeliveryCapabilities };
      const operationsBody = await operationsResponse.json() as { operations?: GitOperation[] };
      if (controller.signal.aborted || requestSequence !== sequenceRef.current || requestScope !== scopeRef.current) return;
      setStatus(statusBody.status);
      setCapabilities(statusBody.capabilities);
      setOperations(operationsBody.operations || []);
      setConflict(null);
    } catch (nextError) {
      if (controller.signal.aborted) return;
      const normalized = nextError instanceof Error ? nextError : new Error("Git delivery request failed");
      if (normalized instanceof GitDeliveryConflictError) setConflict(normalized);
      setError(normalized.message);
    } finally {
      if (requestSequence === sequenceRef.current && requestScope === scopeRef.current) setLoading(false);
    }
  }, [enabled, token, workspaceDir]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!enabled || !operations.some((operation) => !terminal.has(operation.status))) return;
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [enabled, operations, refresh]);

  const prepare = useCallback(async (request: PrepareGitOperationInput) => {
    setBusyId("prepare");
    setError(null);
    setConflict(null);
    try {
      const response = await fetch(`${API}/operations`, {
        method: "POST",
        headers: { ...auth(token), "Content-Type": "application/json", "Idempotency-Key": request.idempotencyKey },
        body: JSON.stringify({ input: request.input, provenance: request.provenance }),
      });
      if (!response.ok) throw await responseError(response);
      const { operation } = await response.json() as { operation: GitOperation };
      setOperations((current) => [operation, ...current.filter((item) => item.id !== operation.id)]);
      return operation;
    } catch (nextError) {
      const normalized = nextError instanceof Error ? nextError : new Error("Git operation could not be prepared");
      if (normalized instanceof GitDeliveryConflictError) setConflict(normalized);
      setError(normalized.message);
      throw normalized;
    } finally { setBusyId(null); }
  }, [token]);

  const approve = useCallback(async (operation: GitOperation, reason?: string) => {
    setBusyId(operation.id);
    setError(null);
    setConflict(null);
    const optimistic: GitOperation = { ...operation, status: "queued", updatedAt: Date.now() };
    setOperations((current) => current.map((item) => item.id === operation.id ? optimistic : item));
    try {
      const response = await fetch(`${API}/operations/${encodeURIComponent(operation.id)}/approve`, {
        method: "POST",
        headers: { ...auth(token), "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: operation.version, approvalDigest: operation.preflight.approvalDigest, ...(reason?.trim() ? { reason: reason.trim() } : {}) }),
      });
      if (!response.ok) throw await responseError(response);
      const { operation: next } = await response.json() as { operation: GitOperation };
      setOperations((current) => current.map((item) => item.id === next.id ? next : item));
      await refresh();
      return next;
    } catch (nextError) {
      setOperations((current) => current.map((item) => item.id === operation.id ? operation : item));
      const normalized = nextError instanceof Error ? nextError : new Error("Git operation approval failed");
      if (normalized instanceof GitDeliveryConflictError) {
        setConflict(normalized);
        if (normalized.current) setOperations((current) => current.map((item) => item.id === normalized.current?.id ? normalized.current : item));
      }
      setError(normalized.message);
      throw normalized;
    } finally { setBusyId(null); }
  }, [refresh, token]);

  const cancel = useCallback(async (operation: GitOperation) => {
    setBusyId(operation.id);
    setError(null);
    try {
      const response = await fetch(`${API}/operations/${encodeURIComponent(operation.id)}/cancel`, {
        method: "POST",
        headers: { ...auth(token), "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: operation.version }),
      });
      if (!response.ok) throw await responseError(response);
      const { operation: next } = await response.json() as { operation: GitOperation };
      setOperations((current) => current.map((item) => item.id === next.id ? next : item));
      return next;
    } catch (nextError) {
      const normalized = nextError instanceof Error ? nextError : new Error("Git operation cancellation failed");
      if (normalized instanceof GitDeliveryConflictError) setConflict(normalized);
      setError(normalized.message);
      throw normalized;
    } finally { setBusyId(null); }
  }, [token]);

  return { status, capabilities, operations, loading, busyId, error, conflict, refresh, prepare, approve, cancel, clearError: () => { setError(null); setConflict(null); } };
}
