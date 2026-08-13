import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { isProcessAlive } from "./processLiveness.js";

test("process liveness treats only ESRCH as dead", () => {
  assert.equal(isProcessAlive(42, () => undefined), true);
  assert.equal(isProcessAlive(42, () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); }), false);
  assert.equal(isProcessAlive(42, () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); }), true);
  assert.equal(isProcessAlive(42, () => { throw Object.assign(new Error("unknown"), { code: "EIO" }); }), true);
  assert.equal(isProcessAlive(0, () => undefined), false);
  assert.equal(isProcessAlive(Number.NaN, () => undefined), false);
});

test("all durable lock and lease writers use the fail-closed liveness helper", () => {
  const writers = [
    "agent/contextManifestStore.ts",
    "agent/orchestrationStore.ts",
    "agent/teammateManager.ts",
    "artifacts/evidenceBundleStore.ts",
    "chat/changeSetReviewRun.ts",
    "chat/changeSets.ts",
    "chat/traceStore.ts",
    "collaboration/collaborationStore.ts",
    "indexing/indexStore.ts",
    "integrations/feedbackStore.ts",
    "integrations/gitDelivery/store.ts",
    "persistence/migrations.ts",
  ];
  for (const relative of writers) {
    const source = fs.readFileSync(path.join(process.cwd(), "src", relative), "utf8");
    assert.match(source, /isProcessAlive/, relative);
    assert.doesNotMatch(source, /process\.kill\([^\n]*,\s*0\)/, relative);
  }
});

test("migrated filesystem locks retain malformed-owner fail-closed and token-fenced release contracts", () => {
  const writers = [
    "agent/contextManifestStore.ts",
    "agent/orchestrationStore.ts",
    "artifacts/evidenceBundleStore.ts",
    "chat/changeSetReviewRun.ts",
    "chat/changeSets.ts",
    "chat/traceStore.ts",
    "collaboration/collaborationStore.ts",
    "indexing/indexStore.ts",
    "integrations/feedbackStore.ts",
    "persistence/migrations.ts",
  ];
  for (const relative of writers) {
    const source = fs.readFileSync(path.join(process.cwd(), "src", relative), "utf8");
    assert.match(source, /token/i, `${relative}: lock owner token`);
    assert.match(source, /token\s*===|===\s*[^;\n]*token/i, `${relative}: token-fenced release`);
    assert.match(source, /catch\s*\{/, `${relative}: malformed-owner path`);
  }
});
