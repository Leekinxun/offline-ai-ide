import { useCallback, useEffect, useRef, useState } from "react";
import { AgentControlAction, AgentSnapshot, OrchestrationBudget, canUpdateAgentBudget } from "../types";
import { useI18n } from "../i18n";

export type AgentControlPayload = { instruction?: string; prompt?: string; role?: string; targetAgentId?: string; expectedVersion?: number };

/** Polling is deliberately retained until the team socket publishes agent snapshots. */
export function useAgents(token: string, visible: boolean) {
  const { t } = useI18n();
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingById, setPendingById] = useState<Record<string, AgentControlAction | undefined>>({});
  const agentsRef = useRef<AgentSnapshot[]>([]);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const scopeRef = useRef(0);

  useEffect(() => { scopeRef.current += 1; refreshControllerRef.current?.abort(); setAgents([]); setPendingById({}); }, [token]);

  useEffect(() => { agentsRef.current = agents; }, [agents]);
  const agentKey = (agent: AgentSnapshot) => agent.id || agent.name;

  const refresh = useCallback(async () => {
    const scope = scopeRef.current;
    refreshControllerRef.current?.abort();
    const controller = new AbortController(); refreshControllerRef.current = controller;
    setLoading(true);
    try {
      const response = await fetch("/api/team/agents", { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
      if (!response.ok) throw new Error("Failed to load agents");
      const payload = (await response.json()) as { agents?: AgentSnapshot[] };
      if (scope !== scopeRef.current) return;
      setAgents(Array.isArray(payload.agents) ? payload.agents : []);
      setError(null);
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : t("agents.failed"));
    } finally { if (scope === scopeRef.current) setLoading(false); }
  }, [t, token]);

  const control = useCallback(async (agent: AgentSnapshot, action: AgentControlAction, payload: AgentControlPayload = {}) => {
    const key = agentKey(agent);
    if (pendingById[key]) return;
    const previous = agentsRef.current;
    const optimisticStatus = action === "pause" ? "paused" : action === "resume" || action === "retry" ? "working" : action === "stop" ? "shutdown" : agent.status;
    setPendingById((current) => ({ ...current, [key]: action }));
    setAgents((current) => current.map((item) => agentKey(item) === key ? { ...item, status: optimisticStatus, updatedAt: Date.now() } : item));
    try {
      // Contract is intentionally versioned and target-scoped; a 404 means an older server,
      // so the board remains read-only instead of sending an unsafe broad team command.
      const response = await fetch(`/api/team/agents/${encodeURIComponent(key)}/control`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(agent.version !== undefined ? { "If-Match": String(agent.version) } : {}) },
        // `instruction` is the current API field; `prompt` keeps steering compatible
        // with deployed servers that shipped the earlier spelling.
        body: JSON.stringify({ action, ...payload, ...(payload.instruction && !payload.prompt ? { prompt: payload.instruction } : {}), expectedVersion: payload.expectedVersion ?? agent.version }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(response.status === 409 ? t("agents.controlConflict") : body.error || t("agents.controlUnavailable"));
      }
      const result = await response.json().catch(() => ({})) as { agent?: AgentSnapshot };
      if (result.agent) setAgents((current) => current.map((item) => agentKey(item) === key ? result.agent! : item));
      setError(null);
    } catch (reason) {
      setAgents(previous);
      setError(reason instanceof Error ? reason.message : t("agents.controlUnavailable"));
      throw reason;
    } finally {
      setPendingById((current) => ({ ...current, [key]: undefined }));
    }
  }, [pendingById, t, token]);

  const updateBudget = useCallback(async (agent: AgentSnapshot, budget: Partial<OrchestrationBudget>) => {
    if (!canUpdateAgentBudget(agent)) throw new Error(t("agents.controlUnavailable"));
    const key = agentKey(agent); const response = await fetch(`/api/team/agents/${encodeURIComponent(key)}/budget`, { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(agent.version !== undefined ? { "If-Match": String(agent.version) } : {}) }, body: JSON.stringify({ budget, expectedVersion: agent.version }) });
    if (response.status === 409) { await refresh(); throw new Error(t("agents.controlConflict")); }
    if (!response.ok) throw new Error(t("agents.controlUnavailable"));
    const result = await response.json() as { agent?: AgentSnapshot }; if (result.agent) setAgents((current) => current.map((item) => agentKey(item) === key ? result.agent! : item));
  }, [refresh, t, token]);

  useEffect(() => {
    if (!visible) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => { window.clearInterval(timer); refreshControllerRef.current?.abort(); };
  }, [refresh, visible]);

  return { agents, loading, error, refresh, control, updateBudget, pendingById };
}
