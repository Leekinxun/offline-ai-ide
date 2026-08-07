import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  Check,
  ChevronRight,
  Circle,
  FileCode2,
  Pause,
  Play,
  Plus,
  Send,
  TerminalSquare,
  X,
} from "lucide-react";
import {
  AgentMode,
  AgentRunEvent,
  AgentRunState,
  ChatMessage,
  SelectionInfo,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "../types";
import type { ChatRuntimeOptions } from "../hooks/useChat";
import { useI18n } from "../i18n";
import { renderChatTextPart } from "../plugins/runtime";
import { ToolApprovalStack } from "./ToolApprovalStack";

interface EditorAssistantPanelProps {
  visible: boolean;
  activeFilePath: string | null;
  selectionInfo: SelectionInfo | null;
  messages: ChatMessage[];
  connected: boolean;
  isStreaming: boolean;
  agentMode: AgentMode;
  runtimeOptions: ChatRuntimeOptions;
  selectedModelName: string;
  runState: AgentRunState | null;
  pendingApprovals: ToolApprovalRequest[];
  onAgentModeChange: (mode: AgentMode) => void;
  onModelNameChange: (modelName: string) => void;
  onSend: (message: string) => void;
  onSteer: (message: string) => void;
  onStop: () => void;
  onResume: (conversationId: string, runId?: string) => Promise<void> | void;
  onNewConversation: () => void;
  onToolApproval: (approvalId: string, decision: ToolApprovalDecision) => void;
  onApproveConversationTools: (conversationId: string) => void;
  onClose: () => void;
}

function getRenderableMessageContent(content: string): string {
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function EventIcon({ event }: { event: AgentRunEvent }) {
  if (event.isError || event.kind === "error") return <AlertCircle size={13} />;
  if (event.kind === "tool_call" || event.kind === "tool_result") {
    return event.toolName === "bash" ? <TerminalSquare size={13} /> : <FileCode2 size={13} />;
  }
  if (event.kind === "run_finished") return <Check size={13} />;
  return <Activity size={13} />;
}

export const EditorAssistantPanel: React.FC<EditorAssistantPanelProps> = ({
  visible,
  activeFilePath,
  selectionInfo,
  messages,
  connected,
  isStreaming,
  agentMode,
  runtimeOptions,
  selectedModelName,
  runState,
  pendingApprovals,
  onAgentModeChange,
  onModelNameChange,
  onSend,
  onSteer,
  onStop,
  onResume,
  onNewConversation,
  onToolApproval,
  onApproveConversationTools,
  onClose,
}) => {
  const { t } = useI18n();
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const followLatestMessageRef = useRef(true);
  const [now, setNow] = useState(Date.now());
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(() => new Set());
  const fileName = activeFilePath?.split("/").pop() || null;
  const visibleMessages = useMemo(
    () => messages.filter((message) => getRenderableMessageContent(message.content)),
    [messages]
  );
  const runEvents = useMemo(() => runState?.events.slice(-6) || [], [runState]);
  const modeModelName =
    runtimeOptions.modeModels[agentMode] || runtimeOptions.defaultModelName || t("workbench.modelDefault");
  const activeModelName = runState?.modelName || selectedModelName || modeModelName;

  useEffect(() => {
    if (!isStreaming) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isStreaming]);

  useEffect(() => {
    setExpandedEvents(new Set());
  }, [runState?.runId]);

  useEffect(() => {
    followLatestMessageRef.current = true;
  }, [visibleMessages[0]?.timestamp]);

  useEffect(() => {
    if (!visible || !followLatestMessageRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const container = messagesRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pendingApprovals.length, runEvents, visible, visibleMessages]);

  if (!visible) return null;

  const handleSubmit = () => {
    const message = input.trim();
    if (!message || !connected) return;
    if (isStreaming) onSteer(message);
    else onSend(message);
    setInput("");
  };

  const handleRunControl = () => {
    if (isStreaming) {
      onStop();
      return;
    }
    if (runState?.status === "stopped" || runState?.status === "failed") {
      void onResume(runState.conversationId, runState.runId);
      return;
    }
  };

  const handleNewConversation = () => {
    if (isStreaming) return;
    onNewConversation();
    setInput("");
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const runControlLabel = isStreaming
    ? t("workbench.pauseRun")
    : runState?.status === "stopped" || runState?.status === "failed"
      ? t("workbench.resumeRun")
      : t("workbench.waiting");
  const durationMs = runState
    ? (runState.endedAt || (isStreaming ? now : runState.updatedAt)) - runState.startedAt
    : 0;

  return (
    <aside className="editor-assistant-panel" aria-label={t("workbench.editorAssistant")}>
      <header className="editor-assistant-header">
        <strong>{t("workbench.editorAssistant")}</strong>
        <div className="editor-assistant-header-actions">
          <button
            type="button"
            onClick={handleNewConversation}
            disabled={isStreaming}
            title={t("chat.newConversation")}
            aria-label={t("chat.newConversation")}
          >
            <Plus size={15} />
          </button>
          <button type="button" onClick={onClose} title={t("common.close")} aria-label={t("common.close")}>
            <X size={15} />
          </button>
        </div>
      </header>

      <section className="editor-assistant-context">
        <div className="editor-assistant-control-grid">
          <label>
            <span>{t("workbench.workMode")}</span>
            <select
              value={agentMode}
              onChange={(event) => onAgentModeChange(event.target.value as AgentMode)}
              disabled={isStreaming}
            >
              {(["ask", "plan", "code", "review"] as AgentMode[]).map((mode) => (
                <option value={mode} key={mode}>{t(`chat.mode.${mode}.label`)}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("workbench.model")}</span>
            <select
              value={selectedModelName}
              onChange={(event) => onModelNameChange(event.target.value)}
              disabled={isStreaming || runtimeOptions.models.length === 0}
            >
              <option value="">{t("workbench.modelAutomatic", { model: modeModelName })}</option>
              {runtimeOptions.models.map((modelName) => (
                <option value={modelName} key={modelName}>{modelName}</option>
              ))}
            </select>
          </label>
        </div>
        <span>{t("workbench.autoAttachedContext")}</span>
        <button type="button" disabled={!activeFilePath} title={activeFilePath || t("workbench.noActiveFile")}>
          <FileCode2 size={14} />
          <strong>{activeFilePath || t("workbench.noActiveFile")}</strong>
          <small>{activeFilePath ? t("workbench.synced") : t("workbench.waiting")}</small>
        </button>
        {!isStreaming && runState && (runState.status === "failed" || runState.status === "stopped") && (
          <button
            type="button"
            className={`editor-assistant-recovery status-${runState.status}`}
            onClick={handleRunControl}
            disabled={!connected}
            title={runControlLabel}
          >
            {runState.status === "failed" ? <AlertCircle size={14} /> : <Pause size={14} />}
            <span>
              <strong>{t(`workbench.runStatus.${runState.status}`)}</strong>
              <small>{t(`chat.mode.${runState.mode}.label`)} · {activeModelName}</small>
            </span>
            <span className="editor-assistant-recovery-action"><Play size={12} />{runControlLabel}</span>
          </button>
        )}
      </section>

      <div
        className="editor-assistant-messages"
        ref={messagesRef}
        onScroll={(event) => {
          const container = event.currentTarget;
          followLatestMessageRef.current =
            container.scrollHeight - container.scrollTop - container.clientHeight < 48;
        }}
      >
        {visibleMessages.length === 0 ? (
          <article className="editor-assistant-message">
            <div className="editor-assistant-message-header"><span>CF</span><strong>CrewForge</strong></div>
            <p>{t("workbench.editorAssistantIntro")}</p>
            <small>
              {fileName
                ? t("workbench.currentFileContext", {
                    file: fileName,
                    selection: selectionInfo
                      ? t("workbench.linesSelected", {
                          start: selectionInfo.startLine,
                          end: selectionInfo.endLine,
                        })
                      : t("workbench.noSelection"),
                  })
                : t("workbench.openFileForContext")}
            </small>
          </article>
        ) : (
          visibleMessages.map((message, index) => (
            <article className={`editor-assistant-message ${message.role}`} key={`${message.timestamp}-${index}`}>
              <div className="editor-assistant-message-header">
                <span>{message.role === "user" ? t("chat.you") : "CF"}</span>
                <strong>{message.role === "user" ? t("chat.you") : "CrewForge"}</strong>
              </div>
              {message.role === "assistant" ? (
                <div className="editor-assistant-message-content">
                  {renderChatTextPart(getRenderableMessageContent(message.content), message)}
                </div>
              ) : (
                <p>{getRenderableMessageContent(message.content)}</p>
              )}
              {message.role === "user" && activeFilePath && (
                <small>{t("workbench.messageContext", {
                  path: activeFilePath,
                  mode: t(`chat.mode.${agentMode}.label`),
                  model: activeModelName,
                })}</small>
              )}
            </article>
          ))
        )}

        {isStreaming && (!runState || runState.status === "running" || runState.status === "queued") && (
          <section className={`editor-agent-run-card status-${runState?.status || "idle"}`}>
            <div className="editor-agent-run-head">
              <span className={`editor-agent-run-pulse${isStreaming ? " active" : ""}`} />
              <div>
                <strong>
                  {runState
                    ? runState.event?.label || t("workbench.runProcessingFile")
                    : t("workbench.runReady")}
                </strong>
                <small>{t(`chat.mode.${runState?.mode || agentMode}.label`)} · {activeModelName}</small>
              </div>
              <code>{formatDuration(durationMs)}</code>
              <button
                type="button"
                onClick={handleRunControl}
                disabled={!runState || !connected}
                title={runControlLabel}
              >
                <Pause size={12} />
                <span>{runControlLabel}</span>
              </button>
            </div>

            <div className="editor-agent-run-steps">
              {runEvents.length === 0 ? (
                <div className="editor-agent-run-empty">
                  <Circle size={12} />
                  <span>{t("workbench.runReadyStep")}</span>
                  <small>{t("workbench.runWaiting")}</small>
                </div>
              ) : (
                runEvents.map((event, index) => {
                  const expanded = expandedEvents.has(event.id);
                  const isCurrent = index === runEvents.length - 1;
                  const state = event.isError
                    ? t("workbench.runStepFailed")
                    : isCurrent
                      ? t("workbench.runStepRunning")
                      : t("workbench.runStepDone");
                  return (
                    <div className={`editor-agent-run-step${expanded ? " open" : ""}${event.isError ? " failed" : isCurrent ? " running" : " done"}`} key={event.id}>
                      <button
                        type="button"
                        onClick={() => setExpandedEvents((current) => {
                          const next = new Set(current);
                          if (next.has(event.id)) next.delete(event.id);
                          else next.add(event.id);
                          return next;
                        })}
                        aria-expanded={expanded}
                      >
                        <ChevronRight className="editor-agent-run-chevron" size={13} />
                        <EventIcon event={event} />
                        <span>{event.label}</span>
                        <small>{state}</small>
                      </button>
                      {expanded && (
                        <pre>{event.detail || event.toolName || t("workbench.runNoDetails")}</pre>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </section>
        )}
      </div>

      <ToolApprovalStack
        requests={pendingApprovals}
        onRespond={onToolApproval}
        onApproveConversation={onApproveConversationTools}
        className="editor-assistant-approvals"
      />

      <div className="editor-assistant-composer">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              handleSubmit();
            }
          }}
          placeholder={t(`workbench.assistantPlaceholder.${agentMode}`)}
          aria-label={t("workbench.askAboutCurrentFile")}
        />
        <div>
          <span><FileCode2 size={13} /> {fileName ? t("workbench.fileAttached", { file: fileName }) : t("workbench.noContextAttached")}</span>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!input.trim() || !connected}
            title={isStreaming ? t("chat.correct") : t("chat.send")}
            aria-label={isStreaming ? t("chat.correct") : t("chat.send")}
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </aside>
  );
};
