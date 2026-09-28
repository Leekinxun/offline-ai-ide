import { useState, useRef, useCallback, useEffect } from "react";
import { recordRequestOutcome, type RequestOutcome } from "../utils/requestOutcome";
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
  ContextReference,
} from "../types";
import { useI18n } from "../i18n";
import { useContextManifest } from "./useContextManifest";
import { updateAssistantMessage } from "../utils/assistantActivity";
import { acceptsConversationEvent, canBindAcceptedRequest, type ChatRequestScope, type ConversationActivity } from "../utils/chatScope";

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

export type AiHealthStatus = "ready" | "model_offline" | "checking" | "server_offline";

export interface AiHealthInfo {
  status: AiHealthStatus;
  error: string | null;
  apiUrl?: string;
  modelName?: string;
  checkedAt: number;
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
  const [conversationActivity, setConversationActivity] = useState<Record<string, ConversationActivity>>({});
  const requestScopesRef = useRef(new Map<string, ChatRequestScope>());
  const cancelledRequestIdsRef = useRef(new Set<string>());
  const loadingConversationRef = useRef(false);
  const currentRunIdRef = useRef<string | null>(null);
  const [requestOutcomes, setRequestOutcomes] = useState<Record<string, RequestOutcome>>({});
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
  const preserveComposerModeRef = useRef(false);
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

  const [aiHealth, setAiHealth] = useState<AiHealthInfo>({
    status: "checking",
    error: null,
    checkedAt: 0,
  });

  const checkAiHealth = useCallback(async (modelNameOverride?: string) => {
    if (!token) return;
    try {
      const targetModel = modelNameOverride || selectedModelName || runtimeOptions.defaultModelName;
      const url = targetModel
        ? `/api/chat/model-health?model=${encodeURIComponent(targetModel)}`
        : "/api/chat/model-health";
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) {
        setAiHealth({
          status: "model_offline",
          error: `HTTP ${res.status}`,
          checkedAt: Date.now(),
        });
        return;
      }
      const data = await res.json() as { status: string; error?: string; apiUrl?: string; modelName?: string };
      if (data.status === "ready") {
        setAiHealth({
          status: "ready",
          error: null,
          apiUrl: data.apiUrl,
          modelName: data.modelName,
          checkedAt: Date.now(),
        });
      } else {
        setAiHealth({
          status: "model_offline",
          error: data.error || "Model unavailable",
          apiUrl: data.apiUrl,
          modelName: data.modelName,
          checkedAt: Date.now(),
        });
      }
    } catch (err: any) {
      setAiHealth({
        status: "model_offline",
        error: err?.message || "Connection failed",
        checkedAt: Date.now(),
      });
    }
  }, [token, selectedModelName, runtimeOptions.defaultModelName]);

  useEffect(() => {
    if (!connected) {
      setAiHealth((prev) => ({ ...prev, status: "server_offline" }));
      return;
    }
    void checkAiHealth();
    const interval = setInterval(() => {
      void checkAiHealth();
    }, 25000);
    return () => clearInterval(interval);
  }, [connected, checkAiHealth]);

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
      const viewEpoch = conversationLoadTokenRef.current;
      const isCurrent = () => viewEpoch === conversationLoadTokenRef.current && (conversationId || null) === currentConversationIdRef.current;
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
        if (isCurrent()) setRunHistory(hydrated);
      } catch (error) {
        if (!isCurrent()) return;
        setRunHistoryError(
          error instanceof Error ? error.message : "Failed to load agent runs"
        );
      } finally {
        if (isCurrent()) setRunHistoryLoading(false);
      }
    },
    [fetchExecutionPlan, token]
  );

  const updateAssistantByRequestId = useCallback(
    (
      requestId: string | undefined,
      updater: (msg: ChatMessage) => ChatMessage
    ) => {
      setMessages((prev) => updateAssistantMessage(prev, requestId, updater));
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
              const scope = requestScopesRef.current.get(requestId);
              const canRestore = canBindAcceptedRequest(scope, currentConversationIdRef.current, conversationLoadTokenRef.current);
              if (conversationId && canRestore) {
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
                      && scope?.viewEpoch === conversationLoadTokenRef.current
                      && historicalMessages.some((message) => message.role === "user" && message.requestId === requestId)
                      && (currentConversationIdRef.current === conversationId || currentConversationIdRef.current === null)) {
                      currentConversationIdRef.current = conversationId;
                      setCurrentConversationId(conversationId);
                      setMessages(historicalMessages);
                      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: "subscribe_run", conversationId }));
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
      // A run may have continued after the browser socket disconnected. Attach
      // this new socket to the currently open conversation before consuming
      // further events or approvals.
      const conversationId = currentConversationIdRef.current;
      if (conversationId) ws.send(JSON.stringify({ type: "subscribe_run", conversationId }));
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
      if (data.type === "background_run_state") {
        setConversationActivity((current) => ({ ...current, [data.conversationId]: {
          running: ["running", "queued", "stopping"].includes(data.status), waiting: Boolean(data.waiting),
          unread: data.conversationId !== currentConversationIdRef.current,
          updatedAt: Number(data.updatedAt) || Date.now(), runId: data.runId,
        } }));
        setConversations((current) => current.map((conversation) => conversation.id === data.conversationId
          ? { ...conversation, status: data.status === "stopping" ? "running" : data.status, updatedAt: Number(data.updatedAt) || conversation.updatedAt } : conversation));
        if (data.requestId && data.outcome) setRequestOutcomes((current) => recordRequestOutcome(current, data.requestId, data.outcome === "cancelled" ? "stopped" : data.outcome));
        if (!["running", "queued", "stopping"].includes(data.status)) void refreshConversations();
        return;
      }
      if (data.type === "error" && data.requestId) setRequestOutcomes((current) => recordRequestOutcome(current, data.requestId, "failed"));
      if (!["conversation", "conversation_updated", "request_accepted"].includes(data.type)
        && !acceptsConversationEvent(data, { conversationId: currentConversationIdRef.current, runId: currentRunIdRef.current, viewEpoch: conversationLoadTokenRef.current }, requestScopesRef.current.get(data.requestId))) {
        if (data.type === "error" && !data.requestId && !data.conversationId) setHistoryError(String(data.content || "Chat request failed"));
        return;
      }
      switch (data.type) {
        case "conversation_snapshot": {
          const loaded = Array.isArray(data.messages) ? data.messages as ChatMessage[] : [];
          for (const requestId of data.activeRequestIds || []) {
            if (!loaded.some((message) => message.role === "assistant" && message.requestId === requestId)) loaded.push({ role: "assistant", requestId, content: "", timestamp: Date.now() });
          }
          for (const message of loaded) if (message.requestId) requestScopesRef.current.set(message.requestId, {
            conversationId: data.conversationId, viewEpoch: conversationLoadTokenRef.current, runId: data.runId,
          });
          currentRunIdRef.current = data.run?.runId || null;
          setMessages(loaded);
          setActiveRequestIds(Array.isArray(data.activeRequestIds) ? data.activeRequestIds : []);
          setPendingApprovals(Array.isArray(data.pendingApprovals) ? data.pendingApprovals : []);
          setRunState(data.run || null);
          setCurrentRunSummary(data.run?.summary || null);
          if (data.run?.mode && !preserveComposerModeRef.current) setAgentMode(data.run.mode);
          setConversationActivity((current) => ({ ...current, [data.conversationId]: {
            running: ["running", "queued"].includes(data.run?.status), waiting: Boolean(data.waitingForInput), unread: false,
            updatedAt: Number(data.run?.updatedAt) || Date.now(), runId: data.runId,
          } }));
          break;
        }
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
          const scope = requestScopesRef.current.get(data.requestId);
          const bindToView = canBindAcceptedRequest(scope, currentConversationIdRef.current, conversationLoadTokenRef.current);
          const pending = data.requestId
            ? pendingAttachmentSendsRef.current.get(data.requestId) || uncertainAttachmentSendsRef.current.get(data.requestId)
            : undefined;
          const conversationId = typeof data.conversationId === "string" ? data.conversationId : "";
          if (scope && conversationId) requestScopesRef.current.set(data.requestId, { ...scope, conversationId, runId: data.runId || scope.runId });
          if (cancelledRequestIdsRef.current.delete(data.requestId) && conversationId && data.runId) {
            ws.send(JSON.stringify({ type: "stop", conversationId, runId: data.runId, requestId: data.requestId }));
          }
          if (pending) {
            pending.accepted = true;
            if (conversationId) pending.conversationId = conversationId;
          }
          if (conversationId && data.requestId && bindToView) {
              currentConversationIdRef.current = conversationId;
              currentRunIdRef.current = data.runId || currentRunIdRef.current;
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
            if (conversationId && bindToView) {
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
                    ws.send(JSON.stringify({ type: "subscribe_run", conversationId }));
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
          if (!preserveComposerModeRef.current) setAgentMode(data.mode || "code");
          setConversations((prev) =>
            prev.map((conversation) =>
              conversation.id === data.conversationId
                ? { ...conversation, mode: data.mode, status: data.status }
                : conversation
            )
          );
          break;

        case "run_state": {
          currentRunIdRef.current = data.runId;
          const event = data.event as AgentRunEvent | undefined;
          if (data.status === "running" && event?.kind === "model_call") {
            updateAssistantByRequestId(data.requestId || event.requestId, (message) => ({ ...message, activity: { phase: "waiting", waitingFor: "model", updatedAt: Date.now() } }));
          }
          if (data.mode && !preserveComposerModeRef.current) setAgentMode(data.mode);
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
            setActiveRequestIds([]);
            setPendingApprovals([]);
            void refreshRunHistory(data.conversationId);
          }
          break;
        }

        case "summary":
          if (data.conversationId === currentConversationIdRef.current) {
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
            activity: { phase: "responding", updatedAt: Date.now() },
          }));
          break;

        case "thinking":
          updateAssistantByRequestId(data.requestId, (msg) => ({
            ...msg,
            thinking: (msg.thinking || "") + data.content,
            activity: { phase: "reasoning", updatedAt: Date.now() },
          }));
          break;

        case "tool_call":
          updateAssistantByRequestId(data.requestId, (msg) => ({
            ...msg,
            toolCalls: [
              ...(msg.toolCalls || []).filter((step) => step.toolCallId !== data.toolCallId),
              {
                toolCallId: data.toolCallId,
                name: data.name,
                input: data.input,
              },
            ],
            activity: { phase: "tool", toolCallId: data.toolCallId, updatedAt: Date.now() },
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
            toolCalls: [
              ...(msg.toolCalls || []).filter((step) => step.toolCallId !== data.toolCallId),
              { ...(msg.toolCalls || []).find((step) => step.toolCallId === data.toolCallId), toolCallId: data.toolCallId, name: data.name, input: (msg.toolCalls || []).find((step) => step.toolCallId === data.toolCallId)?.input || {}, result: data.result, isError: data.isError, fileUpdate: data.fileUpdate },
            ],
            activity: { phase: "tool", toolCallId: data.toolCallId, updatedAt: Date.now() },
          }));
          if (data.fileUpdate && !data.isError) {
            onFileUpdateRef.current?.(data.fileUpdate);
          }
          break;

        case "done":
          if (data.requestId) setRequestOutcomes((current) => recordRequestOutcome(current, data.requestId, "completed"));
          if (data.requestId) outboundRequestIdsRef.current.delete(data.requestId);
          if (data.requestId) pendingAttachmentSendsRef.current.delete(data.requestId);
          setPendingApprovals((previous) =>
            previous.filter((item) => item.requestId !== data.requestId)
          );
          finishRequest(data.requestId);
          void refreshConversations();
          break;

        case "stopped":
          if (data.requestId) setRequestOutcomes((current) => recordRequestOutcome(current, data.requestId, "stopped"));
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
          if (data.requestId) setRequestOutcomes((current) => recordRequestOutcome(current, data.requestId, "failed"));
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
    const timer = window.setInterval(() => { if (connected) void refreshConversations(); }, 5000);
    return () => window.clearInterval(timer);
  }, [connected, refreshConversations]);

  useEffect(() => {
    conversationLoadTokenRef.current += 1;
    pendingAttachmentSendsRef.current.clear();
    uncertainAttachmentSendsRef.current.clear();
    outboundRequestIdsRef.current.clear();
    preserveComposerModeRef.current = false;
    requestScopesRef.current.clear();
    cancelledRequestIdsRef.current.clear();
    loadingConversationRef.current = false;
    currentRunIdRef.current = null;
    setConversationActivity({});
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
    (content: string, context?: FileContext, modeOverride?: AgentMode, attachments: ChatAttachmentRef[] = [], retryRequestId?: string, contextReferences: ContextReference[] = [], options?: { requestId?: string; preserveMode?: boolean; modelName?: string }): boolean => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || loadingConversationRef.current) return false;
      const requestId = retryRequestId || options?.requestId || createRequestId();
      if (options?.requestId && (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(options.requestId) || outboundRequestIdsRef.current.has(options.requestId) || messages.some((message) => message.requestId === options.requestId))) return false;
      const requestedMode = modeOverride || agentMode;
      requestScopesRef.current.set(requestId, { conversationId: currentConversationIdRef.current, viewEpoch: conversationLoadTokenRef.current });

      const userMsg: ChatMessage = {
        requestId,
        role: "user",
        content,
        timestamp: Date.now(),
        ...(attachments.length ? { attachments } : {}),
        ...(contextReferences.length ? { contextReferences } : {}),
      };
      const assistantMsg: ChatMessage = {
        requestId,
        role: "assistant",
        content: "",
        timestamp: Date.now(),
        activity: { phase: "waiting", waitingFor: "acceptance", updatedAt: Date.now() },
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
          contextReferences,
          referenceWorkspaceDir: workspaceDir,
          history,
          conversationId: currentConversationIdRef.current,
          mode: requestedMode,
          ...((options?.modelName || selectedModelName) ? { modelName: options?.modelName || selectedModelName } : {}),
        }));
      } catch {
        return false;
      }
      setMessages((prev) => [...prev.filter((message) => message.requestId !== requestId), userMsg, assistantMsg]);
      setRequestOutcomes((current) => { const next = { ...current }; delete next[requestId]; return next; });
      preserveComposerModeRef.current = options?.preserveMode === true;
      outboundRequestIdsRef.current.add(requestId);
      if (attachments.length) pendingAttachmentSendsRef.current.set(requestId, { content, attachments, conversationId: currentConversationId, accepted: false });
      setActiveRequestIds((prev) =>
        prev.includes(requestId) ? prev : [...prev, requestId]
      );
      return true;
    },
    [agentMode, currentConversationId, messages, selectedModelName, workspaceDir]
  );

  const sendSteering = useCallback(
    (content: string, context?: FileContext, attachments: ChatAttachmentRef[] = [], contextReferences: ContextReference[] = []): boolean => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || loadingConversationRef.current) return false;
      const requestId = createRequestId();
      requestScopesRef.current.set(requestId, { conversationId: currentConversationIdRef.current, viewEpoch: conversationLoadTokenRef.current, runId: currentRunIdRef.current || undefined });

      const userMsg: ChatMessage = {
        requestId,
        role: "user",
        content,
        timestamp: Date.now(),
        ...(attachments.length ? { attachments } : {}),
        ...(contextReferences.length ? { contextReferences } : {}),
      };
      const assistantMsg: ChatMessage = {
        requestId,
        role: "assistant",
        content: "",
        timestamp: Date.now(),
        activity: { phase: "waiting", waitingFor: "acceptance", updatedAt: Date.now() },
      };

      try {
        ws.send(JSON.stringify({
          type: "steer",
          requestId,
          message: content,
          attachments: attachments.map((attachment) => attachment.id),
          context,
          contextReferences,
          referenceWorkspaceDir: workspaceDir,
          conversationId: currentConversationIdRef.current,
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
    [agentMode, currentConversationId, selectedModelName, workspaceDir]
  );

  const stopRequest = useCallback((requestId: string): boolean => {
    const scope = requestScopesRef.current.get(requestId);
    if (!scope) return false;
    setRequestOutcomes((current) => recordRequestOutcome(current, requestId, "stopped"));
    if (!scope.conversationId || !scope.runId) {
      cancelledRequestIdsRef.current.add(requestId);
      return true;
    }
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ type: "stop", requestId, conversationId: scope.conversationId, runId: scope.runId }));
    if (scope.conversationId === currentConversationIdRef.current && scope.runId === currentRunIdRef.current) {
      setActiveRequestIds([]);
      setPendingApprovals([]);
    }
    return true;
  }, []);

  const stopCurrentRun = useCallback(() => {
    const conversationId = currentConversationIdRef.current;
    const runId = currentRunIdRef.current;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!conversationId || !runId) {
      for (const requestId of activeRequestIds) stopRequest(requestId);
      return;
    }
    const latestRequestId = activeRequestIds[activeRequestIds.length - 1];
    ws.send(JSON.stringify({ type: "stop", conversationId, runId, requestId: latestRequestId }));
    setRequestOutcomes((current) => activeRequestIds.reduce((outcomes, id) => recordRequestOutcome(outcomes, id, "stopped"), current));
    setActiveRequestIds([]);
    setPendingApprovals([]);
    if (latestRequestId) updateAssistantByRequestId(latestRequestId, (msg) => ({ ...msg, content: msg.content || t("chat.stopping") }));
  }, [activeRequestIds, stopRequest, t, updateAssistantByRequestId]);

  const clearMessages = useCallback(() => {
    conversationLoadTokenRef.current += 1;
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "unsubscribe_run", conversationId: currentConversationIdRef.current }));
    currentRunIdRef.current = null;
    loadingConversationRef.current = false;
    preserveComposerModeRef.current = false;
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
      const approval = pendingApprovals.find((item) => item.approvalId === approvalId);
      if (!approval || approval.conversationId !== currentConversationIdRef.current || !currentRunIdRef.current) return;
      wsRef.current.send(JSON.stringify({
        type: "tool_approval",
        approvalId,
        decision,
        conversationId: currentConversationIdRef.current,
        runId: currentRunIdRef.current,
      }));
      setPendingApprovals((previous) =>
        previous.filter((item) => item.approvalId !== approvalId)
      );
    },
    [pendingApprovals]
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
    if (!conversationId || conversationId !== currentConversationIdRef.current || !currentRunIdRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: "tool_approval_all",
      conversationId,
      runId: currentRunIdRef.current,
    }));
    setPendingApprovals((previous) =>
      previous.filter((item) => item.conversationId !== conversationId)
    );
  }, []);

  const retryLast = useCallback(() => {
    const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
    if (!lastUserMessage) return;
    sendMessage(lastUserMessage.content, undefined, undefined, lastUserMessage.attachments || [], undefined, lastUserMessage.contextReferences || []);
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
      const previousConversationId = currentConversationIdRef.current;
      currentConversationIdRef.current = conversationId;
      currentRunIdRef.current = null;
      loadingConversationRef.current = true;
      preserveComposerModeRef.current = false;
      setCurrentConversationId(conversationId);
      setMessages([]);
      setActiveRequestIds([]);
      setPendingApprovals([]);
      setContextState({ estimatedTokens: 0, threshold: 60000, status: "ready", compactionCount: 0 });
      setMcpState({ status: "ready", serverCount: 0, toolCount: 0 });
      setKnowledgeState({ memoryFiles: 0, skillCount: 0 });
      setConversationActivity((current) => current[conversationId] ? { ...current, [conversationId]: { ...current[conversationId], unread: false } } : current);
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
        if (payload.id && payload.id !== conversationId) throw new Error("Conversation response does not match the selected task");
        setMessages(Array.isArray(payload.messages) ? payload.messages : []);
        for (const message of payload.messages || []) if (message.requestId) requestScopesRef.current.set(message.requestId, { conversationId, viewEpoch: loadToken, runId: payload.lastRunId });
        currentConversationIdRef.current = payload.id || conversationId;
        setCurrentConversationId(payload.id || conversationId);
        setAgentMode(payload.mode || "code");
        setCurrentRunSummary(payload.summary || null);
        if (payload.lastRunId) {
          const run = await fetchHydratedRun(payload.lastRunId);
          if (!isCurrentLoad()) return;
          if (run.conversationId === (payload.id || conversationId)) {
            currentRunIdRef.current = run.runId;
            setRunState(run);
            if (run.summary) {
              setCurrentRunSummary(run.executionPlan ? { ...run.summary, executionPlan: run.executionPlan } : run.summary);
            }
          }
        }
        const ws = wsRef.current;
        if (isCurrentLoad() && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "subscribe_run", conversationId }));
      } catch (error) {
        if (!isCurrentLoad()) return;
        currentConversationIdRef.current = previousConversationId;
        setCurrentConversationId(previousConversationId);
        if (previousConversationId && wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: "subscribe_run", conversationId: previousConversationId }));
        setHistoryError(
          error instanceof Error
            ? error.message
            : t("chat.failedToLoadConversation")
        );
      } finally {
        if (isCurrentLoad()) { loadingConversationRef.current = false; setHistoryLoadingId(null); }
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
      const viewEpoch = conversationLoadTokenRef.current;
      try {
        const hydrated = await fetchHydratedRun(runId);
        if (viewEpoch !== conversationLoadTokenRef.current) return;
        if (hydrated.conversationId !== currentConversationIdRef.current) {
          await loadConversation(hydrated.conversationId);
        }
        if (hydrated.conversationId !== currentConversationIdRef.current) return;
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
      if (currentConversationIdRef.current !== conversationId || wsRef.current?.readyState !== WebSocket.OPEN) return;
      const requestId = createRequestId();
      requestScopesRef.current.set(requestId, { conversationId, viewEpoch: conversationLoadTokenRef.current });
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
    stopRequest,
    clearMessages,
    retryLast,
    isStreaming: activeRequestIds.length > 0 || runState?.status === "running" || runState?.status === "queued",
    activeRequestIds,
    conversationActivity,
    requestOutcomes,
    connected,
    aiHealth,
    checkAiHealth,
    currentConversationId,
    getCurrentConversationId: () => currentConversationIdRef.current,
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
