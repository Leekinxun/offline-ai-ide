import { useState, useRef, useCallback, useEffect } from "react";
import {
  ChatMessage,
  ChatAttachmentRef,
  ConversationSummary,
  FileContext,
  FileUpdate,
  AgentMode,
  ConversationRunSummary,
  ContextState,
  McpState,
  KnowledgeState,
  AgentRunEvent,
  AgentRunMetrics,
  AgentRunState,
  AgentRunSummary,
  ToolApprovalRequest,
  ToolApprovalDecision,
  ExecutionContract,
  ExecutionPlan,
  CompletionEvidence,
} from "../types";
import { useI18n } from "../i18n";
import { useContextManifest } from "./useContextManifest";

interface ConversationsResponse {
  conversations?: ConversationSummary[];
}

interface ConversationDetailResponse {
  id: string;
  messages?: ChatMessage[];
  mode?: AgentMode;
  status?: string;
  summary?: ConversationRunSummary;
  lastRunId?: string;
}

interface RunListResponse {
  runs?: AgentRunSummary[];
}
interface RunPayloadFields {
  executionContract?: ExecutionContract;
  executionContractKind?: ExecutionContract["kind"];
  completionEvidence?: CompletionEvidence;
  qualityGate?: AgentRunSummary["qualityGate"];
  executionPlan?: ExecutionPlan;
}

export interface ChatRuntimeOptions {
  defaultModelName: string;
  models: string[];
  modeModels: Partial<Record<AgentMode, string>>;
  modelInputCapabilities: Record<string, { supportsImageInput: boolean; supportsPdfInput: boolean }>;
}

export interface RejectedAttachmentSend {
  requestId: string;
  content: string;
  attachments: ChatAttachmentRef[];
  error: string;
  uncertain?: boolean;
}

export interface AttachmentSendReconciliation {
  requestId: string;
  content: string;
  attachments: ChatAttachmentRef[];
  status: "persisted" | "missing" | "processing" | "unavailable";
}

interface ForkConversationResponse {
  conversation?: ConversationSummary;
}

interface ChatRequestStatusResponse {
  status: "accepted" | "processing" | "unknown";
  conversationId?: string;
}

interface PendingAttachmentSend {
  content: string;
  attachments: ChatAttachmentRef[];
  conversationId: string | null;
  accepted: boolean;
}

const EMPTY_RUN_METRICS: AgentRunMetrics = {
  iterations: 0,
  modelCalls: 0,
  toolCalls: 0,
  toolErrors: 0,
  modelErrors: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  estimatedCostUsd: 0,
  estimatedTokensPeak: 0,
  compactionCount: 0,
};

const DEFAULT_AGENT_MODE: AgentMode = "code";

export function useChat(
  token: string,
  workspaceDir: string,
  onFileUpdate?: (update: FileUpdate) => void,
  onAttachmentSendRejected?: (rejected: RejectedAttachmentSend) => void,
  onAttachmentSendReconciled?: (result: AttachmentSendReconciliation) => void,
) {
  const { t } = useI18n();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeRequestIds, setActiveRequestIds] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(
    null
  );
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadingId, setHistoryLoadingId] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [agentMode, setAgentMode] = useState<AgentMode>(DEFAULT_AGENT_MODE);
  const [runtimeOptions, setRuntimeOptions] = useState<ChatRuntimeOptions>({
    defaultModelName: "",
    models: [],
    modeModels: {},
    modelInputCapabilities: {},
  });
  const [selectedModelName, setSelectedModelName] = useState("");
  const [currentRunSummary, setCurrentRunSummary] = useState<ConversationRunSummary | null>(null);
  const [contextState, setContextState] = useState<ContextState>({
    estimatedTokens: 0,
    threshold: 60000,
    status: "ready",
    compactionCount: 0,
  });
  const [mcpState, setMcpState] = useState<McpState>({
    status: "ready",
    serverCount: 0,
    toolCount: 0,
  });
  const [knowledgeState, setKnowledgeState] = useState<KnowledgeState>({
    memoryFiles: 0,
    skillCount: 0,
  });
  const [runState, setRunState] = useState<AgentRunState | null>(null);
  const [runHistory, setRunHistory] = useState<AgentRunSummary[]>([]);
  const [runHistoryLoading, setRunHistoryLoading] = useState(false);
  const [runHistoryError, setRunHistoryError] = useState<string | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<ToolApprovalRequest[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const onFileUpdateRef = useRef(onFileUpdate);
  const onAttachmentSendRejectedRef = useRef(onAttachmentSendRejected);
  const onAttachmentSendReconciledRef = useRef(onAttachmentSendReconciled);
  const pendingAttachmentSendsRef = useRef(new Map<string, PendingAttachmentSend>());
  const uncertainAttachmentSendsRef = useRef(new Map<string, PendingAttachmentSend>());
  const outboundRequestIdsRef = useRef(new Set<string>());
  const reconcilingAttachmentsRef = useRef(false);
  const reconcileAgainRef = useRef(false);
  const currentConversationIdRef = useRef(currentConversationId);
  const conversationLoadTokenRef = useRef(0);
  const contextManifest = useContextManifest(
    token,
    workspaceDir,
    currentConversationId,
    runState?.runId,
  );

  useEffect(() => {
    onFileUpdateRef.current = onFileUpdate;
  }, [onFileUpdate]);

  useEffect(() => {
    onAttachmentSendRejectedRef.current = onAttachmentSendRejected;
  }, [onAttachmentSendRejected]);

  useEffect(() => {
    onAttachmentSendReconciledRef.current = onAttachmentSendReconciled;
  }, [onAttachmentSendReconciled]);

  useEffect(() => {
    currentConversationIdRef.current = currentConversationId;
  }, [currentConversationId]);

  const refreshConversations = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);

    try {
      const response = await fetch("/api/chat/conversations", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Failed to load conversations");
      }

      const payload = (await response.json()) as ConversationsResponse;
      setConversations(
        Array.isArray(payload.conversations) ? payload.conversations : []
      );
    } catch (error) {
      setHistoryError(
        error instanceof Error
          ? error.message
          : t("chat.failedToLoadHistory")
      );
    } finally {
      setHistoryLoading(false);
    }
  }, [token]);

  const refreshRuntimeOptions = useCallback(async () => {
    try {
      const response = await fetch("/api/chat/runtime-options", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = (await response.json()) as Partial<ChatRuntimeOptions>;
      const models = Array.isArray(payload.models)
        ? payload.models.filter(
            (model): model is string => typeof model === "string" && Boolean(model.trim())
          )
        : [];
      setRuntimeOptions({
        defaultModelName:
          typeof payload.defaultModelName === "string" ? payload.defaultModelName : "",
        models,
        modeModels:
          payload.modeModels && typeof payload.modeModels === "object"
            ? payload.modeModels
            : {},
        modelInputCapabilities:
          payload.modelInputCapabilities && typeof payload.modelInputCapabilities === "object"
            ? payload.modelInputCapabilities
            : {},
      });
      setSelectedModelName((current) =>
        current && !models.includes(current) ? "" : current
      );
    } catch {
      // Mode defaults remain authoritative when runtime discovery is unavailable.
    }
  }, [token]);

  useEffect(() => {
    const refresh = () => { void refreshRuntimeOptions(); };
    window.addEventListener("crewforge:llm-models-updated", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("crewforge:llm-models-updated", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [refreshRuntimeOptions]);

  const fetchExecutionPlan = useCallback(async (planId?: string): Promise<ExecutionPlan | undefined> => {
    if (!planId) return undefined;
    const response = await fetch(`/api/chat/plans/${encodeURIComponent(planId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as { executionPlan?: ExecutionPlan; plan?: ExecutionPlan };
    return payload.executionPlan || payload.plan;
  }, [token]);

  const refreshRunHistory = useCallback(
    async (conversationId?: string | null) => {
      setRunHistoryLoading(true);
      setRunHistoryError(null);
      try {
        const query = conversationId
          ? `?conversationId=${encodeURIComponent(conversationId)}`
          : "";
        const response = await fetch(`/api/chat/runs${query}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || "Failed to load agent runs");
        }
        const payload = (await response.json()) as RunListResponse;
        const runs = Array.isArray(payload.runs) ? payload.runs : [];
        const hydrated = await Promise.all(runs.map(async (run) =>
          run.executionPlan || !run.executionPlanId ? run : { ...run, executionPlan: await fetchExecutionPlan(run.executionPlanId) }
        ));
        setRunHistory(hydrated);
      } catch (error) {
        setRunHistoryError(
          error instanceof Error ? error.message : "Failed to load agent runs"
        );
      } finally {
        setRunHistoryLoading(false);
      }
    },
    [fetchExecutionPlan, token]
  );

  const updateAssistantByRequestId = useCallback(
    (
      requestId: string | undefined,
      updater: (msg: ChatMessage) => ChatMessage
    ) => {
      setMessages((prev) => {
        const updated = [...prev];
        if (requestId) {
          for (let index = updated.length - 1; index >= 0; index -= 1) {
            const candidate = updated[index];
            if (
              candidate.role === "assistant" &&
              candidate.requestId === requestId
            ) {
              updated[index] = updater(candidate);
              return updated;
            }
          }
        }

        for (let index = updated.length - 1; index >= 0; index -= 1) {
          const candidate = updated[index];
          if (candidate.role === "assistant") {
            updated[index] = updater(candidate);
            return updated;
          }
        }
        return updated;
      });
    },
    []
  );

  const finishRequest = useCallback((requestId?: string) => {
    if (!requestId) return;
    setActiveRequestIds((prev) => prev.filter((value) => value !== requestId));
  }, []);

  const reconcileUncertainAttachmentSends = useCallback(async () => {
    if (!uncertainAttachmentSendsRef.current.size) return;
    if (reconcilingAttachmentsRef.current) {
      reconcileAgainRef.current = true;
      return;
    }
    reconcilingAttachmentsRef.current = true;
    const waitForNextCheck = () => new Promise<void>((resolve) => window.setTimeout(resolve, 1500));
    try {
      await Promise.all([...uncertainAttachmentSendsRef.current.keys()].map(async (requestId) => {
        let consecutiveUnknown = 0;
        let lastStatus: AttachmentSendReconciliation["status"] = "unavailable";
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const pending = uncertainAttachmentSendsRef.current.get(requestId);
          if (!pending || wsRef.current?.readyState !== WebSocket.OPEN) return;
          try {
            const response = await fetch(`/api/chat/request-status/${encodeURIComponent(requestId)}`, {
              headers: { Authorization: `Bearer ${token}` },
              cache: "no-store",
            });
            if (!response.ok) throw new Error("Request status unavailable");
            const result = await response.json() as ChatRequestStatusResponse;
            if (!uncertainAttachmentSendsRef.current.has(requestId)) return;
            if (result.status === "accepted") {
              const conversationId = result.conversationId || pending.conversationId;
              if (conversationId) {
                if (currentConversationIdRef.current === null) {
                  currentConversationIdRef.current = conversationId;
                  setCurrentConversationId(conversationId);
                }
                try {
                  const detailResponse = await fetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}`, {
                    headers: { Authorization: `Bearer ${token}` },
                    cache: "no-store",
                  });
                  if (detailResponse.ok) {
                    const detail = await detailResponse.json() as ConversationDetailResponse;
                    const historicalMessages = Array.isArray(detail.messages) ? detail.messages : [];
                    if (uncertainAttachmentSendsRef.current.has(requestId)
                      && historicalMessages.some((message) => message.role === "user" && message.requestId === requestId)
                      && (currentConversationIdRef.current === conversationId || currentConversationIdRef.current === null)) {
                      currentConversationIdRef.current = conversationId;
                      setCurrentConversationId(conversationId);
                      setMessages(historicalMessages);
                    }
                  }
                } catch {
                  // The accepted status is authoritative even if history is briefly unavailable.
                }
              }
              uncertainAttachmentSendsRef.current.delete(requestId);
              onAttachmentSendReconciledRef.current?.({ requestId, ...pending, status: "persisted" });
              await refreshConversations();
              return;
            }
            if (result.status === "unknown") {
              consecutiveUnknown += 1;
              if (consecutiveUnknown >= 2) {
                uncertainAttachmentSendsRef.current.delete(requestId);
                onAttachmentSendReconciledRef.current?.({ requestId, ...pending, status: "missing" });
                return;
              }
              lastStatus = "processing";
            } else if (result.status === "processing") {
              consecutiveUnknown = 0;
              lastStatus = "processing";
            } else {
              consecutiveUnknown = 0;
              lastStatus = "unavailable";
            }
          } catch {
            consecutiveUnknown = 0;
            lastStatus = "unavailable";
          }
          if (attempt < 7) await waitForNextCheck();
        }
        const pending = uncertainAttachmentSendsRef.current.get(requestId);
        if (pending) onAttachmentSendReconciledRef.current?.({ requestId, ...pending, status: lastStatus });
      }));
    } finally {
      reconcilingAttachmentsRef.current = false;
      const shouldRecheck = reconcileAgainRef.current;
      reconcileAgainRef.current = false;
      if (shouldRecheck && uncertainAttachmentSendsRef.current.size && wsRef.current?.readyState === WebSocket.OPEN) {
        void reconcileUncertainAttachmentSends();
      }
    }
  }, [refreshConversations, token]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/chat?token=${encodeURIComponent(token)}`);

    ws.onopen = () => {
      setConnected(true);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (uncertainAttachmentSendsRef.current.size) void reconcileUncertainAttachmentSends();
    };

    ws.onclose = () => {
      // Only clear if this WebSocket is still the current one.
      // Prevents React StrictMode double-mount from wiping the new connection.
      if (wsRef.current === ws) {
        outboundRequestIdsRef.current.clear();
        const uncertain = [...pendingAttachmentSendsRef.current.entries()];
        pendingAttachmentSendsRef.current.clear();
        if (uncertain.length) {
          const requestIds = new Set(uncertain.map(([requestId]) => requestId));
          setMessages((previous) => previous.filter((message) => !message.requestId || !requestIds.has(message.requestId)));
          setActiveRequestIds((previous) => previous.filter((requestId) => !requestIds.has(requestId)));
          for (const [requestId, pending] of uncertain) {
            uncertainAttachmentSendsRef.current.set(requestId, pending);
            onAttachmentSendRejectedRef.current?.({
              requestId,
              ...pending,
              error: t("chat.attachmentDeliveryUncertain"),
              uncertain: true,
            });
          }
        }
        setConnected(false);
        wsRef.current = null;
        reconnectTimer.current = setTimeout(connect, 3000);
      }
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      switch (data.type) {
        case "conversation":
          if (typeof data.conversationId === "string" && data.conversationId) {
            if (currentConversationIdRef.current === data.conversationId) {
              setCurrentConversationId(data.conversationId);
            }
          }
          void refreshConversations();
          break;

        case "conversation_updated":
          void refreshConversations();
          break;

        case "request_accepted": {
          const pending = data.requestId
            ? pendingAttachmentSendsRef.current.get(data.requestId) || uncertainAttachmentSendsRef.current.get(data.requestId)
            : undefined;
          const conversationId = typeof data.conversationId === "string" ? data.conversationId : "";
          if (pending) {
            pending.accepted = true;
            if (conversationId) pending.conversationId = conversationId;
          }
          if (conversationId && data.requestId && outboundRequestIdsRef.current.has(data.requestId)
            && (currentConversationIdRef.current === null || currentConversationIdRef.current === conversationId)) {
              currentConversationIdRef.current = conversationId;
              setCurrentConversationId(conversationId);
          }
          if (data.replayed === true && data.requestId) {
            outboundRequestIdsRef.current.delete(data.requestId);
            pendingAttachmentSendsRef.current.delete(data.requestId);
            uncertainAttachmentSendsRef.current.delete(data.requestId);
            setMessages((previous) => previous.filter((message) => message.requestId !== data.requestId));
            finishRequest(data.requestId);
            if (pending) {
              onAttachmentSendReconciledRef.current?.({
                requestId: data.requestId,
                ...pending,
                status: "persisted",
              });
            }
            if (conversationId) {
              const loadToken = conversationLoadTokenRef.current;
              void (async () => {
                try {
                  const response = await fetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}`, {
                    headers: { Authorization: `Bearer ${token}` },
                    cache: "no-store",
                  });
                  if (!response.ok) return;
                  const detail = await response.json() as ConversationDetailResponse;
                  const historicalMessages = Array.isArray(detail.messages) ? detail.messages : [];
                  if (conversationLoadTokenRef.current !== loadToken) return;
                  if (!historicalMessages.some((message) => message.role === "user" && message.requestId === data.requestId)) return;
                  if (currentConversationIdRef.current === conversationId || currentConversationIdRef.current === null) {
                    currentConversationIdRef.current = conversationId;
                    setCurrentConversationId(conversationId);
                    setMessages(historicalMessages);
                  }
                } finally {
                  void refreshConversations();
                }
              })().catch(() => { /* History may be temporarily unavailable; the sidebar refresh still runs. */ });
            }
          }
          break;
        }

        case "conversation_state":
          setAgentMode(data.mode || "code");
          setConversations((prev) =>
            prev.map((conversation) =>
              conversation.id === data.conversationId
                ? { ...conversation, mode: data.mode, status: data.status }
                : conversation
            )
          );
          break;

        case "run_state": {
          const event = data.event as AgentRunEvent | undefined;
          if (data.mode) setAgentMode(data.mode);
          if (data.requestId && data.status === "running") {
            setMessages((previous) => {
              if (previous.some((message) =>
                message.role === "assistant" && message.requestId === data.requestId
              )) {
                return previous;
              }
              return [
                ...previous,
                {
                  requestId: data.requestId,
                  role: "assistant",
                  content: "",
                  timestamp: Date.now(),
                },
              ];
            });
            setActiveRequestIds((previous) =>
              previous.includes(data.requestId)
                ? previous
                : [...previous, data.requestId]
            );
          }
          setRunState((previous) => {
            const previousRun = previous?.runId === data.runId ? previous : null;
            const events = previousRun ? [...previousRun.events] : [];
            if (event && !events.some((entry) => entry.id === event.id)) {
              events.push(event);
            }
            const fields = data as RunPayloadFields;
            return {
              runId: data.runId,
              conversationId: data.conversationId,
              mode: data.mode || previousRun?.mode || "code",
              modelName: data.modelName || previousRun?.modelName,
              status: data.status || "running",
              startedAt: previousRun?.startedAt || event?.timestamp || Date.now(),
              updatedAt: event?.timestamp || Date.now(),
              metrics: data.metrics || previousRun?.metrics || EMPTY_RUN_METRICS,
              eventCount: events.length,
              events,
              ...(event ? { event } : {}),
              ...(fields.executionContract ? { executionContract: fields.executionContract } : {}),
              ...(fields.executionContractKind ? { executionContractKind: fields.executionContractKind } : {}),
              ...(fields.completionEvidence ? { completionEvidence: fields.completionEvidence } : {}),
              ...(fields.qualityGate ? { qualityGate: fields.qualityGate } : {}),
              ...(fields.executionPlan ? { executionPlan: fields.executionPlan } : {}),
            };
          });
          if (data.status !== "running" && data.status !== "queued") {
            void refreshRunHistory(data.conversationId);
          }
          break;
        }

        case "summary":
          if (data.conversationId === currentConversationId || !currentConversationId) {
            setCurrentRunSummary(data as ConversationRunSummary);
          }
          break;

        case "context_state":
          setContextState({
            estimatedTokens: Number(data.estimatedTokens) || 0,
            estimatedTokensAfter: Number(data.estimatedTokensAfter) || undefined,
            threshold: Number(data.threshold) || 60000,
            status: data.status || "ready",
            compactionCount: Number(data.compactionCount) || 0,
            lastCompactedAt: data.lastCompactedAt,
            transcriptPath: data.transcriptPath,
            preview: data.preview,
            message: data.message,
          });
          break;

        case "context_manifest":
        case "context_manifest_state":
          contextManifest.acceptManifestEvent(data);
          break;

        case "context_index_state":
          contextManifest.acceptIndexEvent(data);
          break;

        case "mcp_state":
          setMcpState({
            status: data.status || "ready",
            serverCount: Number(data.serverCount) || 0,
            toolCount: Number(data.toolCount) || 0,
            servers: Array.isArray(data.servers) ? data.servers : undefined,
            message: data.message,
          });
          break;

        case "knowledge_state":
          setKnowledgeState({
            memoryFiles: Number(data.memoryFiles) || 0,
            skillCount: Number(data.skillCount) || 0,
          });
          break;

        case "token":
          updateAssistantByRequestId(data.requestId, (msg) => ({
            ...msg,
            content: msg.content + data.content,
          }));
          break;

        case "thinking":
          updateAssistantByRequestId(data.requestId, (msg) => ({
            ...msg,
            thinking: (msg.thinking || "") + data.content,
          }));
          break;

        case "tool_call":
          updateAssistantByRequestId(data.requestId, (msg) => ({
            ...msg,
            toolCalls: [
              ...(msg.toolCalls || []),
              {
                toolCallId: data.toolCallId,
                name: data.name,
                input: data.input,
              },
            ],
          }));
          break;

        case "tool_approval_request":
          setPendingApprovals((previous) => [
            ...previous.filter((item) => item.approvalId !== data.approvalId),
            data as ToolApprovalRequest,
          ]);
          break;

        case "tool_result":
          setPendingApprovals((previous) =>
            previous.filter((item) => item.toolCallId !== data.toolCallId)
          );
          updateAssistantByRequestId(data.requestId, (msg) => ({
            ...msg,
            toolCalls: (msg.toolCalls || []).map((tc) =>
              tc.toolCallId === data.toolCallId
                ? {
                    ...tc,
                    result: data.result,
                    isError: data.isError,
                    fileUpdate: data.fileUpdate,
                  }
                : tc
            ),
          }));
          if (data.fileUpdate && !data.isError) {
            onFileUpdateRef.current?.(data.fileUpdate);
          }
          break;

        case "done":
          if (data.requestId) outboundRequestIdsRef.current.delete(data.requestId);
          if (data.requestId) pendingAttachmentSendsRef.current.delete(data.requestId);
          setPendingApprovals((previous) =>
            previous.filter((item) => item.requestId !== data.requestId)
          );
          finishRequest(data.requestId);
          void refreshConversations();
          break;

        case "stopped":
          if (data.requestId) outboundRequestIdsRef.current.delete(data.requestId);
          if (data.requestId) pendingAttachmentSendsRef.current.delete(data.requestId);
          setPendingApprovals((previous) =>
            data.requestId
              ? previous.filter((item) => item.requestId !== data.requestId)
              : []
          );
          if (data.requestId) {
            updateAssistantByRequestId(data.requestId, (msg) => ({
              ...msg,
              content: msg.content || data.content || t("chat.stopped"),
            }));
            finishRequest(data.requestId);
          } else {
            setActiveRequestIds([]);
          }
          void refreshConversations();
          break;

        case "steering":
          break;

        case "error": {
          if (data.requestId) outboundRequestIdsRef.current.delete(data.requestId);
          const pendingAttachmentSend = data.requestId
            ? pendingAttachmentSendsRef.current.get(data.requestId)
            : undefined;
          if (pendingAttachmentSend && !pendingAttachmentSend.accepted) {
            pendingAttachmentSendsRef.current.delete(data.requestId);
            setMessages((previous) => previous.filter((message) => message.requestId !== data.requestId));
            onAttachmentSendRejectedRef.current?.({
              requestId: data.requestId,
              ...pendingAttachmentSend,
              error: String(data.content || "Attachment rejected"),
            });
          } else {
            if (data.requestId) pendingAttachmentSendsRef.current.delete(data.requestId);
            updateAssistantByRequestId(data.requestId, (msg) => ({
              ...msg,
              content: msg.content || `Error: ${data.content}`,
            }));
          }
          finishRequest(data.requestId);
          if (data.requestId) {
            setPendingApprovals((previous) =>
              previous.filter((item) => item.requestId !== data.requestId)
            );
          }
          void refreshConversations();
          break;
        }
      }
    };

    wsRef.current = ws;
  }, [contextManifest.acceptIndexEvent, contextManifest.acceptManifestEvent, finishRequest, reconcileUncertainAttachmentSends, refreshConversations, updateAssistantByRequestId, token]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  useEffect(() => {
    conversationLoadTokenRef.current += 1;
    pendingAttachmentSendsRef.current.clear();
    uncertainAttachmentSendsRef.current.clear();
    outboundRequestIdsRef.current.clear();
    currentConversationIdRef.current = null;
    setMessages([]);
    setCurrentConversationId(null);
    setHistoryError(null);
    setActiveRequestIds([]);
    setAgentMode(DEFAULT_AGENT_MODE);
    setCurrentRunSummary(null);
    setContextState({
      estimatedTokens: 0,
      threshold: 60000,
      status: "ready",
      compactionCount: 0,
    });
    setMcpState({ status: "ready", serverCount: 0, toolCount: 0 });
    setKnowledgeState({ memoryFiles: 0, skillCount: 0 });
    setRunState(null);
    setRunHistory([]);
    setRunHistoryError(null);
    setPendingApprovals([]);
    void refreshConversations();
    void refreshRunHistory(null);
    void refreshRuntimeOptions();
  }, [refreshConversations, refreshRunHistory, refreshRuntimeOptions, workspaceDir]);

  useEffect(() => {
    void refreshRunHistory(currentConversationId);
  }, [currentConversationId, refreshRunHistory]);

  const sendMessage = useCallback(
    (content: string, context?: FileContext, modeOverride?: AgentMode, attachments: ChatAttachmentRef[] = [], retryRequestId?: string): boolean => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      const requestId = retryRequestId || createRequestId();
      const requestedMode = modeOverride || agentMode;

      const userMsg: ChatMessage = {
        requestId,
        role: "user",
        content,
        timestamp: Date.now(),
        ...(attachments.length ? { attachments } : {}),
      };
      const assistantMsg: ChatMessage = {
        requestId,
        role: "assistant",
        content: "",
        timestamp: Date.now(),
      };

      const history = messages.slice(-10).map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.attachments?.length ? { attachments: m.attachments.map((attachment) => attachment.id) } : {}),
      }));

      try {
        ws.send(JSON.stringify({
          requestId,
          message: content,
          attachments: attachments.map((attachment) => attachment.id),
          context,
          history,
          conversationId: currentConversationId,
          mode: requestedMode,
          ...(selectedModelName ? { modelName: selectedModelName } : {}),
        }));
      } catch {
        return false;
      }
      setMessages((prev) => [...prev.filter((message) => message.requestId !== requestId), userMsg, assistantMsg]);
      outboundRequestIdsRef.current.add(requestId);
      if (attachments.length) pendingAttachmentSendsRef.current.set(requestId, { content, attachments, conversationId: currentConversationId, accepted: false });
      setActiveRequestIds((prev) =>
        prev.includes(requestId) ? prev : [...prev, requestId]
      );
      return true;
    },
    [agentMode, currentConversationId, messages, selectedModelName]
  );

  const sendSteering = useCallback(
    (content: string, context?: FileContext, attachments: ChatAttachmentRef[] = []): boolean => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      const requestId = createRequestId();

      const userMsg: ChatMessage = {
        requestId,
        role: "user",
        content,
        timestamp: Date.now(),
        ...(attachments.length ? { attachments } : {}),
      };
      const assistantMsg: ChatMessage = {
        requestId,
        role: "assistant",
        content: "",
        timestamp: Date.now(),
      };

      try {
        ws.send(JSON.stringify({
          type: "steer",
          requestId,
          message: content,
          attachments: attachments.map((attachment) => attachment.id),
          context,
          conversationId: currentConversationId,
          mode: agentMode,
          ...(selectedModelName ? { modelName: selectedModelName } : {}),
        }));
      } catch {
        return false;
      }
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      outboundRequestIdsRef.current.add(requestId);
      if (attachments.length) pendingAttachmentSendsRef.current.set(requestId, { content, attachments, conversationId: currentConversationId, accepted: false });
      setActiveRequestIds((prev) =>
        prev.includes(requestId) ? prev : [...prev, requestId]
      );
      return true;
    },
    [agentMode, currentConversationId, selectedModelName]
  );

  const stopCurrentRun = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const latestRequestId = activeRequestIds[activeRequestIds.length - 1];
    wsRef.current.send(
      JSON.stringify({
        type: "stop",
        requestId: latestRequestId,
      })
    );
    setActiveRequestIds([]);
    setPendingApprovals([]);
    if (latestRequestId) {
      updateAssistantByRequestId(latestRequestId, (msg) => ({
        ...msg,
        content: msg.content || t("chat.stopping"),
      }));
    }
  }, [activeRequestIds, t, updateAssistantByRequestId]);

  const clearMessages = useCallback(() => {
    conversationLoadTokenRef.current += 1;
    pendingAttachmentSendsRef.current.clear();
    uncertainAttachmentSendsRef.current.clear();
    outboundRequestIdsRef.current.clear();
    currentConversationIdRef.current = null;
    setMessages([]);
    setCurrentConversationId(null);
    setAgentMode(DEFAULT_AGENT_MODE);
    setCurrentRunSummary(null);
    setActiveRequestIds([]);
    setContextState({
      estimatedTokens: 0,
      threshold: 60000,
      status: "ready",
      compactionCount: 0,
    });
    setMcpState({ status: "ready", serverCount: 0, toolCount: 0 });
    setKnowledgeState({ memoryFiles: 0, skillCount: 0 });
    setRunState(null);
    setRunHistory([]);
    setRunHistoryError(null);
    setPendingApprovals([]);
  }, []);

  const respondToToolApproval = useCallback(
    (approvalId: string, decision: ToolApprovalDecision) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      wsRef.current.send(JSON.stringify({
        type: "tool_approval",
        approvalId,
        decision,
      }));
      setPendingApprovals((previous) =>
        previous.filter((item) => item.approvalId !== approvalId)
      );
    },
    []
  );

  const decidePlanAmendment = useCallback(async (planId: string, amendmentId: string, decision: "approved" | "rejected") => {
    const response = await fetch(`/api/chat/plans/${encodeURIComponent(planId)}/amendments/${encodeURIComponent(amendmentId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ decision }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "Failed to update plan amendment");
    }
    const payload = await response.json() as { executionPlan?: ExecutionPlan; plan?: ExecutionPlan };
    const executionPlan = payload.executionPlan || payload.plan;
    if (executionPlan) {
      setRunState((current) => current ? { ...current, executionPlan } : current);
      setCurrentRunSummary((current) => current ? { ...current, executionPlan } : current);
    }
    await refreshRunHistory(currentConversationId);
  }, [currentConversationId, refreshRunHistory, token]);

  const approveConversationTools = useCallback((conversationId: string) => {
    if (!conversationId || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: "tool_approval_all",
      conversationId,
    }));
    setPendingApprovals((previous) =>
      previous.filter((item) => item.conversationId !== conversationId)
    );
  }, []);

  const retryLast = useCallback(() => {
    const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
    if (!lastUserMessage) return;
    sendMessage(lastUserMessage.content, undefined, undefined, lastUserMessage.attachments || []);
  }, [messages, sendMessage]);

  const fetchHydratedRun = useCallback(async (runId: string): Promise<AgentRunState> => {
    const response = await fetch(`/api/chat/runs/${encodeURIComponent(runId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "Failed to load agent run");
    }
    const run = await response.json() as AgentRunState;
    const executionPlan = run.executionPlan || await fetchExecutionPlan(run.executionPlanId);
    return executionPlan ? { ...run, executionPlan } : run;
  }, [fetchExecutionPlan, token]);

  const loadConversation = useCallback(
    async (conversationId: string) => {
      const loadToken = ++conversationLoadTokenRef.current;
      pendingAttachmentSendsRef.current.clear();
      uncertainAttachmentSendsRef.current.clear();
      outboundRequestIdsRef.current.clear();
      const previousConversationId = currentConversationIdRef.current;
      currentConversationIdRef.current = conversationId;
      const isCurrentLoad = () => conversationLoadTokenRef.current === loadToken;
      setHistoryLoadingId(conversationId);
      setHistoryError(null);
      // Clear synchronously so a previous conversation's contract cannot be rendered.
      setRunState(null);
      setCurrentRunSummary(null);

      try {
        const response = await fetch(
          `/api/chat/conversations/${encodeURIComponent(conversationId)}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || "Failed to load conversation");
        }

        const payload = (await response.json()) as ConversationDetailResponse;
        if (!isCurrentLoad()) return;
        setMessages(Array.isArray(payload.messages) ? payload.messages : []);
        currentConversationIdRef.current = payload.id || conversationId;
        setCurrentConversationId(payload.id || conversationId);
        setAgentMode(payload.mode || "code");
        setCurrentRunSummary(payload.summary || null);
        if (payload.lastRunId) {
          const run = await fetchHydratedRun(payload.lastRunId);
          if (!isCurrentLoad()) return;
          if (run.conversationId === (payload.id || conversationId)) {
            setRunState(run);
            if (run.summary) {
              setCurrentRunSummary(run.executionPlan ? { ...run.summary, executionPlan: run.executionPlan } : run.summary);
            }
          }
        }
      } catch (error) {
        if (!isCurrentLoad()) return;
        currentConversationIdRef.current = previousConversationId;
        setHistoryError(
          error instanceof Error
            ? error.message
            : t("chat.failedToLoadConversation")
        );
      } finally {
        if (isCurrentLoad()) setHistoryLoadingId(null);
      }
    },
    [fetchHydratedRun, t, token]
  );

  const forkConversation = useCallback(
    async (conversationId: string, upToTimestamp?: number) => {
      setHistoryError(null);
      const response = await fetch(
        `/api/chat/conversations/${encodeURIComponent(conversationId)}/fork`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            ...(typeof upToTimestamp === "number" ? { upToTimestamp } : {}),
          }),
        }
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const error = new Error(payload.error || "Failed to fork conversation");
        setHistoryError(error.message);
        throw error;
      }
      const payload = (await response.json()) as ForkConversationResponse;
      if (!payload.conversation?.id) throw new Error("Conversation fork did not return a conversation");
      await refreshConversations();
      await loadConversation(payload.conversation.id);
      return payload.conversation;
    },
    [loadConversation, refreshConversations, token]
  );

  const deleteConversation = useCallback(
    async (conversationId: string) => {
      setHistoryLoadingId(conversationId);
      setHistoryError(null);
      try {
        const response = await fetch(
          `/api/chat/conversations/${encodeURIComponent(conversationId)}`,
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
          }
        );
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || t("chat.deleteConversationFailed"));
        }
        setConversations((previous) =>
          previous.filter((conversation) => conversation.id !== conversationId)
        );
        if (conversationId === currentConversationId) {
          clearMessages();
        }
      } catch (error) {
        setHistoryError(
          error instanceof Error ? error.message : t("chat.deleteConversationFailed")
        );
        throw error;
      } finally {
        setHistoryLoadingId(null);
      }
    },
    [clearMessages, currentConversationId, t, token]
  );

  const loadRun = useCallback(
    async (runId: string) => {
      try {
        const hydrated = await fetchHydratedRun(runId);
        if (hydrated.conversationId !== currentConversationId) {
          await loadConversation(hydrated.conversationId);
        }
        setRunState(hydrated);
        if (hydrated.summary) setCurrentRunSummary(hydrated.executionPlan ? { ...hydrated.summary, executionPlan: hydrated.executionPlan } : hydrated.summary);
      } catch (error) {
        setRunHistoryError(
          error instanceof Error ? error.message : "Failed to load agent run"
        );
      }
    },
    [currentConversationId, fetchHydratedRun, loadConversation]
  );

  const revertRun = useCallback(
    async (runId: string, options: { legacyFullRestore?: boolean } = {}) => {
      setRunHistoryError(null);
      const response = await fetch(`/api/chat/runs/${encodeURIComponent(runId)}/revert`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(options),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const error = Object.assign(new Error(payload.error || "Failed to revert agent run"), {
          legacyFullRestoreRequired: payload.legacyFullRestoreRequired === true,
          rollback: payload.rollback,
        });
        setRunHistoryError(error.message);
        throw error;
      }
      const payload = await response.json();
      await refreshRunHistory(currentConversationId);
      return payload;
    },
    [currentConversationId, refreshRunHistory, token]
  );

  const resumeConversation = useCallback(
    async (conversationId: string, runId?: string) => {
      if (
        !wsRef.current ||
        wsRef.current.readyState !== WebSocket.OPEN ||
        activeRequestIds.length > 0
      ) {
        return;
      }
      if (conversationId !== currentConversationId) {
        await loadConversation(conversationId);
      }
      const requestId = createRequestId();
      const resumeMessage =
        "Continue the interrupted task from the last recorded state. Do not repeat completed steps; inspect the current workspace and resume from the next step.";
      setMessages((prev) => [
        ...prev,
        { requestId, role: "user", content: resumeMessage, timestamp: Date.now() },
        { requestId, role: "assistant", content: "", timestamp: Date.now() },
      ]);
      currentConversationIdRef.current = conversationId;
      setCurrentConversationId(conversationId);
      setActiveRequestIds([requestId]);
      wsRef.current.send(
        JSON.stringify({ type: "resume", conversationId, runId, requestId })
      );
      outboundRequestIdsRef.current.add(requestId);
    },
    [activeRequestIds.length, currentConversationId, loadConversation]
  );

  return {
    messages,
    sendMessage,
    sendSteering,
    recheckAttachmentSends: reconcileUncertainAttachmentSends,
    stopCurrentRun,
    clearMessages,
    retryLast,
    isStreaming: activeRequestIds.length > 0,
    activeRequestIds,
    connected,
    currentConversationId,
    conversations,
    historyLoading,
    historyLoadingId,
    historyError,
    refreshConversations,
    loadConversation,
    forkConversation,
    deleteConversation,
    agentMode,
    setAgentMode,
    runtimeOptions,
    selectedModelName,
    setSelectedModelName,
    currentRunSummary,
    contextState,
    contextManifest,
    mcpState,
    knowledgeState,
    runState,
    runHistory,
    runHistoryLoading,
    runHistoryError,
    refreshRunHistory,
    loadRun,
    revertRun,
    resumeConversation,
    pendingApprovals,
    respondToToolApproval,
    approveConversationTools,
    decidePlanAmendment,
  };
}

function createRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
