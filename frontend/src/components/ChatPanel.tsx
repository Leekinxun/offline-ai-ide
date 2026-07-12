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
  FileUpdate,
  SelectionInfo,
} from "../types";
import {
  Send,
  Trash2,
  Copy,
  ArrowDownToLine,
  TextSelect,
  ChevronRight,
  History,
  Plus,
  RefreshCw,
  Square,
  GitCompare,
  Sparkles,
} from "lucide-react";
import { ToolCallStep } from "./ToolCallStep";
import { useI18n } from "../i18n";
import { renderChatTextPart } from "../plugins/runtime";

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
  messages: ChatMessage[];
  currentConversationId: string | null;
  conversations: ConversationSummary[];
  isStreaming: boolean;
  activeRequestIds?: string[];
  connected: boolean;
  visible: boolean;
  focusRequest?: number;
  agentMode: AgentMode;
  onAgentModeChange: (mode: AgentMode) => void;
  currentRunSummary: ConversationRunSummary | null;
  onOpenFile: (path: string) => void;
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
  onRefreshConversations: () => Promise<void> | void;
  onApplyCode: (code: string) => void;
  onNavigateToFileUpdate: (update: FileUpdate) => void;
  style?: React.CSSProperties;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({
  messages,
  currentConversationId,
  conversations,
  isStreaming,
  activeRequestIds,
  connected,
  visible,
  focusRequest,
  agentMode,
  onAgentModeChange,
  currentRunSummary,
  onOpenFile,
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
  onRefreshConversations,
  onApplyCode,
  onNavigateToFileUpdate,
  style,
}) => {
  const { locale, t } = useI18n();
  const [input, setInput] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!visible) {
      setHistoryOpen(false);
    }
  }, [visible]);

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
    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "38px";
    }
  }, [connected, input, isStreaming, onSend, onSteer]);

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
    <div className="chat-panel" style={style}>
      <div className="chat-header">
        <div className="chat-header-main">
          <div className="chat-header-heading">
            <span className="chat-header-title">{t("chat.title")}</span>
            <span className={`chat-header-mode mode-${agentMode}`}>
              {t(`chat.mode.${agentMode}.label`)}
            </span>
          </div>
          {currentConversationId && (
            <span className="chat-conversation-pill">
              {t("chat.continuingConversation")}
            </span>
          )}
        </div>
        <div className="chat-header-actions">
          <div className="chat-status">
            <span
              className={`chat-status-dot${connected ? " connected" : ""}`}
            />
            {connected ? t("chat.online") : t("chat.offline")}
          </div>
          <button
            className={`sidebar-action-btn${historyOpen ? " active" : ""}`}
            title={t("chat.tasks")}
            onClick={() => setHistoryOpen((open) => !open)}
            disabled={isStreaming}
          >
            <History size={14} />
          </button>
          <button
            className={`sidebar-action-btn${changesOpen ? " active" : ""}`}
            title={t("chat.changes")}
            onClick={() => setChangesOpen((open) => !open)}
          >
            <GitCompare size={14} />
          </button>
          {messages.length > 0 && (
            <button
              className="sidebar-action-btn"
              title={t("chat.clearChat")}
              onClick={onClear}
              disabled={isStreaming}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="chat-mode-switcher" role="tablist" aria-label={t("chat.modeLabel")}>
        <div className="chat-mode-switcher-heading">
          <span>{t("chat.modeLabel")}</span>
          <small>{t(`chat.mode.${agentMode}.hint`)}</small>
        </div>
        {(["ask", "code", "review", "plan"] as AgentMode[]).map((mode) => (
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

      {changesOpen && (
        <div className="chat-changes-panel">
          <div className="chat-changes-header">
            <strong>{t("chat.changes")}</strong>
            <span>{currentRunSummary?.changedFiles.length || 0}</span>
          </div>
          {currentRunSummary?.changedFiles.length ? (
            <div className="chat-changes-list">
              {currentRunSummary.changedFiles.map((path) => (
                <button type="button" key={path} onClick={() => onOpenFile(path)}>
                  <GitCompare size={12} />
                  <code>{path}</code>
                </button>
              ))}
            </div>
          ) : (
            <div className="chat-changes-empty">{t("chat.noChanges")}</div>
          )}
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
                <button
                  key={conversation.id}
                  className={`chat-history-item${
                    conversation.id === currentConversationId ? " active" : ""
                  }`}
                  onClick={() => {
                    void onLoadConversation(conversation.id);
                    setHistoryOpen(false);
                  }}
                  disabled={historyLoadingId === conversation.id || isStreaming}
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
                    <div className="chat-history-item-preview">
                      {conversation.preview}
                    </div>
                  )}
                  <div className="chat-history-item-meta">
                    {t("chat.messageCount", {
                      count: conversation.messageCount,
                    })}
                  </div>
                </button>
              ))}
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

      {!isStreaming && currentRunSummary && (
        <div className="chat-completion-summary">
          <div className="chat-completion-summary-head">
            <strong>{t("chat.completionSummary")}</strong>
            <span className={`chat-summary-status${currentRunSummary.errorCount > 0 ? " failed" : " completed"}`}>
              {t(`chat.taskStatus.${currentRunSummary.errorCount > 0 ? "failed" : "completed"}`)}
            </span>
          </div>
          {currentRunSummary.errorCount > 0 && (
            <span className="chat-summary-warning">
              {t("chat.summaryErrors", { count: currentRunSummary.errorCount })}
            </span>
          )}
          <div className="chat-completion-summary-stats">
            <span>{t("chat.summaryFiles", { count: currentRunSummary.changedFiles.length })}</span>
            <span>{t("chat.summaryCommands", { count: currentRunSummary.commandCount })}</span>
            <span>{t("chat.summaryTools", { count: currentRunSummary.toolCallCount })}</span>
          </div>
          {currentRunSummary.changedFiles.length > 0 && (
            <div className="chat-completion-files">
              {currentRunSummary.changedFiles.slice(0, 4).map((path) => (
                <button type="button" className="chat-completion-file" key={path} onClick={() => onOpenFile(path)}>
                  <GitCompare size={11} />
                  <code>{path}</code>
                </button>
              ))}
            </div>
          )}
          {currentRunSummary.errorCount > 0 && (
            <button type="button" className="chat-summary-retry" onClick={onRetry}>
              {t("chat.retryTask")}
            </button>
          )}
        </div>
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
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-area">
        <div className="chat-composer-context">
          <span className={`chat-composer-mode mode-${agentMode}`}>
            {t(`chat.mode.${agentMode}.label`)}
          </span>
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
                : t("chat.askYourCode")
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
}

const MessageItem: React.FC<MessageItemProps> = ({
  message,
  isStreaming,
  onApplyCode,
  onNavigateToFileUpdate,
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
      <span className="chat-message-label">
        {message.role === "user" ? t("chat.you") : t("chat.ai")}
      </span>

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
