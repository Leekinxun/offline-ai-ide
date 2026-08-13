import assert from "node:assert/strict";
import test from "node:test";
import { runCriticalPathIteration } from "./ws15CriticalPath.js";

test("WS-15 critical path locks modal, tree, security, migration restore, and corrupt recovery behavior", () => {
  assert.deepEqual(runCriticalPathIteration(), {
    modalTopmostClaimed: true,
    visibleTreeNavigation: true,
    secretRedaction: true,
    exactMigrationRestore: true,
    corruptRecoveryDetected: true,
  });
});
