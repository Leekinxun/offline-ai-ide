import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { desktopNativeIdeEnabled, NativeIdeClient, NativeIdeError, ownedNativeProcessTreeKillInvocation } from "./nativeIdeClient.js";

function fixture(t: test.TestContext): NativeIdeClient {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-native-protocol-"));
  const file = path.join(directory, "service.cjs");
  fs.writeFileSync(file, `
const readline = require('node:readline');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({input:process.stdin}).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'ping') send({id:request.id,result:{protocolVersion:1}});
  else if (request.method === 'die') process.exit(4);
  else if (request.method === 'malformed') process.stdout.write('not json\\n');
  else if (request.method === 'delay') setTimeout(() => send({id:request.id,result:true}), 200);
  else if (request.method === 'unicode') {
    const bytes = Buffer.from(JSON.stringify({id:request.id,result:'中文😀'})+'\\n');
    const split = bytes.indexOf(Buffer.from('中'))+1;
    process.stdout.write(bytes.subarray(0,split));
    setTimeout(() => process.stdout.write(bytes.subarray(split)), 5);
  } else if (request.method === 'bootstrapEnvironment') send({id:request.id,result:process.env.CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN || null});
  else send({id:request.id,result:request.params});
}).on('close', () => process.exit(0));
`);
  const client = new NativeIdeClient(process.execPath, { args: [file] });
  t.after(async () => { await client.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return client;
}

test("native IDE cannot activate in Web mode even when a runtime path is present", () => {
  assert.equal(desktopNativeIdeEnabled({ CREWFORGE_DESKTOP: "0", CROWNFORGE_IDE_CORE_EXECUTABLE: "/runtime" }), false);
  assert.equal(desktopNativeIdeEnabled({ CROWNFORGE_IDE_CORE_EXECUTABLE: "/runtime" }), false);
  assert.equal(desktopNativeIdeEnabled({ CREWFORGE_DESKTOP: "1" }), false);
  assert.equal(desktopNativeIdeEnabled({ CREWFORGE_DESKTOP: "1", CROWNFORGE_IDE_CORE_EXECUTABLE: "/runtime" }), true);
});

test("private RPC preserves split UTF-8 messages and concurrent request identity", async (t) => {
  const client = fixture(t);
  assert.equal(await client.request("unicode", {}), "中文😀");
  const values = await Promise.all([client.request("echo", { number: 42 }), client.request("echo", { number: 43 })]);
  assert.deepEqual(values, [{ number: 42 }, { number: 43 }]);
});

test("the native service does not inherit the host's desktop bootstrap credential", async (t) => {
  const previous = process.env.CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN;
  process.env.CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN = "private-fixture-bootstrap-key-never-inherited";
  try { assert.equal(await fixture(t).request("bootstrapEnvironment", {}), null); }
  finally {
    if (previous === undefined) delete process.env.CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN;
    else process.env.CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN = previous;
  }
});

test("cancelling a request does not invalidate subsequent requests", async (t) => {
  const client = fixture(t);
  const controller = new AbortController();
  const pending = client.request("delay", {}, { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, (error: unknown) => error instanceof NativeIdeError && error.code === "ABORTED");
  assert.deepEqual(await client.request("echo", { after: "cancel" }), { after: "cancel" });
});

test("runtime crash rejects active operations instead of silently using Node", async (t) => {
  const client = fixture(t);
  await assert.rejects(client.request("die", {}), (error: unknown) => error instanceof NativeIdeError && error.code === "RUNTIME_DISCONNECTED");
  await assert.rejects(client.request("echo", {}), /disconnected/);
});

test("malformed native protocol closes the service", async (t) => {
  const client = fixture(t);
  await assert.rejects(client.request("malformed", {}), (error: unknown) => error instanceof NativeIdeError && error.code === "PROTOCOL_ERROR");
});

test("close is idempotent and waits for EOF cleanup while draining both output pipes", { timeout: 5_000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-native-close-"));
  const file = path.join(directory, "service.cjs"), marker = path.join(directory, "cleaned");
  fs.writeFileSync(file, `
    const fs = require('node:fs'), readline = require('node:readline');
    process.chdir(__dirname);
    readline.createInterface({input:process.stdin}).on('line', line => {
      const request=JSON.parse(line); process.stdout.write(JSON.stringify({id:request.id,result:{protocolVersion:1}})+'\\n');
    }).on('close', () => setTimeout(() => {
      process.stdout.write(Buffer.alloc(2*1024*1024, 'x'), () => process.stderr.write(Buffer.alloc(2*1024*1024, 'y'), () => {
        fs.writeFileSync(${JSON.stringify(marker)}, 'cleanup complete'); process.exit(0);
      }));
    }, 100));
  `);
  const client = new NativeIdeClient(process.execPath, { args: [file], shutdown: { graceMs: 2_000, deadlineMs: 4_000 } });
  t.after(async () => { await client.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await client.request("ping", {});
  let closed = false;
  const first = client.close();
  assert.equal(client.close(), first, "Repeated close must reuse the same promise and never immediately kill the owner");
  void first.then(() => { closed = true; });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(closed, false);
  await first;
  assert.equal(fs.readFileSync(marker, "utf8"), "cleanup complete");
  assert.equal(client.close(), first);
});

test("Windows timeout invokes the trusted tree tool with only the owned child PID", { timeout: 5_000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-native-tree-close-"));
  const file = path.join(directory, "service.cjs");
  fs.writeFileSync(file, `
    const readline=require('node:readline');
    setInterval(()=>{},1000);
    readline.createInterface({input:process.stdin}).on('line', line=>{
      const request=JSON.parse(line); process.stdout.write(JSON.stringify({id:request.id,result:request.method==='ping'?{protocolVersion:1}:process.pid})+'\\n');
    });
  `);
  const invocations: Array<{ executable: string; args: string[] }> = [];
  let ownedPid = 0;
  const client = new NativeIdeClient(process.execPath, { args: [file], shutdown: {
    graceMs: 40, deadlineMs: 2_000, platform: "win32", systemRoot: "C:\\Windows",
    runTaskkill: async (invocation) => {
      invocations.push(invocation);
      assert.equal(Number(invocation.args[1]), ownedPid);
      process.kill(ownedPid, "SIGKILL");
    },
  } });
  t.after(async () => { await client.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  ownedPid = await client.request<number>("pid", {});
  await client.close();
  assert.deepEqual(invocations, [{ executable: "C:\\Windows\\System32\\taskkill.exe", args: ["/PID", String(ownedPid), "/T", "/F"] }]);
  for (const pid of [0, -1, NaN, process.pid]) assert.throws(() => ownedNativeProcessTreeKillInvocation(pid));
  for (const root of [".", "\\\\server\\share", "C:\\Windows\\..\\project", "C:\\Windows:stream"]) assert.throws(() => ownedNativeProcessTreeKillInvocation(ownedPid, root));
});

test("failed Windows tree cleanup rejects close even after its owned core is killed", { timeout: 5_000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-native-tree-failure-"));
  const file = path.join(directory, "service.cjs");
  fs.writeFileSync(file, `
    const readline=require('node:readline');setInterval(()=>{},1000);
    readline.createInterface({input:process.stdin}).on('line',line=>{
      const r=JSON.parse(line);process.stdout.write(JSON.stringify({id:r.id,result:r.method==='ping'?{protocolVersion:1}:process.pid})+'\\n');
    });
  `);
  let ownedPid = 0, attempts = 0;
  const client = new NativeIdeClient(process.execPath, { args: [file], shutdown: {
    graceMs: 40, deadlineMs: 2_000, platform: "win32", systemRoot: "C:\\Windows",
    runTaskkill: async (invocation) => {
      attempts++;
      assert.deepEqual(invocation.args, ["/PID", String(ownedPid), "/T", "/F"]);
      assert.equal(invocation.executable, "C:\\Windows\\System32\\taskkill.exe");
      throw new Error("fixture taskkill failure");
    },
  } });
  t.after(async () => { await client.close().catch(() => {}); fs.rmSync(directory, { recursive: true, force: true }); });
  ownedPid = await client.request<number>("pid", {});
  const closed = client.close();
  assert.equal(client.close(), closed);
  await assert.rejects(closed, (error: unknown) => error instanceof NativeIdeError && error.code === "SHUTDOWN_FAILED");
  assert.equal(attempts, 1);
  assert.throws(() => process.kill(ownedPid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH", "Fallback must kill only the still-owned core, without claiming tree cleanup succeeded");
});

test("startup protocol failure closes its child without an unhandled cleanup rejection", { timeout: 5_000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-native-start-failure-"));
  const file = path.join(directory, "service.cjs"), marker = path.join(directory, "closed");
  fs.writeFileSync(file, `
    const fs=require('node:fs'),readline=require('node:readline');
    readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);process.stdout.write(JSON.stringify({id:r.id,result:{protocolVersion:99}})+'\\n')})
      .on('close',()=>setTimeout(()=>{fs.writeFileSync(${JSON.stringify(marker)},'closed');process.exit(0)},30));
  `);
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", listener);
  const client = new NativeIdeClient(process.execPath, { args: [file], shutdown: { graceMs: 500, deadlineMs: 2_000 } });
  t.after(async () => { process.off("unhandledRejection", listener); await client.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await assert.rejects(client.request("echo", {}), (error: unknown) => error instanceof NativeIdeError && error.code === "PROTOCOL_MISMATCH");
  await client.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
  assert.equal(fs.readFileSync(marker, "utf8"), "closed");
});
