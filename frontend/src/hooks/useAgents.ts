import { useCallback, useEffect, useState } from "react";
import { AgentSnapshot } from "../types";
import { useI18n } from "../i18n";

export function useAgents(token: string, visible: boolean) {
  const { t } = useI18n();
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/team/agents", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("Failed to load agents");
      const payload = (await response.json()) as { agents?: AgentSnapshot[] };
      setAgents(Array.isArray(payload.agents) ? payload.agents : []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("agents.failed"));
    } finally {
      setLoading(false);
    }
  }, [t, token]);

  useEffect(() => {
    if (!visible) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [refresh, visible]);

  return { agents, loading, error, refresh };
}
