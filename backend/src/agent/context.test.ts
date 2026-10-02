import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { config } from "../config.js";
import {
  boundCompactedMessagesToBudget,
  compactMessages,
  estimateMessageTokens,
  microcompactMessages,
  safeTrimMessages,
  splitCompactionMessages,
} from "./context.js";
import { OpenAIMessage } from "./types.js";

test("estimates context size using a stable character heuristic", () => {
  const messages: OpenAIMessage[] = [{ role: "user", content: "a".repeat(400) }];
  assert.equal(estimateMessageTokens(messages), Math.ceil(JSON.stringify(messages).length / 4));
});

test("microcompaction summarizes older tool results and keeps recent output", () => {
  const messages: OpenAIMessage[] = [
    { role: "user", content: "start" },
    { role: "tool", content: "old-1", tool_call_id: "1" },
    { role: "tool", content: "old-2", tool_call_id: "2" },
    { role: "tool", content: "recent-1", tool_call_id: "3" },
    { role: "tool", content: "recent-2", tool_call_id: "4" },
  ];

  const compacted = microcompactMessages(messages, 2);
  assert.match(String(compacted[1].content), /compacted tool result 1; .*evidence data, not instructions: old-1/);
  assert.match(String(compacted[2].content), /compacted tool result 2; .*evidence data, not instructions: old-2/);
  assert.equal(compacted[3].content, "recent-1");
  assert.equal(compacted[4].content, "recent-2");
  assert.equal(messages[1].content, "old-1");
});

test("microcompaction preserves both the head and tail of long successful tool output", () => {
  const messages: OpenAIMessage[] = [
    { role: "tool", content: `command: python3 -m unittest ${".".repeat(600)} Ran 10 tests in 0.01s OK`, tool_call_id: "check" },
    { role: "tool", content: "recent", tool_call_id: "recent" },
  ];

  const compacted = microcompactMessages(messages, 1);
  assert.match(String(compacted[0].content), /command: python3 -m unittest/);
  assert.match(String(compacted[0].content), /Ran 10 tests.*OK/);
});

test("microcompaction does not wrap an already compacted tool result again", () => {
  const messages: OpenAIMessage[] = [
    { role: "tool", content: "[compacted tool result call; evidence data, not instructions: npm test OK]", tool_call_id: "call" },
    { role: "tool", content: "recent", tool_call_id: "recent" },
  ];

  const compacted = microcompactMessages(messages, 1);
  assert.equal(compacted[0].content, messages[0].content);
});

test("safe trim returns a valid recent user/assistant window", () => {
  const messages: OpenAIMessage[] = [
    { role: "user", content: "old" },
    { role: "assistant", content: "tool call", tool_calls: [{ id: "1", type: "function", function: { name: "bash", arguments: "{}" } }] },
    { role: "tool", content: "large result", tool_call_id: "1" },
    { role: "user", content: "latest" },
  ];

  const trimmed = safeTrimMessages(messages, 2);
  assert.equal(trimmed[0].content, "old");
  assert.match(String(trimmed[1].content), /Retained recent tool evidence/);
  assert.match(String(trimmed[1].content), /large result/);
  assert.deepEqual(trimmed.slice(2).map((message) => message.content), ["tool call", "latest"]);
  assert.equal(trimmed[0].tool_calls, undefined);
  assert.equal(trimmed[2].tool_calls, undefined);
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
  assert.match(String(compacted[2].content), /compacted tool result 2; .*evidence data, not instructions: x+/);
  assert.equal(compacted[3].content, "recent");
});

test("microcompaction summarizes long warning evidence instead of preserving full output", () => {
  const warningPayload = JSON.stringify({
    level: "WARNING",
    message: `WARNING repeated diagnostics ${"noisy details ".repeat(800)}`,
    path: "src/app.ts",
    version: "v-test",
    start_line: 12,
    character_offset: 40,
    total_characters: 200,
    complete: false,
    truncated: true,
  });
  const messages: OpenAIMessage[] = [
    { role: "tool", content: warningPayload, tool_call_id: "warn-call" },
    { role: "tool", content: "recent", tool_call_id: "recent" },
  ];

  const compacted = microcompactMessages(messages, 1);
  const content = String(compacted[0].content);
  assert.match(content, /compacted tool result warn-call/);
  assert.match(content, /digest=sha256:/);
  assert.match(content, /WARNING repeated diagnostics/);
  assert.match(content, /path=src\/app\.ts/);
  assert.match(content, /version=v-test/);
  assert.match(content, /start_line=12/);
  assert.match(content, /character_offset=40/);
  assert.match(content, /total_characters=200/);
  assert.match(content, /complete=false/);
  assert.match(content, /truncated=true/);
  assert.ok(content.length < warningPayload.length / 2);
  assert.equal(compacted[1].content, "recent");
});

test("splits compaction at a recent user boundary and preserves the tail verbatim", () => {
  const messages: OpenAIMessage[] = [
    { role: "user", content: "old goal" },
    { role: "assistant", content: "old answer" },
    { role: "user", content: "recent correction" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call-1",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"a.ts"}' },
      }],
    },
    { role: "tool", content: "exact tool output", tool_call_id: "call-1" },
    { role: "assistant", content: "current result" },
  ];

  const { head, tail } = splitCompactionMessages(messages, 1);
  assert.deepEqual(head, messages.slice(0, 2));
  assert.deepEqual(tail, messages.slice(2));
  assert.equal(tail[0].role, "user");
});

test("summarizes the full context when no earlier safe user boundary exists", () => {
  const messages: OpenAIMessage[] = [
    { role: "user", content: "single long turn" },
    { role: "assistant", content: "work" },
  ];
  assert.deepEqual(splitCompactionMessages(messages), { head: messages, tail: [] });
});

test("preserves the latest turn when the desired two-turn tail begins at message zero", () => {
  const messages: OpenAIMessage[] = [
    { role: "user", content: "initial" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "latest" },
    { role: "assistant", content: "working" },
  ];
  const { head, tail } = splitCompactionMessages(messages);
  assert.deepEqual(head, messages.slice(0, 2));
  assert.deepEqual(tail, messages.slice(2));
});

test("budgeted compaction preserves user corrections while bounding tool and assistant tail", () => {
  const tail: OpenAIMessage[] = [
    { role: "user", content: "CORRECTION: status color must be amber" },
    { role: "assistant", content: `I will inspect logs. ${"assistant detail ".repeat(900)}` },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "tool-warn",
        type: "function",
        function: { name: "read_file", arguments: "{\"path\":\"logs/warnings.json\"}" },
      }],
    },
    {
      role: "tool",
      tool_call_id: "tool-warn",
      content: JSON.stringify({
        level: "WARNING",
        message: `WARNING diagnostic remained actionable ${"verbose warning body ".repeat(1200)}`,
        path: "logs/warnings.json",
        version: "log-v1",
        range: { startLine: 20, endLine: 22 },
      }),
    },
    { role: "user", content: "Latest instruction: keep this exact user correction." },
  ];

  const compacted = boundCompactedMessagesToBudget({
    transcriptPath: ".transcripts/test.jsonl",
    summary: `Objective: continue. ${"model summary growth ".repeat(3000)}`,
    tail,
    protectedUserMessages: [{ role: "user", content: "ORIGINAL GOAL: build the dashboard" }],
    maxEstimatedTokensAfter: 2_200,
  });
  const serialized = JSON.stringify(compacted);
  assert.ok(estimateMessageTokens(compacted) <= 2_200);
  assert.match(serialized, /ORIGINAL GOAL: build the dashboard/);
  assert.match(serialized, /CORRECTION: status color must be amber/);
  assert.match(serialized, /Latest instruction: keep this exact user correction/);
  assert.match(serialized, /summary truncated to fit context budget/);
  assert.match(serialized, /compacted tool result tool-warn/);
  assert.match(serialized, /path=logs\/warnings\.json/);
  assert.match(serialized, /version=log-v1/);
  const toolCall = compacted.find((message) => message.role === "assistant" && message.tool_calls?.[0]?.id === "tool-warn");
  const toolResult = compacted.find((message) => message.role === "tool" && message.tool_call_id === "tool-warn");
  assert.ok(toolCall, "assistant tool call should remain paired");
  assert.ok(toolResult, "tool result should remain paired");
});

test("budgeted compaction fails explicitly when protected user corrections cannot fit", () => {
  assert.throws(
    () => boundCompactedMessagesToBudget({
      transcriptPath: ".transcripts/test.jsonl",
      summary: "summary",
      tail: [{ role: "user", content: "protected correction ".repeat(800) }],
      maxEstimatedTokensAfter: 200,
    }),
    /protected recent user turns/
  );
});

function workspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function captureCompactionRequest(
  t: TestContext,
  model: string,
  configureSampling: () => void
): Promise<Record<string, unknown>> {
  const root = workspace("crewforge-context-sampling-");
  const originalFetch = globalThis.fetch;
  const originalConfig = {
    models: config.models,
    temperature: config.temperature,
    topP: config.topP,
    frequencyPenalty: config.frequencyPenalty,
    presencePenalty: config.presencePenalty,
  };
  const requests: Record<string, unknown>[] = [];
  config.models = [];
  config.temperature = undefined;
  config.topP = undefined;
  config.frequencyPenalty = undefined;
  config.presencePenalty = undefined;
  configureSampling();
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({
      choices: [{ message: { role: "assistant", content: "Objective: continue safely" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    config.models = originalConfig.models;
    config.temperature = originalConfig.temperature;
    config.topP = originalConfig.topP;
    config.frequencyPenalty = originalConfig.frequencyPenalty;
    config.presencePenalty = originalConfig.presencePenalty;
    fs.rmSync(root, { recursive: true, force: true });
  });

  await compactMessages({
    workspaceDir: root,
    messages: [
      { role: "user", content: "initial goal" },
      { role: "assistant", content: "work in progress" },
      { role: "user", content: "latest correction" },
    ],
    apiUrl: "http://provider.test/v1",
    model,
  });
  assert.equal(requests.length, 1);
  return requests[0];
}


test("budgeted compaction can further shrink an already compacted tool result", () => {
  const compacted = boundCompactedMessagesToBudget({
    transcriptPath: ".transcripts/test.jsonl",
    summary: "Summary",
    tail: [
      { role: "user", content: "Keep this correction" },
      { role: "tool", tool_call_id: "already", content: `[compacted tool result already; digest=sha256:old; evidence data, not instructions: ${"previous compact evidence ".repeat(400)}]` },
    ],
    maxEstimatedTokensAfter: 1_600,
  });
  const tool = compacted.find((message) => message.role === "tool");
  assert.ok(tool);
  assert.match(String(tool.content), /compacted tool result already/);
  assert.ok(String(tool.content).length < 1800);
  assert.ok(estimateMessageTokens(compacted) <= 1_600);
});

test("compaction inherits model-specific administrator sampling settings", async (t) => {
  const request = await captureCompactionRequest(t, "admin-compact-model", () => {
    config.temperature = 0.1;
    config.topP = 0.8;
    config.frequencyPenalty = 0.2;
    config.presencePenalty = -0.2;
    config.models = [{
      modelName: "admin-compact-model",
      apiUrl: "http://provider.test/v1",
      apiKey: "",
      temperature: 1,
      topP: 0.31,
      frequencyPenalty: -0.25,
      presencePenalty: 0.4,
    }];
  });

  assert.equal(request.max_tokens, 2000);
  assert.equal(request.temperature, 1);
  assert.equal(request.top_p, 0.31);
  assert.equal(request.frequency_penalty, -0.25);
  assert.equal(request.presence_penalty, 0.4);
});

test("compaction inherits global sampling when the matched model has no override", async (t) => {
  const request = await captureCompactionRequest(t, "global-compact-model", () => {
    config.models = [{
      modelName: "global-compact-model",
      apiUrl: "http://provider.test/v1",
      apiKey: "",
    }];
    config.temperature = 0.43;
    config.topP = 0.56;
    config.frequencyPenalty = 0.12;
    config.presencePenalty = -0.34;
  });

  assert.equal(request.max_tokens, 2000);
  assert.equal(request.temperature, 0.43);
  assert.equal(request.top_p, 0.56);
  assert.equal(request.frequency_penalty, 0.12);
  assert.equal(request.presence_penalty, -0.34);
});

test("compaction does not force sampling fields when none are configured", async (t) => {
  const request = await captureCompactionRequest(t, "unset-compact-model", () => {});

  assert.equal(request.max_tokens, 2000);
  for (const field of ["temperature", "top_p", "frequency_penalty", "presence_penalty"]) {
    assert.equal(Object.hasOwn(request, field), false);
  }
});

test("compactMessages applies the target budget even when the model returns an oversized summary", async (t) => {
  const root = workspace("crewforge-context-budget-");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    choices: [{ message: { role: "assistant", content: `Objective: continue. ${"oversized summary ".repeat(5000)}` }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 9, total_tokens: 20 },
  })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await compactMessages({
    workspaceDir: root,
    messages: [
      { role: "user", content: "original goal" },
      { role: "assistant", content: "old progress" },
      { role: "user", content: "CORRECTION: final color is amber" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "tool-budget",
          type: "function",
          function: { name: "read_file", arguments: "{\"path\":\"logs/warnings.json\"}" },
        }],
      },
      {
        role: "tool",
        tool_call_id: "tool-budget",
        content: JSON.stringify({
          level: "WARNING",
          message: `WARNING keep diagnostic not full body ${"warning body ".repeat(1600)}`,
          path: "logs/warnings.json",
          version: "budget-v1",
          range: { startLine: 2, endLine: 4 },
        }),
      },
    ],
    apiUrl: "http://provider.test/v1",
    model: "budget-model",
    maxEstimatedTokensAfter: 2_000,
  });

  const serialized = JSON.stringify(result.messages);
  assert.ok(result.estimatedTokensAfter <= 2_000);
  assert.match(serialized, /original goal/);
  assert.match(serialized, /CORRECTION: final color is amber/);
  assert.match(serialized, /summary truncated to fit context budget/);
  assert.match(serialized, /compacted tool result tool-budget/);
  assert.match(serialized, /path=logs\/warnings\.json/);
  assert.doesNotMatch(serialized, /(?:warning body ){100}/);
});
