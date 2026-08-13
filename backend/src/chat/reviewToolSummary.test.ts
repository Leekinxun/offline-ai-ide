import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { PersistedChatMessage } from "./history.js";
import { ReviewFindingStore } from "./reviewFindingStore.js";
import { summarizeAssistantMessages } from "../ws/chat.js";

test("review summary prefers structured tool findings over legacy prose and persists them across reload", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-review-tool-"));
  const structured = {
    severity: "error", lens: "correctness", path: "src/a.ts", line: 9,
    message: "Structured finding", evidence: ["return value is discarded"], reviewedRevision: "rev-42",
  };
  const messages: PersistedChatMessage[] = [{
    role: "assistant",
    content: "[critical] `src/prose.ts:1` - legacy prose must not win",
    timestamp: 1,
    toolCalls: [{ toolCallId: "tool-1", name: "report_review_finding", input: structured, result: JSON.stringify(structured) }],
  }];
  const summary = summarizeAssistantMessages(messages, "review", workspace);
  assert.equal(summary.reviewFindings?.length, 1);
  assert.equal(summary.reviewFindings?.[0]?.message, "Structured finding");
  assert.equal(summary.reviewFindings?.[0]?.reviewedRevision, "rev-42");

  const store = new ReviewFindingStore(workspace);
  const stored = store.ingest(summary.reviewFindings?.[0], {
    id: "reviewer", modelName: "review-model", profile: "review", revision: summary.reviewFindings?.[0]?.reviewedRevision,
  }, { runId: "run-server", conversationId: "conversation-server" });
  assert.ok(stored);
  const reloaded = new ReviewFindingStore(workspace).list();
  assert.equal(reloaded.length, 1);
  assert.deepEqual(reloaded[0]?.reviewer, { id: "reviewer", modelName: "review-model", profile: "review", revision: "rev-42" });
  assert.equal(reloaded[0]?.runId, "run-server");
  assert.equal(reloaded[0]?.conversationId, "conversation-server");
  await fs.rm(workspace, { recursive: true, force: true });
});
