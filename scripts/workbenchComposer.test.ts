import assert from "node:assert/strict";
import test from "node:test";
import { EN_MESSAGES, ZH_CN_MESSAGES } from "../frontend/src/i18n/messages.js";
import { CHAT_EMPTY_QUICK_PROMPTS, resolveQuickPromptCopy } from "../frontend/src/components/workbenchQuickPrompts.js";

const expectedModes = {
  inspect: "ask",
  plan: "plan",
  fix: "code",
  test: "review",
} as const;

test("empty-chat quick cards resolve to real prompts instead of label keys", () => {
  assert.deepEqual(CHAT_EMPTY_QUICK_PROMPTS.map((prompt) => prompt.id), ["inspect", "plan", "fix", "test"]);
  for (const definition of CHAT_EMPTY_QUICK_PROMPTS) {
    assert.equal(definition.mode, expectedModes[definition.id]);
    for (const [locale, messages] of [["en", EN_MESSAGES], ["zh-CN", ZH_CN_MESSAGES]] as const) {
      const copy = resolveQuickPromptCopy(messages, definition.id);
      assert.equal(copy.mode, definition.mode, `${locale} mode mismatch for ${definition.id}`);
      assert.ok(copy.label.trim(), `${locale} label missing for ${definition.id}`);
      assert.ok(copy.prompt.trim(), `${locale} prompt missing for ${definition.id}`);
      assert.notEqual(copy.label, definition.labelKey, `${locale} label fell back to key for ${definition.id}`);
      assert.notEqual(copy.prompt, definition.promptKey, `${locale} prompt fell back to key for ${definition.id}`);
      assert.notEqual(copy.prompt, copy.label, `${locale} prompt should be a full instruction for ${definition.id}`);
      assert.ok(copy.prompt.length > copy.label.length + 12, `${locale} prompt is not meaningfully longer than label for ${definition.id}`);
    }
  }
});

test("quick prompt labels and prompts are complete in both core locales", () => {
  for (const definition of CHAT_EMPTY_QUICK_PROMPTS) {
    const english = resolveQuickPromptCopy(EN_MESSAGES, definition.id);
    const chinese = resolveQuickPromptCopy(ZH_CN_MESSAGES, definition.id);
    assert.match(english.prompt, /\b(?:workspace|task|tests|fix|plan|Inspect)\b/i, `English prompt lacks task wording for ${definition.id}`);
    assert.match(chinese.prompt, /[\u4e00-\u9fff]/, `Chinese prompt lacks Chinese copy for ${definition.id}`);
  }
});
