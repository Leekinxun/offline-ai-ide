import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { config } from "../config.js";
import type { UserSession } from "../auth/sessionManager.js";
import { readRunRecord, AgentRunRecorder } from "../chat/runHistory.js";
import { estimateModelRequest } from "./modelBudget.js";
import { runAgentLoop } from "./loop.js";
import { MessageBus } from "./messageBus.js";
import { readRunEvidence } from "./runEvidence.js";
import { TaskManager } from "./taskManager.js";
import { TeammateManager } from "./teammateManager.js";
import type { OpenAIMessage, WsServerMessage } from "./types.js";

function fixture(t: test.TestContext, prefix = "crewforge-loop-context-budget-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const taskManager = new TaskManager(root);
  const messageBus = new MessageBus(root);
  const session: UserSession = { token: prefix, username: "tester", workspaceDir: root, workspaceRoot: root, isAdmin: false, isolated: false, taskManager, messageBus, teammateManager: new TeammateManager(root, messageBus, taskManager) };
  return { root, session };
}

function tool(id: string, name: string, args: Record<string, unknown>): OpenAIMessage {
  return { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}

function stop(content = "Done."): OpenAIMessage {
  return { role: "assistant", content };
}

function parsedBody(body: string): { messages: OpenAIMessage[]; tools?: any[]; max_tokens?: number } {
  return JSON.parse(body) as { messages: OpenAIMessage[]; tools?: any[]; max_tokens?: number };
}

function bodyText(body: string): string {
  return JSON.stringify(parsedBody(body).messages);
}

async function withConfig<T>(patch: () => void, run: () => Promise<T>): Promise<T> {
  const previous = {
    fetch: globalThis.fetch,
    contextCompactThreshold: config.contextCompactThreshold,
    agentProfiles: config.agentProfiles,
    models: config.models,
    modelFallbacks: config.modelFallbacks,
  };
  patch();
  try { return await run(); }
  finally {
    globalThis.fetch = previous.fetch;
    config.contextCompactThreshold = previous.contextCompactThreshold;
    config.agentProfiles = previous.agentProfiles;
    config.models = previous.models;
    config.modelFallbacks = previous.modelFallbacks;
  }
}

test("loop budget fallback preserves original goal, live correction, and raw transcript evidence", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "warning-a.log"), `WARNING_RAW_MARKER_A\n${"alpha warning body ".repeat(2600)}`);
  fs.writeFileSync(path.join(f.root, "warning-b.log"), `WARNING_RAW_MARKER_B\n${"beta warning body ".repeat(2600)}`);
  fs.writeFileSync(path.join(f.root, "warning-c.log"), `WARNING_RAW_MARKER_C\n${"gamma warning body ".repeat(2600)}`);

  await withConfig(() => {
    config.contextCompactThreshold = 8_000;
    config.agentProfiles = { ask: { budget: { maxSteps: 8, maxToolCalls: 12, maxTokens: 512 } } } as typeof config.agentProfiles;
    config.models = [{ modelName: "budget-loop-model", apiUrl: "http://provider.test/v1", apiKey: "", maxTokens: 512 }];
    config.modelFallbacks = [];
  }, async () => {
    const providerBodies: string[] = [];
    const mainBodies: string[] = [];
    const compactionBodies: string[] = [];
    let mainCalls = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "budget-loop-model", max_output_tokens: 512 }] });
      const body = String(init?.body || "");
      providerBodies.push(body);
      const text = bodyText(body);
      if (/Summarize the following coding-agent conversation context/.test(text)) {
        compactionBodies.push(body);
        return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "" } }] });
      }
      mainBodies.push(body);
      mainCalls += 1;
      if (mainCalls === 1) {
        return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "read-warning-a", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "warning-a.log" }) } },
            { id: "read-warning-b", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "warning-b.log" }) } },
            { id: "read-warning-c", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "warning-c.log" }) } },
          ],
        } }] });
      }
      return Response.json({ choices: [{ finish_reason: "stop", message: stop("Completed after bounded fallback context.") }] });
    };

    const events: WsServerMessage[] = [];
    const recorder = new AgentRunRecorder(f.root, "run-budget", "conversation-budget", "ask", undefined, undefined, undefined, "budget-loop-model");
    await recorder.start();
    let correctionSent = false;
    await runAgentLoop(
      { readyState: WebSocket.OPEN, send() {} } as unknown as WebSocket,
      "ORIGINAL GOAL: inspect warning logs without losing evidence.",
      "request-budget",
      f.session,
      undefined,
      undefined,
      (event) => events.push(event),
      () => {
        if (!correctionSent && mainCalls >= 1) {
          correctionSent = true;
          return [{ requestId: "request-correction", message: "HUMAN CORRECTION: final status color is amber." }];
        }
        return [];
      },
      undefined,
      undefined,
      { mode: "ask", modelName: "budget-loop-model", conversationId: "conversation-budget", runRecorder: recorder, isStopped: () => false, createAbortSignal: () => undefined }
    );

    assert.equal(compactionBodies.length, 1, "summary provider was attempted once");
    assert.ok(mainBodies.length >= 2, "run resumed after bounded fallback");
    const finalMain = parsedBody(mainBodies[mainBodies.length - 1]);
    const system = finalMain.messages.find((message) => message.role === "system")?.content;
    const nonSystemMessages = finalMain.messages.filter((message) => message.role !== "system");
    assert.equal(estimateModelRequest({ systemPrompt: String(system || ""), messages: nonSystemMessages, tools: finalMain.tools as any[] || [], maxOutputTokens: finalMain.max_tokens || 512 }).tokens <= config.contextCompactThreshold, true);
    const finalText = JSON.stringify(finalMain.messages);
    assert.match(finalText, /ORIGINAL GOAL: inspect warning logs/);
    assert.match(finalText, /HUMAN CORRECTION: final status color is amber/);
    assert.doesNotMatch(finalText, /(?:alpha warning body ){100}/);

    const record = readRunRecord(f.root, "run-budget");
    assert.equal(record.executionFacts?.compactions.summaryCount, 0);
    assert.equal(record.executionFacts?.compactions.fallbackTrimCount, 1);
    assert.ok(record.events.some((event) => event.kind === "context_compacted" && event.isError && /fallback_trim/.test(event.detail || "")));
    const contextStates = events.filter((event): event is Extract<WsServerMessage, { type: "context_state" }> => event.type === "context_state");
    assert.ok(contextStates.some((event) => event.status === "warning" && /summary failed/i.test(event.message || "")));

    const evidence = JSON.parse(await readRunEvidence({ view: "transcript", query: "WARNING_RAW_MARKER_A", limit: 500 }, { workspaceDir: f.root, vllmApiUrl: "", vllmApiKey: "", modelName: "budget-loop-model", runId: "run-budget", conversationId: "conversation-budget" }));
    assert.equal(evidence.available, true);
    assert.match(evidence.content, /WARNING_RAW_MARKER_A/);
    assert.ok(typeof evidence.ref.transcriptPath === "string" && evidence.ref.transcriptPath.startsWith(".transcripts/"));
    assert.ok(providerBodies.length >= 3);
  });
});

test("duplicate read facts survive loop-guard warning text on repeated file reads", async (t) => {
  const f = fixture(t, "crewforge-loop-duplicate-facts-");
  fs.writeFileSync(path.join(f.root, "dup.txt"), "duplicate evidence\n");

  await withConfig(() => {
    config.contextCompactThreshold = 60_000;
    config.agentProfiles = { ask: { budget: { maxSteps: 8, maxToolCalls: 8, maxTokens: 512 } } } as typeof config.agentProfiles;
    config.models = [{ modelName: "duplicate-loop-model", apiUrl: "http://provider.test/v1", apiKey: "", maxTokens: 512 }];
    config.modelFallbacks = [];
  }, async () => {
    let calls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "duplicate-loop-model", max_output_tokens: 512 }] });
      calls += 1;
      if (calls <= 3) return Response.json({ choices: [{ finish_reason: "tool_calls", message: tool(`dup-read-${calls}`, "read_file", { path: "dup.txt" }) }] });
      return Response.json({ choices: [{ finish_reason: "stop", message: stop("Duplicate reads observed.") }] });
    };
    const recorder = new AgentRunRecorder(f.root, "run-duplicate", "conversation-duplicate", "ask", undefined, undefined, undefined, "duplicate-loop-model");
    await recorder.start();
    const result = await runAgentLoop(
      { readyState: WebSocket.OPEN, send() {} } as unknown as WebSocket,
      "Read dup.txt three times to exercise duplicate counters.",
      "request-duplicate",
      f.session,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { mode: "ask", modelName: "duplicate-loop-model", conversationId: "conversation-duplicate", runRecorder: recorder, isStopped: () => false, createAbortSignal: () => undefined }
    );
    const warningResult = result[0].toolCalls?.find((item) => /Agent loop guard/.test(item.result || ""));
    assert.ok(warningResult, "third identical read should include loop guard warning in displayed result");
    const facts = readRunRecord(f.root, "run-duplicate").executionFacts;
    assert.equal(facts?.fileReads, 3);
    assert.equal(facts?.duplicateFileReads, 2);
    assert.equal(facts?.readRanges[0]?.count, 3);
  });
});
