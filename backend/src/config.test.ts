import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getAppSettingsMigrationStatus, loadPersistedAppSettings, migrateAppSettingsFile } from "./config.js";

function fixture(t: test.TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-config-migration-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("ordinary config imports compatibility-read legacy settings without file or backup mutation", (t) => {
  const directory = fixture(t); const file = path.join(directory, "app-settings.json");
  const bytes = '{"llm":{"vllmApiKey":"secret-canary"}}\n'; fs.writeFileSync(file, bytes, { mode: 0o644 });
  for (let index = 0; index < 2; index += 1) {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "await import('./src/config.ts')"], {
      cwd: process.cwd(), env: { ...process.env, APP_SETTINGS_CONFIG: file, WORKSPACE_DIR: directory, PLUGINS_DIR: path.join(directory, "plugins") }, encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
  }
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  assert.deepEqual(fs.readdirSync(directory).sort(), ["app-settings.json"]);
});

test("explicit app-settings migration creates an exact-byte mode-0600 backup", { skip: process.platform === "win32" ? "POSIX mode bits are unavailable on Windows" : false }, (t) => {
  const directory = fixture(t); const file = path.join(directory, "app-settings.json");
  const bytes = '{"llm":{"vllmApiKey":"secret-canary"}}\n'; fs.writeFileSync(file, bytes, { mode: 0o644 });
  assert.equal(loadPersistedAppSettings(file).schemaVersion, undefined);
  assert.equal(getAppSettingsMigrationStatus().state, "legacy_compatible");
  assert.equal(migrateAppSettingsFile(file).state, "migrated");
  const backup = fs.readdirSync(directory).find((entry) => entry.endsWith(".bak")); assert.ok(backup);
  assert.equal(fs.readFileSync(path.join(directory, backup), "utf8"), bytes);
  assert.equal(fs.statSync(path.join(directory, backup)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("explicit app-settings migration refuses a pre-created backup symlink without mutation", { skip: process.platform === "win32" ? "symlink semantics differ on Windows" : false }, (t) => {
  const directory = fixture(t); const file = path.join(directory, "app-settings.json"); const external = path.join(directory, "external");
  const bytes = '{"llm":{"vllmApiKey":"secret-canary"}}\n'; fs.writeFileSync(file, bytes); fs.writeFileSync(external, "sentinel");
  const originalNow = Date.now; const fixed = 1_234_567;
  try {
    Date.now = () => fixed;
    fs.symlinkSync(external, `${file}.migration-v0-${fixed}.bak`);
    const status = migrateAppSettingsFile(file);
    assert.equal(status.state, "failed"); assert.match(status.error || "", /exist|exclusive/i);
  } finally { Date.now = originalNow; }
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  assert.equal(fs.readFileSync(external, "utf8"), "sentinel");
});
