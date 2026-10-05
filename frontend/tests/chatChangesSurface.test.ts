import assert from "node:assert/strict";
import test from "node:test";
import { chatChangesEmptyState, hasCommandOnlyExternalEffects, shouldLoadDesktopCommandEffects } from "../src/components/chatChangesSurface";
import { parseReviewChanges } from "../src/components/runReviewPolicy";

test("desktop command-only changes tab loads run changes only for native cursor empty completed runs", () => {
  assert.equal(shouldLoadDesktopCommandEffects({ changesOpen: true, desktopCursor: true, isStreaming: false, changedFileCount: 0, runId: "run" }), true);
  assert.equal(shouldLoadDesktopCommandEffects({ changesOpen: true, desktopCursor: false, isStreaming: false, changedFileCount: 0, runId: "run" }), false);
  assert.equal(shouldLoadDesktopCommandEffects({ changesOpen: true, desktopCursor: true, isStreaming: true, changedFileCount: 0, runId: "run" }), false);
  assert.equal(shouldLoadDesktopCommandEffects({ changesOpen: true, desktopCursor: true, isStreaming: false, changedFileCount: 1, runId: "run" }), false);
  assert.equal(shouldLoadDesktopCommandEffects({ changesOpen: false, desktopCursor: true, isStreaming: false, changedFileCount: 0, runId: "run" }), false);
  assert.equal(shouldLoadDesktopCommandEffects({ changesOpen: true, desktopCursor: true, isStreaming: false, changedFileCount: 0, runId: null }), false);
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
      toolCallId: "shell-1",
      toolName: "bash",
      startedAt: 1,
      rollbackCoverage: "untracked",
      observedPaths: ["generated.txt"],
      observationComplete: true,
    }],
  }, "run");
  assert.equal(hasCommandOnlyExternalEffects(changes), true);
  assert.equal(chatChangesEmptyState({ shouldReadDesktopCommandEffects: true, loading: false, changes }), "externalOnly");
  assert.equal(changes.files.length, 0);
  assert.equal(changes.unavailableReason, undefined);
});

test("native command-effects fetch errors do not fall through to the default empty state", () => {
  assert.equal(chatChangesEmptyState({ shouldReadDesktopCommandEffects: true, loading: false, error: "missing receipt", changes: null }), "error");
  assert.notEqual(chatChangesEmptyState({ shouldReadDesktopCommandEffects: true, loading: false, error: "missing receipt", changes: null }), "default");
});
