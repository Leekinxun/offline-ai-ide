import assert from "node:assert/strict";
import test from "node:test";
import {
  isDisposedInlineAssistantContextError,
  isInlineAssistantEditorUsable,
} from "../frontend/src/editor/inlineAssistantLifecycle.js";

test("inline assistant refuses disposed or throwing editor instances", () => {
  assert.equal(isInlineAssistantEditorUsable(null), false);
  assert.equal(isInlineAssistantEditorUsable({ getModel: () => ({ isDisposed: () => true }) } as any), false);
  assert.equal(isInlineAssistantEditorUsable({ getModel: () => ({ isDisposed: () => false }) } as any), true);
  assert.equal(isInlineAssistantEditorUsable({ getModel: () => null } as any), false);
  assert.equal(isInlineAssistantEditorUsable({ getModel: () => { throw new Error("disposed"); } } as any), false);
});

test("inline assistant only suppresses the known disposed Monaco context-key race", () => {
  assert.equal(
    isDisposedInlineAssistantContextError(new Error("AbstractContextKeyService has been disposed")),
    true
  );
  assert.equal(isDisposedInlineAssistantContextError(new Error("context key failed for another reason")), false);
  assert.equal(isDisposedInlineAssistantContextError("AbstractContextKeyService has been disposed"), false);
});
