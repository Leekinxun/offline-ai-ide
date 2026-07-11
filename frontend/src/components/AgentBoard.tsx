import React from "react";
import { Bot, Clock3, RefreshCw, Sparkles, Square } from "lucide-react";
import { AgentSnapshot } from "../types";
import { useI18n } from "../i18n";
import { useAgents } from "../hooks/useAgents";

interface AgentBoardProps {
  visible: boolean;
  token: string;
  onClose: () => void;
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

export const AgentBoard: React.FC<AgentBoardProps> = ({ visible, token, onClose }) => {
  const { t } = useI18n();
  const { agents, loading, error, refresh } = useAgents(token, visible);

  if (!visible) return null;

  return (
    <aside className="agent-board">
      <div className="agent-board-header">
        <div className="agent-board-title"><Bot size={16} /><strong>{t("agents.title")}</strong></div>
        <div className="agent-board-actions">
          <button type="button" className="sidebar-action-btn" onClick={() => void refresh()} title={t("common.refresh")}>
            <RefreshCw size={14} className={loading ? "chat-spin" : ""} />
          </button>
          <button type="button" className="sidebar-action-btn" onClick={onClose} title={t("common.close")}>×</button>
        </div>
      </div>

      <div className="agent-board-summary">
        <span>{agents.filter((agent) => agent.status === "working").length} {t("agents.working")}</span>
        <span>{agents.length} {t("agents.total")}</span>
      </div>

      {error && <div className="agent-board-error">{error}</div>}
      {!loading && !error && agents.length === 0 && (
        <div className="agent-board-empty">
          <Bot size={28} />
          <strong>{t("agents.emptyTitle")}</strong>
          <span>{t("agents.emptyHint")}</span>
        </div>
      )}
      <div className="agent-board-list">
        {agents.map((agent) => (
          <div className={`agent-card status-${agent.status}`} key={agent.name}>
            <div className="agent-card-head">
              <div className="agent-card-name"><span className="agent-status-icon">{statusIcon(agent.status)}</span><strong>{agent.name}</strong></div>
              <span className="agent-status-label">{t(`agents.status.${agent.status}`)}</span>
            </div>
            <div className="agent-card-role">{agent.role}</div>
            <div className="agent-card-task">{agent.currentTask || t("agents.noCurrentTask")}</div>
            {agent.updatedAt && <div className="agent-card-time">{t("agents.updatedAt", { time: formatTime(agent.updatedAt) })}</div>}
          </div>
        ))}
      </div>
    </aside>
  );
};
