import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compareEditorDiagnosticAdvisories, compareValidationDiagnostics, discoverValidationCommands, resolveResumedValidation, ValidationFeedback } from "./validationFeedback.js";
import { getDiagnosticsWorkspaceVersion, type DiagnosticsResult } from "../diagnostics/service.js";
import { publishEditorDiagnostics, type EditorDiagnosticSnapshot } from "../chat/editorDiagnostics.js";
import { buildFileVersion } from "../files/mutationRegistry.js";

function fixture(t: test.TestContext, scripts: Record<string, string> = { test: "node check.cjs" }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-validation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts }));
  fs.writeFileSync(path.join(root, "app.ts"), "const value = 1;");
  return root;
}

test("validation discovery chooses bounded relevant task kinds, respects an approved plan, and skips documentation", (t) => {
  const root = fixture(t, { dev: "vite", typecheck: "tsc", lint: "eslint", test: "node check.cjs", "test:watch": "test --watch", build: "build" });
  assert.deepEqual(discoverValidationCommands(root, ["app.ts"]), ["npm run typecheck", "npm run test"]);
  assert.deepEqual(discoverValidationCommands(root, ["README.md"]), []);
  assert.deepEqual(discoverValidationCommands(root, ["app.ts"], ["custom approved check"]), ["custom approved check"]);
  assert.deepEqual(discoverValidationCommands(root, ["app.ts"], []), []);
  fs.mkdirSync(path.join(root, "nested"));
  fs.writeFileSync(path.join(root, "nested/package.json"), JSON.stringify({ scripts: { check: "tsc" } }));
  assert.deepEqual(discoverValidationCommands(root, ["nested/app.ts"]), ["cd nested && npm run check"]);
});

test("passing command evidence is invalidated by later edits and a fresh run restores validation", (t) => {
  const root = fixture(t);
  const validation = new ValidationFeedback(root);
  assert.match(validation.assess(["app.ts"]).feedback || "", /normal bash tool/);
  validation.observeCommand({ command: "npm test", toolCallId: "pass-1", output: "ok", isError: false, denied: false, changedFiles: ["app.ts"] });
  assert.equal(validation.assess(["app.ts"]).report.status, "passed");
  fs.writeFileSync(path.join(root, "app.ts"), "const value = 2;");
  assert.equal(validation.assess(["app.ts"]).report.verification[0].status, "pending");
  validation.observeCommand({ command: "npm run test", toolCallId: "pass-2", output: "ok", isError: false, denied: false, changedFiles: ["app.ts"] });
  assert.equal(validation.assess(["app.ts"]).report.verification[0].toolCallId, "pass-2");
});

test("denied checks remain unverified without repeated authorization prompts, even after another edit", (t) => {
  const root = fixture(t);
  const validation = new ValidationFeedback(root);
  validation.observeCommand({ command: "npm run test", toolCallId: "deny", output: "Denied by user", isError: true, denied: true, changedFiles: ["app.ts"] });
  const denied = validation.assess(["app.ts"]);
  assert.equal(denied.report.status, "unverified");
  assert.equal(denied.feedback, undefined);
  fs.writeFileSync(path.join(root, "app.ts"), "edited again");
  assert.equal(validation.assess(["app.ts"]).feedback, undefined);
});

test("failed validation feeds back at most twice and missing checks never become passed", (t) => {
  const root = fixture(t);
  const validation = new ValidationFeedback(root);
  validation.observeCommand({ command: "npm run test", toolCallId: "fail", output: "Error: Process exited with code 1", isError: true, denied: false, changedFiles: ["app.ts"] });
  assert.ok(validation.assess(["app.ts"]).feedback);
  assert.ok(validation.assess(["app.ts"]).feedback);
  const final = validation.assess(["app.ts"]);
  assert.equal(final.report.status, "failed");
  assert.equal(final.feedback, undefined);
  fs.unlinkSync(path.join(root, "package.json"));
  const missing = new ValidationFeedback(root).assess(["app.ts"]);
  assert.equal(missing.report.status, "unverified");
  assert.equal(missing.feedback, undefined);
  assert.equal(new ValidationFeedback(root).assess(["README.md"]).report.status, "not_required");
});

test("diagnostics distinguish known baseline errors, new downstream errors and stale snapshots", (t) => {
  const root = fixture(t);
  const previousError = { path: "app.ts", line: 1, column: 1, severity: "error" as const, source: "tsc", message: "old error" };
  const baseline: DiagnosticsResult = { diagnostics: [previousError], tools: ["tsc"], startedAt: 1, durationMs: 1, session: { status: "stopped", generation: 1 }, workspaceVersion: getDiagnosticsWorkspaceVersion(root) };
  fs.writeFileSync(path.join(root, "app.ts"), "new code");
  const current: DiagnosticsResult = { ...baseline, startedAt: 2, workspaceVersion: getDiagnosticsWorkspaceVersion(root), diagnostics: [previousError, { ...previousError, path: "consumer.ts", message: "new downstream error" }] };
  const compared = compareValidationDiagnostics(root, baseline, current, ["app.ts"]);
  assert.equal(compared.status, "fresh");
  assert.equal(compared.preExistingErrors.length, 1);
  assert.equal(compared.newErrors[0].path, "consumer.ts");
  assert.equal(compareValidationDiagnostics(root, baseline, baseline, ["app.ts"]).status, "stale");
  const unknown = compareValidationDiagnostics(root, { ...baseline, workspaceVersion: undefined }, current, ["app.ts"]);
  assert.equal(unknown.newErrors.length, 0);
  assert.equal(unknown.unclassifiedErrors.length, 1);
});

test("diagnostic fingerprints ignore control metadata but continue scanning after ignored directories", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, ".git"));
  const before = getDiagnosticsWorkspaceVersion(root);
  fs.writeFileSync(path.join(root, "app.ts"), "changed source");
  const changed = getDiagnosticsWorkspaceVersion(root);
  assert.notEqual(before, changed);
  fs.mkdirSync(path.join(root, ".history"));
  fs.writeFileSync(path.join(root, ".history/messages.json"), "{}");
  assert.equal(getDiagnosticsWorkspaceVersion(root), changed);
});

test("check discovery cannot follow a manifest symlink outside the workspace", (t) => {
  const root = fixture(t);
  const outside = fixture(t, { test: "OUTSIDE_MANIFEST_CANARY" });
  fs.unlinkSync(path.join(root, "package.json"));
  fs.symlinkSync(path.join(outside, "package.json"), path.join(root, "package.json"));
  const result = new ValidationFeedback(root).assess(["app.ts"]);
  assert.equal(result.report.status, "unverified");
  assert.equal(result.feedback, undefined);
  assert.doesNotMatch(JSON.stringify(result), /OUTSIDE_MANIFEST_CANARY/);
});

test("resume validation fails closed for missing or corrupt stored runs", (t) => {
  const root = fixture(t);
  assert.match(resolveResumedValidation(root, "current-conversation", "missing-run").error || "", /cannot be trusted/);
  fs.mkdirSync(path.join(root, ".history/runs"), { recursive: true });
  fs.writeFileSync(path.join(root, ".history/runs", "broken-run.json"), "{broken");
  const result = resolveResumedValidation(root, "current-conversation", "broken-run");
  assert.match(result.error || "", /cannot be trusted/);
  assert.deepEqual(result.commands, []);
});

test("editor advisories ignore stale versions and distinguish moved old errors from additional occurrences", () => {
  const diagnostic = { path: "app.ts", line: 1, column: 1, severity: "error" as const, message: "Unknown name", source: "typescript", code: "2304" };
  const baseline: EditorDiagnosticSnapshot = { path: "app.ts", version: "old-version", observedAt: 1, modelVersion: 1, truncated: false, provenance: "editor_advisory", baselineEligible: true, diagnostics: [diagnostic] };
  const current: EditorDiagnosticSnapshot = { ...baseline, version: "current-version", observedAt: 2, diagnostics: [{ ...diagnostic, line: 5 }, { ...diagnostic, line: 8 }] };
  const observed = compareEditorDiagnosticAdvisories(new Map([["app.ts", baseline]]), [current], { "app.ts": "current-version" });
  assert.deepEqual(observed.map((item) => item.classification), ["pre_existing", "new_since_baseline"]);
  assert.deepEqual(compareEditorDiagnosticAdvisories(new Map([["app.ts", baseline]]), [baseline], { "app.ts": "current-version" }), []);
});

test("editor markers without reliable model versions remain unclassified advisory, and empty markers prove nothing", () => {
  const diagnostic = { path: "app.ts", line: 1, column: 1, severity: "error" as const, message: "Cannot find symbol", source: "typescript" };
  const snapshot: EditorDiagnosticSnapshot = { path: "app.ts", version: "version", observedAt: 1, modelVersion: 1, truncated: false, provenance: "editor_advisory", baselineEligible: true, diagnostics: [diagnostic] };
  for (const [baseline, current] of [[{ ...snapshot, baselineEligible: false }, snapshot], [snapshot, { ...snapshot, baselineEligible: false }]]) {
    const result = compareEditorDiagnosticAdvisories(new Map([["app.ts", baseline]]), [current], { "app.ts": "version" });
    assert.equal(result[0].classification, "current_unclassified");
  }
  assert.deepEqual(compareEditorDiagnosticAdvisories(new Map([["app.ts", snapshot]]), [{ ...snapshot, diagnostics: [], baselineEligible: false }], { "app.ts": "version" }), []);
});

test("empty client diagnostics cannot satisfy a real verification requirement", (t) => {
  const root = fixture(t);
  publishEditorDiagnostics({ workspaceDir: root, owner: "tester" }, { workspaceDir: root, path: "app.ts", version: buildFileVersion(fs.readFileSync(path.join(root, "app.ts"), "utf8")), modelVersion: 1, publisherId: "editor", sequence: 1, dirty: false, diagnostics: [] });
  const result = new ValidationFeedback(root, undefined, "tester").assess(["app.ts"]);
  assert.equal(result.report.status, "unverified");
  assert.equal(result.report.verification[0].status, "pending");
  assert.equal(result.report.editorDiagnostics, undefined);
});

test("fresh unclassified client errors are advisory once per version and never override actual check success", (t) => {
  const root = fixture(t);
  const validator = new ValidationFeedback(root, undefined, "tester");
  validator.observeCommand({ command: "npm run test", toolCallId: "real-check", output: "ok", isError: false, denied: false, changedFiles: ["app.ts"] });
  const payload = { workspaceDir: root, path: "app.ts", version: buildFileVersion(fs.readFileSync(path.join(root, "app.ts"), "utf8")), modelVersion: 1, publisherId: "editor", sequence: 1, dirty: false, diagnostics: [{ line: 1, column: 1, severity: "error", source: "monaco", message: "Current editor observation" }] };
  publishEditorDiagnostics({ workspaceDir: root, owner: "tester" }, payload);
  const first = validator.assess(["app.ts"]);
  assert.equal(first.report.status, "passed");
  assert.equal(first.report.editorDiagnostics?.errors[0].classification, "current_unclassified");
  assert.match(first.feedback || "", /untrusted client observations/);
  assert.equal(validator.assess(["app.ts"]).feedback, undefined);
  publishEditorDiagnostics({ workspaceDir: root, owner: "tester" }, { ...payload, sequence: 2, diagnostics: [{ ...payload.diagnostics[0], message: "Another transient observation at the same version" }] });
  assert.equal(validator.assess(["app.ts"]).feedback, undefined);
});

test("pre-existing editor errors and another owner's observations do not create repair requests", (t) => {
  const root = fixture(t);
  const payload = { workspaceDir: root, path: "app.ts", version: buildFileVersion(fs.readFileSync(path.join(root, "app.ts"), "utf8")), modelVersion: 1, publisherId: "editor", sequence: 1, dirty: false, diagnostics: [{ line: 1, column: 1, severity: "error", source: "monaco", message: "Existing error", modelVersion: 1 }] };
  publishEditorDiagnostics({ workspaceDir: root, owner: "tester" }, payload);
  const validator = new ValidationFeedback(root, undefined, "tester");
  validator.observeCommand({ command: "npm run test", toolCallId: "check", output: "ok", isError: false, denied: false, changedFiles: ["app.ts"] });
  publishEditorDiagnostics({ workspaceDir: root, owner: "someone-else" }, { ...payload, diagnostics: [{ ...payload.diagnostics[0], message: "Unrelated other owner error" }] });
  const result = validator.assess(["app.ts"]);
  assert.equal(result.report.status, "passed");
  assert.equal(result.feedback, undefined);
  assert.equal(result.report.editorDiagnostics?.errors[0].classification, "pre_existing");
  assert.doesNotMatch(JSON.stringify(result), /Unrelated other owner/);
});
