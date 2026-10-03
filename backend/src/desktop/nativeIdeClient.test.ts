import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { desktopNativeIdeEnabled, NativeIdeClient, NativeIdeError } from "./nativeIdeClient.js";

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
  t.after(() => { client.close(); fs.rmSync(directory, { recursive: true, force: true }); });
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
