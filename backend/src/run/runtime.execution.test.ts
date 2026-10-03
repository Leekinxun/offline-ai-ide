import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test, type TestContext } from "node:test";
import express from "express";
import type { UserSession } from "../auth/sessionManager.js";
import type { SandboxDiagnostics } from "../run/sandboxDiagnostics.js";

const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-runtime-execution-"));
const previousEnvironment = { USERS_CONFIG: process.env.USERS_CONFIG, APP_SETTINGS_CONFIG: process.env.APP_SETTINGS_CONFIG, WORKSPACE_DIR: process.env.WORKSPACE_DIR };
process.env.USERS_CONFIG = path.join(fixtureDirectory, "users.json");
process.env.APP_SETTINGS_CONFIG = path.join(fixtureDirectory, "settings.json");
process.env.WORKSPACE_DIR = fixtureDirectory;
fs.writeFileSync(process.env.USERS_CONFIG, JSON.stringify({ users: [], allowedRoots: [fixtureDirectory] }));
fs.writeFileSync(process.env.APP_SETTINGS_CONFIG, "{}");
const { createRuntimeRouter } = await import("../routes/runtime.js");
after(() => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(fixtureDirectory, { recursive: true, force: true });
});

const nativeDiagnostics = () => ({
  executionReady: false,
  filesystem: { available: false, reasonCode: "helper_missing", reason: "/private/helper-location" },
  network: { available: false, reason: "/private/network-helper" },
  runtimeReadPaths: ["/private/runtime"],
  linux: { effectiveCapabilities: "private-kernel-detail" },
}) as unknown as SandboxDiagnostics;

async function serve(t: TestContext, router: express.Router): Promise<string> {
  const app = express();
  app.use("/api/runtime", (req, _res, next) => {
    if (req.headers["x-fixture-user"]) (req as typeof req & { userSession: UserSession }).userSession = { username: "fixture", isAdmin: false } as UserSession;
    next();
  }, router);
  const listener = http.createServer(app);
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { listener.closeAllConnections(); listener.close(() => resolve()); }));
  const address = listener.address(); assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}/api/runtime/execution`;
}
const headers = { "x-fixture-user": "user" };

test("execution capability requires authentication before probing", async (t) => {
  let probes = 0;
  const url = await serve(t, createRuntimeRouter(nativeDiagnostics, { platform: "win32", readWslCapability: () => { probes += 1; return { available: true }; } }));
  assert.equal((await fetch(url)).status, 401);
  assert.equal(probes, 0);
});

test("ordinary signed-in users receive only the WSL capability whitelist", async (t) => {
  const url = await serve(t, createRuntimeRouter(nativeDiagnostics, { platform: "win32", readWslCapability: async () => ({
    available: true, distro: "Ubuntu", reason: "stale failure", reasonCode: "stale_code",
    executable: "/private/helper", env: { SECRET: "private-token" }, runtimeReadPaths: ["/private/path"],
  }) }));
  const response = await fetch(url, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { hostPlatform: "win32", executor: "wsl", available: true, distro: "Ubuntu" });
  assert.equal((await fetch(url.replace("/execution", "/sandbox"), { headers })).status, 403);
});

test("execution capability rejects query and command inputs without probing", async (t) => {
  let probes = 0;
  const url = await serve(t, createRuntimeRouter(nativeDiagnostics, { platform: "win32", readWslCapability: () => { probes += 1; return { available: true }; } }));
  for (const query of ["?command=touch%20outside", "?distro=Other", "?path=/private", "?refresh=1"]) {
    const response = await fetch(`${url}${query}`, { headers });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal((await fetch(url, { method: "POST", headers })).status, 404);
  assert.equal(probes, 0);
});

test("execution capability returns bounded unavailable reasons without internal fields", async (t) => {
  const url = await serve(t, createRuntimeRouter(nativeDiagnostics, { platform: "win32", readWslCapability: () => ({ available: false, reasonCode: "helper_missing", reason: "secret-token at /private/helper", paths: ["/private"] }) }));
  assert.deepEqual(await (await fetch(url, { headers })).json(), { hostPlatform: "win32", executor: "wsl", available: false, reasonCode: "helper_missing", reason: "The Linux distribution requires Bash and bubblewrap" });
});

test("unknown diagnostic codes and path-shaped distribution values stay private", async (t) => {
  const url = await serve(t, createRuntimeRouter(nativeDiagnostics, { platform: "win32", readWslCapability: () => ({ available: false, distro: "/private/distribution", reasonCode: "secret-token", reason: "secret-token at /private/helper" }) }));
  assert.deepEqual(await (await fetch(url, { headers })).json(), { hostPlatform: "win32", executor: "wsl", available: false, reasonCode: "probe_failed", reason: "Execution capability could not be checked" });
});

test("native capability summarizes host diagnostics and never runs a WSL probe", async (t) => {
  const url = await serve(t, createRuntimeRouter(nativeDiagnostics, { platform: "linux", readWslCapability: () => { throw new Error("WSL reader must not run"); } }));
  assert.deepEqual(await (await fetch(url, { headers })).json(), { hostPlatform: "linux", executor: "native", available: false, reasonCode: "helper_missing", reason: "Required filesystem isolation is unavailable" });
});

test("execution probe failure does not expose exception details", async (t) => {
  const url = await serve(t, createRuntimeRouter(nativeDiagnostics, { platform: "win32", readWslCapability: () => { throw new Error("secret-token at /private/helper"); } }));
  assert.deepEqual(await (await fetch(url, { headers })).json(), { hostPlatform: "win32", executor: "wsl", available: false, reasonCode: "probe_failed", reason: "Execution capability could not be checked" });
});
