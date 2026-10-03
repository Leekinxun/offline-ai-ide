"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

function fixture(t, source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-ipc-"));
  const bootstrap = path.join(directory, "backend.cjs");
  fs.writeFileSync(bootstrap, source);
  const child = spawn(process.execPath, [path.join(__dirname, "bootstrap.cjs")], {
    env: { ...process.env, CROWNFORGE_BACKEND_BOOTSTRAP: bootstrap }, stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { child.kill(); fs.rmSync(directory, { recursive: true, force: true }); });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return { child, output: () => ({ stdout, stderr }) };
}

test("NDJSON transport preserves ready, folder-picker and shutdown while routing logs to stderr", { timeout: 5000 }, async (t) => {
  const { child, output } = fixture(t, `
    console.log("console log"); process.stdout.write("raw log\\n");
    process.send({type:"ready", url:"http://127.0.0.1:12345"});
    process.send({type:"desktop-pick-folder", requestId:"test", defaultPath:"/tmp"});
    process.on("message", (message) => {
      if (message.type === "desktop-pick-folder-result") process.send(message);
      if (message.type === "shutdown") process.send({type:"stopped"}, () => process.exit(0));
    });
  `);
  const exited = once(child, "exit");
  child.stdin.write(`${JSON.stringify({ type: "desktop-pick-folder-result", requestId: "test", path: "/tmp/selected" })}\n`);
  child.stdin.write("malformed frame\n");
  child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
  const [code] = await exited;
  assert.equal(code, 0);
  const { stdout, stderr } = output();
  assert.match(stderr, /console log/);
  assert.match(stderr, /raw log/);
  const messages = stdout.trim().split("\n").map(JSON.parse);
  assert.deepEqual(messages.map((message) => message.type), ["ready", "desktop-pick-folder", "desktop-pick-folder-result", "stopped"]);
  assert.equal(messages[2].path, "/tmp/selected");
});

test("host pipe closure shuts down its retained daemon", { timeout: 5000 }, async (t) => {
  const { child } = fixture(t, `process.on("message", (message) => { if (message.type === "shutdown") process.exit(0); });`);
  const exited = once(child, "exit");
  child.stdin.end();
  assert.equal((await exited)[0], 0);
});

test("relative backend paths are rejected before loading code", { timeout: 5000 }, async (t) => {
  const child = spawn(process.execPath, [path.join(__dirname, "bootstrap.cjs")], {
    env: { ...process.env, CROWNFORGE_BACKEND_BOOTSTRAP: "backend.cjs" }, stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(stdout), { type: "error", phase: "bootstrap", code: "INVALID_BACKEND_PATH" });
});
