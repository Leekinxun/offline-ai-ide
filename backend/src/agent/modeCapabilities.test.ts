import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionPlan } from "../chat/executionPlans.js";
import { evaluateInspectionCommand, evaluateModeCapability } from "./modeCapabilities.js";
import { getAllTools, TOOL_DISPATCH } from "./tools.js";

const plan: ExecutionPlan = {
  id: "plan-1",
  conversationId: "conversation-1",
  planRunId: "run-plan",
  status: "approved",
  goal: "Tighten mode boundaries",
  files: ["src/agent", "README.md"],
  steps: ["Implement policy"],
  risks: [],
  verificationCommands: ["npm test", "npm run build"],
  acceptanceCriteria: ["Out-of-scope writes are rejected"],
  createdAt: 1,
  approvedAt: 1,
  updatedAt: 1,
  executionRunIds: [],
};

test("Plan and Review allow inspection commands but reject composed shell actions", () => {
  assert.equal(evaluateInspectionCommand("rg -n plan src").allowed, true);
  assert.equal(evaluateInspectionCommand("git diff -- src").allowed, true);
  assert.equal(evaluateInspectionCommand("rg plan src | head").allowed, false);
  assert.equal(evaluateModeCapability({
    mode: "plan",
    toolName: "write_file",
    input: { path: "src/a.ts" },
  }).allowed, false);
  assert.equal(evaluateModeCapability({
    mode: "code",
    toolName: "submit_completion_evidence",
    input: { criterionEvidence: { "0": ["tool-1"] } },
    executionPlan: plan,
  }).allowed, true);
});

test("Code is constrained to approved files and verification commands", () => {
  assert.deepEqual(evaluateModeCapability({
    mode: "code",
    toolName: "request_plan_amendment",
    input: { reason: "Need an additional source file" },
    executionPlan: plan,
  }), { allowed: true });
  assert.equal(evaluateModeCapability({
    mode: "code",
    toolName: "edit_file",
    input: { path: "src/agent/loop.ts" },
    executionPlan: plan,
  }).allowed, true);
  const outside = evaluateModeCapability({
    mode: "code",
    toolName: "write_file",
    input: { path: "src/routes/admin.ts" },
    executionPlan: plan,
  });
  assert.equal(outside.allowed, false);
  assert.equal(outside.requiresReplan, true);
  assert.equal(outside.decision, "amendment_required");
  assert.equal(outside.amendmentRequired, true);
  assert.equal(evaluateModeCapability({
    mode: "code",
    toolName: "bash",
    input: { command: "npm test" },
    executionPlan: plan,
  }).allowed, true);
  assert.equal(evaluateModeCapability({
    mode: "code",
    toolName: "bash",
    input: { command: "npm run deploy" },
    executionPlan: plan,
  }).allowed, false);
});

test("Code can edit and execute directly without an approved Plan", () => {
  assert.deepEqual(evaluateModeCapability({
    mode: "code",
    toolName: "edit_file",
    input: { path: "src/routes/admin.ts" },
  }), { allowed: true });
  assert.equal(evaluateModeCapability({
    mode: "code",
    toolName: "request_plan_amendment",
    input: { reason: "Not applicable" },
  }).allowed, false);
  assert.deepEqual(evaluateModeCapability({
    mode: "code",
    toolName: "bash",
    input: { command: "npm test" },
  }), { allowed: true });
  assert.deepEqual(evaluateModeCapability({
    mode: "code",
    toolName: "submit_completion_evidence",
    input: { criterionEvidence: { "0": ["tool-1"] } },
  }), { allowed: true });
});

test("completion evidence is unavailable outside Code mode", () => {
  assert.equal(evaluateModeCapability({ mode: "plan", toolName: "submit_completion_evidence", input: {} }).allowed, false);
  assert.equal(evaluateModeCapability({ mode: "review", toolName: "submit_completion_evidence", input: {} }).allowed, false);
  assert.equal(evaluateModeCapability({ mode: "ask", toolName: "submit_completion_evidence", input: {} }).allowed, false);
});

test("plan-amendment requests are unavailable outside approved Code runs", () => {
  for (const mode of ["plan", "review", "ask"] as const) {
    assert.equal(evaluateModeCapability({
      mode,
      toolName: "request_plan_amendment",
      input: { reason: "Need more scope" },
    }).allowed, false);
  }
});

test("plan-amendment tool is exposed only for approved-plan Code runs", () => {
  const names = (options?: Parameters<typeof getAllTools>[0]) =>
    getAllTools(options).map((tool) => tool.function.name);
  assert.ok(names({ mode: "code", constrainedCode: true }).includes("request_plan_amendment"));
  assert.ok(!names({ mode: "code" }).includes("request_plan_amendment"));
  assert.ok(!names({ mode: "plan" }).includes("request_plan_amendment"));
  assert.ok(!names({ mode: "review" }).includes("request_plan_amendment"));
  assert.ok(!names({ mode: "ask" }).includes("request_plan_amendment"));
});

test("structured review reporting is exposed and permitted only in Review mode", async () => {
  const names = (options?: Parameters<typeof getAllTools>[0]) =>
    getAllTools(options).map((tool) => tool.function.name);
  assert.ok(names({ mode: "review" }).includes("report_review_finding"));
  assert.ok(!names({ mode: "ask" }).includes("report_review_finding"));
  assert.ok(!names({ mode: "plan" }).includes("report_review_finding"));
  assert.ok(!names({ mode: "code" }).includes("report_review_finding"));
  assert.equal(evaluateModeCapability({ mode: "review", toolName: "report_review_finding", input: {} }).allowed, true);
  assert.equal(evaluateModeCapability({ mode: "code", toolName: "report_review_finding", input: {} }).allowed, false);

  const dispatch = TOOL_DISPATCH.report_review_finding;
  const valid = await dispatch({
    severity: "error", lens: "correctness", path: "src/example.ts", line: 4,
    message: "Returns the wrong value", evidence: ["src/example.ts:4 returns null"], reviewedRevision: "abc123",
  }, { mode: "review", workspaceDir: process.cwd() } as never);
  assert.deepEqual(JSON.parse(valid as string), {
    severity: "error", lens: "correctness", path: "src/example.ts", line: 4,
    message: "Returns the wrong value", evidence: ["src/example.ts:4 returns null"], reviewedRevision: "abc123",
  });
  const missingEvidence = await dispatch({
    severity: "critical", lens: "security", path: "src/example.ts", line: 4,
    message: "Untrusted access", evidence: [], reviewedRevision: "abc123",
  }, { mode: "review", workspaceDir: process.cwd() } as never);
  assert.match(missingEvidence as string, /require direct evidence or a reproduction/);
  const traversal = await dispatch({
    severity: "warning", lens: "maintainability", path: "../secret", line: 1,
    message: "unsafe", evidence: [], reviewedRevision: "abc123",
  }, { mode: "review", workspaceDir: process.cwd() } as never);
  assert.match(traversal as string, /safe workspace-relative path/);
});

test("plan-amendment dispatch rejects incomplete requests and normalizes valid scope", async () => {
  const dispatch = TOOL_DISPATCH.request_plan_amendment;
  const incomplete = await dispatch({ reason: "Need more scope" }, {} as never);
  assert.equal(incomplete, "Error: request_plan_amendment requires at least one requested file or verification command");

  const accepted = await dispatch({
    reason: "  Need a test file  ",
    requestedFiles: [" src/agent/tools.test.ts ", "", 12],
    requestedVerificationCommands: [" npm test -- tools ", "   "],
  }, {} as never);
  assert.deepEqual(JSON.parse(accepted as string), {
    accepted: true,
    reason: "Need a test file",
    requestedFiles: ["src/agent/tools.test.ts"],
    requestedVerificationCommands: ["npm test -- tools"],
  });
});
