import assert from "node:assert/strict";
import test from "node:test";
import {
  createInlineAssistantRequest,
  inlineInstructionLabel,
  extractInlineCode,
  getInlineApplyState,
  isInlineTargetCurrent,
  type InlineAssistantResponse,
  type InlineAssistantTarget,
  type InlineDocumentState,
} from "../frontend/src/editor/inlineAssistantPolicy.js";

const target = (overrides: Partial<InlineAssistantTarget> = {}): InlineAssistantTarget => ({
  path: "src/main.ts",
  language: "typescript",
  modelUri: "file:///repo/src/main.ts",
  modelVersion: 4,
  fullModelSnapshot: "const value = 1;\nconsole.log(value);",
  selection: { startLine: 1, startColumn: 15, endLine: 1, endColumn: 16 },
  selectedText: "1",
  dirty: true,
  modelKey: "provider/model-a",
  ...overrides,
});
const current = (source = target(), overrides: Partial<InlineDocumentState> = {}): InlineDocumentState => ({
  path: source.path, language: source.language, modelUri: source.modelUri,
  modelVersion: source.modelVersion, fullModelSnapshot: source.fullModelSnapshot,
  modelKey: source.modelKey, readOnly: false, ...overrides,
});
const request = createInlineAssistantRequest(target(), "change one to two", "req-1");
const completed: InlineAssistantResponse = { requestId: "req-1", status: "completed", text: "```ts\n2\n```" };

test("extracts one complete fenced replacement while preserving indentation", () => {
  assert.deepEqual(extractInlineCode("```ts\n  return value;\n```", true), { kind: "complete", code: "  return value;" });
  assert.deepEqual(extractInlineCode("\n~~~c++\r\n  return value;\r\n~~~\n", true), { kind: "complete", code: "  return value;" });
});

test("supports a longer outer fence when replacement contains fenced Markdown", () => {
  assert.deepEqual(extractInlineCode("````markdown\n```ts\nlet x = 1;\n```\n````", true), {
    kind: "complete", code: "```ts\nlet x = 1;\n```",
  });
});

test("plain text and explanations around a block are never interpreted as a replacement", () => {
  for (const text of ["Use the value 2 instead.", "let x = 2;", "Here is the fix:\n```ts\n2\n```", "```ts\n2\n```\nThis fixes it."]) {
    assert.equal(extractInlineCode(text, true).kind, "invalid", text);
  }
});

test("multiple code blocks and unmatched fences are rejected", () => {
  for (const text of ["```ts\n2\n```\n```ts\n3\n```", "```ts\n2", "````ts\n2\n```", "```ts\n2\n~~~"]) {
    assert.equal(extractInlineCode(text, true).kind, "invalid", text);
  }
});

test("streaming shows a preview but never yields an applicable candidate", () => {
  assert.deepEqual(extractInlineCode("```ts\nconst value =", false), { kind: "partial", code: "const value =" });
  assert.deepEqual(extractInlineCode(completed.text, false), { kind: "partial", code: "2" });
  assert.deepEqual(getInlineApplyState(request, { ...completed, status: "streaming" }, current()), { allowed: false, reason: "pending" });
  assert.deepEqual(getInlineApplyState(request, { ...completed, text: "```ts\n2" }, current()), { allowed: false, reason: "invalid" });
});

test("a proposal can target an unsaved buffer without touching surrounding code", () => {
  assert.equal(request.dirty, true);
  assert.deepEqual(getInlineApplyState(request, completed, current()), { allowed: true, replacement: "2" });
  assert.equal(request.fullModelSnapshot, "const value = 1;\nconsole.log(value);");
  assert.deepEqual(request.selection, { startLine: 1, startColumn: 15, endLine: 1, endColumn: 16 });
});

test("typing after submission invalidates the captured model version", () => {
  assert.deepEqual(getInlineApplyState(request, completed, current(target(), { modelVersion: 5, fullModelSnapshot: "const value = 10;\nconsole.log(value);" })), { allowed: false, reason: "stale" });
});

test("undoing back to identical text does not revive a stale proposal", () => {
  assert.deepEqual(getInlineApplyState(request, completed, current(target(), { modelVersion: 6 })), { allowed: false, reason: "stale" });
});

test("full snapshot comparison catches edits even if a host reuses a model version", () => {
  assert.deepEqual(getInlineApplyState(request, completed, current(target(), { fullModelSnapshot: "const value = 1;\notherSideEffect();" })), { allowed: false, reason: "stale" });
});

test("switching editor models, file paths, language, or AI model invalidates the proposal", () => {
  for (const state of [
    { path: "src/other.ts" },
    { modelUri: "file:///other-repo/src/main.ts" },
    { language: "javascript" },
    { modelKey: "provider/model-b" },
  ]) {
    assert.deepEqual(getInlineApplyState(request, completed, current(target(), state)), { allowed: false, reason: "stale" });
  }
});

test("readonly blocks acceptance even with a completed and current proposal", () => {
  assert.deepEqual(getInlineApplyState(request, completed, current(target(), { readOnly: true })), { allowed: false, reason: "readonly" });
});

test("responses are bound to their exact request; cancellation and errors cannot apply", () => {
  for (const response of [
    { ...completed, requestId: "an-older-request" },
    { ...completed, status: "cancelled" as const },
    { ...completed, status: "error" as const },
  ]) assert.deepEqual(getInlineApplyState(request, response, current()), { allowed: false, reason: "pending" });
});

test("selection text and bounds are verified against the captured snapshot", () => {
  assert.equal(isInlineTargetCurrent(target({ selectedText: "another value" }), current()), false);
  for (const selection of [
    { startLine: 0, startColumn: 1, endLine: 1, endColumn: 1 },
    { startLine: 1, startColumn: 99, endLine: 1, endColumn: 100 },
    { startLine: 1, startColumn: 16, endLine: 1, endColumn: 15 },
    { startLine: 2, startColumn: 1, endLine: 1, endColumn: 1 },
    { startLine: 1, startColumn: 1, endLine: 3, endColumn: 1 },
  ]) assert.equal(isInlineTargetCurrent(target({ selection }), current()), false);
});

test("multiline CRLF selections compare correctly without normalizing the full snapshot", () => {
  const source = target({ fullModelSnapshot: "alpha\r\nbeta", selection: { startLine: 1, startColumn: 3, endLine: 2, endColumn: 3 }, selectedText: "pha\r\nbe" });
  assert.equal(isInlineTargetCurrent(source, current(source)), true);
  assert.equal(isInlineTargetCurrent(source, current(source, { fullModelSnapshot: "alpha\nbeta" })), false);
});

test("empty fenced code is an explicit deletion only when there is selected text", () => {
  const deletion = { ...completed, text: "```\n```" };
  assert.deepEqual(getInlineApplyState(request, deletion, current()), { allowed: true, replacement: "" });
  const cursor = target({ selection: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, selectedText: "" });
  assert.deepEqual(getInlineApplyState(createInlineAssistantRequest(cursor, "insert code", "req-1"), deletion, current(cursor)), { allowed: false, reason: "unchanged" });
});

test("an empty editor accepts a cursor insertion into the captured model", () => {
  const empty = target({ fullModelSnapshot: "", selectedText: "", selection: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 } });
  assert.deepEqual(getInlineApplyState(createInlineAssistantRequest(empty, "insert code", "req-1"), completed, current(empty)), { allowed: true, replacement: "2" });
});

test("unchanged replacements are not offered as edits", () => {
  assert.deepEqual(getInlineApplyState(request, { ...completed, text: "```ts\n1\n```" }, current()), { allowed: false, reason: "unchanged" });
});

test("inline history labels show the instruction and scope without generation boilerplate", () => {
  assert.equal(inlineInstructionLabel(request.prompt), "change one to two\nsrc/main.ts:1–1");
  assert.equal(inlineInstructionLabel("ordinary user message"), null);
  assert.equal(inlineInstructionLabel("You are proposing an inline code edit in Ask mode.\nUser instruction: invalid"), null);
});

test("request prompt preserves scope without bypassing authorized context with copied source", () => {
  const source = target({ fullModelSnapshot: "PRIVATE_SOURCE_SENTINEL\n// ``` embedded fence\n", selectedText: "PRIVATE_SELECTION_SENTINEL" });
  const next = createInlineAssistantRequest(source, "  use two  ", "new-request");
  assert.equal(next.instruction, "use two");
  assert.match(next.prompt, /Do not write files or execute commands/);
  assert.match(next.prompt, /unsaved buffer: true/);
  assert.match(next.prompt, /exactly ONE fenced code block/);
  assert.match(next.prompt, /authorized editor document/);
  assert.equal(next.prompt.includes("PRIVATE_SOURCE_SENTINEL"), false);
  assert.equal(next.prompt.includes("PRIVATE_SELECTION_SENTINEL"), false);
  source.selection.startColumn = 1;
  assert.equal(next.selection.startColumn, 15);
});
