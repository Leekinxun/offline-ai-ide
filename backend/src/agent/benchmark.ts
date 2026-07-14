import { performance } from "node:perf_hooks";
import { estimateMessageTokens, microcompactMessages } from "./context.js";
import { OpenAIMessage } from "./types.js";

const messageCount = Number.parseInt(process.env.BENCHMARK_MESSAGES || "2000", 10);
const messages: OpenAIMessage[] = Array.from({ length: Math.max(100, messageCount) }, (_, index) => ({
  role: index % 3 === 0 ? "tool" : index % 2 === 0 ? "assistant" : "user",
  content: `benchmark-${index} ${"x".repeat(700)}`,
  ...(index % 3 === 0 ? { tool_call_id: `benchmark-tool-${index}` } : {}),
}));

const startedAt = performance.now();
const compacted = microcompactMessages(messages, 3);
const elapsedMs = performance.now() - startedAt;
const result = {
  messageCount: messages.length,
  elapsedMs: Number(elapsedMs.toFixed(2)),
  estimatedTokensBefore: estimateMessageTokens(messages),
  estimatedTokensAfter: estimateMessageTokens(compacted),
};

console.log(JSON.stringify(result, null, 2));
if (elapsedMs > 2_000) {
  throw new Error(`Context microcompaction exceeded the 2s benchmark budget (${elapsedMs.toFixed(2)}ms)`);
}
