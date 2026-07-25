import { WebSocket } from "ws";
import { config } from "../config.js";
import {
  OpenAIMessage,
  OpenAIResponse,
  AgentMode,
  ToolFileUpdate,
  WsServerMessage,
  wsSend,
  AgentRunEventInput,
} from "./types.js";
import { callChatCompletion } from "./llm.js";
import { getAllTools, MCP_CONTROL_TOOLS, TOOL_DISPATCH } from "./tools.js";
import { TodoManager } from "./todoManager.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import type { UserSession } from "../auth/sessionManager.js";
import type { PersistedChatMessage } from "../chat/history.js";
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
import { resolveMaxOutputTokens } from "./modelCapabilities.js";
import { classifyToolApproval, type ToolApprovalDecision } from "./toolApproval.js";

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
  const tools = getAllTools({ readOnly: readOnlyWorkspace, mode });
  const mcpClient = getMcpClient();
  const mcpSelection = new McpToolSelection();
  const toolCtx = {
    workspaceDir: session.workspaceDir,
    vllmApiUrl: config.vllmApiUrl,
    vllmApiKey: config.vllmApiKey,
    modelName: config.modelName,
    actorName: session.username,
    todoManager,
    taskManager: session.taskManager,
    messageBus: session.messageBus,
    teammateManager: session.teammateManager,
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
      const result = await compactMessages({
        workspaceDir: session.workspaceDir,
        messages,
        apiUrl: config.vllmApiUrl,
        apiKey: config.vllmApiKey,
        model: config.modelName,
      });
      messages = result.messages;
      compactionCount += 1;
      lastCompactedAt = Date.now();
      lastTranscriptPath = result.transcriptPath;
      lastCompactionPreview = result.preview;
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

    for (let i = 0; i < config.maxAgentIterations; i++) {
      if (ws.readyState !== WebSocket.OPEN) return persistedAssistantMessages;
      if (control?.isStopped()) {
        await stopCurrentTurn(currentAssistantMessage);
        return persistedAssistantMessages;
      }
      if (await consumeSteeringTurns(currentAssistantMessage)) {
        continue outer;
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
      const mcpDiscovery = await mcpClient.discoverTools(false, mcpSelection);
      if (mcpDiscovery.servers.length > 0) {
        const failedServers = mcpDiscovery.servers.filter((server) => !server.ok);
        emit({
          type: "mcp_state",
          requestId: currentRequestId,
          status: failedServers.length > 0 ? "warning" : "ready",
          serverCount: mcpDiscovery.servers.filter((server) => server.ok).length,
          toolCount: mcpDiscovery.tools.length,
          servers: mcpDiscovery.servers,
          message:
            failedServers.length > 0
              ? failedServers.map((server) => `${server.endpoint}: ${server.error}`).join(" | ")
              : undefined,
        });
        availableTools = [...tools, ...mcpDiscovery.tools];
        if (mcpDiscovery.hasLazyEndpoints) {
          availableTools = [...availableTools, ...MCP_CONTROL_TOOLS];
        }
      }

      // Non-streaming call for tool-use rounds
      let resp: Response;
      try {
        const maxOutputTokens = await resolveMaxOutputTokens({
          apiUrl: config.vllmApiUrl,
          apiKey: config.vllmApiKey,
          modelName: config.modelName,
          fallbackMaxOutputTokens: config.agentMaxTokens,
        });
        resp = await callChatCompletion({
          apiUrl: config.vllmApiUrl,
          apiKey: config.vllmApiKey,
          model: config.modelName,
          systemPrompt,
          messages,
          tools: availableTools,
          maxTokens: maxOutputTokens,
          temperature: 0.3,
          stream: false,
          signal: control?.createAbortSignal(),
        });
      } catch (e: any) {
        if (control?.isStopped() || e?.name === "AbortError") {
          await stopCurrentTurn(currentAssistantMessage);
          return persistedAssistantMessages;
        }
        await recordRunEvent(
          {
            kind: "error",
            label: "Model request failed",
            requestId: currentRequestId,
            isError: true,
            durationMs: Date.now() - modelCallStartedAt,
            detail: e?.message || String(e),
          },
          {
            modelErrors: (currentMetrics?.modelErrors || 0) + 1,
          }
        );
        emit({
          type: "error",
          requestId: currentRequestId,
          content: `LLM request failed: ${e.message}`,
        });
        await flushAssistantTurn(
          currentAssistantMessage,
          currentRequestId,
          onAssistantTurnComplete
        );
        return persistedAssistantMessages;
      }

      if (control?.isStopped()) {
        await stopCurrentTurn(currentAssistantMessage);
        return persistedAssistantMessages;
      }

      if (!resp.ok) {
        const errText = await resp.text();
        await recordRunEvent(
          {
            kind: "error",
            label: "Model returned an error",
            requestId: currentRequestId,
            isError: true,
            durationMs: Date.now() - modelCallStartedAt,
            detail: `HTTP ${resp.status}: ${errText.slice(0, 300)}`,
          },
          {
            modelErrors: (currentMetrics?.modelErrors || 0) + 1,
          }
        );
        emit({
          type: "error",
          requestId: currentRequestId,
          content: `vLLM error (${resp.status}): ${errText.slice(0, 300)}`,
        });
        await flushAssistantTurn(
          currentAssistantMessage,
          currentRequestId,
          onAssistantTurnComplete
        );
        return persistedAssistantMessages;
      }

      let data: OpenAIResponse;
      try {
        data = (await resp.json()) as OpenAIResponse;
      } catch (e: any) {
        await recordRunEvent(
          {
            kind: "error",
            label: "Model response could not be parsed",
            requestId: currentRequestId,
            isError: true,
            durationMs: Date.now() - modelCallStartedAt,
            detail: e?.message || String(e),
          },
          {
            modelErrors: (currentMetrics?.modelErrors || 0) + 1,
          }
        );
        emit({
          type: "error",
          requestId: currentRequestId,
          content: `Failed to parse LLM response: ${e.message}`,
        });
        await flushAssistantTurn(
          currentAssistantMessage,
          currentRequestId,
          onAssistantTurnComplete
        );
        return persistedAssistantMessages;
      }

      const choice = data.choices?.[0];
      if (!choice) {
        await recordRunEvent(
          {
            kind: "error",
            label: "Model returned no choice",
            requestId: currentRequestId,
            isError: true,
            durationMs: Date.now() - modelCallStartedAt,
          },
          {
            modelErrors: (currentMetrics?.modelErrors || 0) + 1,
          }
        );
        emit({ type: "error", requestId: currentRequestId, content: "No response from LLM" });
        await flushAssistantTurn(
          currentAssistantMessage,
          currentRequestId,
          onAssistantTurnComplete
        );
        return persistedAssistantMessages;
      }

      const usage = data.usage || {};
      const promptTokens =
        typeof usage.prompt_tokens === "number" ? Math.max(0, usage.prompt_tokens) : 0;
      const completionTokens =
        typeof usage.completion_tokens === "number"
          ? Math.max(0, usage.completion_tokens)
          : 0;
      const totalTokens =
        typeof usage.total_tokens === "number"
          ? Math.max(0, usage.total_tokens)
          : promptTokens + completionTokens;
      await recordRunEvent(
        {
          kind: "model_response",
          label: "Model response received",
          requestId: currentRequestId,
          durationMs: Date.now() - modelCallStartedAt,
          detail: `finish_reason=${choice.finish_reason || "unknown"}`,
        },
        {
          promptTokens: (currentMetrics?.promptTokens || 0) + promptTokens,
          completionTokens: (currentMetrics?.completionTokens || 0) + completionTokens,
          totalTokens: (currentMetrics?.totalTokens || 0) + totalTokens,
        }
      );

      const assistantMsg = choice.message;
      const finishReason = choice.finish_reason;

      // Push assistant message to history
      messages.push({
        role: "assistant",
        content: assistantMsg.content,
        tool_calls: assistantMsg.tool_calls,
      });

      // Check for tool calls
      if (
        finishReason === "tool_calls" &&
        assistantMsg.tool_calls &&
        assistantMsg.tool_calls.length > 0
      ) {
        // Send any reasoning text (parse <think> tags)
        if (assistantMsg.content) {
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
        const executedToolCalls: typeof assistantMsg.tool_calls = [];
        let compressRequested = false;
        for (const toolCall of assistantMsg.tool_calls) {
          if (control?.isStopped()) {
            await stopCurrentTurn(currentAssistantMessage);
            return persistedAssistantMessages;
          }
          executedToolCalls.push(toolCall);
          if (toolCall.function.name === "compress") {
            compressRequested = true;
          }
          const args = parseToolArgs(toolCall.function.arguments);
          const toolStartedAt = Date.now();
          const toolMetrics = control?.runRecorder?.snapshot().metrics;
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
          const handler = TOOL_DISPATCH[toolCall.function.name];
          const approval = classifyToolApproval(toolCall.function.name, args);
          let shouldExecute = true;
          if (approval.kind === "blocked") {
            result = `Error: Tool blocked by safety policy: ${approval.reason}`;
            isError = true;
            shouldExecute = false;
          } else if (approval.kind === "approval") {
            const decision = await control?.requestToolApproval?.({
              requestId: currentRequestId,
              toolCallId: toolCall.id,
              name: toolCall.function.name,
              input: args,
              risk: approval.risk,
              reason: approval.reason,
              scope: approval.scope,
              canAllowSession: approval.canAllowSession,
              sessionKey: approval.sessionKey,
            }) || "deny";
            if (decision === "deny" || control?.isStopped()) {
              result = "Error: Tool execution was denied or cancelled before approval";
              isError = true;
              shouldExecute = false;
            }
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
              result = await mcpClient.callTool(toolCall.function.name, args);
            } catch (e: any) {
              result = `[MCP Error] ${e.message}`;
              isError = true;
            }
          } else if (shouldExecute && handler) {
            try {
              const execution = await handler(args, toolCtx);
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
          if (result.startsWith("Error:") || result.startsWith("[MCP Error]")) {
            isError = true;
            fileUpdate = undefined;
          }

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

      // No tool calls — this is the final text response
      const rawText = assistantMsg.content || "";
      const { thinking, rest: finalText } = extractThinkTags(rawText);

      // Send thinking content first
      if (thinking) {
        currentAssistantMessage.thinking = `${
          currentAssistantMessage.thinking || ""
        }${thinking}`;
        emit({ type: "thinking", requestId: currentRequestId, content: thinking });
      }

      if (finalText) {
        currentAssistantMessage.content = finalText;
        // Send as tokens in chunks for typewriter effect
        const chunkSize = 8;
        for (let j = 0; j < finalText.length; j += chunkSize) {
          if (ws.readyState !== WebSocket.OPEN) return persistedAssistantMessages;
          if (control?.isStopped()) {
            await stopCurrentTurn(currentAssistantMessage);
            return persistedAssistantMessages;
          }
          emit({
            type: "token",
            requestId: currentRequestId,
            content: finalText.slice(j, j + chunkSize),
          });
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

    // Max iterations
    const iterationMetrics = control?.runRecorder?.snapshot().metrics;
    await recordRunEvent(
      {
        kind: "error",
        label: "Agent iteration limit reached",
        requestId: currentRequestId,
        isError: true,
        detail: `Maximum iterations: ${config.maxAgentIterations}`,
      },
      {
        modelErrors: (iterationMetrics?.modelErrors || 0) + 1,
      }
    );
    emit({
      type: "error",
      requestId: currentRequestId,
      content: "Agent loop exceeded maximum iterations",
    });
    await flushAssistantTurn(
      currentAssistantMessage,
      currentRequestId,
      onAssistantTurnComplete
    );
    return persistedAssistantMessages;
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
  conversationId?: string;
  runRecorder?: AgentRunRecorder;
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

  await onAssistantTurnComplete?.(message, requestId);
}
