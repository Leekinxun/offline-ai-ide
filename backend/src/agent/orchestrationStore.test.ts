import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rollbackLastMigration } from "../persistence/migrations.js";
import { OrchestrationStore } from "./orchestrationStore.js";

function child(script: string): { done: Promise<{ code: number | null; output: string }>; kill: () => void } {
  const processHandle = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  processHandle.stdout.on("data", (chunk) => { output += String(chunk); });
  processHandle.stderr.on("data", (chunk) => { output += String(chunk); });
  return { done: new Promise((resolve) => processHandle.on("close", (code) => resolve({ code, output }))), kill: () => processHandle.kill("SIGKILL") };
}

function fixture(t: test.TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-orchestration-migration-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory;
}

test("orchestration stores accept only canonical inventory format ids", (t) => {
  const directory = fixture(t);
  for (const id of ["tasks", "messages", "team-config", "model-budgets", "git-delivery", "provider-delivery"]) {
    assert.doesNotThrow(() => new OrchestrationStore(directory, id, () => ({})));
  }
  assert.throws(() => new OrchestrationStore(directory, "orchestration:tasks", () => ({})), /canonical/);
});

test("auto-read tasks migration journals canonical id and selected rollback restores exact bytes", (t) => {
  const directory = fixture(t); const file = path.join(directory, ".team", "state", "tasks.json"); fs.mkdirSync(path.dirname(file), { recursive: true });
  const legacyBytes = '{"version":7,"nextId":2,"tasks":{"1":{"id":1}}}\n'; fs.writeFileSync(file, legacyBytes);
  const store = new OrchestrationStore(directory, "tasks", () => ({ schemaVersion: 1, version: 1, nextId: 1, tasks: {} as Record<string, unknown> }));
  assert.equal(store.snapshot().schemaVersion, 1);
  const rollback = rollbackLastMigration(directory, "tasks"); assert.equal(rollback.formatId, "tasks"); assert.equal(fs.readFileSync(file, "utf8"), legacyBytes);
});

test("store writer and global-to-target rollback fail deterministically without deadlock", async (t) => {
  const directory = fixture(t); const file = path.join(directory, ".team", "state", "tasks.json"); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"version":1,"nextId":1,"tasks":{}}\n');
  const initial = new OrchestrationStore(directory, "tasks", () => ({ schemaVersion: 1, version: 1, nextId: 1, tasks: {} as Record<string, unknown> }));
  initial.snapshot();
  const marker = path.join(directory, "writer-held");
  const writer = child(`import fs from "node:fs"; import { OrchestrationStore } from "./src/agent/orchestrationStore.ts"; const workspace=${JSON.stringify(directory)}; const marker=${JSON.stringify(marker)}; const store=new OrchestrationStore(workspace,"tasks",()=>({schemaVersion:1,version:1,nextId:1,tasks:{}})); store.transact((state)=>{fs.writeFileSync(marker,"held"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,600); state.version += 1;}); process.stdout.write("writer-complete");`);
  t.after(() => writer.kill());
  const markerDeadline = Date.now() + 2_000;
  while (!fs.existsSync(marker) && Date.now() < markerDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(marker), true, "writer did not acquire the target lock");
  const started = Date.now();
  const rollback = child(`import { rollbackLastMigration } from "./src/persistence/migrations.ts"; try { rollbackLastMigration(${JSON.stringify(directory)},"tasks"); process.stdout.write("unexpected-success"); } catch (error) { process.stdout.write(error.message); }`);
  t.after(() => rollback.kill());
  const timeout = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("rollback/store lock-order test deadlocked")), 3_000));
  const rollbackResult = await Promise.race([rollback.done, timeout]);
  const writerResult = await Promise.race([writer.done, timeout]);
  assert.equal(rollbackResult.code, 0, rollbackResult.output);
  assert.match(rollbackResult.output, /active writer lock/i);
  assert.equal(writerResult.code, 0, writerResult.output);
  assert.match(writerResult.output, /writer-complete/);
  assert.ok(Date.now() - started < 3_000);
});
