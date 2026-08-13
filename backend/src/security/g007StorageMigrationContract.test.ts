import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { getAppSettingsMigrationStatus, loadPersistedAppSettings, migrateAppSettingsFile } from "../config.js";
import { CURRENT_CHANGE_SET_SCHEMA_VERSION, CURRENT_CHANGE_SET_WAL_SCHEMA_VERSION } from "../chat/changeSetSchema.js";
import {
  getMigrationStatus,
  MATERIAL_PERSISTENCE_INVENTORY,
  migrateMaterialJson,
  migrateWorkspacePersistence,
  PersistenceMigrationError,
  rollbackLastMigration,
} from "../persistence/migrations.js";

function workspace(t: TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-g007-migration-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("material persistence inventory is unique and covers every WS-14 storage family", () => {
  const ids = MATERIAL_PERSISTENCE_INVENTORY.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of MATERIAL_PERSISTENCE_INVENTORY) {
    assert.match(entry.id, /^[a-z0-9][a-z0-9-]+$/);
    assert.ok(entry.pathPattern.trim());
    assert.ok(Number.isSafeInteger(entry.currentSchemaVersion) && entry.currentSchemaVersion >= 1);
  }
  const areas = MATERIAL_PERSISTENCE_INVENTORY.map((entry) => entry.area).join("\n");
  for (const required of ["history", "checkpoints", "tasks", "settings"]) assert.match(areas, new RegExp(required));
  assert.equal(MATERIAL_PERSISTENCE_INVENTORY.find((entry) => entry.id === "change-sets")?.currentSchemaVersion, CURRENT_CHANGE_SET_SCHEMA_VERSION);
  assert.equal(CURRENT_CHANGE_SET_WAL_SCHEMA_VERSION, 3, "the integration WAL is an independent v3 contract");
});

test("forward migration creates an immutable backup, compatibility-read is stable, and rollback restores exact bytes", (t) => {
  const directory = workspace(t); const file = path.join(directory, ".team", "state", "fixture.json"); fs.mkdirSync(path.dirname(file), { recursive: true });
  const legacyBytes = '{"items":["legacy"],"version":7}\n'; fs.writeFileSync(file, legacyBytes);
  const steps = {
    0: { up: (value: Record<string, unknown>) => ({ ...value, forwardMarker: "v1" }) },
    1: { up: (value: Record<string, unknown>) => ({ ...value, forwardMarker: "v2", compatible: true }) },
  };
  const migrated = migrateMaterialJson({ workspaceDir: directory, filePath: file, formatId: "fixture", currentVersion: 2, legacyVersion: 0, steps });
  assert.equal(migrated.schemaVersion, 2); assert.equal(migrated.forwardMarker, "v2");
  const status = getMigrationStatus(directory); const migration = status.journal.records.find((record) => record.formatId === "fixture" && record.state === "migrated"); assert.ok(migration?.backupPath); assert.equal(fs.readFileSync(path.join(directory, migration.backupPath), "utf8"), legacyBytes);

  const migratedBytes = fs.readFileSync(file, "utf8");
  const compatibleRead = migrateMaterialJson({ workspaceDir: directory, filePath: file, formatId: "fixture", currentVersion: 2, legacyVersion: 0, steps });
  assert.equal(compatibleRead.schemaVersion, 2); assert.equal(fs.readFileSync(file, "utf8"), migratedBytes); assert.equal(getMigrationStatus(directory).journal.records.filter((record) => record.formatId === "fixture" && record.state === "migrated").length, 1);

  const rollback = rollbackLastMigration(directory, "fixture"); assert.equal(rollback.state, "rolled_back"); assert.equal(fs.readFileSync(file, "utf8"), legacyBytes);
});

test("future schemas and post-migration edits fail closed without destructive rollback", (t) => {
  const directory = workspace(t); const future = path.join(directory, "future.json"); const futureBytes = '{"schemaVersion":99,"value":"future"}\n'; fs.writeFileSync(future, futureBytes);
  assert.throws(() => migrateMaterialJson({ workspaceDir: directory, filePath: future, formatId: "future", currentVersion: 1, legacyVersion: 0, steps: { 0: { up: (value) => value } } }), PersistenceMigrationError);
  assert.equal(fs.readFileSync(future, "utf8"), futureBytes);

  const current = path.join(directory, "current.json"); fs.writeFileSync(current, '{"value":"legacy"}\n');
  migrateMaterialJson({ workspaceDir: directory, filePath: current, formatId: "tamper", currentVersion: 1, legacyVersion: 0, steps: { 0: { up: (value) => ({ ...value, migrated: true }) } } });
  fs.writeFileSync(current, '{"schemaVersion":1,"value":"operator-edit"}\n');
  assert.throws(() => rollbackLastMigration(directory, "tamper"), /changed after migration/);
  assert.match(fs.readFileSync(current, "utf8"), /operator-edit/);
});

test("workspace migration upgrades legacy agent state and provider state with per-format backups", (t) => {
  const directory = workspace(t); const state = path.join(directory, ".team", "state"); fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "tasks.json"), JSON.stringify({ version: 4, nextId: 2, tasks: { "1": { id: 1 } } }));
  fs.writeFileSync(path.join(state, "messages.json"), JSON.stringify({ version: 3, sequence: 1, messages: [] }));
  const providerLegacyBytes = JSON.stringify({ operations: { preserved: true } });
  fs.writeFileSync(path.join(state, "provider-delivery.json"), providerLegacyBytes);
  const result = migrateWorkspacePersistence(directory);
  assert.deepEqual(result.failed, []); assert.deepEqual(new Set(result.migrated), new Set(["tasks", "messages", "provider-delivery"]));
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, "tasks.json"), "utf8")).schemaVersion, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, "messages.json"), "utf8")).schemaVersion, 1);
  const provider = JSON.parse(fs.readFileSync(path.join(state, "provider-delivery.json"), "utf8")); assert.equal(provider.schemaVersion, 2); assert.equal(provider.operations.preserved, true);
  const records = getMigrationStatus(directory).journal.records.filter((record) => record.state === "migrated"); assert.equal(records.length, 3); assert.ok(records.every((record) => record.backupPath && fs.existsSync(path.join(directory, record.backupPath))));
  const rollback = rollbackLastMigration(directory, "provider-delivery");
  assert.equal(rollback.state, "rolled_back");
  assert.equal(fs.readFileSync(path.join(state, "provider-delivery.json"), "utf8"), providerLegacyBytes);
});

test("app settings compatibility read is non-mutating and explicit migration creates private exact-byte backup", (t) => {
  const directory = workspace(t); const file = path.join(directory, "app-settings.json");
  const legacyBytes = '{"llm":{"apiKey":"migration-secret"}}\n';
  fs.writeFileSync(file, legacyBytes, { mode: 0o644 });

  assert.deepEqual(loadPersistedAppSettings(file).llm, { apiKey: "migration-secret" });
  assert.equal(getAppSettingsMigrationStatus().state, "legacy_compatible");
  assert.equal(fs.readFileSync(file, "utf8"), legacyBytes);
  assert.deepEqual(fs.readdirSync(directory), ["app-settings.json"]);

  const migration = migrateAppSettingsFile(file);
  assert.equal(migration.state, "migrated"); assert.equal(migration.backupCreated, true);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).schemaVersion, 1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const backups = fs.readdirSync(directory).filter((entry) => entry.startsWith("app-settings.json.migration-v0-") && entry.endsWith(".bak"));
  assert.equal(backups.length, 1);
  const backup = path.join(directory, backups[0]);
  assert.equal(fs.readFileSync(backup, "utf8"), legacyBytes);
  assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
});
