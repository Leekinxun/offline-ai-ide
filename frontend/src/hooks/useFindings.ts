import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReviewFinding, ReviewFindingLifecycle } from "../types";

const headers = (token: string) => ({ Authorization: `Bearer ${token}` });
const PAGE_LIMIT = 500;
const fallbackTransitions: Record<ReviewFindingLifecycle, ReviewFindingLifecycle[]> = {
  open: ["accepted", "disputed", "fixed", "dismissed"],
  accepted: ["disputed", "fixed", "dismissed"],
  disputed: ["accepted", "dismissed"],
  fixed: ["verified", "open"],
  verified: [],
  dismissed: [],
};

export interface FindingFilters {
  runId?: string;
  conversationId?: string;
  changeSetId?: string;
  changeSetIds?: readonly string[];
  reviewRunId?: string;
  enabled?: boolean;
}

interface FindingsResponse {
  findings?: ReviewFinding[];
  page?: { offset: number; limit: number; total: number };
  canIntegrate?: boolean;
}

export function allowedFindingTransitions(finding: ReviewFinding): ReviewFindingLifecycle[] {
  return finding.allowedTransitions || fallbackTransitions[finding.lifecycle || "open"];
}

async function responseError(response: Response): Promise<Error & { code?: string; currentVersion?: number }> {
  const body = await response.json().catch(() => ({})) as { error?: string; code?: string; currentVersion?: number };
  const error = new Error(body.error || `Finding request failed: ${response.status}`) as Error & { code?: string; currentVersion?: number };
  error.code = response.status === 409 ? body.code || "version_conflict" : body.code;
  error.currentVersion = body.currentVersion;
  return error;
}

async function fetchAllFindings(token: string, filters: Omit<FindingFilters, "changeSetIds" | "enabled">, signal: AbortSignal): Promise<{ findings: ReviewFinding[]; canIntegrate?: boolean } | null> {
  const findings: ReviewFinding[] = [];
  let canIntegrate: boolean | undefined;
  let offset = 0;
  while (true) {
    const query = new URLSearchParams({
      limit: String(PAGE_LIMIT),
      offset: String(offset),
      ...(filters.runId ? { runId: filters.runId } : {}),
      ...(filters.conversationId ? { conversationId: filters.conversationId } : {}),
      ...(filters.changeSetId ? { changeSetId: filters.changeSetId } : {}),
      ...(filters.reviewRunId ? { reviewRunId: filters.reviewRunId } : {}),
    });
    const response = await fetch(`/api/chat/review-findings?${query}`, { headers: headers(token), signal });
    if (response.status === 404 || response.status === 501) return null;
    if (!response.ok) throw await responseError(response);
    const data = await response.json() as FindingsResponse;
    const pageFindings = data.findings || [];
    findings.push(...pageFindings);
    if (typeof data.canIntegrate === "boolean") canIntegrate = data.canIntegrate;
    const total = data.page?.total;
    if (typeof total !== "number" || findings.length >= total) return { findings, canIntegrate };
    if (pageFindings.length === 0) throw new Error("Findings pagination ended before the reported total");
    offset += pageFindings.length;
  }
}

function filename(response: Response, fallback: string): string {
  const disposition = response.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1] || disposition.match(/filename="?([^";]+)"?/i)?.[1];
  if (!match) return fallback;
  try { return decodeURIComponent(match); } catch { return fallback; }
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function useFindings(token: string, filters: FindingFilters = {}) {
  const [findings, setFindings] = useState<ReviewFinding[]>([]);
  const [available, setAvailable] = useState(true);
  const [canIntegrate, setCanIntegrate] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transitioningIds, setTransitioningIds] = useState<Set<string>>(new Set());
  const [transitionErrors, setTransitionErrors] = useState<Record<string, string>>({});
  const controllerRef = useRef<AbortController | null>(null);
  const sequenceRef = useRef(0);
  const { runId, conversationId, changeSetId, reviewRunId, enabled = true } = filters;
  const hasChangeSetList = filters.changeSetIds !== undefined;
  const changeSetScope = useMemo(() => [...new Set(filters.changeSetIds || [])].sort(), [filters.changeSetIds]);
  const changeSetScopeKey = changeSetScope.join("\u0000");
  const scopeKey = [runId, conversationId, changeSetId, changeSetScopeKey, reviewRunId].join("\u0001");

  const refresh = useCallback(async () => {
    controllerRef.current?.abort();
    if (!enabled || (hasChangeSetList && !changeSetScopeKey)) {
      setFindings([]);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    const requestSequence = ++sequenceRef.current;
    setLoading(true);
    setError(null);
    try {
      const scopes = hasChangeSetList
        ? changeSetScope.map((id) => ({ runId, conversationId, reviewRunId, changeSetId: id }))
        : [{ runId, conversationId, changeSetId, reviewRunId }];
      const results = await Promise.all(scopes.map((scope) => fetchAllFindings(token, scope, controller.signal)));
      if (controller.signal.aborted || requestSequence !== sequenceRef.current) return;
      if (results.some((result) => result === null)) {
        setAvailable(false);
        setFindings([]);
        return;
      }
      const resolved = results.flatMap((result) => result?.findings || []);
      const unique = Array.from(new Map(resolved.map((finding) => [finding.id, finding])).values());
      setFindings(unique.filter((finding) => {
        if (runId && finding.runId !== runId) return false;
        if (changeSetId && finding.changeSetId !== changeSetId) return false;
        if (hasChangeSetList && !changeSetScope.includes(finding.changeSetId || "")) return false;
        if (reviewRunId && finding.reviewRunId !== reviewRunId && finding.reviewer?.reviewRunId !== reviewRunId) return false;
        return true;
      }));
      setCanIntegrate(results.every((result) => result?.canIntegrate !== false));
      setAvailable(true);
      setError(null);
    } catch (nextError) {
      if (controller.signal.aborted) return;
      setError(nextError instanceof Error ? nextError.message : "Findings request failed");
    } finally {
      if (requestSequence === sequenceRef.current) setLoading(false);
    }
  }, [changeSetId, changeSetScope, changeSetScopeKey, conversationId, enabled, hasChangeSetList, reviewRunId, runId, token]);

  useEffect(() => { void refresh(); return () => controllerRef.current?.abort(); }, [refresh, scopeKey]);

  const transition = useCallback(async (
    finding: ReviewFinding,
    to: ReviewFindingLifecycle,
    extra: { reason?: string; evidence?: string[]; revision?: string; fixRef?: string } = {}
  ) => {
    const previous = finding;
    const optimistic: ReviewFinding = {
      ...finding,
      lifecycle: to,
      version: (finding.version || 0) + 1,
      updatedAt: Date.now(),
    };
    setTransitioningIds((current) => new Set(current).add(finding.id));
    setTransitionErrors((current) => { const next = { ...current }; delete next[finding.id]; return next; });
    setFindings((current) => current.map((item) => item.id === finding.id ? optimistic : item));
    try {
      const response = await fetch(`/api/chat/review-findings/${encodeURIComponent(finding.id)}/transition`, {
        method: "POST",
        headers: { ...headers(token), "Content-Type": "application/json" },
        body: JSON.stringify({ to, expectedVersion: finding.version, ...extra }),
      });
      if (!response.ok) throw await responseError(response);
      const result = await response.json() as { finding: ReviewFinding; canIntegrate?: boolean };
      setFindings((current) => current.map((item) => item.id === finding.id ? result.finding : item));
      if (typeof result.canIntegrate === "boolean") setCanIntegrate(result.canIntegrate);
      return result.finding;
    } catch (nextError) {
      setFindings((current) => current.map((item) => item.id === finding.id ? previous : item));
      const normalized = nextError instanceof Error ? nextError : new Error("Finding transition failed");
      setTransitionErrors((current) => ({ ...current, [finding.id]: normalized.message }));
      if ((normalized as Error & { code?: string }).code === "version_conflict") await refresh();
      throw normalized;
    } finally {
      setTransitioningIds((current) => { const next = new Set(current); next.delete(finding.id); return next; });
    }
  }, [refresh, token]);

  const exportFindings = useCallback(async (format: "crewforge" | "sarif") => {
    const query = new URLSearchParams({ format });
    if (runId) query.set("runId", runId);
    if (conversationId) query.set("conversationId", conversationId);
    if (changeSetId) query.set("changeSetId", changeSetId);
    if (reviewRunId) query.set("reviewRunId", reviewRunId);
    if (![runId, conversationId, changeSetId, reviewRunId].some(Boolean)) throw new Error("A review finding export scope is required");
    const response = await fetch(`/api/chat/review-findings/export?${query}`, { headers: headers(token) });
    if (!response.ok) throw await responseError(response);
    const fallback = `crewforge-findings.${format === "sarif" ? "sarif.json" : "json"}`;
    if (format === "sarif") {
      const contentType = response.headers.get("Content-Type") || "";
      if (!/application\/sarif\+json/i.test(contentType)) throw new Error(`SARIF export returned an invalid content type: ${contentType || "missing"}`);
      const payload = await response.json() as { version?: string; runs?: unknown[] };
      if (payload.version !== "2.1.0" || !Array.isArray(payload.runs)) throw new Error("SARIF export returned an invalid SARIF 2.1.0 document");
      downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/sarif+json" }), filename(response, fallback));
      return;
    }
    downloadBlob(await response.blob(), filename(response, fallback));
  }, [changeSetId, conversationId, reviewRunId, runId, token]);

  return {
    findings, available, canIntegrate, loading, error, transitioningIds, transitionErrors,
    refresh, transition, exportFindings,
    clearTransitionError: (id: string) => setTransitionErrors((current) => { const next = { ...current }; delete next[id]; return next; }),
  };
}
