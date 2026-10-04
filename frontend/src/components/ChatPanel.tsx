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
  CollaborationState,
  ContextReference,
  FileNode,
} from "../types";
import {
  Copy,
  ArrowDownToLine,
  ArrowUp,
  Bug,
  Code2,
  TestTube2,
  TextSelect,
  Plus,
  Square,
  Sparkles,
  GitFork,
  GitCompare,
  RotateCcw,
  Trash2,
  X,
  Layers,
  History,
  AtSign,
  AlertCircle,
} from "lucide-react";
import "./ChatPanel.css";
import "./ExecutionFactsCard.css";
import { ExecutionFactsCard } from "./ExecutionFactsCard";
import { BrandMark } from "./BrandMark";
import { ContextInspector } from "./ContextInspector";
import { TaskHeader } from "./TaskHeader";
import { ToolCallStep } from "./ToolCallStep";
import { useI18n } from "../i18n";
import { renderChatTextPart } from "../plugins/runtime";
import { ToolApprovalStack } from "./ToolApprovalStack";
import { approvalTaskAction } from "../utils/toolApprovalPolicy";
import { AgentQuestionStack } from "./AgentQuestionStack";
import { inlineInstructionLabel } from "../editor/inlineAssistantPolicy";
import { UndoTurnButton } from "./UndoTurnButton";
import type { RunReviewComment } from "./RunChangesReview";
import { ChangeSummary } from "./ChangeSummary";
import { TaskStateStrip, type TaskStateTone } from "./TaskStateStrip";
import { MessageAttachments, type ChatAttachmentDraftController } from "./ChatAttachmentPicker";
import { ActionConfirmDialog, type ActionConfirmIntent } from "./ActionConfirmDialog";
import { ModelSelector } from "./ModelSelector";
import { WorkbenchSelect } from "./WorkbenchSelect";
import type { ContextManifestController } from "../hooks/useContextManifest";
import type { ChatRuntimeOptions, AiHealthInfo } from "../hooks/useChat";
import { CHAT_EMPTY_QUICK_PROMPTS, type WorkbenchQuickPromptId } from "./workbenchQuickPrompts";
import { ContextReferencePicker, ContextReferenceBadges } from "./ContextReferencePicker";
import { AssistantActivity, AssistantReasoning } from "./AssistantActivity";
import { assistantToolStatus } from "../utils/assistantActivity";
import { useModalDialogFocus } from "./useModalDialogFocus";
import { runFailureNotice, type RunFailureNotice } from "../utils/runFailureNotice";

type ChatConfirmAction =
  | { kind: "delete"; conversation: ConversationSummary }
  | { kind: "revert"; runId: string; legacyFullRestore?: boolean };

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


function quickPromptIcon(id: WorkbenchQuickPromptId): React.ReactNode {
  switch (id) {
    case "inspect":
      return <Sparkles size={13} aria-hidden="true" />;
    case "plan":
      return <Code2 size={13} aria-hidden="true" />;
    case "fix":
      return <Bug size={13} aria-hidden="true" />;
    case "test":
      return <TestTube2 size={13} aria-hidden="true" />;
  }
}

interface ChatPanelProps {
  token: string;
  workspaceDir: string;
  referenceFiles: FileNode[];
  contextReferences: ContextReference[];
  onContextReferencesChange: (references: ContextReference[]) => void;
  isolatedWindow: boolean;
  messages: ChatMessage[];
  currentConversationId: string | null;
  conversations: ConversationSummary[];
  isStreaming: boolean;
  activeRequestIds?: string[];
  connected: boolean;
  aiHealth?: AiHealthInfo;
  visible: boolean;
  focusRequest?: number;
  agentMode: AgentMode;
  runtimeOptions: ChatRuntimeOptions;
  selectedModelName: string;
  draftText: string;
  onDraftTextChange: (value: string) => void;
  attachmentDraft: ChatAttachmentDraftController;
  attachmentWarning: string | null;
  attachmentDeliveryChecking: boolean;
  onRecheckAttachmentDelivery: () => void;
  attachmentSubmissionError: string | null;
  attachmentSubmissionNotice: string | null;
  taskTitle: string;
  onAgentModeChange: (mode: AgentMode) => void;
  onModelNameChange: (modelName: string) => void;
  currentRunSummary: ConversationRunSummary | null;
  contextState: ContextState;
  contextManifest: ContextManifestController;
  contextReadOnly: boolean;
  mcpState: McpState;
  knowledgeState: KnowledgeState;
  historyRequest?: number;
  newConversationRequest?: number;
  onOpenSettings: () => void;
  collaboration?: CollaborationState | null;
  activeFilePath?: string | null;
  onOpenCollaboration?: () => void;
  onOpenFile: (path: string) => void;
  onOpenDiff: (path: string, runId?: string) => void;
  theme?: "light" | "dark";
  onReviewComment?: (comment: RunReviewComment) => void;
  onChangesApplied?: () => void;
  onUndoLastTurn?: () => Promise<void>;
  onOpenReviewFinding: (finding: ReviewFinding) => void;
  historyLoading: boolean;
  historyLoadingId: string | null;
  historyError: string | null;
  selectionInfo: SelectionInfo | null;
  activeFileName: string | null;
  onSend: (message: string, references?: ContextReference[]) => boolean;
  onSteer: (message: string, references?: ContextReference[]) => boolean;
  onStop: () => void;
  onClear: () => void;
  onRetry: () => void;
  onLoadConversation: (conversationId: string) => Promise<void> | void;
  onDeleteConversation: (conversationId: string) => Promise<void> | void;
  onForkConversation: (conversationId: string, upToTimestamp?: number) => Promise<ConversationSummary>;
  onRefreshConversations: () => Promise<void> | void;
  runState: AgentRunState | null;
  runHistory: AgentRunSummary[];
  runHistoryLoading: boolean;
  runHistoryError: string | null;
  onLoadRun: (runId: string) => Promise<void> | void;
  onResumeRun: (conversationId: string, runId?: string) => Promise<void> | void;
  onRevertRun: (runId: string, options?: { legacyFullRestore?: boolean }) => Promise<unknown>;
  onApplyCode: (code: string) => void;
  onNavigateToFileUpdate: (update: FileUpdate) => void;
  pendingApprovals: ToolApprovalRequest[];
  onToolApproval: (approvalId: string, decision: ToolApprovalDecision) => void;
  onApproveConversationTools: (conversationId: string) => void;
  onPlanAmendmentDecision: (planId: string, amendmentId: string, decision: "approved" | "rejected") => Promise<void> | void;
  style?: React.CSSProperties;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({
  token,
  workspaceDir,
  referenceFiles,
  contextReferences,
  onContextReferencesChange,
  isolatedWindow,
  messages,
  currentConversationId,
  conversations,
  isStreaming,
  activeRequestIds,
  connected,
  aiHealth,
  visible,
  focusRequest,
  agentMode,
  runtimeOptions,
  selectedModelName,
  draftText,
  onDraftTextChange,
  attachmentDraft,
  attachmentWarning,
  attachmentDeliveryChecking,
  onRecheckAttachmentDelivery,
  attachmentSubmissionError,
  attachmentSubmissionNotice,
  taskTitle,
  onAgentModeChange,
  onModelNameChange,
  currentRunSummary,
  contextState,
  contextManifest,
  contextReadOnly,
  mcpState,
  knowledgeState,
  historyRequest,
  newConversationRequest,
  activeFilePath,
  onOpenFile,
  onOpenDiff,
  theme,
  onReviewComment,
  onChangesApplied,
  onUndoLastTurn,
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
  onDeleteConversation,
  onForkConversation,
  runState,
  onResumeRun,
  onRevertRun,
  onApplyCode,
  onNavigateToFileUpdate,
  pendingApprovals,
  onToolApproval,
  onApproveConversationTools,
  onPlanAmendmentDecision,
  style,
}) => {
  const { locale, t } = useI18n();
  const modeModelName = runtimeOptions.modeModels[agentMode]
    || runtimeOptions.defaultModelName
    || t("workbench.modelDefault");
  const input = draftText;
  const setInput = onDraftTextChange;
  const contextPercent = Math.min(
    100,
    Math.max(0, (contextState.estimatedTokens / Math.max(contextState.threshold, 1)) * 100)
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [contextInspectorOpen, setContextInspectorOpen] = useState(false);
  const [contextPopoverOpen, setContextPopoverOpen] = useState(false);
  const [busyHistoryAction, setBusyHistoryAction] = useState<string | null>(null);
  const [detailsCollapsed, setDetailsCollapsed] = useState(true);
  const [creatingIsolatedWindow, setCreatingIsolatedWindow] = useState(false);
  const [isolatedWindowError, setIsolatedWindowError] = useState<string | null>(null);
  const [confirmIntent, setConfirmIntent] = useState<ActionConfirmIntent | null>(null);
  const [confirmAction, setConfirmAction] = useState<ChatConfirmAction | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const approvalStackRef = useRef<HTMLElement>(null);
  const contextDrawerCloseRef = useRef<HTMLButtonElement>(null);
  const historyDrawerCloseRef = useRef<HTMLButtonElement>(null);
  const contextContainerRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);
  const handledNewConversationRef = useRef(0);
  const previousMessageCountRef = useRef(messages.length);
  const previousConversationIdRef = useRef(currentConversationId);

  useEffect(() => {
    if (!input && textareaRef.current) {
      textareaRef.current.style.height = "48px";
    }
  }, [input]);

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

  const contextDrawerRef = useModalDialogFocus<HTMLElement>({
    open: contextInspectorOpen,
    onClose: () => setContextInspectorOpen(false),
    initialFocusRef: contextDrawerCloseRef,
  });
  const historyDrawerRef = useModalDialogFocus<HTMLElement>({
    open: historyOpen,
    onClose: () => setHistoryOpen(false),
    initialFocusRef: historyDrawerCloseRef,
  });

  useEffect(() => {
    if (!contextPopoverOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (contextContainerRef.current && !contextContainerRef.current.contains(e.target as Node)) {
        setContextPopoverOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setContextPopoverOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextPopoverOpen]);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!connected) return;
    let sent = false;
    if (isStreaming) {
      if (!trimmed || attachmentDeliveryChecking) return;
      sent = onSteer(trimmed, contextReferences);
    } else {
      if ((!trimmed && attachmentDraft.readyRefs.length === 0) || attachmentDraft.blocked || attachmentWarning) return;
      sent = onSend(trimmed, contextReferences);
    }
    if (!sent) return;
    onContextReferencesChange([]);
    setDetailsCollapsed(true);
    setHistoryOpen(false);
    setChangesOpen(false);
    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "48px";
    }
  }, [attachmentDeliveryChecking, attachmentDraft.blocked, attachmentDraft.readyRefs.length, attachmentWarning, connected, contextReferences, input, isStreaming, onContextReferencesChange, onSend, onSteer, setInput]);

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

  const handleDeleteConversation = useCallback(
    (conversation: ConversationSummary) => {
      if (busyHistoryAction || isStreaming) return;
      const title = conversation.title || t("chat.untitledConversation");
      setConfirmError(null);
      setConfirmAction({ kind: "delete", conversation });
      setConfirmIntent({ id: `delete:${conversation.id}`, title: t("chat.deleteConversation"), description: t("chat.deleteConversationConfirm", { title }), confirmLabel: t("chat.deleteConversation"), tone: "danger" });
    },
    [busyHistoryAction, isStreaming, t]
  );

  const executeConfirmedAction = useCallback(async () => {
    const action = confirmAction;
    if (!action) return;
    setBusyHistoryAction(action.kind === "delete" ? `delete:${action.conversation.id}` : `revert:${action.runId}`);
    setConfirmError(null);
    try {
      if (action.kind === "delete") await onDeleteConversation(action.conversation.id);
      else await onRevertRun(action.runId, action.legacyFullRestore ? { legacyFullRestore: true } : undefined);
      setConfirmIntent(null);
      setConfirmAction(null);
    } catch (error) {
      if (action.kind === "revert" && !action.legacyFullRestore && (error as { legacyFullRestoreRequired?: boolean }).legacyFullRestoreRequired) {
        setConfirmAction({ ...action, legacyFullRestore: true });
        setConfirmIntent((current) => current ? { ...current, description: t("chat.revertRunLegacyConfirm") } : current);
      } else {
        setConfirmError(error instanceof Error ? error.message : t(action.kind === "delete" ? "chat.deleteConversationFailed" : "chat.revertRunFailed"));
      }
    } finally {
      setBusyHistoryAction(null);
    }
  }, [confirmAction, onDeleteConversation, onRevertRun, t]);

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
      el.style.height = "auto";
      el.style.height = `${Math.max(48, Math.min(el.scrollHeight, 240))}px`;
    },
    [setInput]
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
  const runStatus = isStreaming ? "running" : runState?.status || "queued";
  const runTone: TaskStateTone = pendingApprovals.length ? "warning" : runStatus === "running" || runStatus === "queued" ? "running" : runStatus === "completed" ? "success" : runStatus === "failed" ? "danger" : "warning";
  const evidenceCount = (currentRunSummary?.changedFiles.length || 0) + (currentRunSummary?.completionEvidence?.ledger.verification.length || 0) + (currentRunSummary?.reviewFindings?.length || 0);
  const hasRecoveryAction = runState?.status === "failed" || runState?.status === "stopped";
  const failureNotice = runFailureNotice(runState, currentRunSummary);
  const taskActionKind = approvalTaskAction(pendingApprovals.length > 0, isStreaming, hasRecoveryAction);
  const taskAction = taskActionKind === "approval" ? t("chat.approval.view") : taskActionKind === "stop" ? t("chat.stop") : taskActionKind === "resume" ? t("workbench.resumeRun") : currentRunSummary?.changedFiles.length ? t("chat.changes") : t("chat.focusComposer");
  const handleTaskAction = () => {
    if (taskActionKind === "approval") {
      const stack = approvalStackRef.current;
      stack?.scrollIntoView({ behavior: "smooth", block: "center" });
      window.requestAnimationFrame(() => (stack?.querySelector<HTMLElement>('button:not(:disabled)') || stack)?.focus());
      return;
    }
    if (taskActionKind === "stop") { onStop(); return; }
    if (taskActionKind === "resume" && runState) { void onResumeRun(runState.conversationId, runState.runId); return; }
    if (currentRunSummary?.changedFiles.length) { setChangesOpen(true); return; }
    textareaRef.current?.focus();
  };

  if (!visible) return null;

  return (
    <div className={`chat-panel panel-shell workspace-drawer${messages.length === 0 ? " is-empty-session" : ""}`} style={style} tabIndex={-1} data-workspace-drawer="chat">
      <TaskHeader
        taskTitle={taskTitle}
        connected={connected}
        aiHealth={aiHealth}
        currentConversationId={currentConversationId}
        isStreaming={isStreaming}
        activeToolName={activeTool?.name}
        hasMessages={messages.length > 0}
        historyOpen={historyOpen}
        changesOpen={changesOpen}
        changedFilesCount={currentRunSummary?.changedFiles?.length || 0}
        detailsCollapsed={detailsCollapsed}
        onToggleHistory={() => setHistoryOpen((open) => !open)}
        onToggleChanges={() => setChangesOpen((open) => !open)}
        onToggleDetails={handleToggleDetails}
        onClear={onClear}
        onOpenIsolatedWindow={() => void handleOpenIsolatedWindow()}
        creatingIsolatedWindow={creatingIsolatedWindow}
        isolatedWindow={isolatedWindow}
        executionContract={runState?.executionContract || (runState?.executionContractKind ? { kind: runState.executionContractKind, planId: runState.executionPlan?.id || runState.executionPlanId } : currentRunSummary?.executionContract || (currentRunSummary?.executionContractKind ? { kind: currentRunSummary.executionContractKind, planId: currentRunSummary.executionPlan?.id } : undefined))}
        completionEvidence={runState?.completionEvidence || currentRunSummary?.completionEvidence}
      />
      {isolatedWindowError && <div className="workbench-panel-error" role="alert">{isolatedWindowError}</div>}
      {isolatedWindow && <div className="vibe-window-banner"><span>{t("chat.isolatedWindowActive")}</span><code>{t("chat.isolatedWindowHint")}</code></div>}

      {changesOpen ? (
        <div className="chat-changes-view-container" role="region" aria-label={t("chat.changes")}>
          <div className="chat-changes-view-header">
            <div className="chat-changes-view-title">
              <GitCompare size={16} />
              <strong>{t("chat.changes")}</strong>
              <span className="chat-changes-count-pill">
                {currentRunSummary?.changedFiles?.length || 0} 个文件修改
              </span>
            </div>
            <button
              type="button"
              className="chat-changes-back-btn"
              onClick={() => setChangesOpen(false)}
            >
              返回对话
            </button>
          </div>

          <div className="chat-changes-view-content">
            {currentRunSummary && currentRunSummary.changedFiles.length > 0 ? (
              <ChangeSummary
                token={token}
                workspaceDir={workspaceDir}
                theme={theme}
                readOnly={contextReadOnly}
                onComment={onReviewComment}
                onChanged={onChangesApplied}
                runId={runState?.runId}
                summary={currentRunSummary}
                expanded={true}
                onToggle={() => setChangesOpen(false)}
                onOpenFile={onOpenFile}
                onOpenDiff={onOpenDiff}
                onOpenLocation={onOpenReviewFinding}
                onRetry={onRetry}
                onPlanAmendmentDecision={onPlanAmendmentDecision}
              />
            ) : (
              <div className="chat-changes-fullscreen-empty">
                <div className="chat-changes-empty-icon-wrap">
                  <GitCompare size={36} />
                </div>
                <strong>当前任务暂无代码变更</strong>
                <p>当 AI 助手执行代码修改、重构或生成文件后，将在此集中展示文件差异对比与改动清单。</p>
                <button
                  type="button"
                  className="chat-changes-return-action"
                  onClick={() => setChangesOpen(false)}
                >
                  返回任务对话
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="chat-conversation-view">
          {(messages.length > 0 || isStreaming || Boolean(runState)) && (
            <TaskStateStrip requested={`${t(`chat.mode.${agentMode}.label`)} · ${taskTitle}`} running={pendingApprovals.length ? t("chat.approval.waiting") : t(`chat.taskStatus.${runStatus}`)} runningTone={runTone} evidence={evidenceCount ? t("taskState.evidenceCount", { count: evidenceCount }) : t("taskState.noEvidence")} evidenceTone={evidenceCount ? "success" : "neutral"} action={taskAction} actionTone={isStreaming ? "warning" : hasRecoveryAction ? "danger" : "neutral"} onAction={handleTaskAction} actionDisabled={!connected && !currentRunSummary?.changedFiles.length} actionDisabledReason={!connected ? t("chat.offline") : undefined} compact />
          )}
          {failureNotice && <RunFailureBanner notice={failureNotice} canResume={hasRecoveryAction} t={t} />}
          {(runState || currentRunSummary) && <ExecutionFactsCard facts={runState ? runState.executionFacts || runState.summary?.executionFacts : currentRunSummary?.executionFacts} t={t} />}

          <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-empty-state">
            <div className="chat-empty-icon">
              <BrandMark size={32} />
            </div>
            <strong>{t("chat.emptyPrimary")}</strong>
            <span>{t("chat.emptySecondary")}</span>
            <div className="chat-empty-quick-prompts">
              {CHAT_EMPTY_QUICK_PROMPTS.map((prompt) => (
                <button
                  type="button"
                  className="chat-empty-quick-btn"
                  key={prompt.id}
                  onClick={() => {
                    onAgentModeChange(prompt.mode);
                    onDraftTextChange(t(prompt.promptKey));
                    textareaRef.current?.focus();
                  }}
                >
                  <div className="chat-empty-quick-icon">
                    {quickPromptIcon(prompt.id)}
                  </div>
                  <div className="chat-empty-quick-copy">
                    <strong>{t(prompt.labelKey)}</strong>
                    <span>{t(prompt.promptKey)}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((msg, idx) => (
          <MessageItem
            key={`${msg.requestId || "msg"}-${idx}`}
            token={token}
            message={msg}
            pendingApprovals={pendingApprovals}
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
        <AssistantActivity messages={messages} isStreaming={isStreaming} connected={connected} runState={runState} activeRequestIds={activeRequestIds} pendingApprovals={pendingApprovals} />

        {!isStreaming && currentRunSummary && currentRunSummary.changedFiles.length > 0 && (
          <div className="chat-changes-banner-card">
            <div className="chat-changes-banner-info">
              <GitCompare size={15} />
              <span>本次运行修改了 {currentRunSummary.changedFiles.length} 个文件</span>
            </div>
            <button
              type="button"
              className="chat-changes-banner-btn"
              onClick={() => setChangesOpen(true)}
            >
              查看文件 Diff
            </button>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <ToolApprovalStack
        ref={approvalStackRef}
        requests={pendingApprovals}
        onRespond={onToolApproval}
        onApproveConversation={onApproveConversationTools}
        onRequestRevision={(request, instruction) => {
          const sent = onSteer(`${t("planCard.revisionPrompt")}\n${instruction}`);
          if (sent) onToolApproval(request.approvalId, "deny");
          return sent;
        }}
      />
      <AgentQuestionStack token={token} conversationId={currentConversationId} />
      <UndoTurnButton onUndo={onUndoLastTurn} disabled={isStreaming || contextReadOnly} />

      <div className="chat-input-area">
        <div className="chat-composer-box">
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

          <textarea
            ref={textareaRef}
            className="chat-input"
            placeholder={
              selectionInfo
                ? t("chat.askSelectedCode")
                : messages.length === 0
                  ? `${t("workbench.describeTask")} (键入 @ 引用上下文)`
                  : `${t("workbench.followUpTask")} (键入 @ 引用上下文)`
            }
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            rows={2}
          />

          <ContextReferencePicker token={token} workspaceDir={workspaceDir} files={referenceFiles} references={contextReferences} onChange={onContextReferencesChange} value={input} onValueChange={setInput} textareaRef={textareaRef} activeFilePath={activeFilePath} selectionInfo={selectionInfo} />

          <input
            ref={fileInputRef}
            className="sr-only"
            type="file"
            accept="image/*,application/pdf,text/*,.txt,.md,.py,.js,.jsx,.ts,.tsx,.json,.yaml,.yml,.toml,.css,.html,.sh,.rs,.go,.java,.c,.cpp"
            multiple
            aria-label={t("chat.attachFiles")}
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files || []);
              if (files.length) attachmentDraft.add(files);
              event.currentTarget.value = "";
            }}
          />

          {attachmentDraft.attachments.length > 0 && (
            <div className="chat-composer-attachment-drafts">
              {attachmentDraft.attachments.map((attachment) => (
                <div className={`chat-draft-chip status-${attachment.status}`} key={attachment.localId}>
                  <span title={attachment.name}>{attachment.name}</span>
                  {attachment.status === "error" && (
                    <button
                      type="button"
                      disabled={isStreaming || !connected}
                      onClick={() => attachmentDraft.retry(attachment.localId)}
                      title={t("chat.attachmentRetry")}
                    >
                      <RotateCcw size={10} aria-hidden="true" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => attachmentDraft.remove(attachment.localId)}
                    title={t("chat.attachmentRemove")}
                  >
                    <Trash2 size={10} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {(attachmentWarning || attachmentSubmissionError || attachmentSubmissionNotice) && (
            <div className="chat-composer-attachment-notice" role="alert">
              <span>{attachmentWarning || attachmentSubmissionError || attachmentSubmissionNotice}</span>
              {attachmentDeliveryChecking && onRecheckAttachmentDelivery && (
                <button
                  type="button"
                  className="chat-recheck-btn"
                  onClick={onRecheckAttachmentDelivery}
                  disabled={!connected}
                >
                  <RotateCcw size={10} aria-hidden="true" />
                </button>
              )}
            </div>
          )}

          <div className="chat-composer-controls">
            <div className="chat-composer-left">
              <button
                type="button"
                className="chat-composer-plus-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={isStreaming || !connected}
                title={t("chat.attachFiles")}
                aria-label={t("chat.attachFiles")}
              >
                <Plus size={15} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="chat-composer-at-btn"
                onClick={() => {
                  const textarea = textareaRef.current;
                  if (textarea) {
                    const start = textarea.selectionStart ?? input.length;
                    const end = textarea.selectionEnd ?? input.length;
                    const next = input.slice(0, start) + "@" + input.slice(end);
                    setInput(next);
                    requestAnimationFrame(() => {
                      textarea.focus();
                      textarea.setSelectionRange(start + 1, start + 1);
                    });
                  }
                }}
                disabled={isStreaming || !connected}
                title="添加上下文引用 (@)"
                aria-label="添加上下文引用"
              >
                <AtSign size={14} aria-hidden="true" />
              </button>
              <div className="chat-composer-mode-select">
                <span className="sr-only">{t("workbench.workMode")}</span>
                <WorkbenchSelect
                  label={t("workbench.workMode")}
                  value={agentMode}
                  onChange={(val) => onAgentModeChange(val as AgentMode)}
                  disabled={isStreaming}
                  title={t("workbench.workMode")}
                  options={(["ask", "plan", "code", "review"] as AgentMode[]).map((mode) => ({
                    value: mode,
                    label: t(`chat.mode.${mode}.label`),
                  }))}
                />
              </div>
            </div>

            <div className="chat-composer-right">
              <div
                ref={contextContainerRef}
                className="chat-composer-context-container"
              >
                <button
                  type="button"
                  className={`chat-composer-context-ring-btn${contextPopoverOpen ? " active" : ""}`}
                  role="progressbar"
                  aria-label={`${t("workbench.currentContext")}: ${Math.round(contextPercent)}%`}
                  aria-valuenow={Math.round(contextPercent)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  onClick={() => setContextPopoverOpen((open) => !open)}
                  title={`${t("workbench.currentContext")}: ${contextState.estimatedTokens.toLocaleString()} / ${contextState.threshold.toLocaleString()} tokens (${Math.round(contextPercent)}%)`}
                >
                  <svg width="18" height="18" viewBox="0 0 20 20" className="chat-context-svg" aria-hidden="true">
                    <circle
                      cx="10"
                      cy="10"
                      r="7.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      className="chat-context-ring-bg"
                    />
                    <circle
                      cx="10"
                      cy="10"
                      r="7.5"
                      fill="none"
                      stroke={contextPercent > 90 ? "var(--danger)" : contextPercent > 75 ? "var(--warning)" : "var(--accent)"}
                      strokeWidth="2.4"
                      strokeDasharray="47.12"
                      strokeDashoffset={47.12 * (1 - contextPercent / 100)}
                      strokeLinecap="round"
                      transform="rotate(-90 10 10)"
                      className="chat-context-ring-val"
                    />
                  </svg>
                  <span className="chat-context-percent-text">{Math.round(contextPercent)}%</span>
                </button>

                {contextPopoverOpen && (
                  <div className="chat-context-popover" role="tooltip">
                    <div className="chat-context-popover-head">
                      <strong>{t("workbench.currentContext")}</strong>
                      <span className="chat-context-popover-badge">{Math.round(contextPercent)}%</span>
                    </div>
                    <div className="chat-context-popover-progress">
                      <div
                        className="chat-context-popover-progress-bar"
                        style={{
                          width: `${contextPercent}%`,
                          backgroundColor: contextPercent > 90 ? "var(--danger)" : contextPercent > 75 ? "var(--warning)" : "var(--accent)"
                        }}
                      />
                    </div>
                    <div className="chat-context-popover-stats">
                      <div className="chat-context-popover-item">
                        <span>Tokens</span>
                        <strong>{contextState.estimatedTokens.toLocaleString()} / {contextState.threshold.toLocaleString()}</strong>
                      </div>
                      <div className="chat-context-popover-item">
                        <span>工作区来源</span>
                        <strong>{contextManifest.draftManifest ? `${contextManifest.draftManifest.totals.includedSources} 个来源` : contextManifest.indexState.status === "ready" ? "索引已就绪" : `状态: ${contextManifest.indexState.status}`}</strong>
                      </div>
                      <div className="chat-context-popover-item">
                        <span>MCP 工具</span>
                        <strong>{mcpState.toolCount} 个可用 ({mcpState.serverCount} 服务)</strong>
                      </div>
                      <div className="chat-context-popover-item">
                        <span>知识库</span>
                        <strong>{knowledgeState.memoryFiles} 记忆 · {knowledgeState.skillCount} 技能</strong>
                      </div>
                    </div>
                    <div className="chat-context-popover-footer">
                      <button
                        type="button"
                        className="chat-context-popover-btn"
                        onClick={() => {
                          setContextPopoverOpen(false);
                          setContextInspectorOpen(true);
                        }}
                      >
                        <Layers size={13} />
                        <span>查看来源清单</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <div className="chat-composer-model-select">
                <span className="sr-only">{t("workbench.model")}</span>
                <ModelSelector
                  value={selectedModelName}
                  onChange={onModelNameChange}
                  disabled={isStreaming || runtimeOptions.models.length === 0}
                  models={runtimeOptions.models}
                  automaticLabel={modeModelName || "自动"}
                  label={t("workbench.model")}
                />
              </div>
              {isStreaming ? (
                <button
                  type="button"
                  className="chat-composer-stop-btn"
                  onClick={onStop}
                  title={t("chat.stop")}
                  aria-label={t("chat.stop")}
                >
                  <Square size={13} />
                </button>
              ) : (
                <button
                  type="button"
                  className="chat-composer-send-btn"
                  onClick={handleSend}
                  disabled={!connected || (
                    !input.trim() && attachmentDraft.readyRefs.length === 0
                  ) || attachmentDraft.blocked || !!attachmentWarning}
                  title={t("chat.sendShortcut")}
                  aria-label={t("chat.sendShortcut")}
                >
                  <ArrowUp size={15} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )}

  {contextInspectorOpen && (
    <div className="chat-drawer-backdrop" onClick={() => setContextInspectorOpen(false)}>
      <aside ref={contextDrawerRef} className="chat-drawer chat-drawer-context" role="dialog" aria-modal="true" aria-label={t("workbench.currentContext")} onClick={(e) => e.stopPropagation()} tabIndex={-1}>
        <div className="chat-drawer-header">
          <div className="chat-drawer-title">
            <Layers size={15} />
            <strong>{t("workbench.currentContext")}</strong>
          </div>
          <button
            type="button"
            ref={contextDrawerCloseRef}
            className="chat-drawer-close"
            onClick={() => setContextInspectorOpen(false)}
            title={t("common.close")}
            aria-label={t("common.close")}
          >
            <X size={14} />
          </button>
        </div>
        <div className="chat-drawer-body">
          <ContextInspector
            manifests={contextManifest.draftManifests}
            selectedManifestId={contextManifest.draftManifest?.id}
            indexState={contextManifest.indexState}
            mode="draft"
            loading={contextManifest.loading}
            readOnly={contextReadOnly}
            preferencesDisabledReason={contextManifest.preferenceMutationsAvailable ? undefined : t("context.startConversationToChange")}
            error={contextManifest.error}
            emptyHint={t("context.noPreviewSources")}
            mutationBySource={contextManifest.mutationBySource}
            onPin={(key) => void contextManifest.pinSource(key)}
            onUnpin={(key) => void contextManifest.unpinSource(key)}
            onExclude={(key) => void contextManifest.excludeSource(key)}
            onRestore={(key) => void contextManifest.restoreSource(key)}
            onRefreshSource={(key) => void contextManifest.refreshSources([key])}
            onRefreshAll={() => void (
              contextManifest.indexState.status === "unavailable" || contextManifest.indexState.status === "error"
                ? contextManifest.rebuildIndex()
                : contextManifest.refreshSources()
            )}
            onRetry={() => void contextManifest.retryPreview()}
          />
        </div>
      </aside>
    </div>
  )}

  {historyOpen && (
    <div className="chat-drawer-backdrop" onClick={() => setHistoryOpen(false)}>
      <aside ref={historyDrawerRef} className="chat-drawer chat-drawer-history" role="dialog" aria-modal="true" aria-label={t("chat.tasks")} onClick={(e) => e.stopPropagation()} tabIndex={-1}>
        <div className="chat-drawer-header">
          <div className="chat-drawer-title">
            <History size={15} />
            <strong>{t("chat.tasks")}</strong>
          </div>
          <div className="chat-drawer-actions">
            <button
              type="button"
              className="chat-drawer-action-btn"
              onClick={() => {
                onClear();
                setHistoryOpen(false);
              }}
              disabled={isStreaming}
            >
              <Plus size={13} />
              <span>{t("chat.newConversation")}</span>
            </button>
            <button
              type="button"
              ref={historyDrawerCloseRef}
              className="chat-drawer-close"
              onClick={() => setHistoryOpen(false)}
              title={t("common.close")}
              aria-label={t("common.close")}
            >
              <X size={14} />
            </button>
          </div>
        </div>
        <div className="chat-drawer-body">
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
                  <div className="chat-history-item-actions">
                    <button
                      type="button"
                      className="chat-history-item-delete"
                      onClick={() => void handleDeleteConversation(conversation)}
                      disabled={isStreaming || busyHistoryAction !== null}
                      title={t("chat.deleteConversation")}
                      aria-label={t("chat.deleteConversationNamed", {
                        title: conversation.title || t("chat.untitledConversation"),
                      })}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  )}

  <ActionConfirmDialog
        intent={confirmIntent}
        busy={busyHistoryAction !== null}
        error={confirmError}
        onClose={() => { setConfirmIntent(null); setConfirmAction(null); setConfirmError(null); }}
        onConfirm={() => executeConfirmedAction()}
      />
    </div>
  );
};

// --- Message rendering with code block extraction ---

const RunFailureBanner: React.FC<{
  notice: RunFailureNotice;
  canResume: boolean;
  t: (key: string, values?: Record<string, string | number>) => string;
}> = ({ notice, canResume, t }) => (
  <section className="chat-run-failure-banner" role="alert" aria-live="assertive">
    <AlertCircle size={15} aria-hidden="true" />
    <div>
      <strong>
        {notice.kind === "max_iterations"
          ? t("chat.failure.maxIterations.title", { limit: notice.limit || 0 })
          : t("chat.failure.generic.title")}
      </strong>
      <span>
        {notice.kind === "max_iterations"
          ? t("chat.failure.maxIterations.body")
          : t("chat.failure.generic.body", { reason: notice.reason })}
      </span>
      <small>{t(canResume ? "chat.failure.resumeHint" : "chat.failure.noResumeHint")}</small>
    </div>
  </section>
);

interface MessageItemProps {
  token: string;
  message: ChatMessage;
  pendingApprovals: ToolApprovalRequest[];
  isLast: boolean;
  isStreaming: boolean;
  onApplyCode: (code: string) => void;
  onNavigateToFileUpdate: (update: FileUpdate) => void;
  onFork?: () => void;
  forking?: boolean;
}

const MessageItem: React.FC<MessageItemProps> = ({
  token,
  message,
  pendingApprovals,
  isStreaming,
  onApplyCode,
  onNavigateToFileUpdate,
  onFork,
  forking,
}) => {
  const { t } = useI18n();
  const parts = useMemo(
    () => parseContent(message.role === "user" ? inlineInstructionLabel(message.content) || message.content : message.content),
    [message.content, message.role]
  );

  const hasToolCalls = message.toolCalls && message.toolCalls.length > 0;
  const hasThinking = !!message.thinking;
  const hasContent = message.content.length > 0;
  const showCursor = isStreaming && !hasToolCalls;

  return (
    <div className={`chat-message ${message.role}`} role="group" aria-label={message.role === "user" ? t("chat.you") : t("chat.ai")}>
      {onFork && (
        <button type="button" className="chat-message-fork" onClick={onFork} title={t("chat.forkFromHere")} aria-label={t("chat.forkFromHere")}>
          <GitFork size={11} className={forking ? "chat-spin" : ""} />
          <span>{t("chat.fork")}</span>
        </button>
      )}

      {/* Thinking text (collapsible) */}
      {hasThinking && (
        <AssistantReasoning content={message.thinking!} active={isStreaming} />
      )}

      {/* Tool call steps */}
      {hasToolCalls &&
        message.toolCalls!.map((step, i) => (
          <div key={step.toolCallId || i} data-assistant-tool-call-id={step.toolCallId} data-status={assistantToolStatus(step, isStreaming, pendingApprovals)}>
            <ToolCallStep step={step} onNavigateToFileUpdate={onNavigateToFileUpdate} />
          </div>
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
      {message.error && (
        <div className="chat-message-error" role="alert">
          <AlertCircle size={13} aria-hidden="true" />
          <span>{t("chat.messageFailedWithReason", { reason: message.error })}</span>
        </div>
      )}
      <ContextReferenceBadges references={message.contextReferences} />
      <MessageAttachments attachments={message.attachments} token={token} />
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
