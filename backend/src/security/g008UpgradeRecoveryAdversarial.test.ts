import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { config, migrateAppSettingsFile } from "../config.js";
import { getMigrationStatus, migrateWorkspacePersistence, rollbackLastMigration } from "../persistence/migrations.js";
import { migrationsRouter } from "../routes/migrations.js";

function fixture(t: test.TestContext, prefix = "crewforge-g008-"): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory;
}

test("clean install and current v1 state are read-only migration no-ops", (t) => {
  const workspace = fixture(t); assert.deepEqual(migrateWorkspacePersistence(workspace), { migrated: [], current: [], skipped: [], failed: [] });
  assert.equal(fs.existsSync(path.join(workspace, ".codex")), false);
  const tasks = path.join(workspace, ".team", "state", "tasks.json"); fs.mkdirSync(path.dirname(tasks), { recursive: true });
  const currentBytes = '{"schemaVersion":1,"version":1,"nextId":1,"tasks":{}}\n'; fs.writeFileSync(tasks, currentBytes);
  const result = migrateWorkspacePersistence(workspace); assert.deepEqual(result.migrated, []); assert.deepEqual(result.current, ["tasks"]); assert.deepEqual(result.failed, []);
  assert.equal(fs.readFileSync(tasks, "utf8"), currentBytes); assert.equal(fs.existsSync(path.join(workspace, ".codex")), false);
});

test("air-gapped v0 upgrade, complete backup transfer, and one-release downgrade restore exact bytes", (t) => {
  const workspace = fixture(t); const restored = fixture(t, "crewforge-g008-restored-"); const tasks = path.join(workspace, ".team", "state", "tasks.json"); fs.mkdirSync(path.dirname(tasks), { recursive: true });
  const legacyBytes = '{ "version": 7, "nextId": 2, "tasks": {"1":{"id":1,"subject":"kept"}} }\n'; fs.writeFileSync(tasks, legacyBytes);
  const originalFetch = globalThis.fetch; let networkCalls = 0;
  globalThis.fetch = (async () => { networkCalls += 1; throw new Error("offline network call"); }) as typeof fetch;
  try {
    const upgraded = migrateWorkspacePersistence(workspace); assert.deepEqual(upgraded.migrated, ["tasks"]); assert.deepEqual(upgraded.failed, []);
    assert.equal(JSON.parse(fs.readFileSync(tasks, "utf8")).schemaVersion, 1); assert.equal(networkCalls, 0);
    fs.cpSync(workspace, restored, { recursive: true, force: true });
    const restoredTasks = path.join(restored, ".team", "state", "tasks.json"); const rollback = rollbackLastMigration(restored, "tasks");
    assert.equal(rollback.state, "rolled_back"); assert.equal(fs.readFileSync(restoredTasks, "utf8"), legacyBytes); assert.equal(networkCalls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("corrupt source and corrupt migration control state fail closed, preserve bytes, and recover from a complete control-state backup", (t) => {
  const workspace = fixture(t); const tasks = path.join(workspace, ".team", "state", "tasks.json"); fs.mkdirSync(path.dirname(tasks), { recursive: true });
  const corruptSource = '{broken-json\n'; fs.writeFileSync(tasks, corruptSource);
  const first = migrateWorkspacePersistence(workspace); assert.equal(first.failed.length, 1); assert.equal(fs.readFileSync(tasks, "utf8"), corruptSource);
  const statusPath = path.join(workspace, ".codex", "migrations", "status.json"); const recoveryBytes = fs.readFileSync(statusPath); const repairedSource = '{"version":1,"nextId":1,"tasks":{}}\n'; fs.writeFileSync(tasks, repairedSource);
  const corruptStatus = '{journal-corrupt\n'; fs.writeFileSync(statusPath, corruptStatus);
  const blocked = migrateWorkspacePersistence(workspace); assert.equal(blocked.failed.length, 1); assert.equal(fs.readFileSync(tasks, "utf8"), repairedSource); assert.equal(fs.readFileSync(statusPath, "utf8"), corruptStatus);
  assert.match(getMigrationStatus(workspace).statusError || "", /operator recovery/);
  fs.writeFileSync(statusPath, recoveryBytes);
  const recovered = migrateWorkspacePersistence(workspace); assert.deepEqual(recovered.migrated, ["tasks"]); assert.equal(JSON.parse(fs.readFileSync(tasks, "utf8")).schemaVersion, 1);
});

test("explicit sensitive app-settings migration preserves plugin and MCP policy offline with private exact backup", { skip: process.platform === "win32" ? "POSIX backup mode bits are unavailable on Windows" : false }, (t) => {
  const directory = fixture(t); const file = path.join(directory, "app-settings.json");
  const legacy = {
    llm: { vllmApiKey: "secret-canary", modelName: "offline-model" },
    plugins: { overrides: { quality: { enabled: false } } },
    mcp: { servers: [{ id: "local-only", transport: "stdio", command: "local-helper", env: { SAFE: "yes" } }], disabledUrls: ["https://disabled.invalid"] },
  };
  const legacyBytes = `${JSON.stringify(legacy)}\n`; fs.writeFileSync(file, legacyBytes, { mode: 0o644 });
  const originalFetch = globalThis.fetch; let networkCalls = 0; globalThis.fetch = (async () => { networkCalls += 1; throw new Error("offline"); }) as typeof fetch;
  try {
    assert.equal(migrateAppSettingsFile(file).state, "migrated"); assert.equal(networkCalls, 0);
    const migrated = JSON.parse(fs.readFileSync(file, "utf8")); assert.equal(migrated.llm.vllmApiKey, "secret-canary"); assert.deepEqual(migrated.plugins, legacy.plugins); assert.deepEqual(migrated.mcp, legacy.mcp);
    const backups = fs.readdirSync(directory).filter((entry) => entry.endsWith(".bak")); assert.equal(backups.length, 1); const backup = path.join(directory, backups[0]);
    assert.equal(fs.readFileSync(backup, "utf8"), legacyBytes); assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
    assert.equal(migrateAppSettingsFile(file).state, "current"); assert.equal(fs.readdirSync(directory).filter((entry) => entry.endsWith(".bak")).length, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("operator routes reject role, client-path, symlink, and rollback-format bypasses", { skip: process.platform === "win32" ? "symlink semantics differ on Windows" : false }, async (t) => {
  const workspace = fixture(t); const configured = path.join(workspace, "app-settings.json"); const attacker = path.join(workspace, "attacker.json"); const link = path.join(workspace, "linked-settings.json");
  const configuredBytes = '{"app":{"uploadMaxFileSizeMb":10}}\n'; fs.writeFileSync(configured, configuredBytes); fs.writeFileSync(attacker, '{"secret":"untouched"}\n');
  const originalPath = config.appSettingsPath; config.appSettingsPath = configured;
  const app = express(); app.use(express.json()); app.use((req: any, _res, next) => { req.userSession = { workspaceDir: workspace, isAdmin: req.get("x-admin") === "yes" }; next(); }); app.use("/api/migrations", migrationsRouter);
  const server = http.createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}/api/migrations`;
    assert.equal((await fetch(`${base}/app-settings/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ configPath: attacker }) })).status, 403); assert.equal(fs.readFileSync(configured, "utf8"), configuredBytes);
    const migrated = await fetch(`${base}/app-settings/run`, { method: "POST", headers: { "content-type": "application/json", "x-admin": "yes" }, body: JSON.stringify({ configPath: attacker }) }); assert.equal(migrated.status, 200); assert.equal(fs.readFileSync(attacker, "utf8"), '{"secret":"untouched"}\n');
    for (const formatId of ["app-settings", "team-index", "repository-index", "../tasks"]) assert.equal((await fetch(`${base}/rollback`, { method: "POST", headers: { "content-type": "application/json", "x-admin": "yes" }, body: JSON.stringify({ formatId }) })).status, 400, formatId);
    fs.symlinkSync(attacker, link); config.appSettingsPath = link; const symlinked = await fetch(`${base}/app-settings/run`, { method: "POST", headers: { "x-admin": "yes" } }); assert.equal(symlinked.status, 409); assert.equal(fs.readFileSync(attacker, "utf8"), '{"secret":"untouched"}\n');
  } finally { config.appSettingsPath = originalPath; }
});
