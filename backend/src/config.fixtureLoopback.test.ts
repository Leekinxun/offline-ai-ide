import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("the explicit fixture switch binds loopback without changing ordinary Web or desktop defaults", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-fixture-host-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const readBinding = (desktop: string, fixture: string | undefined, port = "4567") => {
    const env = { ...process.env, APP_SETTINGS_CONFIG: path.join(directory, "settings.json"),
      WORKSPACE_DIR: directory, CREWFORGE_DESKTOP: desktop, PORT: port,
      CREWFORGE_FIXTURE_LOOPBACK: fixture };
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      "const { config } = await import('./src/config.ts'); console.log(JSON.stringify({host: config.host, port: config.port}))"],
    { cwd: process.cwd(), env, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout.trim());
  };
  assert.deepEqual(readBinding("0", "1"), { host: "127.0.0.1", port: 4567 });
  assert.deepEqual(readBinding("0", undefined), { host: "0.0.0.0", port: 4567 });
  assert.deepEqual(readBinding("0", "0"), { host: "0.0.0.0", port: 4567 });
  assert.deepEqual(readBinding("1", "0", "0"), { host: "127.0.0.1", port: 0 });
});
