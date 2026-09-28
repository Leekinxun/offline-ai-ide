import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { EditorProblem } from "../frontend/src/hooks/useEditorProblems.js";
import { buildEditorDiagnosticPayload, diagnosticModelPath } from "../frontend/src/editor/editorDiagnosticPolicy.js";

const content = "const value = 1;\n";
const version = createHash("sha1").update(content).digest("hex");
const problem: EditorProblem = { id: "p1", path: "src/a.ts", line: 1, column: 1, endLine: 1, endColumn: 2,
  severity: "error", message: "Mismatch", source: "typescript", modelUri: "file:///src/a.ts", modelVersion: 4, observedModelVersion: 4 };
const input = () => ({ workspaceDir: "/repo", file: { path: "src/a.ts", content, version, modified: false },
  model: { uri: "file:///src/a.ts", path: "/src/a.ts", version: 4, content }, contentVersion: version,
  problems: [problem], publisherId: "client", sequence: 1 });

test("a clean matching saved model produces a version-bound advisory payload", () => {
  const payload = buildEditorDiagnosticPayload(input())!;
  assert.equal(payload.version, version); assert.equal(payload.modelVersion, 4); assert.equal(payload.path, "src/a.ts");
  assert.equal(payload.diagnostics[0].modelVersion, 4); assert.equal(payload.dirty, false);
  assert.equal("content" in payload, false); assert.equal("status" in payload, false);
});

test("dirty, stale disk hash, wrong model path and different live text are not uploaded", () => {
  const value = input();
  assert.equal(buildEditorDiagnosticPayload({ ...value, file: { ...value.file, modified: true } }), null);
  assert.equal(buildEditorDiagnosticPayload({ ...value, contentVersion: "0".repeat(40) }), null);
  assert.equal(buildEditorDiagnosticPayload({ ...value, model: { ...value.model, path: "/other.ts" } }), null);
  assert.equal(buildEditorDiagnosticPayload({ ...value, model: { ...value.model, content: "typed after save" } }), null);
  assert.equal(buildEditorDiagnosticPayload({ ...value, file: { ...value.file, version: undefined } }), null);
});

test("old or unobserved markers cannot be relabelled with the latest saved version", () => {
  const value = input();
  assert.equal(buildEditorDiagnosticPayload({ ...value, problems: [{ ...problem, modelVersion: 3 }] }), null);
  assert.equal(buildEditorDiagnosticPayload({ ...value, problems: [{ ...problem, observedModelVersion: 3 }] }), null);
  assert.equal(buildEditorDiagnosticPayload({ ...value, problems: [{ ...problem, observedModelVersion: undefined }] }), null);
});

test("unknown producer version remains unknown while markers from other models are excluded", () => {
  const payload = buildEditorDiagnosticPayload({ ...input(), problems: [{ ...problem, modelVersion: undefined }, { ...problem, id: "other", modelUri: "file:///other.ts" }] })!;
  assert.equal(payload.diagnostics.length, 1);
  assert.equal("modelVersion" in payload.diagnostics[0], false);
  assert.equal(payload.diagnostics[0].source, "editor:typescript");
});

test("diagnostic count, text and total byte budgets truncate with an explicit incomplete marker", () => {
  const count = buildEditorDiagnosticPayload({ ...input(), problems: Array.from({ length: 101 }, () => problem) })!;
  assert.equal(count.diagnostics.length, 100); assert.equal(count.truncated, true);
  const text = buildEditorDiagnosticPayload({ ...input(), problems: [{ ...problem, message: "x".repeat(1001), source: "y".repeat(200), code: "z".repeat(101) }] })!;
  assert.equal(text.diagnostics[0].message.length, 1000); assert.equal(text.diagnostics[0].source.length, 120); assert.equal(text.diagnostics[0].code?.length, 100); assert.equal(text.truncated, true);
  const bytes = buildEditorDiagnosticPayload({ ...input(), problems: Array.from({ length: 100 }, () => ({ ...problem, message: "x".repeat(1000) })) })!;
  assert.ok(bytes.diagnostics.length < 100); assert.equal(bytes.truncated, true);
});

test("empty marker observations do not manufacture a validation or baseline claim", () => {
  const payload = buildEditorDiagnosticPayload({ ...input(), problems: [] })!;
  assert.deepEqual(payload.diagnostics, []);
  assert.equal("baselineEligible" in payload, false); assert.equal("passed" in payload, false);
});

test("model path normalization handles workspace absolute paths and Windows URI drive prefixes", () => {
  assert.equal(diagnosticModelPath("/repo/src/a.ts", "/repo"), "src/a.ts");
  assert.equal(diagnosticModelPath("/C:/repo/src/a.ts", "C:\\repo"), "src/a.ts");
  assert.equal(diagnosticModelPath("src\\a.ts", "/repo"), "src/a.ts");
});
