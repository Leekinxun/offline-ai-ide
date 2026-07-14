import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateMessageTokens,
  microcompactMessages,
  safeTrimMessages,
} from "./context.js";
import { OpenAIMessage } from "./types.js";

test("estimates context size using a stable character heuristic", () => {
  const messages: OpenAIMessage[] = [{ role: "user", content: "a".repeat(400) }];
  assert.equal(estimateMessageTokens(messages), Math.ceil(JSON.stringify(messages).length / 4));
});

test("microcompaction clears older tool results and keeps recent output", () => {
  const messages: OpenAIMessage[] = [
    { role: "user", content: "start" },
    { role: "tool", content: "old-1", tool_call_id: "1" },
    { role: "tool", content: "old-2", tool_call_id: "2" },
    { role: "tool", content: "recent-1", tool_call_id: "3" },
    { role: "tool", content: "recent-2", tool_call_id: "4" },
  ];

  const compacted = microcompactMessages(messages, 2);
  assert.equal(compacted[1].content, "[cleared]");
  assert.equal(compacted[2].content, "[cleared]");
  assert.equal(compacted[3].content, "recent-1");
  assert.equal(compacted[4].content, "recent-2");
  assert.equal(messages[1].content, "old-1");
});

test("safe trim returns a valid recent user/assistant window", () => {
  const messages: OpenAIMessage[] = [
    { role: "user", content: "old" },
    { role: "assistant", content: "tool call", tool_calls: [{ id: "1", type: "function", function: { name: "bash", arguments: "{}" } }] },
    { role: "tool", content: "large result", tool_call_id: "1" },
    { role: "user", content: "latest" },
  ];

  const trimmed = safeTrimMessages(messages, 2);
  assert.deepEqual(trimmed.map((message) => message.content), ["old", "tool call", "latest"]);
  assert.equal(trimmed[0].tool_calls, undefined);
});

test("keeps important tool failures during microcompaction", () => {
  const messages: OpenAIMessage[] = [
    { role: "user", content: "goal" },
    { role: "tool", content: "Error: deployment failed", tool_call_id: "1" },
    { role: "tool", content: "x".repeat(180), tool_call_id: "2" },
    { role: "tool", content: "recent", tool_call_id: "3" },
  ];

  const compacted = microcompactMessages(messages, 1);
  assert.equal(compacted[1].content, "Error: deployment failed");
  assert.equal(compacted[2].content, "[cleared]");
  assert.equal(compacted[3].content, "recent");
});
