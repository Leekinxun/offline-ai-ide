import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DESKTOP_RUNTIME_FILES, DESKTOP_TARGETS, createPackageConfig,
  verifyRemoteDesktopContents, writeChecksums,
} from "../desktop/scripts/package.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "desktop/package.json"), "utf8"));

test("all desktop targets package the client shell without a private frontend or server", () => {
  for (const target of Object.keys(DESKTOP_TARGETS)) {
    const config = createPackageConfig(target);
    assert.deepEqual(config.files, DESKTOP_RUNTIME_FILES);
    assert.deepEqual(config.extraResources, []);
    assert.equal(config.npmRebuild, false);
    assert.equal(config.asar, true);
    assert.equal(config.electronVersion, DESKTOP_TARGETS[target].electron);
    assert.equal(path.basename(config.directories.output), target);
    assert.ok(config.artifactName.endsWith(".${ext}"));
  }
  for (const file of DESKTOP_RUNTIME_FILES) assert.ok(fs.statSync(path.join(root, "desktop", file)).isFile(), file);
  assert.deepEqual(Object.keys(manifest.dependencies || {}), []);
});

test("Windows cross packages use the same client resources and retain separate outputs", () => {
  for (const target of ["win-x64", "win7-x64"]) {
    const config = createPackageConfig(target, { cross: true });
    assert.deepEqual(config.files, createPackageConfig(target).files);
    assert.deepEqual(config.extraResources, []);
    assert.equal(path.basename(config.directories.output), `${target}-cross`);
    assert.equal(config.win.signAndEditExecutable, false);
  }
  assert.throws(() => createPackageConfig("mac-x64", { cross: true }), /Windows targets only/);
  assert.throws(() => createPackageConfig("unknown"), /Unknown target/);
});

test("artifact verification catches missing connection UI and accidental server or credential contents", () => {
  assert.doesNotThrow(() => verifyRemoteDesktopContents(DESKTOP_RUNTIME_FILES.map((file) => `/${file}`), manifest));
  for (const omitted of ["connection.html", "connection-preload.cjs", "preload.cjs"]) {
    assert.throws(() => verifyRemoteDesktopContents(DESKTOP_RUNTIME_FILES.filter((file) => file !== omitted), manifest), /missing/);
  }
  for (const extra of ["backend/dist/index.js", "frontend/index.html", "plugins/plugin.js", "node_modules/node-pty/index.js", "users.json", "app-settings.json"]) {
    assert.throws(() => verifyRemoteDesktopContents([...DESKTOP_RUNTIME_FILES, extra], manifest), /Unexpected resource/);
  }
  assert.throws(() => verifyRemoteDesktopContents(DESKTOP_RUNTIME_FILES, { ...manifest, main: "backend/bootstrap.cjs" }), /launch main.cjs/);
  assert.throws(() => verifyRemoteDesktopContents(DESKTOP_RUNTIME_FILES, { ...manifest, dependencies: { "node-pty": "1.0.0" } }), /server runtime dependencies/);
});

test("installer and archive checksums describe the actual output bytes", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-remote-package-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = ["CrownForge.dmg", "CrownForge.exe", "CrownForge.zip"];
  for (const file of [...files, "builder-debug.yml"]) fs.writeFileSync(path.join(directory, file), `fixture:${file}\n`);
  assert.deepEqual((await writeChecksums(directory)).sort(), files.sort());
  for (const file of files) {
    const expected = crypto.createHash("sha256").update(fs.readFileSync(path.join(directory, file))).digest("hex");
    assert.equal(fs.readFileSync(path.join(directory, `${file}.sha256`), "utf8"), `${expected}  ${file}\n`);
  }
  assert.equal(fs.existsSync(path.join(directory, "builder-debug.yml.sha256")), false);
});
