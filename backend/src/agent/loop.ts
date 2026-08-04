import { WebSocket } from "ws";
import { config } from "../config.js";
import {
  OpenAIMessage,
  AgentMode,
  ToolFileUpdate,
  WsServerMessage,
  wsSend,
  AgentRunEventInput,
} from "./types.js";
import { getAllTools, MCP_CONTROL_TOOLS, TOOL_DISPATCH } from "./tools.js";
import { TodoManager } from "./todoManager.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import type { UserSession } from "../auth/sessionManager.js";
import { withStructuredParts, type PersistedChatMessage } from "../chat/history.js";
import { canWriteActiveWorkspace } from "../team/sessionBridge.js";
import { getMcpClient, McpToolSelection } from "./mcp.js";
import { loadMemorySnapshot } from "./memory.js";
import { listWorkspaceSkills } from "./skills.js";
import {
  compactMessages,
  type ContextCompactionPreview,
  estimateMessageTokens,
  microcompactMessages,
  safeTrimMessages,
} from "./context.js";
import { AgentRunRecorder } from "../chat/runHistory.js";
import { classifyToolApproval, type ToolApprovalDecision } from "./toolApproval.js";
import { ProviderRequestError } from "./providerErrors.js";
import { createPermissionAuthorizer } from "./permissionService.js";
import { ThinkStreamSplitter } from "./thinkStream.js";
import { processModelTurn } from "./modelProcessor.js";
import { ToolLoopGuard } from "./toolLoopGuard.js";
import { requireModelTurnAction } from "./finishReason.js";
import {
  agentProfileAllowsTool,
  estimateUsageCostUsd,
  resolveAgentProfile,
} from "./agentProfiles.js";
import { runAgentHooks } from "./agentHooks.js";
import { createCheckpoint } from "../chat/checkpoints.js";

const SNAPSHOT_TOOL_NAMES = new Set([
  "write_file",
  "edit_file",
  "bash",
  "task",
  "spawn_teammate",
]);

function shouldCreateStepSnapshot(toolName: string): boolean {
  return SNAPSHOT_TOOL_NAMES.has(toolName) || toolName.startsWith("mcp_");
}

/**
 * Extract <think>...</think> blocks from LLM output.
 * Returns { thinking, rest } where `rest` is the text with think tags removed.
 */
function extractThinkTags(text: string): { thinking: string; rest: string } {
  const thinkParts: string[] = [];
  const rest = text.replace(/<think>([\s\S]*?)<\/think>/g, (_match, content) => {
    thinkParts.push(content.trim());
    return "";
  });
  return { thinking: thinkParts.join("\n"), rest: rest.trim() };
}

function parseToolArgs(argsStr: string): Record<string, unknown> {
  try {
    return JSON.parse(argsStr);
  } catch {
    return { _raw: argsStr };
  }
}

export async function runAgentLoop(
  ws: WebSocket,
  initialUserMessage: string,
  requestId: string,
  session: UserSession,
  context?: { path: string; content: string; language: string; selection?: string },
  history?: { role: string; content: string }[],
  onEmit?: (message: WsServerMessage) => void,
  consumePendingUserMessages?: () => PendingUserTurn[],
  onUserTurnStart?: (turn: PendingUserTurn) => Promise<void> | void,
  onAssistantTurnComplete?: (
    message: PersistedChatMessage,
    requestId: string
  ) => Promise<void> | void,
  control?: AgentLoopControl
): Promise<PersistedChatMessage[]> {
  const emit = (message: WsServerMessage) => {
    onEmit?.(message);
    wsSend(ws, message);
  };

  const persistedAssistantMessages: PersistedChatMessage[] = [];

  const todoManager = new TodoManager();
  const readOnlyWorkspace = !canWriteActiveWorkspace(session);
  const mode = control?.mode || "code";
  const agentProfile = resolveAgentProfile(mode, config.agentProfiles, {
    modelName: config.modelName,
    maxOutputTokens: config.agentMaxTokens,
    maxSteps: config.maxAgentIterations,
  });
  const modelName = control?.modelName || agentProfile.modelName || config.modelName;
  const runStartedAt = Date.now();
  const runSignal = control?.createAbortSignal();
  const tools = getAllTools({
    readOnly: readOnlyWorkspace,
    mode,
    constrainedCode: Boolean(control?.executionPlan),
  }).filter((tool) =>
    agentProfileAllowsTool(agentProfile, tool.function.name)
  );
  const authorizeTool = createPermissionAuthorizer({
    mode,
    readOnly: readOnlyWorkspace,
    signal: runSignal,
    requestApproval: control?.requestToolApproval,
    profile: agentProfile,
    runId: control?.runRecorder?.runId,
    executionPlan: control?.executionPlan,
  });
  const mcpClient = getMcpClient();
  const mcpSelection = new McpToolSelection();
  const toolLoopGuard = new ToolLoopGuard();
  const toolCtx = {
    workspaceDir: session.workspaceDir,
    vllmApiUrl: config.vllmApiUrl,
    vllmApiKey: config.vllmApiKey,
    modelName,
    actorName: session.username,
    todoManager,
    taskManager: session.taskManager,
    messageBus: session.messageBus,
    teammateManager: session.teammateManager,
    authorizeTool,
    signal: runSignal,
    agentProfileId: agentProfile.id,
    mode,
    conversationId: control?.conversationId,
    runId: control?.runRecorder?.runId,
    executionPlan: control?.executionPlan,
  };

  // Build user content with file/selection context
  // Build message history
  let messages: OpenAIMessage[] = [
    ...(history || []).slice(-10).map((h) => ({
      role: h.role as "user" | "assistant",
      content: h.content,
    })),
  ];

  const appendUserTurn = (turn: PendingUserTurn) => {
    messages.push({
      role: "user",
      content: buildUserContent(turn.message, turn.context),
    });
  };

  appendUserTurn({
    requestId,
    message: initialUserMessage,
    context,
  });

  let pendingTurns: PendingUserTurn[] = consumePendingUserMessages?.() || [];
  let currentRequestId = requestId;
  let compactionCount = 0;
  let lastCompactedAt: number | undefined;
  let lastTranscriptPath: string | undefined;
  let lastCompactionPreview: ContextCompactionPreview | undefined;
  let knowledgeStateSent = false;
  let approvedPlanSubmitted = false;

  const recordRunEvent = async (
    event: AgentRunEventInput,
    metricsPatch: Record<string, number> = {}
  ): Promise<void> => {
    if (!control?.runRecorder) return;
    const snapshot = await control.runRecorder.event(event, metricsPatch);
    emit({
      type: "run_state",
      conversationId: control.conversationId || control.runRecorder.conversationId,
      runId: control.runRecorder.runId,
      mode,
      status: "running",
      metrics: snapshot.metrics,
      event: snapshot.events[snapshot.events.length - 1],
    });
  };

  const emitContextState = (
    status: "ready" | "compacting" | "warning",
    message?: string
  ) => {
    emit({
      type: "context_state",
      requestId: currentRequestId,
      estimatedTokens: estimateMessageTokens(messages),
      estimatedTokensAfter: lastCompactionPreview?.estimatedTokensAfter,
      threshold: config.contextCompactThreshold,
      status,
      compactionCount,
      lastCompactedAt,
      transcriptPath: lastTranscriptPath,
      preview: lastCompactionPreview,
      message,
    });
  };

  const compactContextIfNeeded = async (force = false) => {
    messages = microcompactMessages(messages);
    const estimatedTokens = estimateMessageTokens(messages);
    if (!force && estimatedTokens <= config.contextCompactThreshold) {
      emitContextState("ready");
      return;
    }

    emitContextState("compacting");
    try {
      await runAgentHooks("beforeCompaction", {
        agentId: agentProfile.id,
        runId: control?.runRecorder?.runId,
        conversationId: control?.conversationId,
        requestId: currentRequestId,
        metadata: { force, estimatedTokens },
      });
      const result = await compactMessages({
        workspaceDir: session.workspaceDir,
        messages,
        apiUrl: config.vllmApiUrl,
        apiKey: config.vllmApiKey,
        model: modelName,
        signal: runSignal,
      });
      messages = result.messages;
      compactionCount += 1;
      lastCompactedAt = Date.now();
      lastTranscriptPath = result.transcriptPath;
      lastCompactionPreview = result.preview;
      await runAgentHooks("afterCompaction", {
        agentId: agentProfile.id,
        runId: control?.runRecorder?.runId,
        conversationId: control?.conversationId,
        requestId: currentRequestId,
        output: result.preview,
      });
      await recordRunEvent(
        {
          kind: "context_compacted",
          label: "Context compacted",
          detail: `${estimatedTokens} estimated tokens before compaction`,
        },
        {
          compactionCount,
          estimatedTokensPeak: Math.max(
            control?.runRecorder?.snapshot().metrics.estimatedTokensPeak || 0,
            estimatedTokens
          ),
        }
      );
      emitContextState("ready");
    } catch (error) {
      await runAgentHooks("afterCompaction", {
        agentId: agentProfile.id,
        runId: control?.runRecorder?.runId,
        conversationId: control?.conversationId,
        requestId: currentRequestId,
        error: error instanceof Error ? error.message : String(error),
      });
      messages = safeTrimMessages(messages);
      await recordRunEvent({
        kind: "error",
        label: "Context compaction failed",
        isError: true,
        detail: error instanceof Error ? error.message : "unknown error",
      });
      emitContextState(
        "warning",
        `Context summary failed; retained a recent message window (${error instanceof Error ? error.message : "unknown error"}).`
      );
    }
  };

  const stopCurrentTurn = async (
    currentAssistantMessage: PersistedChatMessage
  ) => {
    emit({
      type: "stopped",
      requestId: currentRequestId,
      content: "Stopped by user",
    });
    emit({ type: "done", requestId: currentRequestId, interrupted: true });
    await flushAssistantTurn(
      currentAssistantMessage,
      currentRequestId,
      onAssistantTurnComplete
    );
  };

  const consumeSteeringTurns = async (
    currentAssistantMessage: PersistedChatMessage
  ): Promise<boolean> => {
    const steeringTurns = consumePendingUserMessages?.() || [];
    if (steeringTurns.length === 0) {
      return false;
    }

    pendingTurns = [...pendingTurns, ...steeringTurns];
    await recordRunEvent({
      kind: "steering",
      label: "Correction queued for the current run",
      requestId: steeringTurns[0]?.requestId,
      detail: `${steeringTurns.length} pending instruction(s)`,
    });
    emit({ type: "done", requestId: currentRequestId, interrupted: true });
    await flushAssistantTurn(
      currentAssistantMessage,
      currentRequestId,
      onAssistantTurnComplete
    );
    const nextTurn = pendingTurns.shift();
    if (!nextTurn) {
      return false;
    }
    currentRequestId = nextTurn.requestId;
    await onUserTurnStart?.(nextTurn);
    appendUserTurn(nextTurn);
    return true;
  };

  outer: while (true) {
    const currentAssistantMessage: PersistedChatMessage = {
      role: "assistant",
      content: "",
      timestamp: Date.now(),
    };
    persistedAssistantMessages.push(currentAssistantMessage);
    let contextOverflowRetries = 0;

    for (let i = 0; i < agentProfile.budget.maxSteps; i++) {
      if (ws.readyState !== WebSocket.OPEN) return persistedAssistantMessages;
      if (control?.isStopped()) {
        await stopCurrentTurn(currentAssistantMessage);
        return persistedAssistantMessages;
      }
      if (await consumeSteeringTurns(currentAssistantMessage)) {
        continue outer;
      }

      const budgetMetrics = control?.runRecorder?.snapshot().metrics;
      const durationExceeded = Date.now() - runStartedAt >= agentProfile.budget.maxDurationMs;
      const costExceeded =
        agentProfile.budget.maxCostUsd > 0 &&
        (budgetMetrics?.estimatedCostUsd || 0) >= agentProfile.budget.maxCostUsd;
      if (durationExceeded || costExceeded) {
        const reason = durationExceeded
          ? `Agent duration budget exceeded (${agentProfile.budget.maxDurationMs}ms)`
          : `Agent cost budget exceeded ($${agentProfile.budget.maxCostUsd})`;
        await recordRunEvent({ kind: "error", label: reason, requestId: currentRequestId, isError: true });
        emit({ type: "error", requestId: currentRequestId, content: reason });
        await flushAssistantTurn(currentAssistantMessage, currentRequestId, onAssistantTurnComplete);
        return persistedAssistantMessages;
      }

      await compactContextIfNeeded();

      const modelCallStartedAt = Date.now();
      const currentMetrics = control?.runRecorder?.snapshot().metrics;
      const estimatedTokensBeforeCall = estimateMessageTokens(messages);
      await recordRunEvent(
        {
          kind: "model_call",
          label: "Model request started",
          requestId: currentRequestId,
        },
        {
          iterations: i + 1,
          modelCalls: (currentMetrics?.modelCalls || 0) + 1,
          estimatedTokensPeak: Math.max(
            currentMetrics?.estimatedTokensPeak || 0,
            estimatedTokensBeforeCall
          ),
        }
      );

      const systemPrompt = buildSystemPrompt(session.workspaceDir, todoManager.render(), {
        readOnlyWorkspace,
        mode,
        executionPlan: control?.executionPlan,
      });

      if (!knowledgeStateSent) {
        let memoryFiles = 0;
        let skillCount = 0;
        try {
          const memory = loadMemorySnapshot(session.workspaceDir);
          memoryFiles = Number(Boolean(memory.user)) + Number(Boolean(memory.workspace));
        } catch {
          // Persistent context is best-effort; the prompt loader applies the same policy.
        }
        try {
          skillCount = listWorkspaceSkills(session.workspaceDir).length;
        } catch {
          // A malformed skill directory must not block the task.
        }
        emit({
          type: "knowledge_state",
          requestId: currentRequestId,
          memoryFiles,
          skillCount,
        });
        knowledgeStateSent = true;
      }

      let availableTools = tools;
      const mcpDiscovery = !readOnlyWorkspace && !control?.executionPlan
        ? await mcpClient.discoverTools(false, mcpSelection)
        : { tools: [], servers: [], hasLazyEndpoints: false };
      if (mcpDiscovery.servers.length > 0) {
        const failedServers = mcpDiscovery.servers.filter((server) => !server.ok && !server.disabled);
        emit({
          type: "mcp_state",
          requestId: currentRequestId,
          status: failedServers.length > 0 ? "warning" : "ready",
          serverCount: mcpDiscovery.servers.filter((server) => server.ok && !server.disabled).length,
          toolCount: mcpDiscovery.tools.length,
          servers: mcpDiscovery.servers,
          message:
            failedServers.length > 0
              ? failedServers.map((server) => `${server.endpoint}: ${server.error}`).join(" | ")
              : undefined,
        });
        availableTools = [...tools, ...mcpDiscovery.tools].filter((tool) =>
          agentProfileAllowsTool(agentProfile, tool.function.name)
        );
        if (mcpDiscovery.hasLazyEndpoints) {
          availableTools = [...availableTools, ...MCP_CONTROL_TOOLS].filter((tool) =>
            agentProfileAllowsTool(agentProfile, tool.function.name)
          );
        }
      }

      // The processor owns capability discovery, bounded provider retries, and stream parsing.
      let streamedContent = "";
      let streamedReasoning = "";
      const streamSplitter = new ThinkStreamSplitter(
        (delta) => {
          streamedContent += delta;
          currentAssistantMessage.content += delta;
          emit({ type: "token", requestId: currentRequestId, content: delta });
        },
        (delta) => {
          streamedReasoning += delta;
          currentAssistantMessage.thinking = `${currentAssistantMessage.thinking || ""}${delta}`;
          emit({ type: "thinking", requestId: currentRequestId, content: delta });
        }
      );
      let processed;
      try {
        processed = await processModelTurn({
          apiUrl: config.vllmApiUrl,
          apiKey: config.vllmApiKey,
          model: modelName,
          providerId: agentProfile.providerId,
          systemPrompt,
          messages,
          tools: availableTools,
          fallbackMaxOutputTokens: agentProfile.budget.maxOutputTokens,
          maxOutputTokens: agentProfile.budget.maxOutputTokens,
          temperature: 0.3,
          signal: runSignal,
          hookContext: {
            agentId: agentProfile.id,
            runId: control?.runRecorder?.runId,
            conversationId: control?.conversationId,
            requestId: currentRequestId,
          },
          onContentDelta: (delta) => streamSplitter.push(delta),
          onReasoningDelta: (delta) => {
            streamedReasoning += delta;
            currentAssistantMessage.thinking = `${currentAssistantMessage.thinking || ""}${delta}`;
            emit({ type: "thinking", requestId: currentRequestId, content: delta });
          },
        });
        streamSplitter.flush();
      } catch (e: any) {
        streamSplitter.flush();
        if (control?.isStopped() || e?.name === "AbortError") {
          await stopCurrentTurn(currentAssistantMessage);
          return persistedAssistantMessages;
        }
        if (
          e instanceof ProviderRequestError &&
          e.code === "context_overflow" &&
          contextOverflowRetries < 1
        ) {
          contextOverflowRetries += 1;
          await recordRunEvent({
            kind: "context_compacted",
            label: "Provider context overflow; compacting before one retry",
            requestId: currentRequestId,
            detail: e.status ? `HTTP ${e.status}` : e.message,
          });
          await compactContextIfNeeded(true);
          continue;
        }
        throw e;
      }

      const data = processed.response;

      const choice = data.choices?.[0];
      if (!choice) {
        throw new Error("Model returned no choice");
      }

      const usage = data.usage || {};
      const promptTokens =
        typeof usage.prompt_tokens === "number"
          ? Math.max(0, usage.prompt_tokens)
          : estimateMessageTokens(messages);
      const completionTokens =
        typeof usage.completion_tokens === "number"
          ? Math.max(0, usage.completion_tokens)
          : estimateMessageTokens([{
              role: "assistant",
              content: choice.message.content,
              tool_calls: choice.message.tool_calls,
            }]);
      const totalTokens =
        typeof usage.total_tokens === "number"
          ? Math.max(0, usage.total_tokens)
          : promptTokens + completionTokens;
      const estimatedCostUsd = estimateUsageCostUsd(
        agentProfile,
        promptTokens,
        completionTokens
      );
      await recordRunEvent(
        {
          kind: "model_response",
          label: "Model response received",
          requestId: currentRequestId,
          durationMs: Date.now() - modelCallStartedAt,
          detail: `finish_reason=${choice.finish_reason ?? "missing"}; provider_attempts=${processed.attempts}`,
        },
        {
          promptTokens: (currentMetrics?.promptTokens || 0) + promptTokens,
          completionTokens: (currentMetrics?.completionTokens || 0) + completionTokens,
          totalTokens: (currentMetrics?.totalTokens || 0) + totalTokens,
          estimatedCostUsd:
            (currentMetrics?.estimatedCostUsd || 0) + estimatedCostUsd,
        }
      );

      const assistantMsg = choice.message;
      const turnAction = requireModelTurnAction(choice);

      // Push assistant message to history
      messages.push({
        role: "assistant",
        content: assistantMsg.content,
        tool_calls: assistantMsg.tool_calls,
      });

      // Check for tool calls
      if (turnAction === "tool_calls") {
        const toolCalls = assistantMsg.tool_calls!;
        // Send any reasoning text (parse <think> tags)
        if (assistantMsg.content && !streamedContent && !streamedReasoning) {
          const { thinking, rest } = extractThinkTags(assistantMsg.content);
          if (thinking) {
            currentAssistantMessage.thinking = `${
              currentAssistantMessage.thinking || ""
            }${thinking}`;
            emit({ type: "thinking", requestId: currentRequestId, content: thinking });
          }
          if (rest) {
            currentAssistantMessage.thinking = `${
              currentAssistantMessage.thinking || ""
            }${rest}`;
            emit({ type: "thinking", requestId: currentRequestId, content: rest });
          }
        }

        // Execute each tool call
        const executedToolCalls: typeof toolCalls = [];
        let compressRequested = false;
        for (const toolCall of toolCalls) {
          if (control?.isStopped()) {
            await stopCurrentTurn(currentAssistantMessage);
            return persistedAssistantMessages;
          }
          executedToolCalls.push(toolCall);
          const args = parseToolArgs(toolCall.function.arguments);
          const loopDecision = toolLoopGuard.inspect(toolCall.function.name, args);
          const toolStartedAt = Date.now();
          const toolMetrics = control?.runRecorder?.snapshot().metrics;
          await control?.runRecorder?.toolState({
            toolCallId: toolCall.id,
            requestId: currentRequestId,
            name: toolCall.function.name,
            toolInput: args,
            status: "pending",
          });
          await recordRunEvent(
            {
              kind: "tool_call",
              label: "Tool execution started",
              requestId: currentRequestId,
              toolName: toolCall.function.name,
              ...(toolCall.function.name === "skill_load" && typeof args.name === "string"
                ? { detail: args.name }
                : {}),
            },
            {
              toolCalls: (toolMetrics?.toolCalls || 0) + 1,
            }
          );
          emit({
            type: "tool_call",
            requestId: currentRequestId,
            toolCallId: toolCall.id,
            name: toolCall.function.name,
            input: args,
          });

          let result = "";
          let isError = false;
          let fileUpdate: ToolFileUpdate | undefined;
          let snapshotId: string | undefined;
          const handler = TOOL_DISPATCH[toolCall.function.name];
          const approval = classifyToolApproval(toolCall.function.name, args);
          let shouldExecute = true;
          let deniedByPolicyOrUser = false;
          if ((toolMetrics?.toolCalls || 0) >= agentProfile.budget.maxToolCalls) {
            result = `Error: Agent tool-call budget exceeded (${agentProfile.budget.maxToolCalls})`;
            isError = true;
            shouldExecute = false;
          }
          if (loopDecision.action === "block") {
            result = `Error: ${loopDecision.message}`;
            isError = true;
            shouldExecute = false;
          }
          if (shouldExecute && approval.kind === "approval") {
            await control?.runRecorder?.toolState({
              toolCallId: toolCall.id,
              requestId: currentRequestId,
              name: toolCall.function.name,
              status: "awaiting_permission",
            });
          }
          if (shouldExecute) {
            const permission = await authorizeTool({
              requestId: currentRequestId,
              toolCallId: toolCall.id,
              name: toolCall.function.name,
              input: args,
              agentName: "primary",
            });
            if (!permission.allowed || control?.isStopped()) {
              result = `Error: Tool execution denied: ${permission.reason || "cancelled"}`;
              isError = true;
              shouldExecute = false;
              deniedByPolicyOrUser = true;
            }
          }

          if (shouldExecute) {
            if (agentProfile.stepSnapshots && shouldCreateStepSnapshot(toolCall.function.name)) {
              try {
                const checkpoint = createCheckpoint(session.workspaceDir, {
                  label: `Before ${toolCall.function.name}`,
                  conversationId: control?.conversationId,
                  runId: control?.runRecorder?.runId,
                  kind: "step",
                  toolCallId: toolCall.id,
                });
                snapshotId = checkpoint.id;
                await control?.runRecorder?.toolState({
                  toolCallId: toolCall.id,
                  requestId: currentRequestId,
                  name: toolCall.function.name,
                  status: "pending",
                  snapshotId,
                });
              } catch (error) {
                await control?.runRecorder?.event({
                  kind: "error",
                  label: "Step snapshot unavailable",
                  requestId: currentRequestId,
                  toolName: toolCall.function.name,
                  isError: true,
                  detail: error instanceof Error ? error.message : String(error),
                });
              }
            }
            try {
              await runAgentHooks("beforeToolExecute", {
                agentId: agentProfile.id,
                runId: control?.runRecorder?.runId,
                conversationId: control?.conversationId,
                requestId: currentRequestId,
                toolCallId: toolCall.id,
                toolName: toolCall.function.name,
                input: args,
              });
            } catch (error) {
              result = `Error: ${error instanceof Error ? error.message : String(error)}`;
              isError = true;
              shouldExecute = false;
              deniedByPolicyOrUser = true;
            }
          }

          if (shouldExecute) {
            await control?.runRecorder?.toolState({
              toolCallId: toolCall.id,
              requestId: currentRequestId,
              name: toolCall.function.name,
              status: "running",
            });
          }

          if (shouldExecute && toolCall.function.name === "search_lazy_mcp_tools") {
            try {
              result = await mcpClient.searchLazyTools(args.query, args.endpoint_key);
            } catch (e: any) {
              result = `Error: ${e.message}`;
              isError = true;
            }
          } else if (shouldExecute && toolCall.function.name === "activate_lazy_mcp_tools") {
            try {
              result = await mcpClient.activateLazyTools(
                mcpSelection,
                args.endpoint_key,
                args.tool_names
              );
            } catch (e: any) {
              result = `Error: ${e.message}`;
              isError = true;
            }
          } else if (shouldExecute && toolCall.function.name.startsWith("mcp_")) {
            try {
              result = await mcpClient.callTool(
                toolCall.function.name,
                args,
                runSignal
              );
            } catch (e: any) {
              result = `[MCP Error] ${e.message}`;
              isError = true;
            }
          } else if (shouldExecute && handler) {
            try {
              const execution = await handler(args, {
                ...toolCtx,
                ...(control?.runRecorder
                  ? {
                      lineage: {
                        parentRunId: control.runRecorder.runId,
                        parentConversationId:
                          control.conversationId || control.runRecorder.conversationId,
                        parentRequestId: currentRequestId,
                        parentToolCallId: toolCall.id,
                      },
                    }
                  : {}),
              });
              if (typeof execution === "string") {
                result = execution;
              } else {
                result = execution.output;
                fileUpdate = execution.fileUpdate;
              }
            } catch (e: any) {
              result = `Error: ${e.message}`;
              isError = true;
            }
          } else if (shouldExecute) {
            result = `Unknown tool: ${toolCall.function.name}`;
            isError = true;
          }
          if (loopDecision.action === "warn" && loopDecision.message) {
            result = `${result}\n\n[Agent loop guard] ${loopDecision.message}`;
          }
          if (result.startsWith("Error:") || result.startsWith("[MCP Error]")) {
            isError = true;
            fileUpdate = undefined;
          }
          if (!isError && toolCall.function.name === "compress") {
            compressRequested = true;
          }
          if (!isError && toolCall.function.name === "submit_plan") {
            approvedPlanSubmitted = true;
          }
          await runAgentHooks("afterToolExecute", {
            agentId: agentProfile.id,
            runId: control?.runRecorder?.runId,
            conversationId: control?.conversationId,
            requestId: currentRequestId,
            toolCallId: toolCall.id,
            toolName: toolCall.function.name,
            input: args,
            output: result,
            ...(isError ? { error: result } : {}),
          });

          await control?.runRecorder?.toolState({
            toolCallId: toolCall.id,
            requestId: currentRequestId,
            name: toolCall.function.name,
            status: deniedByPolicyOrUser ? "denied" : isError ? "failed" : "completed",
            resultSummary: result.slice(0, 2000),
            ...(isError ? { error: result.slice(0, 2000) } : {}),
            ...(snapshotId ? { snapshotId } : {}),
          });

          const afterToolMetrics = control?.runRecorder?.snapshot().metrics;
          await recordRunEvent(
            {
              kind: "tool_result",
              label: isError ? "Tool failed" : "Tool completed",
              requestId: currentRequestId,
              toolName: toolCall.function.name,
              durationMs: Date.now() - toolStartedAt,
              isError,
              detail: isError ? result.slice(0, 500) : undefined,
            },
            {
              toolErrors: (afterToolMetrics?.toolErrors || 0) + (isError ? 1 : 0),
            }
          );

          currentAssistantMessage.toolCalls = [
            ...(currentAssistantMessage.toolCalls || []).filter(
              (step) => step.toolCallId !== toolCall.id
            ),
            {
              toolCallId: toolCall.id,
              name: toolCall.function.name,
              input: args,
              result: result.slice(0, 5000),
              isError,
              fileUpdate,
            },
          ];

          emit({
            type: "tool_result",
            requestId: currentRequestId,
            toolCallId: toolCall.id,
            name: toolCall.function.name,
            result: result.slice(0, 5000),
            isError,
            fileUpdate,
          });

          // Add tool result to message history
          messages.push({
            role: "tool",
            content: result.slice(0, 50000),
            tool_call_id: toolCall.id,
          });

          const lastMessage = messages[messages.length - executedToolCalls.length - 1];
          if (lastMessage && lastMessage.role === "assistant") {
            lastMessage.tool_calls = executedToolCalls;
          }

          if (await consumeSteeringTurns(currentAssistantMessage)) {
            continue outer;
          }
        }

        if (compressRequested) {
          await compactContextIfNeeded(true);
        }

        // Continue to next iteration
        continue;
      }

      // Only an explicit finish_reason=stop reaches the final response path.
      if (mode === "plan" && !approvedPlanSubmitted) {
        messages.push({
          role: "user",
          content:
            "Runtime requirement: Plan mode cannot finish until submit_plan has been called and explicitly approved. Submit the complete structured plan now.",
        });
        continue;
      }
      const rawText = assistantMsg.content || "";
      const { thinking, rest: finalText } = extractThinkTags(rawText);

      // Send thinking content first
      if (thinking && !streamedReasoning) {
        currentAssistantMessage.thinking = `${
          currentAssistantMessage.thinking || ""
        }${thinking}`;
        emit({ type: "thinking", requestId: currentRequestId, content: thinking });
      }

      if (finalText) {
        currentAssistantMessage.content = finalText;
        // JSON-only compatibility providers still deliver one complete fallback chunk.
        if (!streamedContent) {
          emit({ type: "token", requestId: currentRequestId, content: finalText });
        }
      }

      emit({ type: "done", requestId: currentRequestId });
      await flushAssistantTurn(
        currentAssistantMessage,
        currentRequestId,
        onAssistantTurnComplete
      );

      pendingTurns = [...pendingTurns, ...(consumePendingUserMessages?.() || [])];
      const nextTurn = pendingTurns.shift();
      if (!nextTurn) {
        return persistedAssistantMessages;
      }

      currentRequestId = nextTurn.requestId;
      await onUserTurnStart?.(nextTurn);
      appendUserTurn(nextTurn);
      continue outer;
    }

    throw new Error(`Agent loop exceeded maximum iterations (${agentProfile.budget.maxSteps})`);
  }

  return persistedAssistantMessages;
}

interface PendingUserTurn {
  requestId: string;
  message: string;
  context?: { path: string; content: string; language: string; selection?: string };
  conversationId?: string;
}

export interface AgentLoopControl {
  isStopped: () => boolean;
  createAbortSignal: () => AbortSignal | undefined;
  mode?: AgentMode;
  modelName?: string;
  conversationId?: string;
  runRecorder?: AgentRunRecorder;
  executionPlan?: import("../chat/executionPlans.js").ExecutionPlan;
  requestToolApproval?: (input: {
    requestId: string;
    toolCallId: string;
    name: string;
    input: Record<string, unknown>;
    risk: "medium" | "high";
    reason: string;
    scope: string;
    canAllowSession: boolean;
    sessionKey?: string;
  }) => Promise<ToolApprovalDecision>;
}

function buildUserContent(
  userMessage: string,
  context?: { path: string; content: string; language: string; selection?: string }
): string {
  if (context?.selection) {
    return (
      `File: \`${context.path}\` (${context.language || "plaintext"})\n` +
      `User has selected the following code:\n\`\`\`${context.language || ""}\n${context.selection}\n\`\`\`\n\n` +
      userMessage
    );
  }
  if (context?.content) {
    return (
      `Current file: \`${context.path}\` (${context.language || "plaintext"})\n` +
      `\`\`\`${context.language || ""}\n${context.content}\n\`\`\`\n\n` +
      userMessage
    );
  }
  return userMessage;
}

async function flushAssistantTurn(
  message: PersistedChatMessage,
  requestId: string,
  onAssistantTurnComplete?: (
    message: PersistedChatMessage,
    requestId: string
  ) => Promise<void> | void
): Promise<void> {
  if (
    !message.content &&
    !message.thinking &&
    (!message.toolCalls || message.toolCalls.length === 0)
  ) {
    return;
  }

  Object.assign(message, withStructuredParts(message));
  await onAssistantTurnComplete?.(message, requestId);
}
