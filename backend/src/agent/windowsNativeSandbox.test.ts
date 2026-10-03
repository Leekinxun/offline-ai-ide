import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import type { CodexSandboxRpcClient, CodexSandboxClientOptions } from "./codexSandboxClient.js";
import { __windowsNativeSandboxForTests, prepareWindowsNativeProcess, probeWindowsNativeSandbox, setWindowsNativeSandboxTestHooks, setupWindowsNativeSandbox } from "./windowsNativeSandbox.js";
import type { WorkspaceProcessOptions } from "./processSandbox.js";

function fixture(t: test.TestContext) {
  const preparedCleanups: Array<() => void> = [];
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-native-test-")));
  const workspace = path.join(root, "workspace"); const backendRoot = path.join(root, "app", "backend");
  const runtimeRoot = path.join(backendRoot, "vendor", "codex", "win-x64"); const stateHome = path.join(root, "private", "codex-native-sandbox");
  const powershellExecutable = path.join(root, "Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const privateFile = path.join(root, "private", "private-config.json");
  fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(path.dirname(privateFile), { recursive: true }); fs.writeFileSync(privateFile, "fixture");
  fs.mkdirSync(path.dirname(powershellExecutable), { recursive: true }); fs.writeFileSync(powershellExecutable, "trusted fixture");
  const files: Record<string, string> = {};
  for (const relative of __windowsNativeSandboxForTests.REQUIRED_FILES) {
    const file = path.join(runtimeRoot, ...relative.split("/")); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `fixture:${relative}`); files[relative] = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }
  const manifestFile = path.join(runtimeRoot, __windowsNativeSandboxForTests.MANIFEST_NAME);
  fs.writeFileSync(manifestFile, JSON.stringify({ schemaVersion: 1, runtimeVersion: "0.160.0", platform: "win32", arch: "x64", files }));
  // Configured fixtures model a prior explicit setup; readiness cannot create it.
  fs.mkdirSync(stateHome, { recursive: true });
  fs.writeFileSync(path.join(stateHome, "config.toml"), __windowsNativeSandboxForTests.baseConfig("elevated"));
  t.after(() => {
    try { for (const cleanup of preparedCleanups.reverse()) cleanup(); }
    finally { setWindowsNativeSandboxTestHooks(undefined); fs.rmSync(root, { recursive: true, force: true }); }
  });
  return { root, workspace, backendRoot, runtimeRoot, stateHome, powershellExecutable, privateFile, manifestFile,
    cleanupBeforeRemoval: (cleanup: () => void) => { preparedCleanups.push(cleanup); } };
}
type Fixture = ReturnType<typeof fixture>;
function install(f: Fixture, extra: { status?: unknown; mode?: "elevated" | "unelevated"; completion?: unknown; started?: unknown } = {}) {
  const calls: Array<{ method: string; params?: unknown }> = []; const clients: CodexSandboxClientOptions[] = [];
  setWindowsNativeSandboxTestHooks({ platform: "win32", arch: "x64", backendRoot: f.backendRoot, runtimeRoot: f.runtimeRoot, stateHome: f.stateHome, privateFiles: [f.privateFile], powershellExecutable: f.powershellExecutable,
    sandboxMode: extra.mode ?? "elevated", env: { SystemRoot: path.join(f.root, "Windows"), USERPROFILE: path.join(f.root, "user"), PATH: `${f.workspace};${path.dirname(f.powershellExecutable)}`,
      OPENAI_API_KEY: "fixture-do-not-inherit", MODEL_TOKEN: "fixture-do-not-inherit", NODE_OPTIONS: "--require injection", ELECTRON_RUN_AS_NODE: "1", CODEX_WINDOWS_REGISTERED_CORE: "1", CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN: "fixture-do-not-inherit" },
    clientFactory: (options) => {
      clients.push(options);
      return { initialize: async () => { calls.push({ method: "initialize" }); },
        call: async (method, params) => { calls.push({ method, params }); return method === "windowsSandbox/readiness" ? { status: extra.status ?? "ready" } : extra.started ?? { started: true }; },
        waitForNotification: async (method) => { calls.push({ method }); return extra.completion ?? { mode: extra.mode ?? "elevated", success: true, error: null }; }, close: () => {} } satisfies CodexSandboxRpcClient;
    } });
  return { calls, clients };
}
function command(f: Fixture, overrides: Partial<WorkspaceProcessOptions> = {}): WorkspaceProcessOptions {
  return { executable: f.powershellExecutable, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "Write-Output 'native ready'"], cwd: f.workspace,
    networkMode: "deny", filesystem: { workspaceDir: f.workspace, readPaths: ["."], writePaths: ["."] }, ...overrides };
}
function preparedProfile(prepared: ReturnType<typeof prepareWindowsNativeProcess>, f: Fixture): string {
  const profile = prepared.args[prepared.args.indexOf("-p") + 1]; return fs.readFileSync(path.join(f.stateHome, `${profile}.config.toml`), "utf8");
}

test("native readiness uses only the pinned sidecar and no auth or inherited secrets", async (t) => {
  const f = fixture(t); const { calls, clients } = install(f);
  const configFile = path.join(f.stateHome, "config.toml"); const before = fs.statSync(configFile);
  const result = await probeWindowsNativeSandbox();
  assert.equal(result.available, true); assert.equal(result.shell, "powershell"); assert.equal(result.runtimeVersion, "0.160.0");
  assert.deepEqual(calls.map((call) => call.method), ["initialize", "windowsSandbox/readiness"]);
  assert.equal(clients[0].executable, path.join(f.runtimeRoot, "bin", "codex.exe"));
  for (const key of ["OPENAI_API_KEY", "MODEL_TOKEN", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "CODEX_WINDOWS_REGISTERED_CORE", "CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN"]) assert.equal(clients[0].env[key], undefined);
  assert.equal(clients[0].env.CODEX_HOME, f.stateHome);
  const config = fs.readFileSync(path.join(f.stateHome, "config.toml"), "utf8");
  assert.ok(config.includes("http://127.0.0.1:9")); assert.ok(config.includes("enabled = false"));
  assert.equal(fs.statSync(configFile).mtimeMs, before.mtimeMs);
  assert.deepEqual(fs.readdirSync(f.stateHome), ["config.toml"]);
});
test("a readiness read never creates a control home or configuration, or requests setup", async (t) => {
  const f = fixture(t); const { calls, clients } = install(f);
  fs.rmSync(f.stateHome, { recursive: true, force: true });
  const missingHome = await probeWindowsNativeSandbox();
  assert.equal(missingHome.status, "notConfigured"); assert.equal(missingHome.available, false);
  assert.equal(fs.existsSync(f.stateHome), false); assert.deepEqual(calls, []); assert.deepEqual(clients, []);
  fs.mkdirSync(f.stateHome);
  const missingConfig = await probeWindowsNativeSandbox();
  assert.equal(missingConfig.status, "notConfigured"); assert.equal(missingConfig.available, false);
  assert.deepEqual(fs.readdirSync(f.stateHome), []); assert.deepEqual(calls, []);
  assert.throws(() => prepareWindowsNativeProcess(command(f)), /Set up or recheck/);
});
test("a changed control configuration is preserved and cannot enable execution during a probe", async (t) => {
  const f = fixture(t); const { calls } = install(f);
  const file = path.join(f.stateHome, "config.toml");
  const injected = 'sandbox_mode = "danger-full-access"\n'; fs.writeFileSync(file, injected);
  const result = await probeWindowsNativeSandbox();
  assert.equal(result.available, false); assert.match(result.reason!, /configuration changed/);
  assert.equal(fs.readFileSync(file, "utf8"), injected); assert.deepEqual(calls, []);
  assert.throws(() => prepareWindowsNativeProcess(command(f)), /Set up or recheck/);
});
test("cached readiness cannot authorize execution after control configuration changes", async (t) => {
  const f = fixture(t); install(f); await probeWindowsNativeSandbox();
  const file = path.join(f.stateHome, "config.toml");
  fs.appendFileSync(file, 'sandbox_mode = "danger-full-access"\n');
  assert.throws(() => prepareWindowsNativeProcess(command(f)), /configuration changed/);
  fs.rmSync(file);
  assert.throws(() => prepareWindowsNativeProcess(command(f)), /Set up or recheck/);
  assert.equal(fs.existsSync(file), false);
});
test("cold or not-ready native execution fails without any host command fallback", async (t) => {
  const f = fixture(t); install(f, { status: "notConfigured" });
  assert.throws(() => prepareWindowsNativeProcess(command(f)), /Set up or recheck/);
  assert.equal((await probeWindowsNativeSandbox()).available, false);
  assert.throws(() => prepareWindowsNativeProcess(command(f)), /Set up or recheck/);
});
test("native scripts keep PowerShell source out of launcher argv and carry private-path protection", async (t) => {
  const f = fixture(t); install(f); await probeWindowsNativeSandbox();
  fs.mkdirSync(path.join(f.workspace, ".GiT")); fs.writeFileSync(path.join(f.workspace, ".ENV.production"), "fixture");
  fs.mkdirSync(path.join(f.workspace, "src")); fs.writeFileSync(path.join(f.workspace, "src", ".env"), "fixture");
  const source = "Write-Output '$(not a bootstrap expression)'";
  const prepared = prepareWindowsNativeProcess(command(f, { args: ["-NoProfile", "-Command", source], timeoutMs: 4567, maxOutputBytes: 200 }));
  f.cleanupBeforeRemoval(prepared.cleanup);
  assert.equal(prepared.executable, path.join(f.runtimeRoot, "bin", "codex.exe")); assert.equal(prepared.args.includes("windows"), false);
  assert.equal(prepared.args.includes(source), false); assert.equal(prepared.args.includes("-EncodedCommand"), false);
  assert.equal(prepared.timeoutMs, 4567); assert.equal(prepared.maxOutputBytes, 200);
  const script = prepared.args[prepared.args.indexOf("-File") + 1]; const text = fs.readFileSync(script, "utf8");
  assert.ok(text.includes(source)); assert.ok(text.startsWith("\uFEFF")); assert.ok(text.includes("$crownforgeCommandSucceeded = $?"));
  const profile = preparedProfile(prepared, f);
  assert.ok(profile.includes('\":root\" = \"read\"'));
  for (const file of [path.join(f.workspace, ".ENV.production"), path.join(f.workspace, "src", ".env"), f.privateFile, f.stateHome]) assert.ok(profile.includes(`${JSON.stringify(file)} = "deny"`));
  assert.ok(profile.includes(`${JSON.stringify(path.join(f.workspace, ".GiT"))} = "read"`));
  assert.ok(profile.includes('trust_level = "untrusted"')); assert.ok(profile.includes("enabled = false"));
  assert.equal(prepared.env.PATH.split(";").includes(f.workspace), false);
  prepared.cleanup(); assert.equal(fs.existsSync(script), false);
});
test("native exact write grants stay scoped and narrow read grants require WSL", async (t) => {
  const f = fixture(t); install(f); await probeWindowsNativeSandbox(); fs.mkdirSync(path.join(f.workspace, "src"));
  assert.throws(() => prepareWindowsNativeProcess(command(f, { filesystem: { readPaths: ["src"], writePaths: ["src"] } })), /narrow filesystem read grants/);
  const prepared = prepareWindowsNativeProcess(command(f, { filesystem: { readPaths: ["."], writePaths: ["src"] } })); f.cleanupBeforeRemoval(prepared.cleanup);
  const profile = preparedProfile(prepared, f); assert.ok(profile.includes(`${JSON.stringify(path.join(f.workspace, "src"))} = "write"`));
  assert.equal(profile.includes(`${JSON.stringify(f.workspace)} = "write"`), false);
  prepared.cleanup();
  for (const value of ["../outside", "src/*", ".git", ".env", "C:\\escape"]) assert.throws(() => prepareWindowsNativeProcess(command(f, { filesystem: { readPaths: ["."], writePaths: [value] } })));
});
test("native rejects control-plane overlap, workspace executable shadows and symlink grants", async (t) => {
  const f = fixture(t); install(f); await probeWindowsNativeSandbox();
  assert.throws(() => prepareWindowsNativeProcess(command(f, { cwd: f.root, filesystem: { workspaceDir: f.root, readPaths: ["."], writePaths: ["."] } })), /separate from the App/);
  const shadow = path.join(f.workspace, "powershell.exe"); fs.writeFileSync(shadow, "shadow");
  assert.throws(() => prepareWindowsNativeProcess(command(f, { executable: shadow })), /supplied by the workspace/);
  fs.symlinkSync(path.dirname(f.privateFile), path.join(f.workspace, "link"), "junction");
  assert.throws(() => prepareWindowsNativeProcess(command(f, { filesystem: { readPaths: ["."], writePaths: ["link"] } })), /symlinks or junctions/);
});
test("native never drops explicit POSIX limits or executable/environment injection", async (t) => {
  const f = fixture(t); install(f); await probeWindowsNativeSandbox();
  for (const limits of [{ cpuTimeMs: 1 }, { memoryBytes: 1000 }, { maxOpenFiles: 10 }]) assert.throws(() => prepareWindowsNativeProcess(command(f, { limits })), /does not expose POSIX/);
  for (const key of ["PATH", "NODE_OPTIONS", "OPENAI_API_KEY", "ELECTRON_RUN_AS_NODE", "SystemRoot"]) assert.throws(() => prepareWindowsNativeProcess(command(f, { env: { [key]: "inject" } })), /safe Windows tool variables/);
  assert.throws(() => prepareWindowsNativeProcess(command(f, { executable: "powershell.exe" })), /absolute trusted tool/);
  assert.throws(() => prepareWindowsNativeProcess(command(f, { args: ["-NoProfile", "-File", f.privateFile] })), /non-interactive -Command/);
  const prepared = prepareWindowsNativeProcess(command(f, { env: { NPM_CONFIG_USERCONFIG: "NUL" } })); f.cleanupBeforeRemoval(prepared.cleanup);
  assert.equal(prepared.env.NPM_CONFIG_USERCONFIG, "NUL");
  prepared.cleanup();
  assert.throws(() => prepareWindowsNativeProcess(command(f, { env: { NPM_CONFIG_USERCONFIG: f.privateFile } })), /safe Windows tool variables/);
  const inspection = prepareWindowsNativeProcess(command(f, { env: { GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "" } })); f.cleanupBeforeRemoval(inspection.cleanup);
  assert.equal(inspection.env.GIT_OPTIONAL_LOCKS, "0"); assert.equal(inspection.env.GIT_PAGER, "");
  inspection.cleanup();
  const unsafeGitEnvironments: Array<Record<string, string>> = [{ GIT_OPTIONAL_LOCKS: "1" }, { GIT_PAGER: "workspace-pager.cmd" }];
  for (const env of unsafeGitEnvironments) assert.throws(() => prepareWindowsNativeProcess(command(f, { env })), /safe Windows tool variables/);
});
test("large PowerShell commands use a controlled script while oversized argv fails", async (t) => {
  const f = fixture(t); install(f); await probeWindowsNativeSandbox();
  const source = `Write-Output '${"x".repeat(65_000)}'`;
  const prepared = prepareWindowsNativeProcess(command(f, { args: ["-Command", source] })); f.cleanupBeforeRemoval(prepared.cleanup);
  assert.ok(prepared.args.join(" ").length < 30_000); assert.equal(prepared.args.includes(source), false);
  prepared.cleanup();
  const tool = path.join(f.root, "tool.exe"); fs.writeFileSync(tool, "trusted external fixture");
  assert.throws(() => prepareWindowsNativeProcess(command(f, { executable: tool, args: ["x".repeat(31_000)] })), /launch limit/);
});
test("runtime changes, incomplete manifests and wrong versions fail closed", async (t) => {
  const f = fixture(t); install(f); await probeWindowsNativeSandbox();
  fs.appendFileSync(path.join(f.runtimeRoot, "codex-resources", "codex-command-runner.exe"), "changed");
  assert.throws(() => prepareWindowsNativeProcess(command(f)), /integrity check/);
  let data = JSON.parse(fs.readFileSync(f.manifestFile, "utf8")); data.runtimeVersion = "0.154.0"; fs.writeFileSync(f.manifestFile, JSON.stringify(data));
  assert.equal((await probeWindowsNativeSandbox()).available, false);
  data.runtimeVersion = "0.160.0"; delete data.files["codex-resources/codex-windows-sandbox-setup.exe"]; fs.writeFileSync(f.manifestFile, JSON.stringify(data));
  assert.match((await probeWindowsNativeSandbox()).reason!, /incomplete/);
});
test("unknown readiness protocols never enable Agent commands", async (t) => {
  const f = fixture(t); install(f, { status: "probablyReady" });
  assert.equal((await probeWindowsNativeSandbox()).available, false);
  assert.throws(() => prepareWindowsNativeProcess(command(f)), /Set up or recheck/);
});
test("setup waits for its completion and verifies a new server before enabling execution", async (t) => {
  const f = fixture(t); const { calls, clients } = install(f);
  await setupWindowsNativeSandbox(f.workspace, "elevated");
  assert.deepEqual(calls.map((call) => call.method), ["initialize", "windowsSandbox/setupCompleted", "windowsSandbox/setupStart", "initialize", "windowsSandbox/readiness"]);
  assert.equal(clients.length, 2); assert.equal(clients.every((client) => !client.args.includes("-p")), true);
  assert.equal(fs.readFileSync(path.join(f.stateHome, "config.toml"), "utf8").includes("[permissions."), false);
  const prepared = prepareWindowsNativeProcess(command(f)); prepared.cleanup();
});
test("setup cancellation or success with stale readiness leaves execution disabled", async (t) => {
  const f = fixture(t); install(f, { completion: { mode: "elevated", success: false, error: "cancelled" } });
  await assert.rejects(setupWindowsNativeSandbox(f.workspace, "elevated"), /failed or was cancelled/);
  assert.throws(() => prepareWindowsNativeProcess(command(f)), /Set up or recheck/);
  install(f, { status: "updateRequired" });
  await assert.rejects(setupWindowsNativeSandbox(f.workspace, "elevated"), /readiness verification failed/);
});
test("non-Windows platforms do not start a runtime or setup", async (t) => {
  const f = fixture(t); install(f); setWindowsNativeSandboxTestHooks({ platform: "darwin" });
  assert.equal((await probeWindowsNativeSandbox()).status, "unsupported");
  await assert.rejects(setupWindowsNativeSandbox(f.workspace, "elevated"), /only on Windows/);
});
test("unelevated mode cannot advertise readiness when private-file reads cannot be isolated", async (t) => {
  const f = fixture(t); const { calls } = install(f, { mode: "unelevated" });
  const result = await probeWindowsNativeSandbox(); assert.equal(result.available, false); assert.equal(result.status, "error");
  assert.equal(result.reasonCode, "unsupported_permissions"); assert.equal(result.weakerNetworkIsolation, true);
  assert.equal(calls.length, 0);
  await assert.rejects(setupWindowsNativeSandbox(f.workspace, "unelevated"), /cannot enforce private-file read restrictions/);
});
test("missing user secret files never become upstream deny-directory placeholders", async (t) => {
  const f = fixture(t); install(f); await probeWindowsNativeSandbox();
  const prepared = prepareWindowsNativeProcess(command(f)); f.cleanupBeforeRemoval(prepared.cleanup);
  const profile = preparedProfile(prepared, f);
  for (const file of [path.join(f.workspace, ".env"), path.join(f.workspace, ".git"), path.join(f.root, "user", ".npmrc"), path.join(f.root, "user", ".ssh")]) {
    assert.equal(fs.existsSync(file), false); assert.equal(profile.includes(`${JSON.stringify(file)} = `), false);
  }
});
test("a missing App-owned config is protected through its parent while scripts stay outside", async (t) => {
  const f = fixture(t); install(f); await probeWindowsNativeSandbox(); fs.rmSync(f.privateFile);
  const prepared = prepareWindowsNativeProcess(command(f)); f.cleanupBeforeRemoval(prepared.cleanup);
  const profile = preparedProfile(prepared, f); const parent = path.dirname(f.privateFile);
  const script = prepared.args[prepared.args.indexOf("-File") + 1];
  assert.ok(profile.includes(`${JSON.stringify(parent)} = "deny"`));
  assert.equal(profile.includes(`${JSON.stringify(f.privateFile)} = "deny"`), false);
  assert.equal(path.relative(parent, script).startsWith(".."), true); assert.equal(fs.existsSync(f.privateFile), false);
});
test("registered workspace protections are monotonic across later profiles and restarts", async (t) => {
  const f = fixture(t); install(f); await probeWindowsNativeSandbox();
  const secretA = path.join(f.workspace, ".env"); fs.writeFileSync(secretA, "fixture-A");
  const first = prepareWindowsNativeProcess(command(f)); first.cleanup();
  const workspaceB = path.join(f.root, "workspace-B"); fs.mkdirSync(workspaceB); const secretB = path.join(workspaceB, ".env"); fs.writeFileSync(secretB, "fixture-B");
  const second = prepareWindowsNativeProcess(command(f, { cwd: workspaceB, filesystem: { workspaceDir: workspaceB, readPaths: ["."], writePaths: ["."] } }));
  const both = preparedProfile(second, f); second.cleanup();
  for (const file of [secretA, secretB]) assert.ok(both.includes(`${JSON.stringify(file)} = "deny"`));
  install(f); await probeWindowsNativeSandbox();
  const afterRestart = prepareWindowsNativeProcess(command(f)); f.cleanupBeforeRemoval(afterRestart.cleanup);
  const persisted = preparedProfile(afterRestart, f);
  assert.ok(persisted.includes(`${JSON.stringify(secretB)} = "deny"`));
  const registry = JSON.parse(fs.readFileSync(path.join(f.stateHome, __windowsNativeSandboxForTests.DENY_REGISTRY_NAME), "utf8"));
  assert.ok(registry.paths.includes(secretA)); assert.ok(registry.paths.includes(secretB));
});
test("a removed registered secret is remembered without recreating a missing deny path", async (t) => {
  const f = fixture(t); install(f); await probeWindowsNativeSandbox();
  const secret = path.join(f.workspace, ".env"); fs.writeFileSync(secret, "fixture");
  const first = prepareWindowsNativeProcess(command(f)); first.cleanup(); fs.rmSync(secret);
  const second = prepareWindowsNativeProcess(command(f)); f.cleanupBeforeRemoval(second.cleanup);
  assert.equal(preparedProfile(second, f).includes(`${JSON.stringify(secret)} = "deny"`), false); assert.equal(fs.existsSync(secret), false);
});
test("native nonzero exit propagation precedes the boolean failure fallback and cmdlet errors stay caught", () => {
  const source = __windowsNativeSandboxForTests.scriptSource("& 'fixture-native.exe'");
  assert.ok(source.indexOf("$crownforgeNativeExitCode -ne 0") < source.indexOf("if (-not $crownforgeCommandSucceeded)"));
  assert.ok(source.includes("catch {\n[Console]::Error.WriteLine($_.ToString())\nexit 1"));
});
test("native pending execution stays exclusive through cancellation until actual close cleanup", async (t) => {
  const f = fixture(t); install(f); await probeWindowsNativeSandbox();
  const first = prepareWindowsNativeProcess(command(f)); f.cleanupBeforeRemoval(first.cleanup);
  const script = first.args[first.args.indexOf("-File") + 1];
  const lease = path.join(f.stateHome, __windowsNativeSandboxForTests.EXECUTION_LEASE_NAME);
  first.onSpawn?.(process.pid); first.cancel?.();
  assert.ok(fs.existsSync(script)); assert.equal(JSON.parse(fs.readFileSync(lease, "utf8")).cancelled, true);
  assert.equal(JSON.parse(fs.readFileSync(lease, "utf8")).supervisorPid, process.pid);
  assert.throws(() => prepareWindowsNativeProcess(command(f)), /execution is busy/);
  await assert.rejects(setupWindowsNativeSandbox(f.workspace, "elevated"), /execution is busy/);
  first.cleanup(); assert.equal(fs.existsSync(lease), false);
  await probeWindowsNativeSandbox();
  const second = prepareWindowsNativeProcess(command(f)); second.cleanup();
});
test("a lease is reclaimed only after both the original backend and its supervisor are dead", async (t) => {
  const f = fixture(t); install(f); await probeWindowsNativeSandbox();
  const lease = path.join(f.stateHome, __windowsNativeSandboxForTests.EXECUTION_LEASE_NAME);
  // Very large PIDs are known not to exist on supported hosts; no process is spawned or killed.
  const dead = 2_147_483_646;
  const record = { version: 1, backendPid: dead, supervisorPid: process.pid, nonce: "a".repeat(32) };
  fs.writeFileSync(lease, JSON.stringify(record));
  assert.throws(() => prepareWindowsNativeProcess(command(f)), /execution is busy/);
  record.backendPid = process.pid; record.supervisorPid = dead; fs.writeFileSync(lease, JSON.stringify(record));
  assert.throws(() => prepareWindowsNativeProcess(command(f)), /execution is busy/);
  record.backendPid = dead; fs.writeFileSync(lease, JSON.stringify(record));
  const recovered = prepareWindowsNativeProcess(command(f)); recovered.cleanup(); assert.equal(fs.existsSync(lease), false);
});
test("a malformed or unregistered dead-owner lease cannot silently authorize a new command", async (t) => {
  const f = fixture(t); install(f); await probeWindowsNativeSandbox();
  const lease = path.join(f.stateHome, __windowsNativeSandboxForTests.EXECUTION_LEASE_NAME);
  fs.writeFileSync(lease, JSON.stringify({ version: 1, backendPid: 2_147_483_646, nonce: "b".repeat(32) }));
  assert.throws(() => prepareWindowsNativeProcess(command(f)), /execution is busy/);
  fs.writeFileSync(lease, "{}"); assert.throws(() => prepareWindowsNativeProcess(command(f)), /Invalid Windows sandbox execution lease/);
});

function lifecycleFaults(t: test.TestContext, f: Fixture, successfulLeaseWrites: number) {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
  const keys = ["APP_SETTINGS_CONFIG", "CROWNFORGE_WINDOWS_AGENT_ENVIRONMENT"];
  const previous = keys.map((key) => process.env[key]);
  process.env.APP_SETTINGS_CONFIG = path.join(f.root, "fixture-app-settings.json");
  process.env.CROWNFORGE_WINDOWS_AGENT_ENVIRONMENT = "native";
  const child = new EventEmitter() as childProcess.ChildProcess;
  Object.defineProperty(child, "pid", { value: 424242 });
  Object.defineProperty(child, "exitCode", { value: null, writable: true });
  Object.defineProperty(child, "signalCode", { value: null, writable: true });
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const spawnCalls: Array<{ executable: string; args: string[] }> = [];
  const kills: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
  const timers: NodeJS.Timeout[] = [];
  const keepAlive = setInterval(() => {}, 1000);
  const originalRename = fs.renameSync;
  const originalTimeout = globalThis.setTimeout;
  let leaseWrites = 0;
  t.mock.method(fs, "renameSync", ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to).endsWith(__windowsNativeSandboxForTests.EXECUTION_LEASE_NAME) && ++leaseWrites > successfulLeaseWrites) {
      throw Object.assign(new Error("fixture lease disk is full"), { code: "ENOSPC" });
    }
    return originalRename(from, to);
  }) as typeof fs.renameSync);
  t.mock.method(childProcess, "spawn", ((executable: string, args: readonly string[]) => {
    spawnCalls.push({ executable, args: [...args] });
    return /(?:^|[\\/])taskkill\.exe$/i.test(executable) ? new EventEmitter() as childProcess.ChildProcess : child;
  }) as typeof childProcess.spawn);
  t.mock.method(process, "kill", ((pid: number, signal?: NodeJS.Signals | number) => { kills.push({ pid, signal }); return true; }) as typeof process.kill);
  t.mock.method(globalThis, "setTimeout", ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const timer = originalTimeout(callback, delay, ...args);
    if (delay === 1000 || delay === 1500) timers.push(timer);
    return timer;
  }) as typeof setTimeout);
  syncBuiltinESMExports();
  f.cleanupBeforeRemoval(() => {
    child.emit("close", 1, null); clearInterval(keepAlive); for (const timer of timers) clearTimeout(timer);
    t.mock.restoreAll(); syncBuiltinESMExports(); Object.defineProperty(process, "platform", platformDescriptor);
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  });
  return { child, spawnCalls, kills, leaseWrites: () => leaseWrites };
}

test("short native spawn registration and cancel failures still kill the owned child and defer cleanup to close", async (t) => {
  const f = fixture(t); install(f); await probeWindowsNativeSandbox();
  const faults = lifecycleFaults(t, f, 0);
  const { runWorkspaceProcess } = await import("./processSandbox.js");
  const result = await runWorkspaceProcess(command(f));
  assert.match(result, /fixture lease disk is full/); assert.equal(faults.leaseWrites(), 2);
  assert.deepEqual(faults.kills, [{ pid: 424242, signal: "SIGKILL" }]);
  const lease = path.join(f.stateHome, __windowsNativeSandboxForTests.EXECUTION_LEASE_NAME);
  assert.equal(fs.existsSync(lease), true);
  assert.ok(fs.readdirSync(f.stateHome).some((name) => /^crownforge-.+\.config\.toml$/.test(name)));
  faults.child.emit("close", 1, null); assert.equal(fs.existsSync(lease), false);
});
test("short native timeout still terminates after a cancel marker write fails without releasing the live lease", async (t) => {
  const f = fixture(t); install(f); await probeWindowsNativeSandbox();
  const faults = lifecycleFaults(t, f, 1);
  const { runWorkspaceProcess } = await import("./processSandbox.js");
  const result = await runWorkspaceProcess(command(f, { timeoutMs: 10 }));
  assert.match(result, /^Error: Timeout/); assert.equal(faults.leaseWrites(), 2);
  assert.deepEqual(faults.kills, [{ pid: 424242, signal: "SIGTERM" }]);
  const lease = path.join(f.stateHome, __windowsNativeSandboxForTests.EXECUTION_LEASE_NAME);
  assert.equal(fs.existsSync(lease), true); faults.child.emit("close", 1, null); assert.equal(fs.existsSync(lease), false);
});
test("managed native spawn registration and cancel failures still taskkill the owned supervisor", async (t) => {
  const f = fixture(t); install(f); await probeWindowsNativeSandbox();
  const faults = lifecycleFaults(t, f, 0);
  const { startAgentProcessSession } = await import("../run/processSessions.js");
  assert.throws(() => startAgentProcessSession({ workspaceDir: f.workspace, owner: "fixture-native-owner", executable: f.powershellExecutable, args: command(f).args as string[], timeoutMs: 1000 }), /fixture lease disk is full/);
  assert.equal(faults.leaseWrites(), 2);
  const killer = faults.spawnCalls.find((call) => /(?:^|[\\/])taskkill\.exe$/i.test(call.executable));
  assert.deepEqual(killer?.args, ["/pid", "424242", "/T", "/F"]);
  const lease = path.join(f.stateHome, __windowsNativeSandboxForTests.EXECUTION_LEASE_NAME);
  assert.equal(fs.existsSync(lease), true); faults.child.emit("close", 1, null); assert.equal(fs.existsSync(lease), false);
});
test("native preparation protects a fresh App-owned history directory before session persistence", async (t) => {
  const f = fixture(t); install(f); await probeWindowsNativeSandbox();
  const history = path.join(f.workspace, ".history"); assert.equal(fs.existsSync(history), false);
  const prepared = prepareWindowsNativeProcess(command(f)); f.cleanupBeforeRemoval(prepared.cleanup);
  assert.equal(fs.statSync(history).isDirectory(), true);
  assert.ok(preparedProfile(prepared, f).includes(`${JSON.stringify(history)} = "read"`));
  prepared.cleanup(); fs.rmSync(history, { recursive: true }); fs.writeFileSync(history, "fixture collision");
  assert.throws(() => prepareWindowsNativeProcess(command(f)), /EEXIST|Invalid Windows sandbox control directory/);
});
