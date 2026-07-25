import React, { useEffect, useRef } from "react";
import { Bot, Clock3, Sparkles, Square } from "lucide-react";
import { AgentSnapshot } from "../types";
import { useI18n } from "../i18n";
import { useAgents } from "../hooks/useAgents";
import { PanelHeader, PanelState } from "./PanelChrome";

interface AgentBoardProps {
  visible: boolean;
  token: string;
  onClose: () => void;
  drawerMode?: boolean;
}

function formatTime(value?: number): string {
  if (!value) return "";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function statusIcon(status: AgentSnapshot["status"]): React.ReactNode {
  if (status === "working") return <Sparkles size={14} />;
  if (status === "idle") return <Clock3 size={14} />;
  return <Square size={12} />;
}

export const AgentBoard: React.FC<AgentBoardProps> = ({ visible, token, onClose, drawerMode = false }) => {
  const { t } = useI18n();
  const { agents, loading, error, refresh } = useAgents(token, visible);
  const panelRef = useRef<HTMLElement>(null);
  const workingCount = agents.filter((agent) => agent.status === "working").length;

  useEffect(() => {
    if (visible && drawerMode) {
      requestAnimationFrame(() => panelRef.current?.focus());
    }
  }, [drawerMode, visible]);

  if (!visible) return null;

  return (
    <aside
      ref={panelRef}
      className="agent-board panel-shell workspace-drawer"
      role={drawerMode ? "dialog" : "complementary"}
      aria-modal={drawerMode || undefined}
      aria-labelledby="agent-board-title"
      tabIndex={-1}
      data-workspace-drawer="agents"
    >
      <PanelHeader
        titleId="agent-board-title"
        icon={<Bot size={16} />}
        title={t("agents.title")}
        status={loading && agents.length === 0 ? t("common.loading") : t("agents.statusSummary", { count: workingCount })}
        statusTone={workingCount > 0 ? "working" : error ? "danger" : "neutral"}
        refreshing={loading}
        refreshLabel={t("common.refresh")}
        closeLabel={t("common.close")}
        onRefresh={() => void refresh()}
        onClose={onClose}
      />

      <div className="agent-board-summary" aria-live="polite">
        <span className="agent-summary-item working">
          <i aria-hidden="true" />
          <strong>{workingCount}</strong>
          {t("agents.working")}
        </span>
        <span className="agent-summary-item">
          <strong>{agents.length}</strong>
          {t("agents.total")}
        </span>
      </div>

      {loading && agents.length === 0 && !error && (
        <PanelState tone="loading" icon={<Sparkles size={24} />} title={t("agents.loadingTitle")} detail={t("agents.loadingHint")} />
      )}
      {error && (
        <PanelState tone="error" icon={<Bot size={24} />} title={t("agents.failed")} detail={error} actionLabel={t("common.refresh")} onAction={() => void refresh()} />
      )}
      {!loading && !error && agents.length === 0 && (
        <PanelState icon={<Bot size={28} />} title={t("agents.emptyTitle")} detail={t("agents.emptyHint")} />
      )}
      <div className="agent-board-list">
        {agents.map((agent) => (
          <article className={`agent-card status-${agent.status}`} key={agent.name} aria-label={`${agent.name}: ${t(`agents.status.${agent.status}`)}`}>
            <div className="agent-card-head">
              <div className="agent-card-name"><span className="agent-status-icon" aria-hidden="true">{statusIcon(agent.status)}</span><strong>{agent.name}</strong></div>
              <span className="agent-status-label">{t(`agents.status.${agent.status}`)}</span>
            </div>
            <div className="agent-card-role">{agent.role}</div>
            <div className="agent-card-task">{agent.currentTask || t("agents.noCurrentTask")}</div>
            {agent.updatedAt && <div className="agent-card-time">{t("agents.updatedAt", { time: formatTime(agent.updatedAt) })}</div>}
          </article>
        ))}
      </div>
    </aside>
  );
};
