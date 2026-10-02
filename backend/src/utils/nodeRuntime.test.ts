import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { macosNodeRuntimeFrameworks, nodeRuntimeEnvironment } from "./nodeRuntime.js";

test("fixed internal Node launches restore Electron Node mode without inheriting arbitrary values", (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, "electron");
  Object.defineProperty(process.versions, "electron", { value: "44.4.4", configurable: true });
  t.after(() => { if (descriptor) Object.defineProperty(process.versions, "electron", descriptor); else delete process.versions.electron; });
  const environment = { PATH: "/fixture/bin", ELECTRON_RUN_AS_NODE: "untrusted" };
  assert.deepEqual(nodeRuntimeEnvironment(environment), { PATH: "/fixture/bin", ELECTRON_RUN_AS_NODE: "1" });
  assert.equal(environment.ELECTRON_RUN_AS_NODE, "untrusted");
});

test("ordinary Node launches do not forward Electron runtime flags", (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, "electron");
  delete process.versions.electron;
  t.after(() => { if (descriptor) Object.defineProperty(process.versions, "electron", descriptor); });
  assert.deepEqual(nodeRuntimeEnvironment({ PATH: "/fixture/bin", ELECTRON_RUN_AS_NODE: "1" }), { PATH: "/fixture/bin" });
});

test("trusted macOS Frameworks discovery stays inside the current canonical bundle and rejects redirects", (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-runtime-paths-")));
  const contents = path.join(root, "Fixture.app", "Contents");
  const frameworks = path.join(contents, "Frameworks"); const executable = path.join(contents, "MacOS", "Fixture");
  fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.mkdirSync(frameworks); fs.writeFileSync(executable, "fixture");
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!; const execPath = Object.getOwnPropertyDescriptor(process, "execPath")!;
  const electron = Object.getOwnPropertyDescriptor(process.versions, "electron");
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" }); Object.defineProperty(process, "execPath", { ...execPath, value: executable });
  Object.defineProperty(process.versions, "electron", { value: "44.4.4", configurable: true });
  t.after(() => { Object.defineProperty(process, "platform", platform); Object.defineProperty(process, "execPath", execPath);
    if (electron) Object.defineProperty(process.versions, "electron", electron); else delete process.versions.electron;
    fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(macosNodeRuntimeFrameworks(), frameworks);
  Object.defineProperty(process, "platform", { ...platform, value: "linux" }); assert.equal(macosNodeRuntimeFrameworks(), undefined);
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" }); delete process.versions.electron; assert.equal(macosNodeRuntimeFrameworks(), undefined);
  Object.defineProperty(process.versions, "electron", { value: "44.4.4", configurable: true });
  fs.rmdirSync(frameworks); const outside = path.join(root, "outside"); fs.mkdirSync(outside); fs.symlinkSync(outside, frameworks, "dir");
  assert.equal(macosNodeRuntimeFrameworks(), undefined);
  fs.unlinkSync(frameworks); assert.equal(macosNodeRuntimeFrameworks(), undefined);
  Object.defineProperty(process, "execPath", { ...execPath, value: path.join(root, "outside-node") }); assert.equal(macosNodeRuntimeFrameworks(), undefined);
});
