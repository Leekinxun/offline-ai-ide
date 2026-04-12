import { WebSocket } from "ws";
import { config } from "../config.js";
import {
  OpenAIMessage,
  OpenAIResponse,
  OpenAIToolCall,
  wsSend,
} from "./types.js";
import { getAllTools, TOOL_DISPATCH } from "./tools.js";
import { TodoManager } from "./todoManager.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import type { UserSession } from "../auth/sessionManager.js";

async function callVllm(
  systemPrompt: string,
  messages: OpenAIMessage[],
  tools: ReturnType<typeof getAllTools>,
  stream: boolean = false
): Promise<Response> {
  const body: Record<string, unknown> = {
    model: config.modelName,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    max_tokens: config.agentMaxTokens,
    temperature: 0.3,
    stream,
  };
  if (tools.length > 0) {
    body.tools = tools;
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.vllmApiKey) {
    headers["Authorization"] = `Bearer ${config.vllmApiKey}`;
  }
  return fetch(`${config.vllmApiUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
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
  userMessage: string,
  session: UserSession,
  context?: { path: string; content: string; language: string; selection?: string },
  history?: { role: string; content: string }[]
): Promise<void> {
  const todoManager = new TodoManager();
  const tools = getAllTools();
  const toolCtx = {
    workspaceDir: session.workspaceDir,
    vllmApiUrl: config.vllmApiUrl,
    vllmApiKey: config.vllmApiKey,
    modelName: config.modelName,
    todoManager,
    taskManager: session.taskManager,
    messageBus: session.messageBus,
    teammateManager: session.teammateManager,
  };

  // Build user content with file/selection context
  let userContent: string;
  if (context?.selection) {
    userContent =
      `File: \`${context.path}\` (${context.language || "plaintext"})\n` +
      `User has selected the following code:\n\`\`\`${context.language || ""}\n${context.selection}\n\`\`\`\n\n` +
      userMessage;
  } else if (context?.content) {
    userContent =
      `Current file: \`${context.path}\` (${context.language || "plaintext"})\n` +
      `\`\`\`${context.language || ""}\n${context.content}\n\`\`\`\n\n` +
      userMessage;
  } else {
    userContent = userMessage;
  }

  // Build message history
  const messages: OpenAIMessage[] = [
    ...(history || []).slice(-10).map((h) => ({
      role: h.role as "user" | "assistant",
      content: h.content,
    })),
    { role: "user" as const, content: userContent },
  ];

  for (let i = 0; i < config.maxAgentIterations; i++) {
    if (ws.readyState !== WebSocket.OPEN) return;

    const systemPrompt = buildSystemPrompt(session.workspaceDir, todoManager.render());

    // Non-streaming call for tool-use rounds
    let resp: Response;
    try {
      resp = await callVllm(systemPrompt, messages, tools, false);
    } catch (e: any) {
      wsSend(ws, { type: "error", content: `LLM request failed: ${e.message}` });
      return;
    }

    if (!resp.ok) {
      const errText = await resp.text();
      wsSend(ws, { type: "error", content: `vLLM error (${resp.status}): ${errText.slice(0, 300)}` });
      return;
    }

    let data: OpenAIResponse;
    try {
      data = (await resp.json()) as OpenAIResponse;
    } catch (e: any) {
      wsSend(ws, { type: "error", content: `Failed to parse LLM response: ${e.message}` });
      return;
    }

    const choice = data.choices?.[0];
    if (!choice) {
      wsSend(ws, { type: "error", content: "No response from LLM" });
      return;
    }

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
          wsSend(ws, { type: "thinking", content: thinking });
        }
        if (rest) {
          wsSend(ws, { type: "thinking", content: rest });
        }
      }

      // Execute each tool call
      for (const toolCall of assistantMsg.tool_calls) {
        const args = parseToolArgs(toolCall.function.arguments);
        wsSend(ws, {
          type: "tool_call",
          toolCallId: toolCall.id,
          name: toolCall.function.name,
          input: args,
        });

        let result: string;
        let isError = false;
        const handler = TOOL_DISPATCH[toolCall.function.name];
        if (handler) {
          try {
            result = await handler(args, toolCtx);
          } catch (e: any) {
            result = `Error: ${e.message}`;
            isError = true;
          }
        } else {
          result = `Unknown tool: ${toolCall.function.name}`;
          isError = true;
        }

        wsSend(ws, {
          type: "tool_result",
          toolCallId: toolCall.id,
          name: toolCall.function.name,
          result: result.slice(0, 5000),
          isError,
        });

        // Add tool result to message history
        messages.push({
          role: "tool",
          content: result.slice(0, 50000),
          tool_call_id: toolCall.id,
        });
      }

      // Continue to next iteration
      continue;
    }

    // No tool calls — this is the final text response
    const rawText = assistantMsg.content || "";
    const { thinking, rest: finalText } = extractThinkTags(rawText);

    // Send thinking content first
    if (thinking) {
      wsSend(ws, { type: "thinking", content: thinking });
    }

    if (finalText) {
      // Send as tokens in chunks for typewriter effect
      const chunkSize = 8;
      for (let j = 0; j < finalText.length; j += chunkSize) {
        if (ws.readyState !== WebSocket.OPEN) return;
        wsSend(ws, { type: "token", content: finalText.slice(j, j + chunkSize) });
      }
    }
    wsSend(ws, { type: "done" });
    return;
  }

  // Max iterations
  wsSend(ws, { type: "error", content: "Agent loop exceeded maximum iterations" });
}
