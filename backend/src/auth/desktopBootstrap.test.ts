import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test, type TestContext } from "node:test";

// Configure isolated storage before importing any backend module with configuration.
const importRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-bootstrap-tests-")));
const importWorkspace = path.join(importRoot, "workspace"); fs.mkdirSync(importWorkspace);
const keys = ["USERS_CONFIG", "APP_SETTINGS_CONFIG", "WORKSPACE_DIR", "TEAM_STORE_ROOT", "PLUGINS_DIR", "CREWFORGE_DESKTOP", "CROWNFORGE_DESKTOP_RUNTIME", "CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN", "CROWNFORGE_IDE_CORE_EXECUTABLE"] as const;
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const usersFile = path.join(importRoot, "users.json");
fs.writeFileSync(usersFile, JSON.stringify({ allowedRoots: [importRoot], users: [{ username: "admin", password: "fixture-password", defaultWorkspace: importWorkspace, isAdmin: true }] }));
const settingsFile = path.join(importRoot, "app-settings.json"); fs.writeFileSync(settingsFile, "{}\n");
process.env.USERS_CONFIG = usersFile; process.env.APP_SETTINGS_CONFIG = settingsFile;
process.env.WORKSPACE_DIR = importWorkspace; process.env.TEAM_STORE_ROOT = importRoot;
process.env.PLUGINS_DIR = path.join(importRoot, "plugins"); process.env.CREWFORGE_DESKTOP = "1";
delete process.env.CROWNFORGE_IDE_CORE_EXECUTABLE;

const { authRouter } = await import("../routes/auth.js");
const { initializeDesktopBootstrapCredential } = await import("./desktopBootstrapCredential.js");
const { SessionManager, sessionManager, setSessionManagerForTests } = await import("./sessionManager.js");
const originalManager = sessionManager;
after(() => {
  setSessionManagerForTests(originalManager);
  delete process.env.CREWFORGE_DESKTOP; initializeDesktopBootstrapCredential();
  for (const key of keys) { const value = previous[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(importRoot, { recursive: true, force: true });
});

const headerName = "X-CrownForge-Desktop-Bootstrap";

async function serve(t: TestContext, remoteAddress?: string) {
  const root = fs.mkdtempSync(path.join(importRoot, "case-"));
  const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace);
  const configFile = path.join(root, "users.json");
  fs.writeFileSync(configFile, JSON.stringify({ allowedRoots: [root], users: [{ username: "admin", password: "fixture-password", defaultWorkspace: workspace, isAdmin: true }] }));
  const policyKeys = ["CREWFORGE_DESKTOP", "CROWNFORGE_DESKTOP_RUNTIME", "CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN"] as const;
  const priorPolicy = Object.fromEntries(policyKeys.map((key) => [key, process.env[key]]));
  process.env.CREWFORGE_DESKTOP = "1"; process.env.CROWNFORGE_DESKTOP_RUNTIME = "tauri";
  const bootstrap = crypto.randomBytes(32).toString("hex");
  process.env.CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN = bootstrap;
  initializeDesktopBootstrapCredential();
  setSessionManagerForTests(new SessionManager(configFile));
  const app = express();
  if (remoteAddress) app.use((req, _res, next) => { Object.defineProperty(req.socket, "remoteAddress", { value: remoteAddress, configurable: true }); next(); });
  app.use(express.json()); app.use("/api/auth", authRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    setSessionManagerForTests(originalManager);
    delete process.env.CREWFORGE_DESKTOP; initializeDesktopBootstrapCredential();
    for (const key of policyKeys) { const value = priorPolicy[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    origin,
    bootstrapHeaders: { [headerName]: bootstrap },
    async me(headers: Record<string, string> = {}) {
      return new Promise<{ status: number; cacheControl: string | undefined; body: Record<string, unknown> }>((resolve, reject) => {
        // A raw HTTP request preserves spoofed Host headers for the origin checks.
        const request = http.request(`${origin}/api/auth/me`, { headers, method: "GET" }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk)); response.on("error", reject);
          response.on("end", () => {
            try { resolve({ status: response.statusCode || 0, cacheControl: response.headers["cache-control"], body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> }); }
            catch (error) { reject(error); }
          });
        });
        request.on("error", reject); request.setTimeout(5_000, () => request.destroy(new Error("Fixture request timed out"))); request.end();
      });
    },
  };
}

test("Tauri loopback bootstrap requires the private header and rejects empty, wrong, or malformed authority", async (t) => {
  const server = await serve(t);
  assert.ok(process.env.CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN === undefined, "Captured bootstrap authority must not remain in the process environment");
  const rejectedHeaders: Array<Record<string, string>> = [{}, { [headerName]: "" }, { [headerName]: "incorrect" }, { [headerName]: "0".repeat(64) }, { [headerName]: `${server.bootstrapHeaders[headerName]}, ${server.bootstrapHeaders[headerName]}` }];
  for (const headers of rejectedHeaders) {
    const result = await server.me(headers);
    assert.equal(result.status, 401); assert.equal(result.cacheControl, "no-store");
    assert.equal(result.body.token, undefined);
  }
  const authorized = await server.me(server.bootstrapHeaders);
  assert.equal(authorized.status, 200); assert.equal(authorized.body.isAdmin, true); assert.equal(authorized.body.desktop, true);
  assert.equal(typeof authorized.body.token, "string");
});

test("Tauri bootstrap rejects absent, empty, or short server authority even when the header matches", async (t) => {
  const server = await serve(t);
  for (const value of [undefined, "", "short", "a".repeat(31)]) {
    if (value === undefined) delete process.env.CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN;
    else process.env.CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN = value;
    initializeDesktopBootstrapCredential();
    assert.ok(process.env.CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN === undefined, "Invalid bootstrap authority must also leave the process environment");
    const result = await server.me({ [headerName]: value ?? "" });
    assert.equal(result.status, 401); assert.equal(result.body.token, undefined);
  }
});

test("Tauri bootstrap keeps actual loopback and same-origin checks even with the correct private header", async (t) => {
  const server = await serve(t);
  const sameOrigin = await server.me({ ...server.bootstrapHeaders, Origin: server.origin });
  assert.equal(sameOrigin.status, 200);
  for (const origin of ["https://outside.example", "null", "", "http://127.0.0.1:1", `${server.origin.replace("127.0.0.1", "localhost")}`, server.origin.replace("http://", "http://user:password@")]) {
    assert.equal((await server.me({ ...server.bootstrapHeaders, Origin: origin })).status, 401);
  }
  assert.equal((await server.me({ ...server.bootstrapHeaders, Host: "outside.example" })).status, 401);
  assert.equal((await server.me({ ...server.bootstrapHeaders, Host: "127.0.0.1:1", Origin: "http://127.0.0.1:1" })).status, 401);
});

test("Tauri private bootstrap header never authorizes a non-loopback socket", async (t) => {
  const server = await serve(t, "192.0.2.10");
  assert.equal((await server.me({ ...server.bootstrapHeaders, Origin: server.origin })).status, 401);
});

test("Tauri valid Bearer sessions remain usable without bootstrap authority and invalid Bearers never bootstrap", async (t) => {
  const server = await serve(t);
  const authorized = await server.me(server.bootstrapHeaders);
  assert.equal(authorized.status, 200); assert.equal(typeof authorized.body.token, "string");
  delete process.env.CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN;
  initializeDesktopBootstrapCredential();
  assert.equal((await server.me(server.bootstrapHeaders)).status, 401, "Reinitializing without authority must not reuse the previously captured credential");
  const bearer = await server.me({ Authorization: `Bearer ${authorized.body.token as string}` });
  assert.equal(bearer.status, 200); assert.equal(bearer.body.isAdmin, true);
  process.env.CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN = server.bootstrapHeaders[headerName];
  initializeDesktopBootstrapCredential();
  assert.equal((await server.me({ ...server.bootstrapHeaders, Authorization: "Bearer nonexistent" })).status, 401);
  assert.equal((await server.me({ ...server.bootstrapHeaders, Authorization: "Basic invalid" })).status, 401);
});

test("Electron bootstrap and Web Bearer authentication keep their existing profile behavior", async (t) => {
  const server = await serve(t);
  const legacyEnvironmentValue = "legacy-fixture-environment-is-preserved";
  process.env.CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN = legacyEnvironmentValue;
  for (const runtime of [undefined, "electron"]) {
    if (runtime === undefined) delete process.env.CROWNFORGE_DESKTOP_RUNTIME;
    else process.env.CROWNFORGE_DESKTOP_RUNTIME = runtime;
    initializeDesktopBootstrapCredential();
    assert.ok(process.env.CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN === legacyEnvironmentValue, "Electron environment behavior must remain unchanged");
    assert.equal((await server.me()).status, 200);
  }
  process.env.CROWNFORGE_DESKTOP_RUNTIME = "tauri"; delete process.env.CREWFORGE_DESKTOP;
  initializeDesktopBootstrapCredential();
  assert.ok(process.env.CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN === legacyEnvironmentValue, "Web environment behavior must remain unchanged");
  assert.equal((await server.me(server.bootstrapHeaders)).status, 401);
  const login = await fetch(`${server.origin}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "fixture-password" }) });
  assert.equal(login.status, 200);
  const session = await login.json() as { token: string };
  const me = await server.me({ Authorization: `Bearer ${session.token}` });
  assert.equal(me.status, 200); assert.equal(me.body.desktop, false);
});
