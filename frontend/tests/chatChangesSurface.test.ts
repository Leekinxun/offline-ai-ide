import assert from "node:assert/strict";
import test from "node:test";
import { chatChangesEmptyState, hasCommandOnlyExternalEffects, shouldLoadChatRunEffects } from "../src/components/chatChangesSurface.ts";
import { parseReviewChanges } from "../src/components/runReviewPolicy.ts";

test("command-only changes tab loads run changes for completed empty runs", () => {
  assert.equal(shouldLoadChatRunEffects({ changesOpen: true, isStreaming: false, changedFileCount: 0, runId: "run" }), true);
  assert.equal(shouldLoadChatRunEffects({ changesOpen: true, isStreaming: true, changedFileCount: 0, runId: "run" }), false);
  assert.equal(shouldLoadChatRunEffects({ changesOpen: true, isStreaming: false, changedFileCount: 1, runId: "run" }), false);
  assert.equal(shouldLoadChatRunEffects({ changesOpen: false, isStreaming: false, changedFileCount: 0, runId: "run" }), false);
  assert.equal(shouldLoadChatRunEffects({ changesOpen: true, isStreaming: false, changedFileCount: 0, runId: null }), false);
});

test("external-only run changes select the command-effects empty state without fake files", () => {
  const changes = parseReviewChanges({
    runId: "run",
    revision: "rev",
    files: [],
    externalToolEffects: [{
      schemaVersion: 1,
      runId: "run",
      requestId: "turn",
      toolName: "bash",
      startedAt: 1,
      rollbackCoverage: "untracked",
      observedPaths: ["generated.txt"],
      observationComplete: false,
    }],
  }, "run");
  assert.equal(hasCommandOnlyExternalEffects(changes), true);
  assert.equal(chatChangesEmptyState({ shouldReadRunEffects: true, loading: false, changes }), "externalOnly");
  assert.equal(changes.files.length, 0);
  assert.equal(changes.unavailableReason, undefined);
});

test("command-effects fetch errors do not fall through to the default empty state", () => {
  assert.equal(chatChangesEmptyState({ shouldReadRunEffects: true, loading: false, error: "missing receipt", changes: null }), "error");
  assert.notEqual(chatChangesEmptyState({ shouldReadRunEffects: true, loading: false, error: "missing receipt", changes: null }), "default");
});
