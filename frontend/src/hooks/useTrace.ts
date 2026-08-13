import { useCallback, useEffect, useState } from "react";
import { CausalTraceEvent, TraceMetrics, TracePrunePreview, TraceRetention } from "../types";
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export function useTrace(token: string, runId?: string, enabled = true) {
  const [events, setEvents] = useState<CausalTraceEvent[]>([]); const [metrics, setMetrics] = useState<TraceMetrics | null>(null); const [retention, setRetention] = useState<TraceRetention | null>(null); const [preview, setPreview] = useState<TracePrunePreview | null>(null); const [available, setAvailable] = useState(true); const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!runId || !enabled) return;
    try {
      const query = `?runId=${encodeURIComponent(runId)}&limit=500`;
      const [list, metric, policy] = await Promise.all([fetch(`/api/chat/traces${query}`, { headers: auth(token) }), fetch("/api/chat/traces/metrics", { headers: auth(token) }), fetch("/api/chat/traces/retention", { headers: auth(token) })]);
      if (list.status === 404 || list.status === 501) { setAvailable(false); return; }
      if (!list.ok) throw new Error("Trace request failed");
      setEvents(((await list.json()) as { events?: CausalTraceEvent[] }).events || []);
      if (metric.ok) setMetrics(((await metric.json()) as { metrics: TraceMetrics }).metrics);
      if (policy.ok) { const value = await policy.json() as { retention: TraceRetention; preview: TracePrunePreview }; setRetention(value.retention); setPreview(value.preview); }
      setAvailable(true); setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Trace request failed"); }
  }, [enabled, runId, token]);
  useEffect(() => { void refresh(); }, [refresh]);
  const exportTrace = useCallback(async () => { if (!runId) return; const response = await fetch(`/api/chat/traces/export?runId=${encodeURIComponent(runId)}`, { headers: auth(token) }); if (!response.ok) throw new Error("Trace export failed"); const blob = new Blob([JSON.stringify(await response.json(), null, 2)], { type: "application/json" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `crewforge-trace-${runId}.json`; link.click(); URL.revokeObjectURL(link.href); }, [runId, token]);
  const deleteTrace = useCallback(async () => { if (!runId) return; const response = await fetch(`/api/chat/traces?runId=${encodeURIComponent(runId)}`, { method: "DELETE", headers: auth(token) }); if (response.status === 409) throw new Error("active"); if (!response.ok) throw new Error("Trace deletion failed"); await refresh(); }, [refresh, runId, token]);
  const updateRetention = useCallback(async (patch: Partial<TraceRetention>, prune = false) => { const response = await fetch("/api/chat/traces/retention", { method: "PUT", headers: { ...auth(token), "Content-Type": "application/json" }, body: JSON.stringify({ ...patch, prune }) }); if (!response.ok) throw new Error("Retention update failed"); const value = await response.json() as { retention: TraceRetention; preview: TracePrunePreview; metrics?: TraceMetrics }; setRetention(value.retention); setPreview(value.preview); if (value.metrics) setMetrics(value.metrics); }, [token]);
  return { events, metrics, retention, preview, available, error, refresh, exportTrace, deleteTrace, updateRetention };
}
