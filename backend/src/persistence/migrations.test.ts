import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import http from "node:http";
import { spawn } from "node:child_process";
import express from "express";
import { config } from "../config.js";
import { CURRENT_CHANGE_SET_SCHEMA_VERSION } from "../chat/changeSetSchema.js";
import { migrationsRouter } from "../routes/migrations.js";
import {
  getMigrationStatus,
  isMigrationRollbackFormatId,
  MATERIAL_PERSISTENCE_INVENTORY,
  migrateMaterialJson,
  migrateWorkspacePersistence,
  PersistenceMigrationError,
  rollbackLastMigration,
} from "./migrations.js";

function fixture(t: test.TestContext): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-migration-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true })); return workspace;
}

test("material persistence inventory covers every G001-G006 persistence family with unique ids", () => {
  const areas = new Set(MATERIAL_PERSISTENCE_INVENTORY.map((entry) => entry.area));
  for (const required of ["history/runs/evidence", "checkpoints/rollback", "tasks/agents/messages", "tasks/agents/messages/traces", "repo-index", "delivery/integrations", "delivery/findings", "extension-policy/profiles/hooks", "collaboration", "model-governance/budgets/settings"]) assert.equal(areas.has(required), true, required);
  assert.equal(new Set(MATERIAL_PERSISTENCE_INVENTORY.map((entry) => entry.id)).size, MATERIAL_PERSISTENCE_INVENTORY.length);
  assert.ok(MATERIAL_PERSISTENCE_INVENTORY.every((entry) => entry.currentSchemaVersion >= 1 && entry.pathPattern.length > 0));
  assert.ok(MATERIAL_PERSISTENCE_INVENTORY.some((entry) => entry.id === "team-index" && entry.pathPattern === ".team/teams.json" && entry.compatibility === "legacy-reader"));
  assert.equal(MATERIAL_PERSISTENCE_INVENTORY.find((entry) => entry.id === "change-sets")?.currentSchemaVersion, CURRENT_CHANGE_SET_SCHEMA_VERSION);
});

test("current ChangeSet storage is a migration no-op and never creates a rollback backup", (t) => {
  const workspace = fixture(t); const directory = path.join(workspace, ".history", "change-sets"); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${"a".repeat(64)}.json`); const bytes = `${JSON.stringify({ schemaVersion: CURRENT_CHANGE_SET_SCHEMA_VERSION, id: "a".repeat(64), marker: "current" })}\n`; fs.writeFileSync(file, bytes);
  const result = migrateWorkspacePersistence(workspace); assert.deepEqual(result.failed, []); assert.equal(fs.readFileSync(file, "utf8"), bytes); assert.equal(result.migrated.includes("change-sets"), false);
  const status = getMigrationStatus(workspace); assert.equal(status.journal.records.some((record) => record.formatId === "change-sets"), false); assert.equal(fs.existsSync(path.join(workspace, ".codex", "migrations", "backups")), false);
  assert.equal(isMigrationRollbackFormatId("change-sets"), false);
});

test("one-version migration backs up atomically, is compatibility-idempotent, exposes status, and rolls back", (t) => {
  const workspace = fixture(t); const file = path.join(workspace, ".team", "state", "legacy.json"); fs.mkdirSync(path.dirname(file), { recursive: true });
  const legacy = { version: 7, items: ["kept"] }; fs.writeFileSync(file, JSON.stringify(legacy));
  const migrated = migrateMaterialJson({ workspaceDir: workspace, filePath: file, formatId: "tasks", currentVersion: 1, steps: { 0: { up: (value) => ({ ...value, added: true }) } } });
  assert.equal(migrated.schemaVersion, 1); assert.deepEqual(migrated.items, ["kept"]); assert.equal(migrated.added, true);
  const status = getMigrationStatus(workspace); const record = status.journal.records.at(-1)!;
  assert.equal(record.state, "migrated"); assert.equal(record.fromVersion, 0); assert.equal(record.toVersion, 1); assert.ok(record.backupPath && fs.existsSync(path.join(workspace, record.backupPath)));
  const count = status.journal.records.length;
  migrateMaterialJson({ workspaceDir: workspace, filePath: file, formatId: "tasks", currentVersion: 1, steps: { 0: { up: (value) => value } } });
  assert.equal(getMigrationStatus(workspace).journal.records.length, count, "current reads must not create migrations or backups");
  const migratedBytes = fs.readFileSync(file); fs.writeFileSync(file, `${migratedBytes.toString("utf8").trim()} `);
  assert.throws(() => rollbackLastMigration(workspace, "tasks"), /changed after migration/);
  fs.writeFileSync(file, migratedBytes);
  const rollback = rollbackLastMigration(workspace, "tasks"); assert.equal(rollback.state, "rolled_back");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), legacy);
});

test("forward migration chains versions while preserving source on failure and refusing future versions", (t) => {
  const workspace = fixture(t); const chained = path.join(workspace, "chain.json"); fs.writeFileSync(chained, JSON.stringify({ name: "old" }));
  const result = migrateMaterialJson({ workspaceDir: workspace, filePath: chained, formatId: "messages", currentVersion: 2, steps: { 0: { up: (value) => ({ ...value, first: 1 }) }, 1: { up: (value) => ({ ...value, second: 2 }) } } });
  assert.deepEqual({ first: result.first, second: result.second, schemaVersion: result.schemaVersion }, { first: 1, second: 2, schemaVersion: 2 });
  const downgraded = rollbackLastMigration(workspace, "messages"); assert.equal(downgraded.toVersion, 0); assert.deepEqual(JSON.parse(fs.readFileSync(chained, "utf8")), { name: "old" });

  const failed = path.join(workspace, "failed.json"); const original = JSON.stringify({ schemaVersion: 1, safe: true }); fs.writeFileSync(failed, original);
  assert.throws(() => migrateMaterialJson({ workspaceDir: workspace, filePath: failed, formatId: "failed", currentVersion: 2, steps: {} }), PersistenceMigrationError);
  assert.equal(fs.readFileSync(failed, "utf8"), original); assert.equal(getMigrationStatus(workspace).failures.some((entry) => entry.formatId === "failed"), true);

  const future = path.join(workspace, "future.json"); const futureBytes = JSON.stringify({ schemaVersion: 99, safe: true }); fs.writeFileSync(future, futureBytes);
  assert.throws(() => migrateMaterialJson({ workspaceDir: workspace, filePath: future, formatId: "future", currentVersion: 1, steps: {} }), /newer/);
  assert.equal(fs.readFileSync(future, "utf8"), futureBytes);
});

test("workspace migration upgrades legacy orchestration formats without dropping payloads", (t) => {
  const workspace = fixture(t); const state = path.join(workspace, ".team", "state"); fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "tasks.json"), JSON.stringify({ version: 3, nextId: 2, tasks: { "1": { id: 1, subject: "keep" } } }));
  fs.writeFileSync(path.join(state, "messages.json"), JSON.stringify({ version: 2, sequence: 1, messages: [{ id: "m1", content: "keep" }] }));
  const result = migrateWorkspacePersistence(workspace); assert.deepEqual(result.failed, []); assert.deepEqual(result.migrated.sort(), ["messages", "tasks"]);
  const tasks = JSON.parse(fs.readFileSync(path.join(state, "tasks.json"), "utf8")); const messages = JSON.parse(fs.readFileSync(path.join(state, "messages.json"), "utf8"));
  assert.equal(tasks.schemaVersion, 1); assert.equal(tasks.tasks["1"].subject, "keep"); assert.equal(messages.schemaVersion, 1); assert.equal(messages.messages[0].content, "keep");
});

test("eager migration persists corrupt-source failure and leaves active stores untouched", (t) => {
  const workspace = fixture(t); const state = path.join(workspace, ".team", "state"); fs.mkdirSync(state, { recursive: true });
  const corrupt = path.join(state, "tasks.json"); const corruptBytes = '{broken\n'; fs.writeFileSync(corrupt, corruptBytes);
  const failure = migrateWorkspacePersistence(workspace); assert.equal(failure.failed.length, 1); assert.equal(fs.readFileSync(corrupt, "utf8"), corruptBytes);
  assert.ok(getMigrationStatus(workspace).failures.some((record) => record.formatId === "tasks" && record.state === "failed"));

  const messages = path.join(state, "messages.json"); const messageBytes = '{"sequence":0,"messages":[]}\n'; fs.writeFileSync(messages, messageBytes); fs.mkdirSync(`${messages}.lock`);
  const active = migrateWorkspacePersistence(workspace); assert.ok(active.skipped.some((entry) => entry.formatId === "messages" && entry.code === "active_lock" && entry.blocking)); assert.equal(fs.readFileSync(messages, "utf8"), messageBytes);
});

test("migration refuses workspace escape and symlink targets", (t) => {
  const workspace = fixture(t); const outside = path.join(os.tmpdir(), `outside-${Date.now()}.json`); fs.writeFileSync(outside, "{}"); t.after(() => fs.rmSync(outside, { force: true }));
  assert.throws(() => migrateMaterialJson({ workspaceDir: workspace, filePath: outside, formatId: "escape", currentVersion: 1, steps: { 0: { up: (value) => value } } }), /escapes/);
  const link = path.join(workspace, "link.json"); fs.symlinkSync(outside, link);
  assert.throws(() => migrateMaterialJson({ workspaceDir: workspace, filePath: link, formatId: "symlink", currentVersion: 1, steps: { 0: { up: (value) => value } } }), /symlinks/);
});

test("rollback derives the exact backup path and refuses traversal or tampered backup bytes without target mutation", (t) => {
  for (const attack of ["journal-traversal", "tampered-bytes"] as const) {
    const workspace = fixture(t); const file = path.join(workspace, "tasks.json"); const original = '{"value":"legacy"}\n'; fs.writeFileSync(file, original);
    migrateMaterialJson({ workspaceDir: workspace, filePath: file, formatId: "tasks", currentVersion: 1, steps: { 0: { up: (value) => ({ ...value, migrated: true }) } } });
    const migrated = fs.readFileSync(file); const statusPath = path.join(workspace, ".codex", "migrations", "status.json");
    const status = JSON.parse(fs.readFileSync(statusPath, "utf8")); const record = status.records.find((entry: any) => entry.state === "migrated");
    if (attack === "journal-traversal") { record.backupPath = "../../outside"; fs.writeFileSync(statusPath, JSON.stringify(status)); }
    else fs.writeFileSync(path.join(workspace, record.backupPath), "tampered");
    assert.throws(() => rollbackLastMigration(workspace, "tasks"), attack === "journal-traversal" ? /expected backup location/ : /hash does not match/);
    assert.deepEqual(fs.readFileSync(file), migrated);
  }
});

test("rollback refuses backup file and parent symlinks without target mutation", { skip: process.platform === "win32" ? "symlink semantics differ on Windows" : false }, (t) => {
  for (const attack of ["file", "parent"] as const) {
    const workspace = fixture(t); const file = path.join(workspace, "tasks.json"); fs.writeFileSync(file, '{}\n');
    migrateMaterialJson({ workspaceDir: workspace, filePath: file, formatId: "tasks", currentVersion: 1, steps: { 0: { up: (value) => value } } });
    const migrated = fs.readFileSync(file); const record = getMigrationStatus(workspace).journal.records.find((entry) => entry.state === "migrated")!;
    const backupFile = path.join(workspace, record.backupPath!); const external = path.join(workspace, `external-${attack}`);
    if (attack === "file") { fs.writeFileSync(external, '{}\n'); fs.unlinkSync(backupFile); fs.symlinkSync(external, backupFile); }
    else { const parent = path.dirname(backupFile); fs.renameSync(parent, `${parent}.saved`); fs.mkdirSync(external); fs.writeFileSync(path.join(external, path.basename(backupFile)), '{}\n'); fs.symlinkSync(external, parent); }
    assert.throws(() => rollbackLastMigration(workspace, "tasks"), /symlink|unsafe/);
    assert.deepEqual(fs.readFileSync(file), migrated);
  }
});

test("rollback refuses active target writers and missing or invalid drift hashes without mutation", (t) => {
  for (const attack of ["active-lock", "missing-hash", "invalid-hash"] as const) {
    const workspace = fixture(t); const file = path.join(workspace, "tasks.json"); fs.writeFileSync(file, '{}\n');
    migrateMaterialJson({ workspaceDir: workspace, filePath: file, formatId: "tasks", currentVersion: 1, steps: { 0: { up: (value) => value } } }); const migrated = fs.readFileSync(file);
    if (attack === "active-lock") fs.mkdirSync(`${file}.lock`);
    else {
      const statusPath = path.join(workspace, ".codex", "migrations", "status.json"); const status = JSON.parse(fs.readFileSync(statusPath, "utf8")); const record = status.records.find((entry: any) => entry.state === "migrated");
      if (attack === "missing-hash") delete record.afterHash; else record.afterHash = "not-a-sha256";
      fs.writeFileSync(statusPath, JSON.stringify(status));
    }
    assert.throws(() => rollbackLastMigration(workspace, "tasks"), attack === "active-lock" ? /active writer lock/ : /valid migrated-target hash/); assert.deepEqual(fs.readFileSync(file), migrated);
  }
});

test("migration control-plane symlinks fail before target or external mutation", { skip: process.platform === "win32" ? "symlink semantics differ on Windows" : false }, (t) => {
  for (const location of [".codex", "status", "backups"] as const) {
    const workspace = fixture(t); const file = path.join(workspace, "tasks.json"); const original = '{}\n'; fs.writeFileSync(file, original);
    const external = path.join(workspace, `external-${location}`); fs.mkdirSync(external); const sentinel = path.join(external, "sentinel"); fs.writeFileSync(sentinel, "kept");
    if (location === ".codex") fs.symlinkSync(external, path.join(workspace, ".codex"));
    else {
      const migrations = path.join(workspace, ".codex", "migrations"); fs.mkdirSync(migrations, { recursive: true });
      fs.symlinkSync(location === "status" ? sentinel : external, path.join(migrations, location === "status" ? "status.json" : "backups"));
    }
    assert.throws(() => migrateMaterialJson({ workspaceDir: workspace, filePath: file, formatId: "tasks", currentVersion: 1, steps: { 0: { up: (value) => value } } }), /symlink/);
    assert.equal(fs.readFileSync(file, "utf8"), original); assert.equal(fs.readFileSync(sentinel, "utf8"), "kept");
  }
});

test("corrupt migration journal is preserved and blocks source migration until operator recovery", (t) => {
  const workspace = fixture(t); const file = path.join(workspace, "tasks.json"); fs.writeFileSync(file, '{}\n');
  const statusPath = path.join(workspace, ".codex", "migrations", "status.json"); fs.mkdirSync(path.dirname(statusPath), { recursive: true }); const corrupt = '{not-json\n'; fs.writeFileSync(statusPath, corrupt);
  assert.throws(() => migrateMaterialJson({ workspaceDir: workspace, filePath: file, formatId: "tasks", currentVersion: 1, steps: { 0: { up: (value) => value } } }), /corrupt|unsupported/);
  assert.equal(fs.readFileSync(file, "utf8"), '{}\n'); assert.equal(fs.readFileSync(statusPath, "utf8"), corrupt);
  const status = getMigrationStatus(workspace); assert.match(status.statusError || "", /operator recovery/); assert.doesNotMatch(status.statusError || "", /not-json/);
});

test("legacy team config uses canonical selected rollback and coexistence leaves superseded bytes untouched", (t) => {
  const workspace = fixture(t); const legacy = path.join(workspace, ".team", "config.json"); fs.mkdirSync(path.dirname(legacy), { recursive: true });
  const legacyBytes = '{ "team_name": "legacy", "members": [] }\n'; fs.writeFileSync(legacy, legacyBytes);
  const first = migrateWorkspacePersistence(workspace); assert.deepEqual(first.migrated, ["team-config"]);
  rollbackLastMigration(workspace, "team-config"); assert.equal(fs.readFileSync(legacy, "utf8"), legacyBytes);

  const active = path.join(workspace, ".team", "state", "team-config.json"); fs.mkdirSync(path.dirname(active), { recursive: true }); const activeBytes = '{"team_name":"active"}\n'; fs.writeFileSync(active, activeBytes); fs.writeFileSync(legacy, legacyBytes);
  const second = migrateWorkspacePersistence(workspace); assert.ok(second.migrated.includes("team-config")); assert.deepEqual(second.skipped, [{ formatId: "team-config", relativePath: ".team/config.json", code: "superseded", blocking: false, reason: "superseded by .team/state/team-config.json" }]);
  assert.equal(fs.readFileSync(legacy, "utf8"), legacyBytes); rollbackLastMigration(workspace, "team-config"); assert.equal(fs.readFileSync(active, "utf8"), activeBytes); assert.equal(fs.readFileSync(legacy, "utf8"), legacyBytes);
});

test("concurrent migrations retain every record and same-file migration runs exactly once", async (t) => {
  const workspace = fixture(t); const count = 12; const files = Array.from({ length: count }, (_, index) => path.join(workspace, `item-${index}.json`));
  for (const file of files) fs.writeFileSync(file, '{}\n');
  const code = `import { migrateMaterialJson } from './src/persistence/migrations.ts'; migrateMaterialJson({ workspaceDir: process.argv[1], filePath: process.argv[2], formatId: 'tasks', currentVersion: 1, steps: { 0: { up: value => value } } });`;
  const run = (file: string) => new Promise<void>((resolve, reject) => { const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, workspace, file], { cwd: process.cwd(), stdio: "pipe" }); let stderr = ""; child.stderr.on("data", (chunk) => stderr += chunk); child.on("close", (exit) => exit === 0 ? resolve() : reject(new Error(stderr))); });
  await Promise.all(files.map(run));
  const records = getMigrationStatus(workspace).journal.records.filter((record) => record.state === "migrated"); assert.equal(records.length, count); assert.ok(records.every((record) => fs.existsSync(path.join(workspace, record.backupPath!))));

  const same = path.join(workspace, "same.json"); fs.writeFileSync(same, '{}\n'); await Promise.all([run(same), run(same)]);
  const sameRecords = getMigrationStatus(workspace).journal.records.filter((record) => record.state === "migrated" && record.relativePath === "same.json"); assert.equal(sameRecords.length, 1);
});

test("migration API exposes inventory/failures while mutating and rollback remain admin-only", async (t) => {
  const workspace = fixture(t); const state = path.join(workspace, ".team", "state"); fs.mkdirSync(state, { recursive: true }); fs.writeFileSync(path.join(state, "tasks.json"), JSON.stringify({ version: 1, nextId: 1, tasks: {} }));
  const app = express(); app.use(express.json()); app.use((req: any, _res, next) => { req.userSession = { workspaceDir: workspace, isAdmin: req.get("x-admin") === "yes" }; next(); }); app.use("/api/migrations", migrationsRouter);
  const server = http.createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); assert(address && typeof address === "object"); const base = `http://127.0.0.1:${address.port}/api/migrations`;
  const status = await fetch(base); assert.equal(status.status, 200); const statusBody = await status.json() as any; assert.ok(Array.isArray(statusBody.inventory)); assert.equal(statusBody.inventory.find((entry: any) => entry.id === "change-sets")?.currentSchemaVersion, CURRENT_CHANGE_SET_SCHEMA_VERSION); assert.ok(["current", "legacy_compatible", "migrated", "failed"].includes(statusBody.appSettings.state));
  assert.equal((await fetch(`${base}/run`, { method: "POST" })).status, 403);
  const run = await fetch(`${base}/run`, { method: "POST", headers: { "x-admin": "yes" } }); assert.equal(run.status, 200); assert.deepEqual((await run.json() as any).result.migrated, ["tasks"]);
  const migratedBytes = fs.readFileSync(path.join(state, "tasks.json"));
  for (const body of [{}, { formatId: "" }, { formatId: "typo-format" }]) {
    const rejected = await fetch(`${base}/rollback`, { method: "POST", headers: { "content-type": "application/json", "x-admin": "yes" }, body: JSON.stringify(body) }); assert.equal(rejected.status, 400); assert.deepEqual(fs.readFileSync(path.join(state, "tasks.json")), migratedBytes);
  }
  for (const formatId of ["agent-runs", "change-sets", "team-index", "app-settings", "traces", "repository-index"]) {
    const rejected = await fetch(`${base}/rollback`, { method: "POST", headers: { "content-type": "application/json", "x-admin": "yes" }, body: JSON.stringify({ formatId }) }); assert.equal(rejected.status, 400, formatId); assert.deepEqual(fs.readFileSync(path.join(state, "tasks.json")), migratedBytes);
  }
  const rollback = await fetch(`${base}/rollback`, { method: "POST", headers: { "content-type": "application/json", "x-admin": "yes" }, body: JSON.stringify({ formatId: "tasks" }) }); assert.equal(rollback.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, "tasks.json"), "utf8")).schemaVersion, undefined);

  const messages = path.join(state, "messages.json"); fs.writeFileSync(messages, '{"messages":[],"sequence":0}\n'); fs.mkdirSync(`${messages}.lock`);
  const blockedRun = await fetch(`${base}/run`, { method: "POST", headers: { "x-admin": "yes" } }); assert.equal(blockedRun.status, 409); assert.ok((await blockedRun.json() as any).result.skipped.some((entry: any) => entry.code === "active_lock" && entry.blocking));
  assert.equal(JSON.parse(fs.readFileSync(messages, "utf8")).schemaVersion, undefined); fs.rmSync(`${messages}.lock`, { recursive: true, force: true });
  const retriedRun = await fetch(`${base}/run`, { method: "POST", headers: { "x-admin": "yes" } }); assert.equal(retriedRun.status, 200); assert.equal(JSON.parse(fs.readFileSync(messages, "utf8")).schemaVersion, 1);

  const appSettings = path.join(workspace, "operator-app-settings.json"); fs.writeFileSync(appSettings, '{"llm":{"vllmApiKey":"operator-secret"}}\n', { mode: 0o644 }); const originalPath = config.appSettingsPath; config.appSettingsPath = appSettings;
  try {
    assert.equal((await fetch(`${base}/app-settings/run`, { method: "POST" })).status, 403);
    assert.equal(fs.readFileSync(appSettings, "utf8"), '{"llm":{"vllmApiKey":"operator-secret"}}\n');
    const ignoredPath = path.join(workspace, "must-not-be-used.json"); fs.writeFileSync(ignoredPath, "sentinel");
    const appRun = await fetch(`${base}/app-settings/run`, { method: "POST", headers: { "content-type": "application/json", "x-admin": "yes" }, body: JSON.stringify({ configPath: ignoredPath }) }); assert.equal(appRun.status, 200); assert.equal((await appRun.json() as any).status.state, "migrated"); assert.equal(fs.readFileSync(ignoredPath, "utf8"), "sentinel");
    assert.equal(fs.statSync(fs.readdirSync(workspace).map((entry) => path.join(workspace, entry)).find((entry) => entry.endsWith(".bak"))!).mode & 0o777, 0o600);
    const again = await fetch(`${base}/app-settings/run`, { method: "POST", headers: { "x-admin": "yes" } }); assert.equal((await again.json() as any).status.state, "current");
  } finally { config.appSettingsPath = originalPath; }
});
