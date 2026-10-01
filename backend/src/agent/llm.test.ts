import assert from "node:assert/strict";
import test from "node:test";
import { readChatCompletionResponse } from "./llm.js";

function sseResponse(parts: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  );
}

test("assembles split SSE text and usage while emitting real deltas", async () => {
  const deltas: string[] = [];
  const response = sseResponse([
    'data: {"choices":[{"delta":{"content":"hel"},"finish_reason":null}]}\r\n',
    '\r\ndata: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
    "data: [DONE]\n\n",
  ]);
  const result = await readChatCompletionResponse(response, {
    onContentDelta: (delta) => deltas.push(delta),
  });
  assert.deepEqual(deltas, ["hel", "lo"]);
  assert.equal(result.choices[0].message.content, "hello");
  assert.equal(result.choices[0].finish_reason, "stop");
  assert.equal(result.usage?.total_tokens, 5);
});

test("assembles fragmented indexed tool calls", async () => {
  const response = sseResponse([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"write_","arguments":"{\\"path\\":"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"\\"a.ts\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  const result = await readChatCompletionResponse(response);
  assert.deepEqual(result.choices[0].message.tool_calls?.[0], {
    id: "call-1",
    type: "function",
    function: { name: "write_file", arguments: '{"path":"a.ts"}' },
  });
  assert.equal(result.choices[0].finish_reason, "tool_calls");
});

test("does not invent a terminal finish reason when the stream omits it", async () => {
  const response = sseResponse([
    'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  const result = await readChatCompletionResponse(response);
  assert.equal(result.choices[0].message.content, "partial");
  assert.equal(result.choices[0].finish_reason, null);
});

test("does not infer tool_calls from fragments without a terminal finish reason", async () => {
  const response = sseResponse([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  const result = await readChatCompletionResponse(response);
  assert.equal(result.choices[0].message.tool_calls?.length, 1);
  assert.equal(result.choices[0].finish_reason, null);
});

test("falls back to a regular JSON completion response", async () => {
  const response = Response.json({
    choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  });
  const result = await readChatCompletionResponse(response);
  assert.equal(result.choices[0].message.content, "ok");
});

test("JSON compatibility responses expose only provider-supplied reasoning as reasoning", async () => {
  const reasoning: string[] = [];
  await readChatCompletionResponse(Response.json({ choices: [{ message: { role: "assistant", content: "I will inspect a file", reasoning_content: "Actual provider reasoning" }, finish_reason: "stop" }] }), { onReasoningDelta: (value) => reasoning.push(value) });
  assert.deepEqual(reasoning, ["Actual provider reasoning"]);
  await readChatCompletionResponse(Response.json({ choices: [{ message: { role: "assistant", content: "Ordinary reply" }, finish_reason: "stop" }] }), { onReasoningDelta: (value) => reasoning.push(value) });
  assert.deepEqual(reasoning, ["Actual provider reasoning"], "ordinary content must not be fabricated into reasoning");
});

test("reasoning deltas reach consumers before the SSE response finishes", async () => {
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const reasoning: string[] = []; let completed = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { writer = controller; } });
  const pending = readChatCompletionResponse(new Response(stream, { headers: { "content-type": "text/event-stream" } }), { onReasoningDelta: (value) => reasoning.push(value) }).then((value) => { completed = true; return value; });
  writer.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"visible now"}}]}\n\n'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reasoning, ["visible now"]);
  assert.equal(completed, false);
  writer.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"final"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
  writer.close();
  assert.equal((await pending).choices[0].message.content, "final");
});
