import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("backend shutdown waits for its native owner's EOF cleanup before exiting", { timeout: 20_000 }, async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-daemon-native-stop-")));
  const workspace = path.join(root, "workspace"), staticDir = path.join(root, "static");
  fs.mkdirSync(workspace); fs.mkdirSync(staticDir);
  fs.writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>Fixture</title>");
  fs.writeFileSync(path.join(root, "users.json"), JSON.stringify({ allowedRoots: [root], users: [{ username: "admin", password: "fixture", defaultWorkspace: workspace, isAdmin: true }] }));
  fs.writeFileSync(path.join(root, "app-settings.json"), "{}\n");
  const marker = path.join(root, "owner-cleanup-complete");
  const fakeCore = path.join(root, "fixture-core.cjs"), preloader = path.join(root, "preloader.mjs");
  fs.writeFileSync(fakeCore, `
    const fs=require('node:fs'),readline=require('node:readline');
    process.chdir(__dirname);
    readline.createInterface({input:process.stdin}).on('line',line=>{
      const r=JSON.parse(line); process.stdout.write(JSON.stringify({id:r.id,result:r.method==='ping'?{protocolVersion:1}:[]})+'\\n');
    }).on('close',()=>setTimeout(()=>{
      process.stdout.write(Buffer.alloc(1024*1024,'x'),()=>process.stderr.write(Buffer.alloc(1024*1024,'y'),()=>{
        fs.writeFileSync(${JSON.stringify(marker)},'cleaned');process.exit(0);
      }));
    },200));
  `);
  // Isolated child-only seam: retain the production NativeIdeClient and index
  // lifecycle, substituting only the executable launch for a real Node fixture.
  fs.writeFileSync(preloader, `
    import childProcess from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
    const original=childProcess.spawn;
    childProcess.spawn=(file,args,options)=>file===process.env.CROWNFORGE_IDE_CORE_EXECUTABLE
      ? original(process.execPath,[file],options) : original(file,args,options);
    syncBuiltinESMExports();
  `);
  const bootstrap = crypto.randomBytes(32).toString("hex");
  const backend = spawn(process.execPath, ["--import", preloader, "--import", "tsx", "src/index.ts"], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: { ...process.env, CREWFORGE_DESKTOP: "1", CROWNFORGE_DESKTOP_RUNTIME: "tauri", CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN: bootstrap,
      CROWNFORGE_IDE_CORE_EXECUTABLE: fakeCore, HOST: "127.0.0.1", PORT: "0", WORKSPACE_DIR: workspace,
      USERS_CONFIG: path.join(root, "users.json"), APP_SETTINGS_CONFIG: path.join(root, "app-settings.json"),
      TEAM_STORE_ROOT: root, PLUGINS_DIR: path.join(root, "plugins"), STATIC_DIR: staticDir },
    stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
  });
  assert.ok(backend.stdout && backend.stderr);
  backend.stdout.resume(); backend.stderr.resume();
  const exited = new Promise<number | null>((resolve) => backend.once("close", resolve));
  t.after(async () => { if (backend.exitCode === null) backend.kill(); await exited; fs.rmSync(root, { recursive: true, force: true }); });
  const origin = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Backend fixture startup timed out")), 10_000);
    backend.on("message", (value: unknown) => {
      const message = value as { type?: string; url?: string };
      if (message.type === "ready" && message.url) { clearTimeout(timer); resolve(message.url); }
    });
    backend.once("error", error => { clearTimeout(timer); reject(error); });
    backend.once("close", () => { clearTimeout(timer); reject(new Error("Backend fixture stopped before ready")); });
  });
  const me = await fetch(`${origin}/api/auth/me`, { headers: { "X-CrownForge-Desktop-Bootstrap": bootstrap } });
  assert.equal(me.status, 200);
  const { token } = await me.json() as { token: string };
  assert.ok(token);
  const tree = await fetch(`${origin}/api/files/tree`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(tree.status, 200);
  assert.deepEqual(await tree.json(), []);
  backend.send({ type: "shutdown" });
  assert.equal(await exited, 0);
  assert.equal(fs.readFileSync(marker, "utf8"), "cleaned", "Backend exit must follow the owned child's final cleanup");
});
