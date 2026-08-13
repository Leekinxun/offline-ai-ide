import React from "react";
import {
  ChevronDown,
  ChevronUp,
  GitCompare,
  History,
  Sparkles,
  Trash2,
  PanelsTopLeft,
} from "lucide-react";
import { useI18n } from "../i18n";
import { CompletionEvidence, ExecutionContract } from "../types";

interface TaskHeaderProps {
  taskTitle: string;
  connected: boolean;
  currentConversationId: string | null;
  isStreaming: boolean;
  activeToolName?: string;
  hasMessages: boolean;
  historyOpen: boolean;
  changesOpen: boolean;
  detailsCollapsed: boolean;
  onToggleHistory: () => void;
  onToggleChanges: () => void;
  onToggleDetails: () => void;
  onClear: () => void;
  onOpenIsolatedWindow: () => void;
  creatingIsolatedWindow: boolean;
  isolatedWindow: boolean;
  executionContract?: ExecutionContract;
  completionEvidence?: CompletionEvidence;
}

export const TaskHeader: React.FC<TaskHeaderProps> = ({
  taskTitle,
  connected,
  currentConversationId,
  isStreaming,
  activeToolName,
  hasMessages,
  historyOpen,
  changesOpen,
  detailsCollapsed,
  onToggleHistory,
  onToggleChanges,
  onToggleDetails,
  onClear,
  onOpenIsolatedWindow,
  creatingIsolatedWindow,
  isolatedWindow,
  executionContract,
  completionEvidence,
}) => {
  const { t } = useI18n();
  const statusLabel = isStreaming
    ? activeToolName
      ? t("chat.runCurrentTool", { tool: activeToolName })
      : t("chat.runPreparing")
    : connected
      ? t("chat.online")
      : t("chat.offline");

  return (
    <header
      className={`chat-header task-header${detailsCollapsed ? " collapsed" : ""}`}
    >
      <div className="task-header-main">
        <div className="task-header-title-row">
          <span className="task-header-icon" aria-hidden="true">
            <Sparkles size={14} />
          </span>
          <div className="chat-header-heading">
            <span className="chat-header-title" title={taskTitle}>{taskTitle}</span>
            {executionContract && <span className={`chat-summary-status${completionEvidence?.outcome === "completed" ? " completed" : completionEvidence ? " failed" : ""}`} title={executionContract.planId || undefined}>{t(`chat.contract.${executionContract.kind}`)}</span>}
          </div>
        </div>
        <div className="task-header-status" role="status" aria-live="polite" aria-atomic="true">
          <span
            className={`task-header-status-dot${
              isStreaming ? " running" : connected ? " connected" : ""
            }`}
          />
          <span>{statusLabel}</span>
          {currentConversationId && !isStreaming && (
            <span className="task-header-continuing">
              {t("chat.continuingConversation")}
            </span>
          )}
        </div>
      </div>

      <div className="chat-header-actions task-header-actions">
        <div className="task-header-view-tabs" role="tablist" aria-label={t("workbench.contentView")}>
          <button type="button" role="tab" aria-selected="true" className="active">
            {t("workbench.details.chat")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={changesOpen}
            className={changesOpen ? "active" : ""}
            onClick={onToggleChanges}
          >
            {t("chat.changes")}
          </button>
        </div>
        {!detailsCollapsed && (
          <>
            <button
              type="button"
              className={`sidebar-action-btn${historyOpen ? " active" : ""}`}
              title={t("chat.tasks")}
              aria-label={t("chat.tasks")}
              onClick={onToggleHistory}
              disabled={isStreaming}
            >
              <History size={14} />
            </button>
            <button
              type="button"
              className={`sidebar-action-btn${changesOpen ? " active" : ""}`}
              title={t("chat.changes")}
              aria-label={t("chat.changes")}
              onClick={onToggleChanges}
            >
              <GitCompare size={14} />
            </button>
          </>
        )}
        <button
          type="button"
          className="sidebar-action-btn"
          title={t(isolatedWindow ? "chat.isolatedWindowActive" : "chat.openIsolatedWindow")}
          aria-label={t(isolatedWindow ? "chat.isolatedWindowActive" : "chat.openIsolatedWindow")}
          onClick={onOpenIsolatedWindow}
          disabled={isStreaming || creatingIsolatedWindow || isolatedWindow}
        >
          <PanelsTopLeft size={14} />
        </button>
        {hasMessages && !detailsCollapsed && (
          <button
            type="button"
            className="sidebar-action-btn"
            title={t("chat.clearChat")}
            aria-label={t("chat.clearChat")}
            onClick={onClear}
            disabled={isStreaming}
          >
            <Trash2 size={14} />
          </button>
        )}
        <button
          type="button"
          className="sidebar-action-btn task-header-collapse"
          title={t(detailsCollapsed ? "chat.showDetails" : "chat.hideDetails")}
          aria-label={t(detailsCollapsed ? "chat.showDetails" : "chat.hideDetails")}
          aria-expanded={!detailsCollapsed}
          onClick={onToggleDetails}
        >
          {detailsCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </div>
    </header>
  );
};
