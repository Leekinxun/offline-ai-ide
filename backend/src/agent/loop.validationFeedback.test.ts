import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import { WebSocket } from "ws";
import { runAgentLoop } from "./loop.js";
import { MessageBus } from "./messageBus.js";
import { TaskManager } from "./taskManager.js";
import { TeammateManager } from "./teammateManager.js";
import { registerAgentHooks } from "./agentHooks.js";
import type { UserSession } from "../auth/sessionManager.js";
import type { OpenAIMessage, WsServerMessage } from "./types.js";
import { AgentRunRecorder } from "../chat/runHistory.js";
import { buildFileVersion } from "../files/mutationRegistry.js";
import { deriveCompletionEvidence, type CompletionEvidence } from "../chat/completionEvidence.js";
import type { PersistedChatMessage } from "../chat/history.js";
import { CompletionQualityGateError } from "../extensions/policy/completionGate.js";
import { pollProcessSession } from "../run/processSessions.js";
import { publishEditorDiagnostics } from "../chat/editorDiagnostics.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-loop-validation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node check.cjs" } }));
  fs.writeFileSync(path.join(root, "app.js"), "const value = 1;\n");
  fs.writeFileSync(path.join(root, "check.cjs"), 'const fs = require("node:fs"); if (!fs.readFileSync("app.js", "utf8").includes("value = 3")) { console.error("EXPECTED_VALUE_THREE"); process.exitCode = 1; }');
  const taskManager = new TaskManager(root);
  const messageBus = new MessageBus(root);
  const session: UserSession = { token: "validation", username: "tester", workspaceDir: root, workspaceRoot: root, isAdmin: false, isolated: false, taskManager, messageBus, teammateManager: new TeammateManager(root, messageBus, taskManager) };
  return { root, session };
}

const tool = (id: string, name: string, args: Record<string, unknown>): OpenAIMessage => ({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const edit = (id: string, before: number, after: number) => tool(id, "edit_file", { path: "app.js", old_text: `value = ${before}`, new_text: `value = ${after}`, expected_version: buildFileVersion(`const value = ${before};\n`) });
const stop = (): OpenAIMessage => ({ role: "assistant", content: "Implementation complete." });

async function run(
  t: test.TestContext,
  f: ReturnType<typeof fixture>,
  turns: OpenAIMessage[],
  options: { denyBash?: boolean; mode?: "ask" | "code"; stopped?: () => boolean; resumedFromRunId?: string; onBody?: (body: string, call: number) => void | Promise<void> } = {}
) {
  const priorFetch = globalThis.fetch;
  const events: WsServerMessage[] = [];
  const bodies: string[] = [];
  const approvals: string[] = [];
  const persisted: PersistedChatMessage[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "test-model", max_output_tokens: 1024 }] });
    const body = String(init?.body || "");
    bodies.push(body); await options.onBody?.(body, bodies.length);
    const message = turns[bodies.length - 1] || stop();
    return Response.json({ choices: [{ finish_reason: message.tool_calls?.length ? "tool_calls" : "stop", message }] });
  };
  t.after(() => { globalThis.fetch = priorFetch; });
  const recorder = new AgentRunRecorder(f.root, "run-validation", "conversation-validation", options.mode || "code", options.resumedFromRunId, undefined, undefined, "test-model");
  await recorder.start();
  const result = await runAgentLoop({ readyState: WebSocket.OPEN, send() {} } as unknown as WebSocket, "Update the implementation", "request-validation", f.session, undefined, undefined,
    (event) => events.push(event), undefined, undefined, (message) => { persisted.push(structuredClone(message)); }, {
      mode: options.mode || "code", modelName: "test-model", isStopped: options.stopped || (() => false), createAbortSignal: () => undefined,
      runRecorder: recorder, conversationId: "conversation-validation",
      requestToolApproval: async (request) => { approvals.push(request.name); return request.name === "bash" && options.denyBash ? "deny" : "allow_once"; },
    });
  globalThis.fetch = priorFetch;
  return { result, events, bodies, approvals, persisted };
}

test("direct Code completion requests a missing check through normal approval before reporting verified", async (t) => {
  const f = fixture(t);
  const result = await run(t, f, [edit("edit-1", 1, 3), stop(), tool("check-1", "bash", { command: "npm run test" }), stop()]);
  assert.equal(result.bodies.length, 4);
  assert.match(result.bodies[2], /Runtime validation feedback/);
  assert.deepEqual(result.approvals, ["edit_file", "bash"]);
  assert.equal(result.result[0].runtimeValidation?.status, "passed");
  assert.equal(result.result[0].runtimeValidation?.verification[0].toolCallId, "check-1");
  assert.equal(deriveCompletionEvidence({ messages: result.result }).outcome, "completed");
  assert.equal(result.persisted[0].runtimeValidation?.status, "passed");
});

test("a failed check returns its real output to the model, repairs the code, and accepts a fresh passing check", async (t) => {
  const f = fixture(t);
  const result = await run(t, f, [edit("bad-edit", 1, 2), tool("failed-check", "bash", { command: "npm run test" }), stop(), edit("fix-edit", 2, 3), tool("fixed-check", "bash", { command: "npm run test" }), stop()]);
  assert.match(result.bodies[3], /EXPECTED_VALUE_THREE/);
  assert.equal(fs.readFileSync(path.join(f.root, "app.js"), "utf8"), "const value = 3;\n");
  assert.equal(result.result[0].runtimeValidation?.status, "passed");
  assert.equal(result.result[0].runtimeValidation?.repairAttempts, 1);
  assert.equal(deriveCompletionEvidence({ messages: result.result }).outcome, "completed");
});

test("denied verification stops asking and produces needs_attention, not a false success", async (t) => {
  const f = fixture(t);
  const result = await run(t, f, [edit("edit", 1, 3), stop(), tool("denied-check", "bash", { command: "npm run test" }), stop()], { denyBash: true });
  assert.equal(result.bodies.length, 4);
  assert.equal(result.approvals.filter((name) => name === "bash").length, 1);
  assert.equal(result.result[0].runtimeValidation?.status, "unverified");
  assert.match(result.result[0].content, /unverified/);
  assert.equal(deriveCompletionEvidence({ messages: result.result }).outcome, "needs_attention");
});

test("a real pipe masking a zero-test runner exit preserves unverified completion", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "check.cjs"), 'console.error("Ran 0 tests in 0.000s\\n\\nNO TESTS RAN"); process.exitCode = 5;');
  const result = await run(t, f, [tool("masked-zero", "bash", { command: "npm run test 2>&1 | tail -10" }), stop(), stop(), stop()]);
  const step = result.result[0].toolCalls?.find((item) => item.toolCallId === "masked-zero");
  assert.equal(step?.isError, false, "tail exits zero, while the test runner exits five");
  assert.match(step?.result || "", /Ran 0 tests/);
  assert.equal(result.result[0].runtimeValidation?.status, "unverified");
  assert.equal(result.result[0].runtimeValidation?.verification[0].status, "pending");
  assert.equal(result.bodies.length, 2, "Zero tests require no identical repair round");
  assert.equal(result.result[0].runtimeValidation?.repairAttempts, 0);
  assert.equal(deriveCompletionEvidence({ messages: result.result }).outcome, "needs_attention");
});

test("one successful safe check chain satisfies runtime checks without a redundant repair round", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ scripts: { lint: "node lint.cjs", test: "node check.cjs" } }));
  fs.writeFileSync(path.join(f.root, "lint.cjs"), "console.log('LINT_PASSED');\n");
  const result = await run(t, f, [edit("edit", 1, 3), tool("checks", "bash", { command: "npm run lint && npm test" }), stop()]);
  assert.equal(result.bodies.length, 3);
  assert.equal(result.result[0].runtimeValidation?.status, "passed");
  assert.equal(result.result[0].runtimeValidation?.repairAttempts, 0);
  assert.deepEqual(result.result[0].runtimeValidation?.verification.map((item) => item.toolCallId), ["checks", "checks"]);
});

test("unchanged failed evidence gets one repair feedback rather than identical repeated rounds", async (t) => {
  const f = fixture(t);
  const result = await run(t, f, [edit("edit", 1, 2), tool("failed-check", "bash", { command: "npm run test" }), stop(), stop(), stop()]);
  assert.equal(result.bodies.length, 4);
  assert.equal(result.result[0].runtimeValidation?.repairAttempts, 1);
  assert.equal(result.result[0].runtimeValidation?.status, "failed");
  assert.equal(deriveCompletionEvidence({ messages: result.result }).outcome, "validation_failed");
});

test("repository quality hook failure is fed back and a later passing attempt completes", async (t) => {
  const f = fixture(t);
  let attempts = 0;
  const unregister = registerAgentHooks({ name: "validation-recovering-hook", critical: true, handlers: { repositoryQuality: () => { if (++attempts === 1) throw new Error("HOOK_REPAIR_REQUIRED"); } } });
  t.after(unregister);
  const result = await run(t, f, [stop(), stop()]);
  assert.equal(attempts, 2);
  assert.match(result.bodies[1], /HOOK_REPAIR_REQUIRED/);
});

test("permanent quality failure stops after two feedback rounds and preserves the final failed turn", async (t) => {
  const f = fixture(t);
  let attempts = 0;
  const unregister = registerAgentHooks({ name: "validation-failing-hook", critical: true, handlers: { repositoryQuality: () => { attempts++; throw new Error("HOOK_STAYS_BLOCKED"); } } });
  t.after(unregister);
  await assert.rejects(run(t, f, [stop(), stop(), stop()]), CompletionQualityGateError);
  assert.equal(attempts, 3);
});

test("stopping during a quality check prevents repair calls and returns an interrupted turn", async (t) => {
  const f = fixture(t);
  let stopped = false;
  const unregister = registerAgentHooks({ name: "validation-cancel-hook", critical: true, handlers: { repositoryQuality: () => { stopped = true; throw new Error("cancelled while checking"); } } });
  t.after(unregister);
  const result = await run(t, f, [stop()], { stopped: () => stopped });
  assert.equal(result.bodies.length, 1);
  assert.ok(result.events.some((event) => event.type === "done" && event.interrupted));
  assert.equal(deriveCompletionEvidence({ messages: result.result, stopped: true }).outcome, "stopped");
});

test("Ask mode never initiates code verification or records a misleading validation pass", async (t) => {
  const f = fixture(t);
  const result = await run(t, f, [stop()], { mode: "ask" });
  assert.equal(result.bodies.length, 1);
  assert.equal(result.approvals.length, 0);
  assert.equal(result.result[0].runtimeValidation, undefined);
});

test("long process checks block intervening edits, require distinct stdin approval, and verify only after terminal code zero", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "check.cjs"), 'process.stdin.once("data", () => { console.log("LONG_CHECK_FINISHED"); process.exit(0); });');
  const turns = [edit("edit", 1, 3), tool("start-long-check", "process_start", { command: "npm run test" }), tool("blocked-write", "write_file", { path: "must-not-exist.ts", content: "blocked" }), stop(), stop(), stop()];
  let id = "";
  const result = await run(t, f, turns, { onBody: async (body, call) => {
    if (call < 3) return;
    const messages = JSON.parse(body).messages;
    if (!id) {
      const started = messages.find((message: { tool_call_id?: string }) => message.tool_call_id === "start-long-check");
      id = JSON.parse(started.content).session.id;
    }
    if (call === 4) turns[3] = tool("input-long-check", "process_input", { session_id: id, text: "continue\n", eof: true });
    if (call === 5) {
      const deadline = Date.now() + 5_000;
      while (pollProcessSession({ workspaceDir: f.root, owner: "tester", runId: "run-validation" }, id).session.status === "running") {
        if (Date.now() > deadline) throw new Error("long check did not finish");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      turns[4] = tool("poll-long-check", "process_poll", { session_id: id });
    }
  } });
  assert.equal(fs.existsSync(path.join(f.root, "must-not-exist.ts")), false);
  assert.deepEqual(result.approvals, ["edit_file", "process_start", "process_input"]);
  assert.equal(result.result[0].toolCalls?.find((step) => step.toolCallId === "blocked-write")?.isError, true);
  assert.equal(result.result[0].runtimeValidation?.status, "passed");
  assert.equal(result.result[0].runtimeValidation?.verification[0].toolCallId, "poll-long-check");
});

test("a still-running process cannot be treated as verification success or left running after bounded completion attempts", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "hold.cjs"), "setInterval(() => {}, 1000);");
  const result = await run(t, f, [tool("start-hold", "process_start", { command: "node hold.cjs" }), stop(), stop(), stop()]);
  assert.equal(result.result[0].runtimeValidation?.status, "unverified");
  assert.equal(deriveCompletionEvidence({ messages: result.result }).outcome, "needs_attention");
  const id = JSON.parse(result.result[0].toolCalls!.find((step) => step.toolCallId === "start-hold")!.result!).session.id;
  const deadline = Date.now() + 5_000;
  while (pollProcessSession({ workspaceDir: f.root, owner: "tester", runId: "run-validation" }, id).session.status === "running") {
    if (Date.now() > deadline) throw new Error("Agent process was not cancelled");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(pollProcessSession({ workspaceDir: f.root, owner: "tester", runId: "run-validation" }, id).session.status, "cancelled");
});

async function previousRun(root: string, conversationId = "conversation-validation", evidence = true) {
  const recorder = new AgentRunRecorder(root, "prior-validation-run", conversationId, "code");
  await recorder.start();
  const completionEvidence: CompletionEvidence = { schemaVersion: 1, outcome: "stopped", ledger: { changedFiles: ["app.js"], verification: [{ command: "npm run test", status: "passed", toolCallId: "historical-pass" }], criteria: [], blockers: [] } };
  await recorder.finish("stopped", {}, undefined, evidence ? completionEvidence : undefined);
  return recorder.runId;
}

test("resuming Direct Code without further edits requires a fresh check of inherited changed-file versions", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "app.js"), "const value = 3;\n");
  const prior = await previousRun(f.root);
  const result = await run(t, f, [stop(), tool("resume-check", "bash", { command: "npm run test" }), stop()], { resumedFromRunId: prior });
  assert.equal(result.bodies.length, 3);
  assert.match(result.bodies[1], /Runtime validation feedback/);
  assert.deepEqual(result.approvals, ["bash"]);
  assert.deepEqual(result.result[0].runtimeValidation?.changedFiles, ["app.js"]);
  assert.equal(result.result[0].runtimeValidation?.verification[0].toolCallId, "resume-check");
  assert.equal(deriveCompletionEvidence({ messages: result.result }).outcome, "completed");
});

test("resume validation rejects cross-conversation evidence before any provider request", async (t) => {
  const f = fixture(t);
  const prior = await previousRun(f.root, "another-conversation");
  let calls = 0;
  await assert.rejects(run(t, f, [stop()], { resumedFromRunId: prior, onBody: () => { calls++; } }), /does not belong/);
  assert.equal(calls, 0);
});

test("missing previous validation evidence remains unverified rather than silently completing a resumed run", async (t) => {
  const f = fixture(t);
  const prior = await previousRun(f.root, "conversation-validation", false);
  const result = await run(t, f, [stop()], { resumedFromRunId: prior });
  assert.equal(result.result[0].runtimeValidation?.status, "unverified");
  assert.match(result.result[0].runtimeValidation?.reason || "", /Previous run completion evidence is missing/);
  assert.equal(deriveCompletionEvidence({ messages: result.result }).outcome, "needs_attention");
});

test("a persisted orphan Agent process keeps resumed validation unverified even when a prior ledger exists", async (t) => {
  const f = fixture(t);
  const prior = await previousRun(f.root);
  const processId = crypto.randomUUID();
  fs.mkdirSync(path.join(f.root, ".history/process-sessions"), { recursive: true });
  fs.writeFileSync(path.join(f.root, ".history/process-sessions", `${processId}.json`), JSON.stringify({ id: processId, taskId: "agent:command", label: "old check", status: "running", startedAt: 1, exitCode: null, nextCursor: 0, runId: prior, workspaceDir: fs.realpathSync(f.root), ownerHash: crypto.createHash("sha256").update("tester").digest("hex"), events: [] }));
  const result = await run(t, f, [stop()], { resumedFromRunId: prior });
  assert.equal(result.result[0].runtimeValidation?.status, "unverified");
  assert.match(result.result[0].runtimeValidation?.reason || "", /Previous Agent process was interrupted/);
  assert.equal(deriveCompletionEvidence({ messages: result.result }).outcome, "needs_attention");
});

test("a stopped historical process does not prevent completion after fresh resumed verification", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "app.js"), "const value = 3;\n");
  const prior = await previousRun(f.root);
  const processId = crypto.randomUUID();
  fs.mkdirSync(path.join(f.root, ".history/process-sessions"), { recursive: true });
  fs.writeFileSync(path.join(f.root, ".history/process-sessions", `${processId}.json`), JSON.stringify({ id: processId, taskId: "agent:command", label: "stopped check", status: "cancelled", startedAt: 1, endedAt: 2, exitCode: null, nextCursor: 0, runId: prior, workspaceDir: fs.realpathSync(f.root), ownerHash: crypto.createHash("sha256").update("tester").digest("hex"), events: [] }));
  const result = await run(t, f, [stop(), tool("fresh-resume-check", "bash", { command: "npm run test" }), stop()], { resumedFromRunId: prior });
  assert.equal(result.result[0].runtimeValidation?.status, "passed");
  assert.equal(deriveCompletionEvidence({ messages: result.result }).outcome, "completed");
});

test("versioned Monaco advisories reach the repair prompt while real command success remains required", async (t) => {
  const f = fixture(t);
  const base = { workspaceDir: f.root, path: "app.js", publisherId: "editor", dirty: false };
  publishEditorDiagnostics({ workspaceDir: f.root, owner: "tester" }, { ...base, version: buildFileVersion("const value = 1;\n"), modelVersion: 1, sequence: 1, diagnostics: [{ line: 1, column: 1, severity: "warning", message: "Existing warning", source: "monaco", modelVersion: 1 }] });
  const result = await run(t, f, [edit("edit", 1, 3), stop(), tool("real-editor-check", "bash", { command: "npm run test" }), stop()], { onBody: (_body, call) => {
    if (call === 2) publishEditorDiagnostics({ workspaceDir: f.root, owner: "tester" }, { ...base, version: buildFileVersion("const value = 3;\n"), modelVersion: 2, sequence: 2, diagnostics: [{ line: 1, column: 1, severity: "error", message: "EDITOR_ADVISORY_CURRENT_VERSION", source: "monaco", modelVersion: 2 }] });
  } });
  assert.match(result.bodies[2], /EDITOR_ADVISORY_CURRENT_VERSION/);
  assert.match(result.bodies[2], /untrusted client observations/);
  assert.equal(result.result[0].runtimeValidation?.editorDiagnostics?.errors[0].classification, "new_since_baseline");
  assert.equal(result.result[0].runtimeValidation?.verification[0].toolCallId, "real-editor-check");
  assert.equal(result.result[0].runtimeValidation?.status, "passed");
  assert.equal(result.bodies.length, 4);
});
