import { useCallback, useEffect, useRef, useState } from "react";
import { AgentControlAction, AgentGraphSnapshot, AgentGraphWsMessage, AgentSnapshot, LegacyAgentWsMessage, OrchestrationBudget, canUpdateAgentBudget } from "../types";
import { useI18n } from "../i18n";

export type AgentControlPayload = { instruction?: string; prompt?: string; role?: string; targetAgentId?: string; expectedVersion?: number };
const emptyGraph = (): AgentGraphSnapshot => ({ schemaVersion: 1, revision: "", asOf: 0, nodes: [], edges: [], events: [] });
const agentKey = (agent: AgentSnapshot) => agent.id || agent.name;
const isGraph = (value: unknown): value is AgentGraphSnapshot => {
  const graph = value as Partial<AgentGraphSnapshot> | null;
  return graph?.schemaVersion === 1 && Array.isArray(graph.nodes) && Array.isArray(graph.edges) && Array.isArray(graph.events);
};

export function useAgents(token: string, visible: boolean) {
  const { t } = useI18n();
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  const [graph, setGraph] = useState<AgentGraphSnapshot>(emptyGraph);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [pendingById, setPendingById] = useState<Record<string, AgentControlAction | undefined>>({});
  const agentsRef = useRef<AgentSnapshot[]>([]);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);
  const cursorRef = useRef(-1);
  const legacySequenceRef = useRef(-1);
  const scopeRef = useRef(0);
  const graphScopeRef = useRef(`token:${token}`);

  useEffect(() => { agentsRef.current = agents; }, [agents]);
  useEffect(() => {
    scopeRef.current += 1;
    refreshControllerRef.current?.abort();
    socketRef.current?.close();
    if (reconnectRef.current !== null) window.clearTimeout(reconnectRef.current);
    cursorRef.current = -1; legacySequenceRef.current = -1;
    graphScopeRef.current = `token:${token}`;
    setAgents([]); setGraph(emptyGraph()); setPendingById({}); setSocketConnected(false);
  }, [token]);

  const refreshLegacy = useCallback(async (controller?: AbortController) => {
    const response = await fetch("/api/team/agents", { headers: { Authorization: `Bearer ${token}` }, signal: controller?.signal });
    if (!response.ok) throw new Error("Failed to load agents");
    const payload = await response.json() as { agents?: AgentSnapshot[] };
    if (Array.isArray(payload.agents)) setAgents(payload.agents);
  }, [token]);

  const refresh = useCallback(async () => {
    const scope = scopeRef.current;
    refreshControllerRef.current?.abort();
    const controller = new AbortController(); refreshControllerRef.current = controller;
    setLoading(true);
    try {
      const response = await fetch("/api/team/agents?view=graph", { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
      if (!response.ok) throw new Error("Graph view unavailable");
      const payload = await response.json();
      if (!isGraph(payload)) throw new Error("Graph view unavailable");
      if (scope !== scopeRef.current) return;
      setGraph(payload);
      // The graph intentionally omits control capabilities and budgets. Keep
      // the legacy projection alongside it so target-scoped controls remain safe.
      await refreshLegacy(controller);
      if (scope === scopeRef.current) setError(null);
    } catch {
      if (controller.signal.aborted) return;
      try { await refreshLegacy(controller); if (scope === scopeRef.current) setError(null); }
      catch (reason) { if (!controller.signal.aborted && scope === scopeRef.current) setError(reason instanceof Error ? reason.message : t("agents.failed")); }
    } finally { if (scope === scopeRef.current) setLoading(false); }
  }, [refreshLegacy, t, token]);

  useEffect(() => {
    if (!visible || !token) return;
    let disposed = false;
    let attempts = 0;
    void refresh();
    const connect = () => {
      if (disposed) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/team?token=${encodeURIComponent(token)}`);
      socketRef.current = ws;
      let subscribedGraphScope = "";
      ws.onopen = () => { if (!disposed) { attempts = 0; setSocketConnected(true); } };
      ws.onmessage = (message) => {
        if (disposed) return;
        let payload: AgentGraphWsMessage | LegacyAgentWsMessage | { type: "team_snapshot"; team?: { id?: string } | null };
        try { payload = JSON.parse(String(message.data)); } catch { return; }
        if (payload.type === "team_snapshot") {
          const nextGraphScope = payload.team?.id ? `team:${payload.team.id}` : `token:${token}`;
          if (graphScopeRef.current !== nextGraphScope) {
            graphScopeRef.current = nextGraphScope;
            scopeRef.current += 1;
            refreshControllerRef.current?.abort();
            cursorRef.current = -1;
            setGraph(emptyGraph());
          }
          if (payload.team?.id && subscribedGraphScope !== nextGraphScope) {
            subscribedGraphScope = nextGraphScope;
            ws.send(JSON.stringify({ type: "subscribe", teamId: payload.team.id, afterGraphCursor: Math.max(cursorRef.current, 0), afterGraphSequence: Math.max(cursorRef.current, 0) }));
          }
          return;
        }
        if (payload.type === "agent_graph_snapshot" || payload.type === "agent_graph_event") {
          if (!Number.isSafeInteger(payload.cursor) || !isGraph(payload.graph) || payload.cursor <= cursorRef.current) return;
          if (cursorRef.current >= 0 && payload.cursor > cursorRef.current + 1) { cursorRef.current = payload.cursor; void refresh(); return; }
          cursorRef.current = payload.cursor; setGraph(payload.graph); setError(null); return;
        }
        if ((payload.type === "agent_snapshot" || payload.type === "agent_update") && Number.isSafeInteger(payload.sequence) && payload.sequence > legacySequenceRef.current && Array.isArray(payload.agents)) {
          legacySequenceRef.current = payload.sequence; setAgents(payload.agents);
        }
      };
      ws.onclose = () => {
        if (socketRef.current === ws) socketRef.current = null;
        if (disposed) return;
        setSocketConnected(false);
        reconnectRef.current = window.setTimeout(connect, Math.min(1_000 * 2 ** attempts++, 15_000));
      };
      ws.onerror = () => ws.close();
    };
    connect();
    const fallbackTimer = window.setInterval(() => { void refresh(); }, 30_000);
    return () => { disposed = true; window.clearInterval(fallbackTimer); if (reconnectRef.current !== null) window.clearTimeout(reconnectRef.current); socketRef.current?.close(); refreshControllerRef.current?.abort(); };
  }, [refresh, token, visible]);

  const control = useCallback(async (agent: AgentSnapshot, action: AgentControlAction, payload: AgentControlPayload = {}) => {
    const key = agentKey(agent); if (pendingById[key]) return;
    const previous = agentsRef.current;
    const optimisticStatus = action === "pause" ? "paused" : action === "resume" || action === "retry" ? "working" : action === "stop" ? "shutdown" : agent.status;
    setPendingById((current) => ({ ...current, [key]: action }));
    setAgents((current) => current.map((item) => agentKey(item) === key ? { ...item, status: optimisticStatus, updatedAt: Date.now() } : item));
    try {
      const response = await fetch(`/api/team/agents/${encodeURIComponent(key)}/control`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(agent.version !== undefined ? { "If-Match": String(agent.version) } : {}) }, body: JSON.stringify({ action, ...payload, ...(payload.instruction && !payload.prompt ? { prompt: payload.instruction } : {}), expectedVersion: payload.expectedVersion ?? agent.version }) });
      if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new Error(response.status === 409 ? t("agents.controlConflict") : body.error || t("agents.controlUnavailable")); }
      const result = await response.json().catch(() => ({})) as { agent?: AgentSnapshot };
      if (result.agent) setAgents((current) => current.map((item) => agentKey(item) === key ? result.agent! : item));
      setError(null);
    } catch (reason) { setAgents(previous); setError(reason instanceof Error ? reason.message : t("agents.controlUnavailable")); throw reason; }
    finally { setPendingById((current) => ({ ...current, [key]: undefined })); }
  }, [pendingById, t, token]);

  const updateBudget = useCallback(async (agent: AgentSnapshot, budget: Partial<OrchestrationBudget>) => {
    if (!canUpdateAgentBudget(agent)) throw new Error(t("agents.controlUnavailable"));
    const key = agentKey(agent); const previous = agentsRef.current;
    setAgents((current) => current.map((item) => agentKey(item) === key ? { ...item, budget: { ...item.budget, ...budget } } : item));
    try {
      const response = await fetch(`/api/team/agents/${encodeURIComponent(key)}/budget`, { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(agent.version !== undefined ? { "If-Match": String(agent.version) } : {}) }, body: JSON.stringify({ budget, expectedVersion: agent.version }) });
      if (response.status === 409) { await refresh(); throw new Error(t("agents.controlConflict")); }
      if (!response.ok) throw new Error(t("agents.controlUnavailable"));
      const result = await response.json() as { agent?: AgentSnapshot }; if (result.agent) setAgents((current) => current.map((item) => agentKey(item) === key ? result.agent! : item));
    } catch (reason) { setAgents(previous); throw reason; }
  }, [refresh, t, token]);

  return { agents, graph, loading, error, socketConnected, refresh, control, updateBudget, pendingById };
}
