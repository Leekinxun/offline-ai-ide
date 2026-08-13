import { useCallback, useEffect, useRef, useState } from "react";
import type { DeliveryFeedback, ProviderCapability, ProviderConfigSummary, ProviderDelivery, ProviderDeliveryOperation, ProviderDeliveryPrepareInput } from "../types";

const API = "/api/delivery";
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export class ProviderDeliveryConflictError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = "ProviderDeliveryConflictError"; }
}
export class ProviderFollowUpIncompleteError extends Error {
  constructor(readonly feedback: DeliveryFeedback) { super("Follow-up approval did not return both a task and follow-up run"); this.name = "ProviderFollowUpIncompleteError"; }
}
async function errorFrom(response: Response): Promise<Error> {
  const body = await response.json().catch(() => ({})) as { error?: string; code?: string };
  if (response.status === 409) return new ProviderDeliveryConflictError(body.error || "Delivery is stale", body.code || "version_conflict");
  return new Error(body.error || `Provider delivery request failed: ${response.status}`);
}

export interface DeliveryRepositoryRef { providerConfigId: string; remoteRepositoryId: string; owner?: string; name?: string; gitRemoteName?: string; }
function canonical(value: unknown): string {
  const normalize = (input: unknown): unknown => Array.isArray(input)
    ? input.map(normalize)
    : input && typeof input === "object"
      ? Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, normalize(child)]))
      : input;
  return JSON.stringify(normalize(value));
}

export async function publicationRequestDigest(input: ProviderDeliveryPrepareInput, serverBindingHint = ""): Promise<string> {
  const bytes = new TextEncoder().encode(canonical({ input, serverBindingHint }));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function useProviderDelivery(token: string, workspaceDir: string, enabled: boolean) {
  const [providers, setProviders] = useState<ProviderConfigSummary[]>([]);
  const [capabilities, setCapabilities] = useState<ProviderCapability[]>([]);
  const [deliveries, setDeliveries] = useState<ProviderDelivery[]>([]);
  const [feedback, setFeedback] = useState<DeliveryFeedback[]>([]);
  const [operations, setOperations] = useState<ProviderDeliveryOperation[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ProviderDeliveryConflictError | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const sequenceRef = useRef(0);
  const scopeRef = useRef(workspaceDir);
  const publicationKeysRef = useRef(new Map<string, { key: string; operationId?: string }>());

  useEffect(() => { scopeRef.current = workspaceDir; controllerRef.current?.abort(); publicationKeysRef.current.clear(); setProviders([]); setCapabilities([]); setDeliveries([]); setFeedback([]); setOperations([]); setError(null); setConflict(null); }, [workspaceDir]);
  useEffect(() => () => controllerRef.current?.abort(), []);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    controllerRef.current?.abort();
    const controller = new AbortController(); controllerRef.current = controller;
    const sequence = ++sequenceRef.current; const scope = workspaceDir;
    setLoading(true); setError(null);
    try {
      const [providerResponse, currentResponse, operationResponse] = await Promise.all([fetch(`${API}/providers`, { headers: auth(token), signal: controller.signal }), fetch(`${API}/current`, { headers: auth(token), signal: controller.signal }), fetch(`${API}/operations`, { headers: auth(token), signal: controller.signal })]);
      if (!providerResponse.ok) throw await errorFrom(providerResponse);
      if (!currentResponse.ok) throw await errorFrom(currentResponse);
      if (!operationResponse.ok) throw await errorFrom(operationResponse);
      const providerBody = await providerResponse.json() as { providers?: ProviderConfigSummary[] };
      const currentBody = await currentResponse.json() as { deliveries?: ProviderDelivery[]; feedback?: DeliveryFeedback[] };
      const operationBody = await operationResponse.json() as { operations?: ProviderDeliveryOperation[] };
      if (controller.signal.aborted || sequence !== sequenceRef.current || scope !== scopeRef.current) return;
      setProviders(providerBody.providers || []); setDeliveries(currentBody.deliveries || []); setFeedback(currentBody.feedback || []); setOperations(operationBody.operations || []); setConflict(null);
    } catch (nextError) {
      if (controller.signal.aborted) return;
      const normalized = nextError instanceof Error ? nextError : new Error("Provider delivery request failed");
      if (normalized instanceof ProviderDeliveryConflictError) setConflict(normalized); setError(normalized.message);
    } finally { if (sequence === sequenceRef.current && scope === scopeRef.current) setLoading(false); }
  }, [enabled, token, workspaceDir]);
  useEffect(() => { void refresh(); }, [refresh]);

  const probe = useCallback(async (repository: DeliveryRepositoryRef) => {
    setBusyId("capabilities"); setError(null);
    try {
      const query = new URLSearchParams(Object.entries(repository).flatMap(([key, value]) => value ? [[key, value]] : []));
      const response = await fetch(`${API}/capabilities?${query}`, { headers: auth(token) });
      if (!response.ok) throw await errorFrom(response);
      const body = await response.json() as { capabilities?: ProviderCapability[] };
      setCapabilities(body.capabilities || []); return body.capabilities || [];
    } catch (nextError) { const normalized = nextError instanceof Error ? nextError : new Error("Provider capability check failed"); setError(normalized.message); throw normalized; }
    finally { setBusyId(null); }
  }, [token]);

  const prepare = useCallback(async (input: ProviderDeliveryPrepareInput, serverBindingHint = "") => {
    setBusyId("prepare"); setError(null); setConflict(null);
    const requestDigest = await publicationRequestDigest(input, serverBindingHint);
    const pending = publicationKeysRef.current.get(requestDigest);
    const knownOperation = pending?.operationId ? operations.find((operation) => operation.id === pending.operationId) : undefined;
    const reusablePending = !knownOperation || ["awaiting_approval", "approved", "in_flight", "ambiguous"].includes(knownOperation.status);
    const idempotencyKey = pending && reusablePending ? pending.key : `${input.providerConfigId}:${crypto.randomUUID()}`;
    publicationKeysRef.current.set(requestDigest, { key: idempotencyKey, operationId: pending?.operationId });
    try {
      const response = await fetch(`${API}/operations`, { method: "POST", headers: { ...auth(token), "Content-Type": "application/json", "Idempotency-Key": idempotencyKey }, body: JSON.stringify(input) });
      if (!response.ok) throw await errorFrom(response);
      const { operation } = await response.json() as { operation: ProviderDeliveryOperation };
      publicationKeysRef.current.set(requestDigest, { key: idempotencyKey, operationId: operation.id });
      setOperations((current) => [operation, ...current.filter((item) => item.id !== operation.id)]);
      return operation;
    } catch (nextError) { const normalized = nextError instanceof Error ? nextError : new Error("Provider delivery preflight failed"); if (normalized instanceof ProviderDeliveryConflictError) { setConflict(normalized); if (normalized.code === "idempotency_conflict") publicationKeysRef.current.delete(requestDigest); } setError(normalized.message); throw normalized; }
    finally { setBusyId(null); }
  }, [operations, token]);

  const approvePublication = useCallback(async (operation: ProviderDeliveryOperation) => {
    setBusyId(operation.id); setError(null); setConflict(null);
    try {
      const response = await fetch(`${API}/operations/${encodeURIComponent(operation.id)}/approve`, { method: "POST", headers: { ...auth(token), "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: operation.version, approvalDigest: operation.approvalDigest }) });
      if (!response.ok) throw await errorFrom(response);
      const body = await response.json() as { operation: ProviderDeliveryOperation };
      setOperations((current) => current.map((item) => item.id === body.operation.id ? body.operation : item));
      return body.operation;
    } catch (nextError) { const normalized = nextError instanceof Error ? nextError : new Error("Provider delivery approval failed"); if (normalized instanceof ProviderDeliveryConflictError) { await refresh(); setConflict(normalized); } setError(normalized.message); throw normalized; }
    finally { setBusyId(null); }
  }, [refresh, token]);

  const publish = useCallback(async (operation: ProviderDeliveryOperation) => {
    setBusyId(operation.id); setError(null); setConflict(null);
    try {
      const response = await fetch(`${API}/operations/${encodeURIComponent(operation.id)}/publish`, { method: "POST", headers: { ...auth(token), "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: operation.version }) });
      if (!response.ok) throw await errorFrom(response);
      const { delivery } = await response.json() as { delivery: ProviderDelivery };
      for (const [digest, pending] of publicationKeysRef.current) if (pending.operationId === operation.id) publicationKeysRef.current.delete(digest);
      setDeliveries((current) => [delivery, ...current.filter((item) => item.id !== delivery.id)]);
      await refresh();
      return delivery;
    } catch (nextError) { const normalized = nextError instanceof Error ? nextError : new Error("Provider delivery failed"); if (normalized instanceof ProviderDeliveryConflictError) { await refresh(); setConflict(normalized); } setError(normalized.message); throw normalized; }
    finally { setBusyId(null); }
  }, [refresh, token]);

  const reconcile = useCallback(async (operation: ProviderDeliveryOperation) => {
    setBusyId(operation.id); setError(null); setConflict(null);
    try {
      const response = await fetch(`${API}/operations/${encodeURIComponent(operation.id)}/reconcile`, { method: "POST", headers: auth(token) });
      if (!response.ok) throw await errorFrom(response);
      const { delivery } = await response.json() as { delivery: ProviderDelivery };
      setDeliveries((current) => [delivery, ...current.filter((item) => item.id !== delivery.id)]);
      await refresh();
      return delivery;
    } catch (nextError) { const normalized = nextError instanceof Error ? nextError : new Error("Provider delivery reconcile failed"); if (normalized instanceof ProviderDeliveryConflictError) setConflict(normalized); setError(normalized.message); throw normalized; }
    finally { setBusyId(null); }
  }, [refresh, token]);

  const refreshDelivery = useCallback(async (delivery: ProviderDelivery) => {
    setBusyId(delivery.id); setError(null);
    try {
      const response = await fetch(`${API}/${encodeURIComponent(delivery.id)}/refresh`, { method: "POST", headers: auth(token) });
      if (!response.ok) throw await errorFrom(response);
      const body = await response.json() as { delivery: ProviderDelivery; feedback?: DeliveryFeedback[] };
      setDeliveries((current) => current.map((item) => item.id === body.delivery.id ? body.delivery : item)); setFeedback(body.feedback || []); return body.delivery;
    } catch (nextError) { const normalized = nextError instanceof Error ? nextError : new Error("Delivery refresh failed"); setError(normalized.message); throw normalized; }
    finally { setBusyId(null); }
  }, [token]);

  const approveFollowUp = useCallback(async (delivery: ProviderDelivery, item: DeliveryFeedback, approvalId: string) => {
    setBusyId(item.id); setError(null); setConflict(null);
    const optimistic: DeliveryFeedback = { ...item, lifecycle: "task_created", version: item.version + 1, updatedAt: Date.now() };
    setFeedback((current) => current.map((entry) => entry.id === item.id ? optimistic : entry));
    try {
      const response = await fetch(`${API}/${encodeURIComponent(delivery.id)}/follow-ups/${encodeURIComponent(item.id)}/approve`, { method: "POST", headers: { ...auth(token), "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: item.version, approvalId }) });
      if (!response.ok) throw await errorFrom(response);
      const body = await response.json() as { feedback: DeliveryFeedback };
      setFeedback((current) => current.map((entry) => entry.id === item.id ? body.feedback : entry));
      if (!body.feedback.taskId || !body.feedback.followUpRunId) throw new ProviderFollowUpIncompleteError(body.feedback);
      return body.feedback;
    } catch (nextError) {
      if (!(nextError instanceof ProviderFollowUpIncompleteError)) setFeedback((current) => current.map((entry) => entry.id === item.id ? item : entry));
      const normalized = nextError instanceof Error ? nextError : new Error("Follow-up task could not be created"); if (normalized instanceof ProviderDeliveryConflictError) { await refresh(); setConflict(normalized); } setError(normalized.message); throw normalized;
    } finally { setBusyId(null); }
  }, [refresh, token]);

  return { providers, capabilities, deliveries, feedback, operations, loading, busyId, error, conflict, refresh, probe, prepare, approvePublication, publish, reconcile, refreshDelivery, approveFollowUp, clearError: () => { setError(null); setConflict(null); } };
}
