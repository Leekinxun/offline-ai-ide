import assert from "node:assert/strict";
import test from "node:test";
import { estimateMessageTokens, microcompactMessages, safeTrimMessages } from "./context.js";
import { OpenAIMessage } from "./types.js";

test("keeps a synthetic long agent task within a bounded context window", () => {
  let messages: OpenAIMessage[] = [
    { role: "user", content: "Implement the requested project change and verify it." },
  ];

  for (let turn = 0; turn < 120; turn += 1) {
    messages.push(
      { role: "assistant", content: `Planning turn ${turn}` },
      {
        role: "tool",
        content: turn % 17 === 0
          ? `Error: check failed during turn ${turn}`
          : `command output ${turn} ${"x".repeat(1800)}`,
        tool_call_id: `tool-${turn}`,
      },
      { role: "assistant", content: `Completed turn ${turn}` },
    );
    messages = microcompactMessages(messages, 3);
    if (estimateMessageTokens(messages) > 28_000) {
      messages = safeTrimMessages(messages, 12);
    }
  }

  assert.ok(messages.some((message) => message.role === "user"));
  assert.ok(messages.some((message) => message.role === "tool" && /Error:/.test(message.content || "")));
  assert.ok(estimateMessageTokens(messages) <= 28_000);
});
