import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { AgentRunRecorder } from "../chat/runHistory.js";
import { readRunEvidence } from "./runEvidence.js";
import { agentProfileAllowsTool, resolveAgentProfile } from "./agentProfiles.js";
import { evaluateModeCapability } from "./modeCapabilities.js";
import { getAllTools, TOOL_DISPATCH } from "./tools.js";
import type { ToolContext } from "./types.js";

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-run-evidence-"));
}

function ctx(root: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceDir: root,
    vllmApiUrl: "http://provider.test/v1",
    vllmApiKey: "",
    modelName: "test-model",
    runId: "run-current",
    conversationId: "conversation-current",
    ...overrides,
  };
}

async function fixture(t: TestContext) {
  const root = workspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const recorder = new AgentRunRecorder(root, "run-current", "conversation-current", "code");
  await recorder.start();
  await recorder.toolState({
    requestId: "request-1",
    toolCallId: "tool-read",
    name: "read_file",
    status: "completed",
    toolInput: { path: "src/app.ts", token: "sk-secret-value" },
    resultSummary: "Read src/app.ts token=sk-secret-value",
  });
  await recorder.recordExecutionFact({
    kind: "tool_result",
    requestId: "request-1",
    toolCallId: "tool-read",
    toolName: "read_file",
    isError: false,
    output: JSON.stringify({
      path: "src/app.ts",
      version: "v1",
      start_line: 1,
      character_offset: 0,
      total_characters: 12,
      complete: true,
      truncated: false,
      content: "hello world!",
    }),
  });
  fs.mkdirSync(path.join(root, ".transcripts"), { recursive: true });
  fs.writeFileSync(path.join(root, ".transcripts", "run-current.jsonl"), `${JSON.stringify({ role: "user", content: "original goal" })}\n${JSON.stringify({ role: "tool", content: "WARNING diagnostic line" })}\n`, "utf8");
  await recorder.event({
    kind: "context_compacted",
    label: "Context compacted",
    detail: JSON.stringify({ transcriptPath: ".transcripts/run-current.jsonl" }),
  }, { compactionCount: 1 });
  return { root, recorder };
}

test("read_run_evidence exposes bounded current-run summary and tool evidence", async (t) => {
  const { root } = await fixture(t);
  const summary = JSON.parse(await readRunEvidence({ view: "summary" }, ctx(root)));
  assert.equal(summary.view, "summary");
  assert.equal(summary.data_only, true);
  assert.equal(summary.runId, "run-current");
  assert.equal(summary.conversationId, "conversation-current");
  assert.equal(summary.executionFacts.fileReads, 1);
  assert.equal(summary.contextCompactions.length, 1);

  const tools = JSON.parse(await readRunEvidence({ view: "tools", query: "src/app.ts", limit: 5 }, ctx(root)));
  assert.equal(tools.view, "tools");
  assert.equal(tools.total, 1);
  assert.equal(tools.items[0].toolCallId, "tool-read");
  assert.equal(tools.items[0].input.path, "src/app.ts");
  assert.doesNotMatch(JSON.stringify(tools), /sk-secret-value/);
});

test("read_run_evidence reads only transcript refs recorded on current run", async (t) => {
  const { root } = await fixture(t);
  const transcript = JSON.parse(await readRunEvidence({ view: "transcript", query: "WARNING", limit: 80 }, ctx(root)));
  assert.equal(transcript.view, "transcript");
  assert.equal(transcript.available, true);
  assert.equal(transcript.ref.transcriptPath, ".transcripts/run-current.jsonl");
  assert.equal(transcript.query_match_offset >= 0, true);
  assert.match(transcript.content, /WARNING diagnostic line/);
  assert.equal(typeof transcript.next_offset === "number" || transcript.next_offset === null, true);

  const rejected = await readRunEvidence({ view: "transcript", transcript_index: 1 }, ctx(root));
  assert.match(rejected, /^Error: transcript_index must be an integer/);
});

test("read_run_evidence refuses caller supplied run ids, paths, missing context, and wrong conversation", async (t) => {
  const { root } = await fixture(t);
  assert.match(await readRunEvidence({ view: "summary", runId: "other" } as any, ctx(root)), /^Error: Unsupported read_run_evidence input: runId/);
  assert.match(await readRunEvidence({ view: "transcript", path: ".transcripts/run-current.jsonl" } as any, ctx(root)), /^Error: Unsupported read_run_evidence input: path/);
  assert.match(await readRunEvidence({ view: "summary" }, ctx(root, { runId: undefined })), /^Error: read_run_evidence requires an active run id/);
  assert.match(await readRunEvidence({ view: "summary" }, ctx(root, { conversationId: "other-conversation" })), /^Error: Run evidence belongs to a different conversation/);
});

test("read_run_evidence preflights run records with safePath and rejects symlinks", async (t) => {
  const { root } = await fixture(t);
  const runPath = path.join(root, ".history", "runs", "run-current.json");
  const outside = path.join(root, "outside.json");
  fs.writeFileSync(outside, "{}", "utf8");
  fs.rmSync(runPath);
  fs.symlinkSync(outside, runPath);
  assert.match(await readRunEvidence({ view: "summary" }, ctx(root)), /^Error: Path escapes workspace through a symbolic link|^Error: Run record is not a regular file/);
});

test("read_run_evidence is registered as a read-only tool in modes and profiles", () => {
  assert.equal(typeof TOOL_DISPATCH.read_run_evidence, "function");
  assert.ok(getAllTools({ readOnly: true, mode: "ask" }).some((tool) => tool.function.name === "read_run_evidence"));
  assert.equal(evaluateModeCapability({ mode: "ask", toolName: "read_run_evidence", input: {} }).allowed, true);
  assert.equal(evaluateModeCapability({ mode: "review", toolName: "read_run_evidence", input: {} }).allowed, true);
  assert.equal(agentProfileAllowsTool(resolveAgentProfile("ask"), "read_run_evidence"), true);
  assert.equal(agentProfileAllowsTool(resolveAgentProfile("explore"), "read_run_evidence"), true);
});

test("summary pages large execution read ranges and always returns valid bounded JSON", async (t) => {
  const { root, recorder } = await fixture(t);
  for (let index = 0; index < 120; index += 1) {
    await recorder.recordExecutionFact({
      kind: "tool_result",
      requestId: `request-${index}`,
      toolCallId: `read-${index}`,
      toolName: "read_file",
      isError: false,
      output: JSON.stringify({
        path: `src/file-${index}.ts`,
        version: `v${index}`,
        character_offset: 0,
        total_characters: 10,
        complete: true,
        truncated: false,
        content: "0123456789",
      }),
    });
  }

  const firstRaw = await readRunEvidence({ view: "summary", limit: 10 }, ctx(root));
  assert.ok(firstRaw.length <= 24_000);
  const first = JSON.parse(firstRaw);
  assert.equal(first.executionFacts.readRanges.length, 10);
  assert.equal(first.executionFacts.readRangesTotal >= 120, true);
  assert.equal(first.executionFacts.readRangesTruncated, true);
  assert.equal(first.executionFacts.readRangesNextOffset, 10);

  const second = JSON.parse(await readRunEvidence({ view: "summary", offset: first.executionFacts.readRangesNextOffset, limit: 10 }, ctx(root)));
  assert.equal(second.executionFacts.readRangesOffset, 10);
  assert.notEqual(second.executionFacts.readRanges[0].path, first.executionFacts.readRanges[0].path);
});

test("tools view reports stored window completeness and keeps huge tool summaries parseable", async (t) => {
  const { root, recorder } = await fixture(t);
  for (let index = 0; index < 80; index += 1) {
    await recorder.toolState({
      requestId: `request-stress-${index}`,
      toolCallId: `tool-stress-${index}`,
      name: "read_file",
      status: "completed",
      toolInput: { path: `src/${index}.ts`, ignored: "x".repeat(20_000) },
      resultSummary: `summary-${index} ${"very long tool result ".repeat(2000)}`,
    });
  }
  const raw = await readRunEvidence({ view: "tools", limit: 50 }, ctx(root));
  assert.ok(raw.length <= 24_000);
  const tools = JSON.parse(raw);
  assert.equal(tools.view, "tools");
  assert.equal(tools.storedCount, 81);
  assert.equal(tools.knownTotal, 1);
  assert.equal(tools.captureComplete, true);
  assert.equal(tools.items.length > 0, true);
  assert.equal(typeof tools.next_offset === "number" || tools.next_offset === null, true);
  assert.doesNotMatch(JSON.stringify(tools), /very long tool result (?:very long tool result ){100}/);
});

test("tools view marks pruned or unknown histories as incomplete instead of claiming full totals", async (t) => {
  const { root, recorder } = await fixture(t);
  const runPath = path.join(root, ".history", "runs", "run-current.json");
  const record = JSON.parse(fs.readFileSync(runPath, "utf8"));
  record.executionFacts.completeness = "unknown";
  record.executionFacts.toolCalls = 300;
  record.toolExecutions = Array.from({ length: 250 }, (_, index) => ({
    toolCallId: `tool-${index}`,
    requestId: `request-${index}`,
    name: "read_file",
    input: { path: `src/${index}.ts` },
    status: "completed",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    resultSummary: "ok",
  }));
  fs.writeFileSync(runPath, JSON.stringify(record, null, 2));
  void recorder;

  const raw = await readRunEvidence({ view: "tools", limit: 25 }, ctx(root));
  assert.ok(raw.length <= 24_000);
  const tools = JSON.parse(raw);
  assert.equal(tools.storedCount, 250);
  assert.equal(tools.knownTotal, null);
  assert.equal(tools.captureComplete, false);
  assert.equal(tools.total, 250);
  assert.equal(tools.next_offset, 25);
});

test("tools view does not hang on a single oversized tool identifier", async (t) => {
  const { root } = await fixture(t);
  const runPath = path.join(root, ".history", "runs", "run-current.json");
  const record = JSON.parse(fs.readFileSync(runPath, "utf8"));
  record.executionFacts = { ...record.executionFacts, completeness: "unknown" };
  record.toolExecutions = [{
    toolCallId: "tool-" + "x".repeat(30_000),
    requestId: "request-" + "y".repeat(30_000),
    name: "read_file",
    input: { path: "src/huge.ts" },
    status: "completed",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    resultSummary: "ok",
  }];
  fs.writeFileSync(runPath, JSON.stringify(record, null, 2));

  const started = Date.now();
  const raw = await readRunEvidence({ view: "tools", limit: 1 }, ctx(root));
  assert.ok(Date.now() - started < 2_000);
  assert.ok(raw.length <= 24_000);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.captureComplete, false);
  assert.equal(parsed.storedCount, 1);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].toolCallId.truncated, true);
});
