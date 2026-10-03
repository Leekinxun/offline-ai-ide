import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test, type TestContext } from "node:test";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-agent-settings-")));
const server = path.join(root, "server");
const workspace = path.join(root, "workspace");
fs.mkdirSync(server); fs.mkdirSync(workspace);
const environmentKeys = ["APP_SETTINGS_CONFIG", "USERS_CONFIG", "WORKSPACE_DIR", "CROWNFORGE_WINDOWS_AGENT_ENVIRONMENT", "CROWNFORGE_WINDOWS_SANDBOX_MODE"] as const;
const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
process.env.APP_SETTINGS_CONFIG = path.join(server, "app-settings.json");
process.env.USERS_CONFIG = path.join(server, "users.json");
process.env.WORKSPACE_DIR = workspace;
delete process.env.CROWNFORGE_WINDOWS_AGENT_ENVIRONMENT; delete process.env.CROWNFORGE_WINDOWS_SANDBOX_MODE;
const appSettingsBytes = '{"schemaVersion":1,"app":{"uploadMaxFileSizeMb":71}}\n';
fs.writeFileSync(process.env.APP_SETTINGS_CONFIG, appSettingsBytes);
fs.writeFileSync(process.env.USERS_CONFIG, JSON.stringify({ users: [], allowedRoots: [root] }));
const { getWindowsAgentSettings, updateWindowsAgentSettings, windowsAgentSettingsPath } = await import("./windowsAgentSettings.js");
after(() => {
  for (const key of environmentKeys) { const value = previous[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(root, { recursive: true, force: true });
});
function reset(t: TestContext): string {
  const file = windowsAgentSettingsPath();
  fs.rmSync(file, { force: true });
  delete process.env.CROWNFORGE_WINDOWS_AGENT_ENVIRONMENT; delete process.env.CROWNFORGE_WINDOWS_SANDBOX_MODE;
  t.after(() => { fs.rmSync(file, { force: true }); delete process.env.CROWNFORGE_WINDOWS_AGENT_ENVIRONMENT; delete process.env.CROWNFORGE_WINDOWS_SANDBOX_MODE; });
  return file;
}

test("missing settings lazily default to Windows native elevated without writes", (t) => {
  const file = reset(t);
  assert.deepEqual(getWindowsAgentSettings(), { environment: "native", sandboxMode: "elevated" });
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(process.env.APP_SETTINGS_CONFIG!, "utf8"), appSettingsBytes);
});

test("execution selection persists independently and leaves App settings intact", (t) => {
  const file = reset(t);
  const next = { environment: "wsl", sandboxMode: "unelevated" } as const;
  assert.deepEqual(updateWindowsAgentSettings(next, workspace), next);
  assert.deepEqual(getWindowsAgentSettings(), next);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), next);
  assert.equal(fs.readFileSync(process.env.APP_SETTINGS_CONFIG!, "utf8"), appSettingsBytes);
  assert.equal(fs.readdirSync(server).some((entry) => entry.endsWith(".tmp")), false);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("invalid or extra fields never change the persisted policy", (t) => {
  const file = reset(t);
  const initial = { environment: "native", sandboxMode: "elevated" } as const;
  updateWindowsAgentSettings(initial, workspace);
  const bytes = fs.readFileSync(file, "utf8");
  for (const value of [undefined, null, [], {}, { environment: "native" }, { ...initial, command: "calc.exe" }, { ...initial, workspace: workspace }, { ...initial, environment: "auto" }, { ...initial, sandboxMode: "disabled" }, { environment: true, sandboxMode: "elevated" }]) {
    assert.throws(() => updateWindowsAgentSettings(value, workspace));
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
  }
});

test("unreadable or malformed settings fail closed instead of choosing an unrestricted environment", (t) => {
  const file = reset(t);
  for (const bytes of ["not-json", JSON.stringify({ environment: "native", sandboxMode: "none" }), JSON.stringify({ environment: "native", sandboxMode: "elevated", env: { SECRET: "value" } }), "x".repeat(4_097)]) {
    fs.writeFileSync(file, bytes);
    assert.throws(getWindowsAgentSettings, /could not be read/);
  }
});

test("trusted server environment overrides are strict and do not rewrite persisted settings", (t) => {
  const file = reset(t);
  updateWindowsAgentSettings({ environment: "wsl", sandboxMode: "unelevated" }, workspace);
  const bytes = fs.readFileSync(file, "utf8");
  process.env.CROWNFORGE_WINDOWS_AGENT_ENVIRONMENT = "native";
  process.env.CROWNFORGE_WINDOWS_SANDBOX_MODE = "elevated";
  assert.deepEqual(getWindowsAgentSettings(), { environment: "native", sandboxMode: "elevated" });
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  process.env.CROWNFORGE_WINDOWS_AGENT_ENVIRONMENT = "powershell;calc.exe";
  assert.throws(getWindowsAgentSettings, /Invalid Windows execution/);
  process.env.CROWNFORGE_WINDOWS_AGENT_ENVIRONMENT = "native";
  process.env.CROWNFORGE_WINDOWS_SANDBOX_MODE = "none";
  assert.throws(getWindowsAgentSettings, /Invalid Windows sandbox/);
});

test("Agent workspace cannot contain execution settings, including directory aliases", (t) => {
  const file = reset(t);
  const next = { environment: "native", sandboxMode: "elevated" } as const;
  assert.throws(() => updateWindowsAgentSettings(next, server), /outside the Agent workspace/);
  assert.throws(() => updateWindowsAgentSettings(next, root), /outside the Agent workspace/);
  const alias = path.join(root, "server-alias");
  fs.symlinkSync(server, alias, process.platform === "win32" ? "junction" : "dir");
  t.after(() => fs.rmSync(alias, { recursive: true, force: true }));
  assert.throws(() => updateWindowsAgentSettings(next, alias), /outside the Agent workspace/);
  assert.equal(fs.existsSync(file), false);
});

test("symbolic-link settings are rejected on read and write", { skip: process.platform === "win32" ? "File symlinks require Windows developer mode or elevation" : false }, (t) => {
  const file = reset(t);
  const target = path.join(root, "untrusted.json");
  const bytes = JSON.stringify({ environment: "wsl", sandboxMode: "unelevated" });
  fs.writeFileSync(target, bytes); fs.symlinkSync(target, file);
  assert.throws(getWindowsAgentSettings, /could not be read/);
  assert.throws(() => updateWindowsAgentSettings({ environment: "native", sandboxMode: "elevated" }, workspace), /Invalid execution settings file/);
  assert.equal(fs.readFileSync(target, "utf8"), bytes);
});
