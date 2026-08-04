import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import {
  ChatMessage,
  ConversationSummary,
  AgentMode,
  ConversationRunSummary,
  ReviewFinding,
  FileUpdate,
  SelectionInfo,
  ContextState,
  McpState,
  KnowledgeState,
  AgentRunState,
  AgentRunSummary,
  ToolApprovalRequest,
  ToolApprovalDecision,
} from "../types";
import {
  Send,
  Copy,
  ArrowDownToLine,
  TextSelect,
  ChevronRight,
  Plus,
  RefreshCw,
  Square,
  Sparkles,
  Activity,
  ArchiveRestore,
  GitFork,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { ContextStrip } from "./ContextStrip";
import { TaskHeader } from "./TaskHeader";
import { ToolCallStep } from "./ToolCallStep";
import { useI18n } from "../i18n";
import { renderChatTextPart } from "../plugins/runtime";
import { ToolApprovalCard } from "./ToolApprovalCard";
import { ChangeSummary } from "./ChangeSummary";

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to textarea fallback
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

interface ChatPanelProps {
  token: string;
  isolatedWindow: boolean;
  messages: ChatMessage[];
  currentConversationId: string | null;
  conversations: ConversationSummary[];
  isStreaming: boolean;
  activeRequestIds?: string[];
  connected: boolean;
  visible: boolean;
  focusRequest?: number;
  agentMode: AgentMode;
  taskTitle: string;
  onAgentModeChange: (mode: AgentMode) => void;
  currentRunSummary: ConversationRunSummary | null;
  contextState: ContextState;
  mcpState: McpState;
  knowledgeState: KnowledgeState;
  historyRequest?: number;
  newConversationRequest?: number;
  onOpenSettings: () => void;
  onOpenFile: (path: string) => void;
  onOpenDiff: (path: string) => void;
  onOpenReviewFinding: (finding: ReviewFinding) => void;
  historyLoading: boolean;
  historyLoadingId: string | null;
  historyError: string | null;
  selectionInfo: SelectionInfo | null;
  activeFileName: string | null;
  onSend: (message: string) => void;
  onSteer: (message: string) => void;
  onStop: () => void;
  onClear: () => void;
  onRetry: () => void;
  onLoadConversation: (conversationId: string) => Promise<void> | void;
  onForkConversation: (conversationId: string, upToTimestamp?: number) => Promise<ConversationSummary>;
  onRefreshConversations: () => Promise<void> | void;
  runState: AgentRunState | null;
  runHistory: AgentRunSummary[];
  runHistoryLoading: boolean;
  runHistoryError: string | null;
  onLoadRun: (runId: string) => Promise<void> | void;
  onResumeRun: (conversationId: string, runId?: string) => Promise<void> | void;
  onRevertRun: (runId: string) => Promise<void>;
  onApplyCode: (code: string) => void;
  onNavigateToFileUpdate: (update: FileUpdate) => void;
  pendingApprovals: ToolApprovalRequest[];
  onToolApproval: (approvalId: string, decision: ToolApprovalDecision) => void;
  onApproveConversationTools: (conversationId: string) => void;
  style?: React.CSSProperties;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({
  token,
  isolatedWindow,
  messages,
  currentConversationId,
  conversations,
  isStreaming,
  activeRequestIds,
  connected,
  visible,
  focusRequest,
  agentMode,
  taskTitle,
  onAgentModeChange,
  currentRunSummary,
  contextState,
  mcpState,
  knowledgeState,
  historyRequest,
  newConversationRequest,
  onOpenSettings,
  onOpenFile,
  onOpenDiff,
  onOpenReviewFinding,
  historyLoading,
  historyLoadingId,
  historyError,
  selectionInfo,
  activeFileName,
  onSend,
  onSteer,
  onStop,
  onClear,
  onRetry,
  onLoadConversation,
  onForkConversation,
  onRefreshConversations,
  runState,
  runHistory,
  runHistoryLoading,
  runHistoryError,
  onLoadRun,
  onResumeRun,
  onRevertRun,
  onApplyCode,
  onNavigateToFileUpdate,
  pendingApprovals,
  onToolApproval,
  onApproveConversationTools,
  style,
}) => {
  const { locale, t } = useI18n();
  const [input, setInput] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [runTimelineOpen, setRunTimelineOpen] = useState(false);
  const [busyHistoryAction, setBusyHistoryAction] = useState<string | null>(null);
  const [detailsCollapsed, setDetailsCollapsed] = useState(true);
  const [creatingIsolatedWindow, setCreatingIsolatedWindow] = useState(false);
  const [isolatedWindowError, setIsolatedWindowError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  const handledNewConversationRef = useRef(0);
  const previousMessageCountRef = useRef(messages.length);
  const previousConversationIdRef = useRef(currentConversationId);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!visible) {
      setHistoryOpen(false);
    }
  }, [visible]);

  useEffect(() => {
    if (historyRequest) {
      setHistoryOpen(true);
      setDetailsCollapsed(false);
    }
  }, [historyRequest]);

  useEffect(() => {
    const conversationChanged =
      previousConversationIdRef.current !== currentConversationId;
    const conversationStarted =
      previousMessageCountRef.current === 0 && messages.length > 0;

    if (conversationChanged || conversationStarted) {
      setDetailsCollapsed(true);
      setHistoryOpen(false);
      setChangesOpen(false);
    }

    previousConversationIdRef.current = currentConversationId;
    previousMessageCountRef.current = messages.length;
  }, [currentConversationId, messages.length]);

  useEffect(() => {
    if (!newConversationRequest || handledNewConversationRef.current === newConversationRequest) return;
    handledNewConversationRef.current = newConversationRequest;
    if (isStreaming) return;
    onClear();
    setHistoryOpen(false);
    setChangesOpen(false);
    setDetailsCollapsed(true);
  }, [isStreaming, newConversationRequest, onClear]);

  useEffect(() => {
    if (visible && focusRequest) {
      textareaRef.current?.focus();
    }
  }, [focusRequest, visible]);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || !connected) return;
    if (isStreaming) {
      onSteer(trimmed);
    } else {
      onSend(trimmed);
    }
    setDetailsCollapsed(true);
    setHistoryOpen(false);
    setChangesOpen(false);
    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "38px";
    }
  }, [connected, input, isStreaming, onSend, onSteer]);

  const handleToggleDetails = useCallback(() => {
    setDetailsCollapsed((collapsed) => {
      const nextCollapsed = !collapsed;
      if (nextCollapsed) {
        setHistoryOpen(false);
        setChangesOpen(false);
      }
      return nextCollapsed;
    });
  }, []);

  const handleOpenIsolatedWindow = useCallback(async () => {
    if (isolatedWindow || creatingIsolatedWindow) return;
    const popup = window.open("about:blank", "_blank");
    if (!popup) {
      setIsolatedWindowError(t("chat.popupBlocked"));
      return;
    }
    setCreatingIsolatedWindow(true);
    setIsolatedWindowError(null);
    try {
      popup.document.title = t("chat.creatingIsolatedWindow");
      popup.document.body.textContent = t("chat.creatingIsolatedWindow");
      const response = await fetch("/api/chat/vibe-window", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "vibe" }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || typeof payload.session?.token !== "string") {
        throw new Error(payload.error || t("chat.failedToCreateIsolatedWindow"));
      }
      popup.name = JSON.stringify({
        type: "crownforge-vibe-session",
        token: payload.session.token,
      });
      popup.location.replace(`${window.location.origin}/?vibe=1`);
      popup.opener = null;
    } catch (error) {
      popup.close();
      setIsolatedWindowError(error instanceof Error ? error.message : t("chat.failedToCreateIsolatedWindow"));
    } finally {
      setCreatingIsolatedWindow(false);
    }
  }, [creatingIsolatedWindow, isolatedWindow, t, token]);

  const handleForkConversation = useCallback(
    async (conversationId: string, upToTimestamp?: number) => {
      if (busyHistoryAction || isStreaming) return;
      const key = `fork:${conversationId}:${upToTimestamp ?? "all"}`;
      setBusyHistoryAction(key);
      try {
        await onForkConversation(conversationId, upToTimestamp);
        setHistoryOpen(false);
      } catch {
        // The hook keeps the localized history error visible.
      } finally {
        setBusyHistoryAction(null);
      }
    },
    [busyHistoryAction, isStreaming, onForkConversation]
  );

  const handleRevertRun = useCallback(
    async (runId: string) => {
      if (busyHistoryAction || isStreaming) return;
      if (!window.confirm(t("chat.revertRunConfirm"))) return;
      setBusyHistoryAction(`revert:${runId}`);
      try {
        await onRevertRun(runId);
      } catch {
        // The hook keeps the run error visible.
      } finally {
        setBusyHistoryAction(null);
      }
    },
    [busyHistoryAction, isStreaming, onRevertRun, t]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const nativeEvent = e.nativeEvent as KeyboardEvent & {
        isComposing?: boolean;
        keyCode?: number;
      };

      if (
        isComposingRef.current ||
        nativeEvent.isComposing ||
        nativeEvent.keyCode === 229
      ) {
        return;
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInput(e.target.value);
      const el = e.target;
      el.style.height = "38px";
      el.style.height = Math.min(el.scrollHeight, 120) + "px";
    },
    []
  );

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(() => {
    isComposingRef.current = false;
  }, []);

  const selectionLineCount = selectionInfo
    ? selectionInfo.endLine - selectionInfo.startLine + 1
    : 0;
  const lineLabel = t(selectionLineCount === 1 ? "chat.line" : "chat.lines");
  const formatTimestamp = useCallback(
    (value: number) =>
      new Date(value).toLocaleString(locale === "zh-CN" ? "zh-CN" : "en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    [locale]
  );
  const activeAssistantMessage = useMemo(
    () =>
      [...messages]
        .reverse()
        .find(
          (message) =>
            message.role === "assistant" &&
            message.requestId &&
            (activeRequestIds || []).includes(message.requestId)
        ),
    [activeRequestIds, messages]
  );
  const activeTool = activeAssistantMessage?.toolCalls?.find((step) => step.result === undefined);

  if (!visible) return null;

  return (
    <div className="chat-panel panel-shell workspace-drawer" style={style} tabIndex={-1} data-workspace-drawer="chat">
      <TaskHeader
        taskTitle={taskTitle}
        connected={connected}
        currentConversationId={currentConversationId}
        isStreaming={isStreaming}
        activeToolName={activeTool?.name}
        hasMessages={messages.length > 0}
        historyOpen={historyOpen}
        changesOpen={changesOpen}
        detailsCollapsed={detailsCollapsed}
        onToggleHistory={() => setHistoryOpen((open) => !open)}
        onToggleChanges={() => setChangesOpen((open) => !open)}
        onToggleDetails={handleToggleDetails}
        onClear={onClear}
        onOpenIsolatedWindow={() => void handleOpenIsolatedWindow()}
        creatingIsolatedWindow={creatingIsolatedWindow}
        isolatedWindow={isolatedWindow}
      />
      {isolatedWindowError && <div className="workbench-panel-error" role="alert">{isolatedWindowError}</div>}
      {isolatedWindow && <div className="vibe-window-banner"><span>{t("chat.isolatedWindowActive")}</span><code>{t("chat.isolatedWindowHint")}</code></div>}

      <div className="chat-details-region" hidden={detailsCollapsed}>
      <div className="chat-mode-switcher" role="tablist" aria-label={t("chat.modeLabel")}>
        <div className="chat-mode-switcher-heading">
          <span>{t("chat.modeLabel")}</span>
          <small>{t(`chat.mode.${agentMode}.hint`)}</small>
        </div>
        {(["ask", "plan", "code", "review"] as AgentMode[]).map((mode) => (
          <button
            type="button"
            key={mode}
            role="tab"
            aria-selected={agentMode === mode}
            className={`chat-mode-btn${agentMode === mode ? " active" : ""}`}
            onClick={() => onAgentModeChange(mode)}
            disabled={isStreaming}
            title={t(`chat.mode.${mode}.hint`)}
          >
            {t(`chat.mode.${mode}.label`)}
          </button>
        ))}
      </div>

      <ContextStrip
        contextState={contextState}
        mcpState={mcpState}
        knowledgeState={knowledgeState}
        onOpenSettings={onOpenSettings}
      />

      {contextState.preview && (
        <div className="chat-context-preview">
          <div className="chat-context-preview-heading">
            <span><Sparkles size={12} /> {t("chat.contextPreview")}</span>
            <code>{contextState.preview.transcriptPath}</code>
          </div>
          <div className="chat-context-preview-stats">
            <span>{t("chat.contextProtected", { count: contextState.preview.protectedMessageCount })}</span>
            <span>{t("chat.contextCompactedMessages", { count: contextState.preview.compactedMessageCount })}</span>
            <span>{t("chat.contextRecoverable")}</span>
          </div>
        </div>
      )}

      {historyOpen && (
        <div className="chat-history-panel">
          <div className="chat-history-toolbar">
            <button
              className="chat-history-toolbar-btn primary"
              onClick={() => {
                onClear();
                setHistoryOpen(false);
              }}
              disabled={isStreaming}
            >
              <Plus size={14} />
              {t("chat.newConversation")}
            </button>
            <button
              className="chat-history-toolbar-btn"
              onClick={() => void onRefreshConversations()}
              disabled={historyLoading}
            >
              <RefreshCw size={14} className={historyLoading ? "chat-spin" : ""} />
              {t("chat.refreshHistory")}
            </button>
          </div>

          {historyError && (
            <div className="chat-history-message error">{historyError}</div>
          )}

          {conversations.length === 0 && !historyLoading ? (
            <div className="chat-history-empty">{t("chat.noHistory")}</div>
          ) : (
            <div className="chat-history-list">
              {conversations.map((conversation) => (
                <div
                  key={conversation.id}
                  className={`chat-history-item${
                    conversation.id === currentConversationId ? " active" : ""
                  }`}
                >
                  <button
                    type="button"
                    className="chat-history-item-main"
                    onClick={() => {
                      void onLoadConversation(conversation.id);
                      setHistoryOpen(false);
                    }}
                    disabled={historyLoadingId === conversation.id || isStreaming || busyHistoryAction !== null}
                  >
                    <div className="chat-history-item-header">
                      <span className="chat-history-item-title">
                        {conversation.title || t("chat.untitledConversation")}
                      </span>
                      <span className="chat-history-item-time">
                        {formatTimestamp(conversation.updatedAt)}
                      </span>
                    </div>
                    <div className="chat-history-item-badges">
                      <span className={`chat-task-mode mode-${conversation.mode || "code"}`}>
                        {t(`chat.mode.${conversation.mode || "code"}.label`)}
                      </span>
                      <span className={`chat-task-status status-${conversation.status || "completed"}`}>
                        {t(`chat.taskStatus.${conversation.status || "completed"}`)}
                      </span>
                    </div>
                    {conversation.preview && (
                      <div className="chat-history-item-preview">{conversation.preview}</div>
                    )}
                    <div className="chat-history-item-meta">
                      {t("chat.messageCount", { count: conversation.messageCount })}
                    </div>
                  </button>
                  <button
                    type="button"
                    className="chat-history-item-fork"
                    onClick={() => void handleForkConversation(conversation.id)}
                    disabled={isStreaming || busyHistoryAction !== null}
                    title={t("chat.forkConversation")}
                    aria-label={t("chat.forkConversation")}
                  >
                    <GitFork size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {currentConversationId && (
            <div className="chat-run-history">
              <div className="chat-run-history-heading">
                <span><Activity size={12} /> {t("chat.runHistory")}</span>
                {runHistoryLoading && <RefreshCw size={12} className="chat-spin" />}
              </div>
              {runHistoryError && (
                <div className="chat-history-message error">{runHistoryError}</div>
              )}
              {!runHistoryLoading && runHistory.length === 0 && (
                <div className="chat-run-history-empty">{t("chat.noRunHistory")}</div>
              )}
              {runHistory.length > 0 && (
                <div className="chat-run-history-list">
                  {runHistory.slice(0, 8).map((run) => (
                    <div className="chat-run-history-item" key={run.runId}>
                      <button
                        type="button"
                        className="chat-run-history-main"
                        onClick={() => void onLoadRun(run.runId)}
                        disabled={runHistoryLoading}
                      >
                        <span className="chat-run-history-title">
                          {t(`chat.taskStatus.${run.status}`)} · {run.mode}
                        </span>
                        <span className="chat-run-history-meta">
                          {formatTimestamp(run.startedAt)} · {run.metrics.modelCalls} {t("chat.runModels")}
                        </span>
                      </button>
                      {!run.parentRunId &&
                        (run.status === "running" || run.status === "stopped" || run.status === "failed") && (
                        <button
                          type="button"
                          className="chat-run-history-resume"
                          onClick={() => void onResumeRun(run.conversationId, run.runId)}
                          disabled={isStreaming}
                          title={t("chat.resumeRun")}
                        >
                          <RotateCcw size={12} />
                        </button>
                      )}
                      {!run.parentRunId &&
                        run.mode === "code" &&
                        (run.status === "completed" || run.status === "stopped" || run.status === "failed") && (
                          <button
                            type="button"
                            className="chat-run-history-revert"
                            onClick={() => void handleRevertRun(run.runId)}
                            disabled={isStreaming || busyHistoryAction !== null}
                            title={t("chat.revertRun")}
                            aria-label={t("chat.revertRun")}
                          >
                            <ArchiveRestore size={12} className={busyHistoryAction === `revert:${run.runId}` ? "chat-spin" : ""} />
                          </button>
                        )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {isStreaming && (
        <div className="chat-run-status">
          <span className="chat-run-status-dot" />
          <div className="chat-run-status-copy">
            <strong>{t("chat.runInProgress")}</strong>
            <span>
              {activeTool
                ? t("chat.runCurrentTool", { tool: activeTool.name })
                : t("chat.runPreparing")}
            </span>
          </div>
          <span className="chat-run-status-count">
            {t("chat.runSteps", { count: activeAssistantMessage?.toolCalls?.length || 0 })}
          </span>
          <button
            type="button"
            className="chat-run-stop"
            onClick={onStop}
            title={t("chat.stop")}
          >
            <Square size={12} />
            <span>{t("chat.stop")}</span>
          </button>
        </div>
      )}

      {runState && !isStreaming && (
        <div className="chat-run-telemetry">
          <button
            type="button"
            className="chat-run-telemetry-header"
            onClick={() => setRunTimelineOpen((open) => !open)}
          >
            <span><Activity size={13} /> {t("chat.runTelemetry")}</span>
            <span className={`chat-summary-status${runState.status === "failed" ? " failed" : ""}`}>
              {t(`chat.taskStatus.${runState.status}`)}
            </span>
          </button>
          <div className="chat-run-telemetry-stats">
            <span>{t("chat.runDuration", { value: Math.round((runState.metrics.durationMs || 0) / 1000) })}</span>
            <span>{t("chat.runModels", { count: runState.metrics.modelCalls })}</span>
            <span>{t("chat.runTokens", { count: runState.metrics.totalTokens || runState.metrics.estimatedTokensPeak })}</span>
            {runState.metrics.estimatedCostUsd > 0 && (
              <span>{t("chat.runCost", { value: runState.metrics.estimatedCostUsd.toFixed(6) })}</span>
            )}
            <span>{t("chat.runErrors", { count: runState.metrics.toolErrors + runState.metrics.modelErrors })}</span>
          </div>
          {runTimelineOpen && (
            <div className="chat-run-timeline">
              {runState.events.slice(-10).map((event) => (
                <div className={`chat-run-timeline-event${event.isError ? " error" : ""}`} key={event.id}>
                  <span className="chat-run-timeline-dot" />
                  <div>
                    <strong>{event.label}</strong>
                    <small>
                      {formatTimestamp(event.timestamp)}
                      {event.durationMs !== undefined && ` · ${event.durationMs}ms`}
                    </small>
                    {event.detail && <p>{event.detail}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      </div>

      {!isStreaming && currentRunSummary && (
        <ChangeSummary
          summary={currentRunSummary}
          expanded={changesOpen}
          onToggle={() => setChangesOpen((open) => !open)}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
          onOpenLocation={onOpenReviewFinding}
          onRetry={onRetry}
        />
      )}

      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-empty-state">
            <div className="chat-empty-icon"><Sparkles size={18} /></div>
            <strong>{t("chat.emptyPrimary")}</strong>
            <span>{t("chat.emptySecondary")}</span>
          </div>
        )}
        {messages.map((msg, idx) => (
          <MessageItem
            key={`${msg.requestId || "msg"}-${idx}`}
            message={msg}
            isLast={idx === messages.length - 1}
            isStreaming={
              msg.role === "assistant" &&
              !!msg.requestId &&
              (activeRequestIds || []).includes(msg.requestId)
            }
            onApplyCode={onApplyCode}
            onNavigateToFileUpdate={onNavigateToFileUpdate}
            onFork={currentConversationId && !isStreaming
              ? () => void handleForkConversation(currentConversationId, msg.timestamp)
              : undefined}
            forking={busyHistoryAction === `fork:${currentConversationId}:${msg.timestamp}`}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {pendingApprovals.length > 0 && (
        <div className="tool-approval-stack">
          {pendingApprovals[0].conversationId && pendingApprovals[0].name !== "submit_plan" && (
            <div className="tool-approval-bulk">
              <span>{t("chat.approval.pendingCount", { count: pendingApprovals.length })}</span>
              <button
                type="button"
                onClick={() => onApproveConversationTools(pendingApprovals[0].conversationId!)}
              >
                <ShieldCheck size={14} />
                {t("chat.approval.allowConversation")}
              </button>
            </div>
          )}
          {pendingApprovals.map((request) => (
            <ToolApprovalCard key={request.approvalId} request={request} onRespond={onToolApproval} />
          ))}
        </div>
      )}

      <div className="chat-input-area">
        <div className="chat-composer-context">
          <div className="chat-composer-modes" role="tablist" aria-label={t("chat.modeLabel")}>
            {(["ask", "plan", "code", "review"] as AgentMode[]).map((mode) => (
              <button
                type="button"
                role="tab"
                aria-selected={agentMode === mode}
                className={agentMode === mode ? "active" : ""}
                onClick={() => onAgentModeChange(mode)}
                disabled={isStreaming}
                key={mode}
              >
                {t(`chat.mode.${mode}.label`)}
              </button>
            ))}
          </div>
          {activeFileName && <code>{activeFileName}</code>}
        </div>
        {/* Selection indicator */}
        {selectionInfo && activeFileName && (
          <div className="chat-selection-badge">
            <TextSelect size={13} />
            <span>
              {activeFileName} : L{selectionInfo.startLine}
              {selectionInfo.endLine !== selectionInfo.startLine &&
                `-L${selectionInfo.endLine}`}{" "}
              ({selectionLineCount} {lineLabel})
            </span>
          </div>
        )}
        <div className="chat-input-wrapper">
          <textarea
            ref={textareaRef}
            className="chat-input"
            placeholder={
              selectionInfo
                ? t("chat.askSelectedCode")
                : messages.length === 0
                  ? t("workbench.describeTask")
                  : t("workbench.followUpTask")
            }
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            rows={1}
          />
          <button
            className="chat-send-btn"
            onClick={handleSend}
            disabled={!input.trim() || !connected}
            title={isStreaming ? t("chat.correct") : t("chat.sendShortcut")}
          >
            <Send size={16} />
          </button>
          <button
            className="chat-stop-btn"
            onClick={onStop}
            disabled={!isStreaming || !connected}
            title={t("chat.stop")}
          >
            <Square size={14} />
          </button>
        </div>
      </div>
    </div>
  );
};

// --- Message rendering with code block extraction ---

interface MessageItemProps {
  message: ChatMessage;
  isLast: boolean;
  isStreaming: boolean;
  onApplyCode: (code: string) => void;
  onNavigateToFileUpdate: (update: FileUpdate) => void;
  onFork?: () => void;
  forking?: boolean;
}

const MessageItem: React.FC<MessageItemProps> = ({
  message,
  isStreaming,
  onApplyCode,
  onNavigateToFileUpdate,
  onFork,
  forking,
}) => {
  const { t } = useI18n();
  const parts = useMemo(
    () => parseContent(message.content),
    [message.content]
  );

  const hasToolCalls = message.toolCalls && message.toolCalls.length > 0;
  const hasThinking = !!message.thinking;
  const hasContent = message.content.length > 0;
  const showCursor = isStreaming && !hasToolCalls;

  return (
    <div className={`chat-message ${message.role}`}>
      <div className="chat-message-header">
        <span className="chat-message-label">
          {message.role === "user" ? t("chat.you") : t("chat.ai")}
        </span>
        {onFork && (
          <button type="button" className="chat-message-fork" onClick={onFork} title={t("chat.forkFromHere")} aria-label={t("chat.forkFromHere")}>
            <GitFork size={11} className={forking ? "chat-spin" : ""} />
            <span>{t("chat.fork")}</span>
          </button>
        )}
      </div>

      {/* Thinking text (collapsible) */}
      {hasThinking && (
        <ThinkingBlock content={message.thinking!} />
      )}

      {/* Tool call steps */}
      {hasToolCalls &&
        message.toolCalls!.map((step, i) => (
          <ToolCallStep
            key={step.toolCallId || i}
            step={step}
            onNavigateToFileUpdate={onNavigateToFileUpdate}
          />
        ))}

      {/* Final content */}
      {(hasContent || showCursor) && (
        <div
          className={`chat-message-content${showCursor ? " streaming-cursor" : ""}`}
        >
          {parts.map((part, i) =>
            part.type === "code" ? (
              <CodeBlock
                key={i}
                language={part.language}
                code={part.content}
                onApply={onApplyCode}
              />
            ) : (
              <React.Fragment key={i}>
                {renderChatTextPart(part.content, message)}
              </React.Fragment>
            )
          )}
        </div>
      )}
    </div>
  );
};

const ThinkingBlock: React.FC<{ content: string }> = ({ content }) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const preview = useMemo(() => {
    const first = content.split("\n")[0];
    return first.length > 60 ? first.slice(0, 60) + "..." : first;
  }, [content]);

  return (
    <div className="chat-thinking-block">
      <div
        className="chat-thinking-header"
        onClick={() => setExpanded((v) => !v)}
      >
        <ChevronRight
          size={14}
          className={`chat-thinking-chevron${expanded ? " expanded" : ""}`}
        />
        <span className="chat-thinking-label">{t("chat.thinking")}</span>
        {!expanded && <span className="chat-thinking-preview">{preview}</span>}
      </div>
      {expanded && (
        <div className="chat-thinking-body">{content}</div>
      )}
    </div>
  );
};

interface CodeBlockProps {
  language: string;
  code: string;
  onApply: (code: string) => void;
}

const CodeBlock: React.FC<CodeBlockProps> = ({ language, code, onApply }) => {
  const { t } = useI18n();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle"
  );

  const handleCopy = useCallback(async () => {
    const copied = await copyTextToClipboard(code);
    setCopyState(copied ? "copied" : "failed");
    window.setTimeout(() => setCopyState("idle"), 1600);
  }, [code]);

  return (
    <div className="chat-code-block">
      <div className="chat-code-header">
        <span>{language || "code"}</span>
        <div className="chat-code-actions">
          <button className="chat-code-btn" onClick={handleCopy} title={t("chat.copy")}>
            <Copy size={12} style={{ marginRight: 3 }} />
            {copyState === "copied"
              ? t("chat.copied")
              : copyState === "failed"
              ? t("chat.retry")
              : t("chat.copy")}
          </button>
          <button
            className="chat-code-btn"
            onClick={() => onApply(code)}
            title={t("chat.applyToEditor")}
          >
            <ArrowDownToLine size={12} style={{ marginRight: 3 }} />
            {t("chat.apply")}
          </button>
        </div>
      </div>
      <div className="chat-code-body">{code}</div>
    </div>
  );
};

// Parse message content into text and code blocks
interface ContentPart {
  type: "text" | "code";
  content: string;
  language: string;
}

function parseContent(content: string): ContentPart[] {
  const parts: ContentPart[] = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({
        type: "text",
        content: content.slice(lastIndex, match.index),
        language: "",
      });
    }
    parts.push({
      type: "code",
      content: match[2],
      language: match[1] || "plaintext",
    });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    parts.push({
      type: "text",
      content: content.slice(lastIndex),
      language: "",
    });
  }

  return parts.length ? parts : [{ type: "text", content, language: "" }];
}
