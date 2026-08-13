import React, { useMemo, useState } from "react";
import { Plus, RefreshCw, Search, Sparkles, Trash2 } from "lucide-react";
import { ContextState, ConversationSummary } from "../types";
import { useI18n } from "../i18n";
import { ActionConfirmDialog, type ActionConfirmIntent } from "./ActionConfirmDialog";

interface TaskSidebarProps {
  workspaceLabel: string;
  workspaceDir: string;
  conversations: ConversationSummary[];
  currentConversationId: string | null;
  contextState: ContextState;
  loading: boolean;
  loadingId: string | null;
  isStreaming: boolean;
  onNewTask: () => void;
  onLoadConversation: (conversationId: string) => Promise<void> | void;
  onDeleteConversation: (conversationId: string) => Promise<void> | void;
  onRefresh: () => Promise<void> | void;
}

function formatRelativeTime(timestamp: number, locale: string): string {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return locale === "zh-CN" ? "刚刚" : "Now";
  if (delta < 3_600_000) {
    const minutes = Math.max(1, Math.round(delta / 60_000));
    return locale === "zh-CN" ? `${minutes} 分钟前` : `${minutes}m`;
  }
  if (delta < 86_400_000) {
    return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(timestamp);
  }
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(timestamp);
}

function getConversationTitle(conversation: ConversationSummary, fallback: string): string {
  const title = conversation.title.trim();
  if (title && !title.startsWith("<think")) return title;
  const preview = conversation.preview.replace(/[#*_`]/g, "").trim();
  return preview ? preview.slice(0, 46) : fallback;
}

export const TaskSidebar: React.FC<TaskSidebarProps> = ({
  workspaceLabel,
  workspaceDir,
  conversations,
  currentConversationId,
  contextState,
  loading,
  loadingId,
  isStreaming,
  onNewTask,
  onLoadConversation,
  onDeleteConversation,
  onRefresh,
}) => {
  const { locale, t } = useI18n();
  const [query, setQuery] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ConversationSummary | null>(null);
  const [confirmIntent, setConfirmIntent] = useState<ActionConfirmIntent | null>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase(locale);
  const filteredConversations = useMemo(
    () => conversations.filter((conversation) => {
      if (!normalizedQuery) return true;
      return `${conversation.title} ${conversation.preview}`.toLocaleLowerCase(locale).includes(normalizedQuery);
    }),
    [conversations, locale, normalizedQuery]
  );
  const contextPercent = Math.min(
    100,
    Math.max(0, (contextState.estimatedTokens / Math.max(contextState.threshold, 1)) * 100)
  );

  const handleDeleteConversation = (
    conversation: ConversationSummary,
    title: string
  ) => {
    if (isStreaming || deletingId) return;
    setDeleteError(null);
    setPendingDelete(conversation);
    setConfirmIntent({ id: `delete:${conversation.id}`, title: t("chat.deleteConversation"), description: t("chat.deleteConversationConfirm", { title }), confirmLabel: t("chat.deleteConversation"), tone: "danger" });
  };

  const executeDeleteConversation = async () => {
    if (!pendingDelete) return;
    setDeletingId(pendingDelete.id);
    setDeleteError(null);
    try {
      await onDeleteConversation(pendingDelete.id);
      setConfirmIntent(null);
      setPendingDelete(null);
    } catch (error) {
      setDeleteError(
        error instanceof Error ? error.message : t("chat.deleteConversationFailed")
      );
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <aside className="task-sidebar" aria-label={t("workbench.conversations")}> 
      <header className="task-sidebar-header">
        <div className="task-sidebar-workspace">
          <span className="task-sidebar-mark"><Sparkles size={13} /></span>
          <div>
            <strong>{workspaceLabel}</strong>
            <span title={workspaceDir}>{workspaceDir}</span>
          </div>
        </div>
        <button
          type="button"
          className="task-sidebar-refresh"
          onClick={() => void onRefresh()}
          disabled={loading}
          title={t("chat.refreshHistory")}
          aria-label={t("chat.refreshHistory")}
        >
          <RefreshCw size={14} className={loading ? "chat-spin" : ""} />
        </button>
      </header>

      <div className="task-sidebar-toolbar">
        <button type="button" className="task-new-button" onClick={onNewTask} disabled={isStreaming}>
          <Plus size={15} />
          <span>{t("workbench.newTask")}</span>
          <kbd>⌘ N</kbd>
        </button>
        <label className="task-search">
          <Search size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("workbench.searchTasks")}
            aria-label={t("workbench.searchTasks")}
          />
        </label>
      </div>

      <div className="task-list" role="list" aria-label={t("workbench.recent")}>
        <div className="task-list-label">{t("workbench.recent")}</div>
        {deleteError && <div className="task-list-error" role="alert">{deleteError}</div>}
        {filteredConversations.length === 0 ? (
          <div className="task-list-empty">{query ? t("workbench.noTaskResults") : t("chat.noHistory")}</div>
        ) : (
          filteredConversations.map((conversation) => {
            const title = getConversationTitle(conversation, t("chat.untitledConversation"));
            const busy = loadingId === conversation.id || deletingId === conversation.id;
            return (
              <div
                className={`task-list-item${conversation.id === currentConversationId ? " active" : ""}`}
                key={conversation.id}
                role="listitem"
              >
                <button
                  type="button"
                  className="task-list-item-main"
                  onClick={() => void onLoadConversation(conversation.id)}
                  disabled={isStreaming || busy}
                  aria-current={conversation.id === currentConversationId ? "page" : undefined}
                >
                  <span className="task-list-item-title">
                    <strong>{title}</strong>
                    <time>{formatRelativeTime(conversation.updatedAt, locale)}</time>
                  </span>
                  <span className="task-list-item-preview">
                    {conversation.preview || t("chat.messageCount", { count: conversation.messageCount })}
                  </span>
                  <span className="task-list-item-meta">
                    {t(`chat.taskStatus.${conversation.status || "completed"}`)}
                    {conversation.summary?.changedFiles.length
                      ? ` · ${t("chat.summaryFiles", { count: conversation.summary.changedFiles.length })}`
                      : ` · ${t("chat.messageCount", { count: conversation.messageCount })}`}
                  </span>
                </button>
                <button
                  type="button"
                  className="task-list-item-delete"
                  onClick={() => handleDeleteConversation(conversation, title)}
                  disabled={isStreaming || Boolean(deletingId)}
                  title={t("chat.deleteConversation")}
                  aria-label={t("chat.deleteConversationNamed", { title })}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })
        )}
      </div>

      <footer className="task-sidebar-footer">
        <div className="task-context-row">
          <span>{t("workbench.currentContext")}</span>
          <strong>{Math.round(contextPercent)}%</strong>
        </div>
        <div className="task-context-meter" role="progressbar" aria-label={t("workbench.currentContext")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(contextPercent)}>
          <span style={{ width: `${contextPercent}%` }} />
        </div>
      </footer>
      <ActionConfirmDialog
        intent={confirmIntent}
        busy={deletingId !== null}
        error={deleteError}
        onClose={() => { setConfirmIntent(null); setPendingDelete(null); setDeleteError(null); }}
        onConfirm={() => executeDeleteConversation()}
      />
    </aside>
  );
};
