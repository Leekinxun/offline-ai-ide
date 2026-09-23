import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import test from "node:test";

function fixture(t: test.TestContext): { directory: string; env: NodeJS.ProcessEnv } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-desktop-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const staticDir = path.join(directory, "static");
  fs.mkdirSync(staticDir);
  fs.writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>CrewForge</title>");
  fs.writeFileSync(path.join(directory, "users.json"), JSON.stringify({ allowedRoots: [directory], users: [{ username: "test", password: "test", defaultWorkspace: directory }] }));
  return {
    directory,
    env: {
      ...process.env,
      APP_SETTINGS_CONFIG: path.join(directory, "app-settings.json"),
      USERS_CONFIG: path.join(directory, "users.json"),
      WORKSPACE_DIR: path.join(directory, "workspace"),
      PLUGINS_DIR: path.join(directory, "plugins"),
      STATIC_DIR: staticDir,
    },
  };
}

test("desktop config accepts port zero and keeps ordinary binding defaults", (t) => {
  const { env } = fixture(t);
  const readConfig = (overrides: NodeJS.ProcessEnv) => {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "const { config } = await import('./src/config.ts'); console.log(JSON.stringify({ port: config.port, host: config.host }))"], {
      cwd: process.cwd(), env: { ...env, ...overrides }, encoding: "utf8",
    });
    assert.equal(child.status, 0, `config child exited ${child.status}`);
    return JSON.parse(child.stdout.trim()) as { port: number; host: string };
  };
  assert.deepEqual(readConfig({ CREWFORGE_DESKTOP: "1", PORT: "0" }), { port: 0, host: "127.0.0.1" });
  assert.deepEqual(readConfig({ CREWFORGE_DESKTOP: "0", PORT: "0" }), { port: 3000, host: "0.0.0.0" });
  assert.deepEqual(readConfig({ CREWFORGE_DESKTOP: "0", PORT: "4567" }), { port: 4567, host: "0.0.0.0" });
});

test("desktop backend reports its actual loopback port and honors shutdown IPC", async (t) => {
  const { env } = fixture(t);
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: process.cwd(), env: { ...env, CREWFORGE_DESKTOP: "1", PORT: "0" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  t.after(() => child.kill());

  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("backend did not report readiness")); }, 20_000);
    child.on("message", (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const message = value as { type?: unknown; url?: unknown; code?: unknown };
      if (message.type === "error") {
        clearTimeout(timeout);
        reject(new Error(`backend startup failed: ${String(message.code)}`));
      } else if (message.type === "ready") {
        clearTimeout(timeout);
        if (typeof message.url === "string") resolve(message.url);
        else reject(new Error("backend readiness message has no URL"));
      }
    });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`backend exited before ready: ${code}`)); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
  });

  const parsed = new URL(url);
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.ok(Number(parsed.port) > 0);
  const health = await fetch(`${url}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  const crossOrigin = await fetch(`${url}/api/health`, { headers: { Origin: "https://example.invalid" } });
  assert.equal(crossOrigin.headers.get("access-control-allow-origin"), null);

  const closed = new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("backend did not stop after shutdown")); }, 5_000);
    child.once("exit", (code) => { clearTimeout(timeout); resolve(code); });
  });
  child.send({ type: "shutdown" });
  assert.equal(await closed, 0);
});

test("desktop backend reports listen failures without exposing error details", async (t) => {
  const { env } = fixture(t);
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  t.after(() => occupied.close());
  const address = occupied.address();
  assert.ok(address && typeof address !== "string");

  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: process.cwd(), env: { ...env, CREWFORGE_DESKTOP: "1", PORT: String(address.port) },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  t.after(() => child.kill());
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const reported = await new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("backend did not report the listen failure")); }, 20_000);
    child.on("message", (message) => { clearTimeout(timeout); resolve(message); });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`backend exited without an error message: ${code}`)); });
  });
  assert.deepEqual(reported, { type: "error", phase: "listen", code: "EADDRINUSE" });
  assert.equal(await exited, 1);
});
