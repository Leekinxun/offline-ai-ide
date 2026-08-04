import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendConversationMessage,
  createConversationId,
  deleteConversation,
  forkConversation,
  listConversationSummaries,
  readConversationMessages,
  withStructuredParts,
} from "./history.js";

test("derives structured parts while preserving legacy message fields", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-history-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const conversationId = createConversationId();

  await appendConversationMessage(workspace, conversationId, {
    role: "assistant",
    content: "done",
    thinking: "checking",
    timestamp: 100,
    toolCalls: [{
      toolCallId: "call-1",
      name: "read_file",
      input: { path: "a.ts" },
      result: "contents",
    }],
  });

  const [message] = readConversationMessages(workspace, conversationId);
  assert.equal(message.content, "done");
  assert.equal(message.thinking, "checking");
  assert.equal(message.toolCalls?.[0].name, "read_file");
  assert.deepEqual(message.parts?.map((part) => part.type), ["thinking", "text", "tool"]);
  assert.equal(message.parts?.[2].type === "tool" && message.parts[2].status, "completed");
});

test("forks a conversation at a selected message timestamp", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-history-fork-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const conversationId = createConversationId();
  await appendConversationMessage(workspace, conversationId, {
    role: "user",
    content: "first",
    timestamp: 100,
  });
  await appendConversationMessage(workspace, conversationId, {
    role: "assistant",
    content: "second",
    timestamp: 200,
  });

  const fork = forkConversation(workspace, conversationId, { upToTimestamp: 100 });
  assert.notEqual(fork.id, conversationId);
  assert.equal(fork.messageCount, 1);
  assert.equal(readConversationMessages(workspace, fork.id)[0].content, "first");
  assert.match(fork.title, /^Fork/);
});

test("deletes a saved conversation without affecting other history", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-history-delete-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const deletedId = createConversationId();
  const retainedId = createConversationId();

  await appendConversationMessage(workspace, deletedId, {
    role: "user",
    content: "delete me",
    timestamp: 100,
  });
  await appendConversationMessage(workspace, retainedId, {
    role: "user",
    content: "keep me",
    timestamp: 200,
  });

  await deleteConversation(workspace, deletedId);

  assert.deepEqual(listConversationSummaries(workspace).map((entry) => entry.id), [retainedId]);
  assert.throws(() => readConversationMessages(workspace, deletedId), /not found/i);
  assert.equal(readConversationMessages(workspace, retainedId)[0].content, "keep me");
});

test("normalizes explicit structured parts and drops malformed entries", () => {
  const message = withStructuredParts({
    role: "assistant",
    content: "legacy",
    timestamp: 100,
    parts: [
      { type: "text", text: "visible" },
      {
        type: "tool",
        toolCallId: "call-2",
        name: "bash",
        input: { command: "false" },
        status: "failed",
        isError: true,
      },
    ],
  });
  assert.deepEqual(message.parts?.map((part) => part.type), ["text", "tool"]);
  assert.equal(message.parts?.[1].type === "tool" && message.parts[1].status, "failed");
});
