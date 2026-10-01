import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { changeSetsContainEvidenceGaps, collectAuthoritativeChangedFiles, deriveCompletionEvidence } from "./completionEvidence.js";
import { recordFileMutation } from "../files/mutationRegistry.js";
import { REDACTED } from "../agent/secretRedaction.js";
import type { PersistedChatMessage } from "./history.js";
import { ValidationFeedback } from "../agent/validationFeedback.js";

const message = (toolCalls: PersistedChatMessage["toolCalls"]): PersistedChatMessage => ({ role: "assistant", content: "", timestamp: 1, toolCalls });
const bash = (toolCallId: string, command: string, result = "ok", isError = false) => ({ toolCallId, name: "bash", input: { command }, result, isError });

test("a redirected zero-test run cannot become completed with an empty ledger", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-zero-completion-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const command = "python3 -B -m unittest discover -s empty_tests 2>&1 | tail -10";
  const output = "Ran 0 tests in 0.000s\n\nNO TESTS RAN";
  const validation = new ValidationFeedback(workspace);
  validation.observeCommand({ command, toolCallId: "zero", output, isError: false, denied: false, changedFiles: [] });
  const runtimeValidation = validation.assess([], false).report;
  const result = deriveCompletionEvidence({ messages: [{ ...message([bash("zero", command, output)]), runtimeValidation }] });
  assert.equal(result.outcome, "needs_attention");
  assert.equal(result.ledger.verification[0].status, "pending");
  assert.ok(result.ledger.blockers.includes("check"));
});

test("records changed files and successful exact command evidence", () => {
  const result = deriveCompletionEvidence({ plan: { verificationCommands: ["npm test"], acceptanceCriteria: ["Tests pass"] }, messages: [message([
    { ...bash("b1", "npm test"), fileUpdate: { path: "src/a.ts", content: "x" } },
    { ...bash("b2", "npm test -- --watch"), fileUpdate: { path: "src/a.ts", content: "y" } },
  ])], criterionEvidence: { "0": ["b1"] } });
  assert.equal(result.outcome, "completed");
  assert.deepEqual(result.ledger.changedFiles, ["src/a.ts"]);
  assert.deepEqual(result.ledger.verification[0], { command: "npm test", status: "passed", toolCallId: "b1", exitCode: 0, outputDigest: "sha256:2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df" });
  assert.deepEqual(result.ledger.criteria[0], { criterion: "Tests pass", state: "passed", evidenceRefs: ["b1"] });
});

test("joins checkpoint shell mutations into the authoritative ledger without double counting", (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-completion-ledger-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  for (const [file, before, after] of [["created.ts", undefined, "new"], ["modified.ts", "old", "new"], ["deleted.ts", "old", undefined]] as const) {
    recordFileMutation({ workspaceDir, path: file, source: "assistant_tool", runId: "run-1", toolCallId: "bash-1", preimageContent: before, postimageContent: after });
  }
  const changedFiles = collectAuthoritativeChangedFiles(workspaceDir, "run-1");
  const result = deriveCompletionEvidence({ messages: [message([{ ...bash("bash-1", "apply changes"), fileUpdate: { path: "modified.ts", content: "new" } }])], changedFiles });
  assert.deepEqual(result.ledger.changedFiles, ["created.ts", "deleted.ts", "modified.ts"]);
  assert.equal(new Set(result.ledger.changedFiles).size, result.ledger.changedFiles.length);
});

test("skipped mutation evidence blocks completion instead of silently completing", () => {
  const result = deriveCompletionEvidence({ messages: [], blockers: { changeEvidence: true } });
  assert.equal(result.outcome, "needs_attention");
  assert.deepEqual(result.ledger.blockers, ["changeEvidence"]);
});

test("runtime completion recognizes equivalent ChangeSet evidence-gap shapes", () => {
  for (const changeSet of [
    { checks: { mutationEvidenceGaps: [{ path: "a.ts", reason: "binary" }] } },
    { verificationEvidence: { changeEvidenceGaps: [{ path: "b.ts", reason: "oversized" }] } },
    { verificationEvidence: { changeEvidence: { blocked: true, path: "c.ts", reason: "unreadable" } } },
    { checks: { nested: { changeEvidence: "mutation journal unavailable" } } },
  ]) {
    assert.equal(changeSetsContainEvidenceGaps([changeSet]), true);
    const result = deriveCompletionEvidence({ messages: [], blockers: { changeEvidence: changeSetsContainEvidenceGaps([changeSet]) } });
    assert.equal(result.outcome, "needs_attention");
    assert.deepEqual(result.ledger.blockers, ["changeEvidence"]);
  }
  assert.equal(changeSetsContainEvidenceGaps([{ checks: { changeEvidence: { blocked: false } }, verificationEvidence: { passed: true } }]), false);
});

test("does not complete plans with omitted command or unmapped criteria", () => {
  const result = deriveCompletionEvidence({ plan: { verificationCommands: ["npm test"], acceptanceCriteria: ["Works"] }, messages: [] });
  assert.equal(result.outcome, "needs_attention");
  assert.deepEqual(result.ledger.verification[0], { command: "npm test", status: "pending" });
  assert.equal(result.ledger.criteria[0]?.state, "pending");
  assert.ok(result.ledger.blockers.includes("check"));
});

test("failed and timed-out required commands invalidate validation", () => {
  for (const resultText of ["Error: Command exited with code 2", "Error: Timeout (120s)"]) {
    const result = deriveCompletionEvidence({ plan: { verificationCommands: ["npm test"] }, messages: [message([bash("b1", "npm test", resultText, true)])] });
    assert.equal(result.outcome, "validation_failed");
  }
});

test("classifies cancellation, blockers, base errors, and direct completion deterministically", () => {
  const plan = { verificationCommands: ["npm test"] };
  const cancelled = deriveCompletionEvidence({ plan, messages: [message([bash("b", "npm test", "Error: Stopped during shell execution", true)])] });
  assert.equal(cancelled.ledger.verification[0]?.status, "cancelled");
  assert.equal(cancelled.outcome, "needs_attention");
  const approvalBlocked = deriveCompletionEvidence({ messages: [], blockers: { approval: true }, baseError: true });
  assert.equal(approvalBlocked.outcome, "needs_attention");
  assert.deepEqual(approvalBlocked.ledger.blockers, ["approval"]);
  assert.equal(deriveCompletionEvidence({ messages: [], baseError: true }).outcome, "failed");
  assert.equal(deriveCompletionEvidence({ messages: [], stopped: true, baseError: true }).outcome, "stopped");
  assert.equal(deriveCompletionEvidence({ messages: [] }).outcome, "completed");
});

test("an exploratory tool error does not become a base run failure", () => {
  const result = deriveCompletionEvidence({
    messages: [message([bash("explore", "python3 -c 'print(1)'", "Error: command not allowed", true)])],
  });
  assert.equal(result.outcome, "completed");
  assert.deepEqual(result.ledger.verification, []);
});

test("only successful required bash references can satisfy a criterion", () => {
  const result = deriveCompletionEvidence({ plan: { verificationCommands: ["npm test"], acceptanceCriteria: ["Ready"] }, messages: [message([bash("bad", "npm test", "Error: Command exited with code 1", true)])], criterionEvidence: { Ready: ["bad", "unknown"] } });
  assert.deepEqual(result.ledger.criteria[0], { criterion: "Ready", state: "failed", evidenceRefs: [] });
  assert.equal(result.outcome, "validation_failed");
});

test("uses the last successful submitted evidence map only when no explicit map is supplied", () => {
  const messages = [message([
    bash("good", "npm test"),
    { toolCallId: "old", name: "submit_completion_evidence", input: { criterionEvidence: { Ready: ["bad"] } }, isError: false },
    { toolCallId: "new", name: "submit_completion_evidence", input: { criterionEvidence: { Ready: ["good"] } }, isError: false },
  ])];
  const result = deriveCompletionEvidence({ plan: { verificationCommands: ["npm test"], acceptanceCriteria: ["Ready"] }, messages });
  assert.deepEqual(result.ledger.criteria[0], { criterion: "Ready", state: "passed", evidenceRefs: ["good"] });
  const explicit = deriveCompletionEvidence({ plan: { verificationCommands: ["npm test"], acceptanceCriteria: ["Ready"] }, messages, criterionEvidence: { Ready: ["bad"] } });
  assert.equal(explicit.ledger.criteria[0]?.state, "pending");
});

test("unrelated successful inspection bash cannot prove an acceptance criterion", () => {
  const result = deriveCompletionEvidence({
    plan: { verificationCommands: ["npm test"], acceptanceCriteria: ["Tests prove readiness"] },
    messages: [message([bash("required", "npm test"), bash("inspection", "git status")])],
    criterionEvidence: { "0": ["inspection"] },
  });
  assert.equal(result.ledger.verification[0]?.status, "passed");
  assert.deepEqual(result.ledger.criteria[0], {
    criterion: "Tests prove readiness",
    state: "pending",
    evidenceRefs: [],
  });
  assert.equal(result.outcome, "needs_attention");
});

test("digests redacted output without changing verification semantics", () => {
  const canary = "sk-test_EVIDENCE_CANARY_123456";
  const output = `safe code() token=${canary}`;
  const result = deriveCompletionEvidence({
    plan: { verificationCommands: [`npm test -- --token=${canary}`], acceptanceCriteria: [`No ${canary} leaks`] },
    messages: [message([bash("b1", `npm test -- --token=${canary}`, output)])],
    criterionEvidence: { "0": ["b1"] },
  });
  const rawDigest = `sha256:${crypto.createHash("sha256").update(output).digest("hex")}`;
  const redactedOutput = `safe code() token=${REDACTED}`;
  const redactedDigest = `sha256:${crypto.createHash("sha256").update(redactedOutput).digest("hex")}`;

  assert.equal(result.outcome, "completed");
  assert.equal(result.ledger.verification[0]?.status, "passed");
  assert.equal(result.ledger.criteria[0]?.state, "passed");
  assert.equal(result.ledger.verification[0]?.outputDigest, redactedDigest);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(canary));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(rawDigest));
});

test("version-bound runtime evidence supersedes an earlier planned command pass after another edit", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-stale-validation-ledger-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "code.ts"), "before");
  const validation = new ValidationFeedback(root, ["npm test"]);
  validation.observeCommand({ command: "npm test", toolCallId: "old-pass", output: "ok", isError: false, denied: false, changedFiles: ["code.ts"] });
  fs.writeFileSync(path.join(root, "code.ts"), "after");
  const runtimeValidation = validation.assess(["code.ts"], false).report;
  const result = deriveCompletionEvidence({
    plan: { verificationCommands: ["npm test"], acceptanceCriteria: ["Tests pass"] },
    messages: [{ ...message([bash("old-pass", "npm test")]), runtimeValidation }],
    criterionEvidence: { "0": ["old-pass"] },
  });
  assert.equal(result.ledger.verification[0].status, "pending");
  assert.equal(result.ledger.criteria[0].state, "pending");
  assert.equal(result.outcome, "needs_attention");
});

test("code with no discovered check is explicitly unverified in completion evidence", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-unverified-ledger-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "code.ts"), "no configured checks");
  const runtimeValidation = new ValidationFeedback(root).assess(["code.ts"]).report;
  const result = deriveCompletionEvidence({ messages: [{ ...message([]), runtimeValidation }] });
  assert.equal(result.outcome, "needs_attention");
  assert.deepEqual(result.ledger.blockers, ["check"]);
});
