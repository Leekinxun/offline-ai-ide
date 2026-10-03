import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test, type TestContext } from "node:test";
import express from "express";
import type { UserSession } from "../auth/sessionManager.js";
import type { SandboxDiagnostics } from "../run/sandboxDiagnostics.js";
import type { WindowsAgentSettings } from "./windowsAgentSettings.js";

const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-runtime-execution-"));
const workspace = path.join(fixtureDirectory, "workspace"); fs.mkdirSync(workspace);
const previousEnvironment = { USERS_CONFIG: process.env.USERS_CONFIG, APP_SETTINGS_CONFIG: process.env.APP_SETTINGS_CONFIG, WORKSPACE_DIR: process.env.WORKSPACE_DIR, CREWFORGE_DESKTOP: process.env.CREWFORGE_DESKTOP };
process.env.USERS_CONFIG = path.join(fixtureDirectory, "users.json");
process.env.APP_SETTINGS_CONFIG = path.join(fixtureDirectory, "settings.json");
process.env.WORKSPACE_DIR = workspace;
process.env.CREWFORGE_DESKTOP = "1";
fs.writeFileSync(process.env.USERS_CONFIG, JSON.stringify({ users: [{ username: "fixture", password: "fixture-password", defaultWorkspace: workspace, isAdmin: true }], allowedRoots: [fixtureDirectory] }));
fs.writeFileSync(process.env.APP_SETTINGS_CONFIG, "{}");
const { createRuntimeRouter } = await import("../routes/runtime.js");
after(() => {
  for (const [key, value] of Object.entries(previousEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(fixtureDirectory, { recursive: true, force: true });
});

const nativeSettings: WindowsAgentSettings = { environment: "native", sandboxMode: "elevated" };
const wslSettings: WindowsAgentSettings = { environment: "wsl", sandboxMode: "elevated" };
const nativeDiagnostics = () => ({
  executionReady: false, filesystem: { available: false, reasonCode: "helper_missing", reason: "/private/helper-location" },
  network: { available: false, reason: "/private/network-helper" }, runtimeReadPaths: ["/private/runtime"],
  linux: { effectiveCapabilities: "private-kernel-detail" },
}) as unknown as SandboxDiagnostics;

function router(readers: Parameters<typeof createRuntimeRouter>[1] = {}) {
  return createRuntimeRouter(nativeDiagnostics, { platform: "win32", desktop: true, readSettings: () => ({ ...nativeSettings }), hasRunningAgentProcesses: () => false, ...readers });
}
async function serve(t: TestContext, route: express.Router): Promise<string> {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.use("/api/runtime", (req, _res, next) => {
    if (req.headers["x-fixture-user"]) (req as typeof req & { userSession: UserSession }).userSession = { username: "fixture", isAdmin: req.headers["x-fixture-user"] === "admin", workspaceDir: workspace } as UserSession;
    if (req.headers["x-fixture-remote"] === "external") Object.defineProperty(req.socket, "remoteAddress", { configurable: true, value: "192.0.2.3" });
    next();
  }, route);
  const listener = http.createServer(app);
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { listener.closeAllConnections(); listener.close(() => resolve()); }));
  const address = listener.address(); assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}/api/runtime`;
}
const userHeaders = { "x-fixture-user": "user" };
function post(base: string, suffix: string, value: unknown, extra: Record<string, string> = {}) {
  return fetch(`${base}${suffix}`, { method: "POST", headers: { "x-fixture-user": "admin", "Content-Type": "application/json", Origin: new URL(base).origin, ...extra }, body: JSON.stringify(value) });
}

test("execution diagnostics require authentication before probing and never initialize", async (t) => {
  let probes = 0; let setups = 0;
  const base = await serve(t, router({ readNativeCapability: () => { probes += 1; return { available: false, reasonCode: "setup_required" }; }, setupNativeSandbox: async () => { setups += 1; } }));
  assert.equal((await fetch(`${base}/execution`)).status, 401);
  assert.equal(probes, 0);
  const value = await (await fetch(`${base}/execution`, { headers: userHeaders })).json();
  assert.equal(value.executor, "windows-native"); assert.equal(value.shell, "powershell");
  assert.equal(value.status, "setup_required"); assert.equal(value.setupRequired, true);
  assert.equal(probes, 1); assert.equal(setups, 0);
});

test("Windows defaults to a safe PowerShell native capability whitelist for ordinary users", async (t) => {
  const base = await serve(t, router({ readNativeCapability: async () => ({
    available: true, runtimeVersion: "0.116.0", reason: "stale failure", reasonCode: "stale_code",
    executable: "/private/helper", env: { SECRET: "private-token" }, runtimeReadPaths: ["/private/path"],
  }), readWslCapability: () => { throw new Error("Default Windows execution must not probe WSL"); } }));
  const response = await fetch(`${base}/execution`, { headers: userHeaders });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { hostPlatform: "win32", executor: "windows-native", shell: "powershell", settings: nativeSettings, available: true, status: "ready", setupRequired: false, weakerNetworkIsolation: false, runtimeVersion: "0.116.0" });
  assert.equal((await fetch(`${base}/sandbox`, { headers: userHeaders })).status, 403);
});

test("Windows Web keeps the old WSL execution DTO and ignores desktop native overrides", async (t) => {
  const keys = ["CREWFORGE_DESKTOP", "CROWNFORGE_WINDOWS_AGENT_ENVIRONMENT", "CROWNFORGE_WINDOWS_SANDBOX_MODE"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { const value = previous[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  process.env.CROWNFORGE_WINDOWS_AGENT_ENVIRONMENT = "native"; process.env.CROWNFORGE_WINDOWS_SANDBOX_MODE = "unelevated";
  let wslProbes = 0;
  const route = createRuntimeRouter(nativeDiagnostics, { platform: "win32", readNativeCapability: () => { throw new Error("Web must not probe native Windows execution"); },
    readSettings: () => { throw new Error("Web must not read desktop settings"); }, readWslCapability: () => { wslProbes += 1; return { available: true, distro: "Ubuntu" }; } });
  const base = await serve(t, route);
  for (const desktop of [undefined, "0"]) {
    if (desktop === undefined) delete process.env.CREWFORGE_DESKTOP; else process.env.CREWFORGE_DESKTOP = desktop;
    assert.deepEqual(await (await fetch(`${base}/execution`, { headers: userHeaders })).json(), { hostPlatform: "win32", executor: "wsl", available: true, distro: "Ubuntu" });
  }
  assert.equal(wslProbes, 2);
  const failedBase = await serve(t, createRuntimeRouter(nativeDiagnostics, { platform: "win32", readWslCapability: () => { throw new Error("fixture WSL probe failure"); } }));
  assert.deepEqual(await (await fetch(`${failedBase}/execution`, { headers: userHeaders })).json(), { hostPlatform: "win32", executor: "wsl", available: false, reasonCode: "probe_failed", reason: "Execution capability could not be checked" });
});

test("WSL is used only when explicitly selected and preserves its bounded diagnostics", async (t) => {
  const base = await serve(t, router({ readSettings: () => wslSettings, readNativeCapability: () => { throw new Error("Native must not probe for explicit WSL"); }, readWslCapability: () => ({ available: true, distro: "Ubuntu", executable: "/private/helper" }) }));
  assert.deepEqual(await (await fetch(`${base}/execution`, { headers: userHeaders })).json(), { hostPlatform: "win32", executor: "wsl", shell: "bash", settings: wslSettings, available: true, status: "ready", setupRequired: false, distro: "Ubuntu" });
});

test("compatibility mode reports weaker isolation and stays unavailable when sensitive-file protection is unsupported", async (t) => {
  const base = await serve(t, router({ readSettings: () => ({ environment: "native", sandboxMode: "unelevated" }), readNativeCapability: () => ({ available: false, reasonCode: "unsupported_permissions" }) }));
  const value = await (await fetch(`${base}/execution`, { headers: userHeaders })).json();
  assert.equal(value.weakerNetworkIsolation, true); assert.equal(value.settings.sandboxMode, "unelevated");
  assert.equal(value.available, false); assert.equal(value.status, "unavailable"); assert.equal(value.reasonCode, "unsupported_permissions");
  assert.match(value.reason, /sensitive files.*recommended native sandbox or WSL2/);
});

test("execution capability rejects query and command inputs without probing", async (t) => {
  let probes = 0;
  const base = await serve(t, router({ readNativeCapability: () => { probes += 1; return { available: true }; } }));
  for (const query of ["?command=touch%20outside", "?distro=Other", "?path=/private", "?refresh=1"]) {
    const response = await fetch(`${base}/execution${query}`, { headers: userHeaders });
    assert.equal(response.status, 400); assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal((await fetch(`${base}/execution`, { method: "POST", headers: userHeaders })).status, 404);
  assert.equal(probes, 0);
});

test("unavailable and unknown diagnostics never leak raw errors, paths, or version-shaped paths", async (t) => {
  const base = await serve(t, router({ readNativeCapability: () => ({ available: false, reasonCode: "secret-token", reason: "private-token at /private/helper", runtimeVersion: "/private/runtime" }) }));
  const value = await (await fetch(`${base}/execution`, { headers: userHeaders })).json();
  assert.equal(value.reasonCode, "probe_failed");
  assert.equal(JSON.stringify(value).includes("private"), false);
  const wslBase = await serve(t, router({ readSettings: () => wslSettings, readWslCapability: () => ({ available: false, distro: "/private/distribution", reasonCode: "helper_missing", reason: "private-token at /private/helper" }) }));
  const wsl = await (await fetch(`${wslBase}/execution`, { headers: userHeaders })).json();
  assert.equal(wsl.reason, "The Linux distribution requires Bash and bubblewrap"); assert.equal(JSON.stringify(wsl).includes("private"), false);
});

test("native probe failure stays blocked and does not fall back to WSL or lose its setup settings", async (t) => {
  const base = await serve(t, router({ readNativeCapability: () => { throw new Error("private-token at /private/helper"); }, readWslCapability: () => { throw new Error("Unexpected fallback"); } }));
  assert.deepEqual(await (await fetch(`${base}/execution`, { headers: userHeaders })).json(), { hostPlatform: "win32", executor: "windows-native", shell: "powershell", settings: nativeSettings, available: false, status: "unavailable", reasonCode: "probe_failed", reason: "Execution capability could not be checked" });
});

test("non-Windows native capability never reads Windows settings or probes WSL", async (t) => {
  const base = await serve(t, router({ platform: "linux", readSettings: () => { throw new Error("Windows settings must not load"); }, readWslCapability: () => { throw new Error("WSL reader must not run"); } }));
  assert.deepEqual(await (await fetch(`${base}/execution`, { headers: userHeaders })).json(), { hostPlatform: "linux", executor: "native", available: false, reasonCode: "helper_missing", reason: "Required filesystem isolation is unavailable" });
});

test("settings and setup require authenticated App administrators and a Windows desktop backend", async (t) => {
  let mutations = 0;
  const readers = { writeSettings: () => { mutations += 1; return nativeSettings; }, setupNativeSandbox: async () => { mutations += 1; } };
  const base = await serve(t, router(readers));
  for (const [suffix, body] of [["/execution/settings", nativeSettings], ["/sandbox/setup", {}]] as const) {
    assert.equal((await post(base, suffix, body, { "x-fixture-user": "" })).status, 401);
    assert.equal((await post(base, suffix, body, userHeaders)).status, 403);
  }
  for (const options of [{ platform: "linux" as const }, { desktop: false }]) {
    const restricted = await serve(t, router({ ...readers, ...options }));
    assert.equal((await post(restricted, "/execution/settings", nativeSettings)).status, 403);
    assert.equal((await post(restricted, "/sandbox/setup", {})).status, 403);
  }
  assert.equal(mutations, 0);
});

test("mutations require a physical loopback socket and matching local Origin; forwarded headers cannot authorize", async (t) => {
  let mutations = 0;
  const base = await serve(t, router({ writeSettings: () => { mutations += 1; return nativeSettings; }, setupNativeSandbox: async () => { mutations += 1; } }));
  for (const suffix of ["/execution/settings", "/sandbox/setup"]) {
    const body = suffix.endsWith("settings") ? nativeSettings : {};
    for (const origin of ["", "null", "https://evil.example", "http://127.0.0.1:1", "http://user:password@127.0.0.1:1"]) assert.equal((await post(base, suffix, body, { Origin: origin })).status, 403);
    assert.equal((await post(base, suffix, body, { "x-fixture-remote": "external", "X-Forwarded-For": "127.0.0.1" })).status, 403);
  }
  assert.equal(mutations, 0);
});

test("settings accept only exact enumeration fields and reject command, path, unknown, and query inputs", async (t) => {
  let mutations = 0;
  const base = await serve(t, router({ writeSettings: (value, actualWorkspace) => { assert.equal(actualWorkspace, workspace); mutations += 1; return value as WindowsAgentSettings; } }));
  for (const value of [{}, { environment: "native" }, { ...nativeSettings, command: "calc.exe" }, { ...nativeSettings, path: "/private" }, { ...nativeSettings, sandboxMode: "disabled" }, { ...nativeSettings, environment: "auto" }, []]) assert.equal((await post(base, "/execution/settings", value)).status, 400);
  assert.equal((await post(base, "/execution/settings?command=calc.exe", nativeSettings)).status, 400);
  assert.equal((await post(base, "/execution/settings", nativeSettings, { "Content-Type": "text/plain" })).status, 400);
  assert.equal(mutations, 0);
  const response = await post(base, "/execution/settings", wslSettings);
  assert.deepEqual(await response.json(), { settings: wslSettings }); assert.equal(mutations, 1);
});

test("active Agent commands block settings and sandbox setup without mutations", async (t) => {
  let mutations = 0;
  const base = await serve(t, router({ hasRunningAgentProcesses: () => true, writeSettings: () => { mutations += 1; return nativeSettings; }, setupNativeSandbox: async () => { mutations += 1; } }));
  assert.equal((await post(base, "/execution/settings", wslSettings)).status, 409);
  assert.equal((await post(base, "/sandbox/setup", {})).status, 409);
  assert.equal(mutations, 0);
});

test("setup accepts only empty JSON and passes the server-owned workspace and selected mode", async (t) => {
  const calls: unknown[] = [];
  const base = await serve(t, router({ readSettings: () => ({ environment: "native", sandboxMode: "unelevated" }), setupNativeSandbox: async (...args) => { calls.push(args); } }));
  for (const value of [{ command: "calc.exe" }, { mode: "elevated" }, { workspaceDir: "/private" }, []]) assert.equal((await post(base, "/sandbox/setup", value)).status, 400);
  assert.equal((await post(base, "/sandbox/setup?mode=elevated", {})).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await post(base, "/sandbox/setup", {})).status, 200);
  assert.deepEqual(calls, [[workspace, "unelevated"]]);
  const wslBase = await serve(t, router({ readSettings: () => wslSettings, setupNativeSandbox: async () => { throw new Error("WSL selection must not setup native"); } }));
  assert.equal((await post(wslBase, "/sandbox/setup", {})).status, 409);
});

test("pending setup is visible as unavailable and serializes setup and environment changes", async (t) => {
  let started = false; let finished = false;
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const base = await serve(t, router({ readNativeCapability: () => ({ available: finished }), setupNativeSandbox: async () => { started = true; await wait; finished = true; } }));
  const request = post(base, "/sandbox/setup", {});
  for (let attempt = 0; attempt < 100 && !started; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(started, true);
  const pending = await (await fetch(`${base}/execution`, { headers: userHeaders })).json();
  assert.equal(pending.available, false); assert.equal(pending.status, "setup_pending"); assert.equal(pending.reasonCode, "setup_pending");
  assert.equal((await post(base, "/sandbox/setup", {})).status, 409);
  assert.equal((await post(base, "/execution/settings", wslSettings)).status, 409);
  release(); assert.deepEqual(await (await request).json(), { success: true });
  const ready = await (await fetch(`${base}/execution`, { headers: userHeaders })).json();
  assert.equal(ready.available, true); assert.equal(ready.status, "ready");
});

test("setup errors are sanitized and release the pending lock for a retry", async (t) => {
  let calls = 0;
  const base = await serve(t, router({ setupNativeSandbox: async () => { calls += 1; if (calls === 1) throw new Error("private-token at /private/helper"); } }));
  const response = await post(base, "/sandbox/setup", {});
  assert.equal(response.status, 500); assert.equal(JSON.stringify(await response.json()).includes("private"), false);
  assert.equal((await post(base, "/sandbox/setup", {})).status, 200);
});
