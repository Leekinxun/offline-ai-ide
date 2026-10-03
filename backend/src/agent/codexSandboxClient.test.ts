import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { CodexSandboxClient } from "./codexSandboxClient.js";

function fixture(handler: (message: Record<string, unknown>, reply: (value: unknown) => void) => void) {
  const child = new EventEmitter() as childProcess.ChildProcess;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let killed = false; let input = "";
  child.kill = () => { killed = true; return true; };
  const reply = (value: unknown) => child.stdout!.emit("data", Buffer.from(`${JSON.stringify(value)}\n`));
  child.stdin.on("data", (chunk: Buffer) => {
    input += chunk.toString("utf8"); let at: number;
    while ((at = input.indexOf("\n")) !== -1) { const line = input.slice(0, at); input = input.slice(at + 1); handler(JSON.parse(line), reply); }
  });
  const calls: Array<{ executable: string; args: readonly string[]; options: childProcess.SpawnOptions }> = [];
  const client = new CodexSandboxClient({ executable: "/trusted/bin/codex.exe", args: ["app-server", "--stdio"], cwd: "/private-home", env: { CODEX_HOME: "/private-home" },
    spawn: ((executable: string, args: readonly string[], options: childProcess.SpawnOptions) => { calls.push({ executable, args, options }); return child; }) as typeof childProcess.spawn });
  return { client, child, calls, reply, killed: () => killed };
}
const initialize = (message: Record<string, unknown>, reply: (value: unknown) => void) => {
  if (message.method === "initialize") { reply({ id: message.id, result: { userAgent: "crownforge/0.160.0 (Windows; x64)" } }); return true; } return false;
};
test("RPC initializes once and performs only execution setup/readiness without a model turn", async (t) => {
  const methods: string[] = [];
  const f = fixture((message, reply) => { methods.push(String(message.method)); if (initialize(message, reply)) return; if (message.id) reply({ id: message.id, result: { status: "ready" } }); }); t.after(() => f.client.close());
  await f.client.initialize(); await f.client.initialize(); assert.deepEqual(await f.client.call("windowsSandbox/readiness"), { status: "ready" });
  assert.deepEqual(methods, ["initialize", "initialized", "windowsSandbox/readiness"]);
  assert.equal(f.calls[0].options.shell, false); assert.equal(f.calls[0].options.windowsHide, true);
});
test("setup notification can arrive before its RPC acknowledgment", async (t) => {
  const f = fixture((message, reply) => { if (initialize(message, reply)) return; if (message.method === "windowsSandbox/setupStart") { reply({ method: "windowsSandbox/setupCompleted", params: { mode: "elevated", success: true } }); reply({ id: message.id, result: { started: true } }); } }); t.after(() => f.client.close());
  await f.client.initialize(); const finished = f.client.waitForNotification("windowsSandbox/setupCompleted", 1000);
  await f.client.call("windowsSandbox/setupStart", { mode: "elevated" }); assert.deepEqual(await finished, { mode: "elevated", success: true });
});
test("unknown requests, malformed data and runtime version mismatch fail closed", async () => {
  for (const invalid of [{ id: 200, method: "unsafe/request", params: {} }, { id: 900, result: {} }, ["bad protocol"]]) {
    const f = fixture((message, reply) => { if (message.method === "initialize") reply(invalid); });
    await assert.rejects(f.client.initialize(), /runtime (request|response|protocol)|Unexpected|Unknown|Invalid/); assert.equal(f.killed(), true);
  }
  const f = fixture((message, reply) => { if (message.method === "initialize") reply({ id: message.id, result: { userAgent: "crownforge/0.154.0 (Windows; x64)" } }); });
  await assert.rejects(f.client.initialize(), /initialization response/); assert.equal(f.killed(), true);
});
test("request timeout and process disconnect reject pending calls", async (t) => {
  const f = fixture((message, reply) => { initialize(message, reply); }); t.after(() => f.client.close()); await f.client.initialize();
  await assert.rejects(f.client.call("windowsSandbox/readiness", {}, 10), /timed out/);
  const pending = f.client.call("windowsSandbox/readiness", {}, 1000); f.child.emit("close", 1);
  await assert.rejects(pending, /disconnected/);
});
