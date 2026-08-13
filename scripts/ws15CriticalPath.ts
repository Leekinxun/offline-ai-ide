import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactSecrets, REDACTED } from "../backend/src/agent/secretRedaction.js";
import { getMigrationStatus, migrateMaterialJson, rollbackLastMigration } from "../backend/src/persistence/migrations.js";
import { resolveVisibleTreeIndex } from "../frontend/src/components/fileTreeKeyboardContract.js";
import { claimModalEscape } from "../frontend/src/components/modalKeyboardContract.js";

export interface CriticalPathEvidence {
  modalTopmostClaimed: boolean;
  visibleTreeNavigation: boolean;
  secretRedaction: boolean;
  exactMigrationRestore: boolean;
  corruptRecoveryDetected: boolean;
}

export function runCriticalPathIteration(): CriticalPathEvidence {
  let childClosed = 0; let parentClosed = 0; let immediateStopped = false;
  const event = {
    key: "Escape",
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() { immediateStopped = true; },
  };
  claimModalEscape(event, () => { childClosed += 1; });
  if (!immediateStopped) claimModalEscape(event, () => { parentClosed += 1; });
  assert.deepEqual({ childClosed, parentClosed, immediateStopped }, { childClosed: 1, parentClosed: 0, immediateStopped: true });

  assert.equal(resolveVisibleTreeIndex(0, 3, "ArrowUp"), 0);
  assert.equal(resolveVisibleTreeIndex(1, 3, "ArrowDown"), 2);
  assert.equal(resolveVisibleTreeIndex(1, 3, "Home"), 0);
  assert.equal(resolveVisibleTreeIndex(1, 3, "End"), 2);

  const canary = "sk_ws15criticalsecret";
  const redacted = redactSecrets({ authorization: `Bearer ${canary}`, nested: `token=${canary}` });
  assert.deepEqual(redacted, { authorization: REDACTED, nested: `token=${REDACTED}` });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-ws15-critical-"));
  try {
    const source = path.join(root, "state.json");
    const legacyBytes = '{"payload":"legacy"}\n';
    fs.writeFileSync(source, legacyBytes);
    migrateMaterialJson({
      workspaceDir: root,
      filePath: source,
      formatId: "tasks",
      currentVersion: 2,
      steps: {
        0: { up: (value) => ({ ...value, first: true }) },
        1: { up: (value) => ({ ...value, second: true }) },
      },
    });
    const migration = getMigrationStatus(root).journal.records.find((record) => record.state === "migrated");
    assert.ok(migration?.backupPath);
    assert.equal(fs.readFileSync(path.join(root, migration.backupPath), "utf8"), legacyBytes);
    rollbackLastMigration(root, "tasks");
    assert.equal(fs.readFileSync(source, "utf8"), legacyBytes);

    const corruptRoot = path.join(root, "corrupt");
    fs.mkdirSync(path.join(corruptRoot, ".codex", "migrations"), { recursive: true });
    fs.writeFileSync(path.join(corruptRoot, ".codex", "migrations", "status.json"), "{corrupt\n");
    const corruptStatus = getMigrationStatus(corruptRoot);
    assert.match(corruptStatus.statusError || "", /operator recovery/);
    assert.equal(fs.readFileSync(path.join(corruptRoot, ".codex", "migrations", "status.json"), "utf8"), "{corrupt\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  return {
    modalTopmostClaimed: true,
    visibleTreeNavigation: true,
    secretRedaction: true,
    exactMigrationRestore: true,
    corruptRecoveryDetected: true,
  };
}
