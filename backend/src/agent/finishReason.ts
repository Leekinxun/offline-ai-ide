import type { OpenAIChoice } from "./types.js";

export type ModelTurnAction = "stop" | "tool_calls";

export function requireModelTurnAction(choice: OpenAIChoice): ModelTurnAction {
  const finishReason = choice.finish_reason;
  const toolCallCount = choice.message.tool_calls?.length || 0;

  if (finishReason === "tool_calls") {
    if (toolCallCount === 0) {
      throw new Error("Provider returned finish_reason=tool_calls without tool calls");
    }
    return "tool_calls";
  }

  if (finishReason === "stop") {
    if (toolCallCount > 0) {
      throw new Error("Provider returned finish_reason=stop together with tool calls");
    }
    return "stop";
  }

  if (finishReason === "length") {
    throw new Error("Model response reached the output token limit before completion");
  }

  if (finishReason === null || finishReason === undefined) {
    throw new Error("Provider response is missing a terminal finish_reason");
  }

  throw new Error(`Provider returned unsupported finish_reason: ${String(finishReason)}`);
}
