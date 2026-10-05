import assert from "node:assert/strict";
import test from "node:test";
import { EN_MESSAGES, ZH_CN_MESSAGES } from "../src/i18n/messages.ts";
import type { ChatMessage } from "../src/types/index.ts";
import {
  boundedFailureReason,
  checkpointFileLimit,
  editorRunFailureBody,
  editorRunFailureTitle,
  formatEditorFailureReason,
  isEditorAssistantMessageVisible,
} from "../src/utils/editorAssistantFailure.ts";
import { runFailureNotice } from "../src/utils/runFailureNotice.ts";

const t = (key: string, values?: Record<string, string | number>) =>
  (ZH_CN_MESSAGES[key] || EN_MESSAGES[key] || key).replace(/\{(\w+)\}/g, (_match, name: string) => String(values?.[name] ?? `{${name}}`));

test("desktop editor assistant keeps error-only assistant messages visible while web filtering is unchanged", () => {
  const message: ChatMessage = {
    role: "assistant",
    content: "",
    timestamp: 1,
    error: "Checkpoint exceeds 20000 files",
  };

  assert.equal(isEditorAssistantMessageVisible(message, false), false);
  assert.equal(isEditorAssistantMessageVisible(message, true), true);
  assert.equal(isEditorAssistantMessageVisible({ ...message, role: "user" }, true), false);
});

test("checkpoint file-limit failures get a concrete editor-panel explanation", () => {
  assert.equal(checkpointFileLimit("Checkpoint exceeds 20000 files"), 20_000);
  assert.equal(formatEditorFailureReason("Checkpoint exceeds 20000 files", t), "工作区快照超出 20000 个文件。桌面 Agent 任务已不再依赖此快照，可重新执行；手动工作区快照仍有此限制。");

  const notice = runFailureNotice(null, {
    changedFiles: [],
    toolCallCount: 0,
    errorCount: 1,
    commandCount: 0,
    failureReason: "Checkpoint exceeds 20000 files",
  });
  assert.ok(notice);
  assert.equal(editorRunFailureTitle(notice, t), "工作区快照过大");
  assert.equal(editorRunFailureBody(notice, t), "工作区快照超出 20000 个文件。桌面 Agent 任务已不再依赖此快照，可重新执行；手动工作区快照仍有此限制。");
});

test("generic editor failure reasons remain server-provided and bounded", () => {
  const reason = `Provider disconnected ${"x".repeat(800)}`;

  assert.equal(formatEditorFailureReason("Provider disconnected", t), "Provider disconnected");
  assert.equal(boundedFailureReason(reason).length, 640);
  assert.ok(boundedFailureReason(reason).endsWith("..."));
});
