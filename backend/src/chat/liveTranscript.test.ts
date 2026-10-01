import assert from "node:assert/strict";
import test from "node:test";
import { LiveTranscript } from "./liveTranscript.js";
import type { AgentRunMetrics } from "../agent/types.js";

const metrics: AgentRunMetrics = { iterations: 0, modelCalls: 1, toolCalls: 0, toolErrors: 0, modelErrors: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0, estimatedTokensPeak: 0, compactionCount: 0 };
test("reconnecting before the first token preserves an active request and truthful waiting state", () => {
  const transcript = new LiveTranscript();
  transcript.accept({ type: "run_state", requestId: "request", runId: "run", conversationId: "conversation", mode: "ask", status: "running", metrics, event: { id: "event", timestamp: 1, kind: "model_call", label: "Model request started", requestId: "request" } });
  const snapshot = transcript.snapshot([]);
  assert.deepEqual(snapshot.activeRequestIds, ["request"]);
  assert.equal(snapshot.messages[0].content, "");
  assert.equal(snapshot.messages[0].thinking, undefined);
  assert.equal(snapshot.messages[0].activity?.phase, "waiting");
  transcript.accept({ type: "thinking", requestId: "request", content: "provider reasoning" });
  assert.equal(transcript.snapshot([]).messages[0].activity?.phase, "reasoning");
  transcript.accept({ type: "tool_result", requestId: "request", toolCallId: "tool", name: "read_file", result: "read result", isError: false });
  assert.equal(transcript.snapshot([]).messages[0].toolCalls?.[0].result, "read result");
  assert.equal(transcript.snapshot([]).messages[0].activity?.phase, "tool");
});
