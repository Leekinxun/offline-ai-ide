import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverRunTasks, executeRunTask, startRunTask, stopRunTask, waitForRun } from "./service.js";

async function waitForOutput(record: { stdout: string }, expected: RegExp, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (expected.test(record.stdout)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for run output matching ${expected}`);
}

test("run center discovers allowlisted package scripts and records failures", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-run-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({
    scripts: {
      check: "node -e \"console.log('ok')\"",
      test: "node -e \"console.error('src/example.ts:4:2: expected failure'); process.exit(1)\"",
    },
  }));

  const tasks = discoverRunTasks(workspace);
  assert.deepEqual(tasks.map((task) => task.id), ["npm:check", "npm:test"]);
  assert.equal((await executeRunTask(workspace, "npm:check")).status, "passed");

  const failed = await executeRunTask(workspace, "npm:test");
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.failures[0], {
    path: "src/example.ts",
    line: 4,
    column: 2,
    message: "expected failure",
  });
  await assert.rejects(() => executeRunTask(workspace, "npm:missing"), /Unknown or unavailable task/);
});

test("running tasks can be cancelled and retain partial output", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-run-cancel-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({
    scripts: { watch: "node -e \"console.log('started'); setInterval(() => {}, 1000)\"" },
  }));
  const record = startRunTask(workspace, "npm:watch");
  assert.equal(record.status, "running");
  await waitForOutput(record, /started/);
  stopRunTask(workspace, record.id);
  const finished = await waitForRun(workspace, record.id);
  assert.equal(finished.status, "cancelled");
  assert.match(finished.stdout, /started/);
});
