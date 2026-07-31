import assert from "node:assert/strict";
import test from "node:test";
import { requireModelTurnAction } from "./finishReason.js";
import type { OpenAIChoice } from "./types.js";

function choice(
  finishReason: OpenAIChoice["finish_reason"],
  toolCalls: OpenAIChoice["message"]["tool_calls"] = []
): OpenAIChoice {
  return {
    message: { role: "assistant", content: "", tool_calls: toolCalls },
    ...(finishReason === undefined ? {} : { finish_reason: finishReason }),
  };
}

const toolCall = {
  id: "call-1",
  type: "function" as const,
  function: { name: "read_file", arguments: '{"path":"README.md"}' },
};

test("accepts only explicit stop as a completed model turn", () => {
  assert.equal(requireModelTurnAction(choice("stop")), "stop");
});

test("accepts explicit tool_calls only when calls are present", () => {
  assert.equal(requireModelTurnAction(choice("tool_calls", [toolCall])), "tool_calls");
  assert.throws(
    () => requireModelTurnAction(choice("tool_calls")),
    /without tool calls/
  );
});

test("rejects missing, null, truncated, and contradictory finish reasons", () => {
  assert.throws(
    () => requireModelTurnAction(choice(undefined)),
    /missing a terminal finish_reason/
  );
  assert.throws(
    () => requireModelTurnAction(choice(null)),
    /missing a terminal finish_reason/
  );
  assert.throws(
    () => requireModelTurnAction(choice("length")),
    /output token limit/
  );
  assert.throws(
    () => requireModelTurnAction(choice("stop", [toolCall])),
    /together with tool calls/
  );
});
