import { useState, useRef, useCallback, useEffect } from "react";
import {
  ChatMessage,
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
}

interface ForkConversationResponse {
  conversation?: ConversationSummary;
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

export function useChat(
  token: string,
  workspaceDir: string,
  onFileUpdate?: (update: FileUpdate) => void
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
  const [agentMode, setAgentMode] = useState<AgentMode>("plan");
  const [runtimeOptions, setRuntimeOptions] = useState<ChatRuntimeOptions>({
    defaultModelName: "",
    models: [],
    modeModels: {},
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
      });
      setSelectedModelName((current) =>
        current && !models.includes(current) ? "" : current
      );
    } catch {
      // Mode defaults remain authoritative when runtime discovery is unavailable.
    }
  }, [token]);

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

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/chat?token=${encodeURIComponent(token)}`);

    ws.onopen = () => {
      setConnected(true);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };

    ws.onclose = () => {
      // Only clear if this WebSocket is still the current one.
      // Prevents React StrictMode double-mount from wiping the new connection.
      if (wsRef.current === ws) {
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
          setCurrentConversationId(data.conversationId);
          void refreshConversations();
          break;

        case "conversation_updated":
          void refreshConversations();
          break;

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
          setPendingApprovals((previous) =>
            previous.filter((item) => item.requestId !== data.requestId)
          );
          finishRequest(data.requestId);
          void refreshConversations();
          break;

        case "stopped":
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

        case "error":
          updateAssistantByRequestId(data.requestId, (msg) => ({
            ...msg,
            content: msg.content || `Error: ${data.content}`,
          }));
          finishRequest(data.requestId);
          if (data.requestId) {
            setPendingApprovals((previous) =>
              previous.filter((item) => item.requestId !== data.requestId)
            );
          }
          void refreshConversations();
          break;
      }
    };

    wsRef.current = ws;
  }, [contextManifest.acceptIndexEvent, contextManifest.acceptManifestEvent, finishRequest, refreshConversations, updateAssistantByRequestId, token]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  useEffect(() => {
    conversationLoadTokenRef.current += 1;
    setMessages([]);
    setCurrentConversationId(null);
    setHistoryError(null);
    setActiveRequestIds([]);
    setAgentMode("plan");
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
    (content: string, context?: FileContext, modeOverride?: AgentMode) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      const requestId = createRequestId();
      const requestedMode = modeOverride || agentMode;

      const userMsg: ChatMessage = {
        requestId,
        role: "user",
        content,
        timestamp: Date.now(),
      };
      const assistantMsg: ChatMessage = {
        requestId,
        role: "assistant",
        content: "",
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setActiveRequestIds((prev) =>
        prev.includes(requestId) ? prev : [...prev, requestId]
      );

      const history = messages.slice(-10).map((m) => ({
        role: m.role,
        content: m.content,
      }));

      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        finishRequest(requestId);
        return;
      }
      wsRef.current.send(
        JSON.stringify({
          requestId,
          message: content,
          context,
          history,
          conversationId: currentConversationId,
          mode: requestedMode,
          ...(selectedModelName ? { modelName: selectedModelName } : {}),
        })
      );
    },
    [agentMode, currentConversationId, finishRequest, messages, selectedModelName]
  );

  const sendSteering = useCallback(
    (content: string, context?: FileContext) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      const requestId = createRequestId();

      const userMsg: ChatMessage = {
        requestId,
        role: "user",
        content,
        timestamp: Date.now(),
      };
      const assistantMsg: ChatMessage = {
        requestId,
        role: "assistant",
        content: "",
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setActiveRequestIds((prev) =>
        prev.includes(requestId) ? prev : [...prev, requestId]
      );

      wsRef.current.send(
        JSON.stringify({
          type: "steer",
          requestId,
          message: content,
          context,
          conversationId: currentConversationId,
          mode: agentMode,
          ...(selectedModelName ? { modelName: selectedModelName } : {}),
        })
      );
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
    setMessages([]);
    setCurrentConversationId(null);
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
    sendMessage(lastUserMessage.content);
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
      setCurrentConversationId(conversationId);
      setActiveRequestIds([requestId]);
      wsRef.current.send(
        JSON.stringify({ type: "resume", conversationId, runId, requestId })
      );
    },
    [activeRequestIds.length, currentConversationId, loadConversation]
  );

  return {
    messages,
    sendMessage,
    sendSteering,
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
