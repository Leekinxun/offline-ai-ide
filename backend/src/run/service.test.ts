import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverRunTasks, executeRunTask, resolveRunTaskExecution, startRunTask, stopRunTask, waitForRun, type RunTask } from "./service.js";

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

test("run center discovers unittest for plain Python source trees", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-run-python-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "solution.py"), "def add(a, b): return a + b\n");
  const tasks = discoverRunTasks(workspace);
  assert.ok(tasks.some((task) => task.id === "python:unittest" && task.command.includes("python") && task.args.join(" ") === "-B -m unittest discover"));
});

test("Windows npm tasks launch npm-cli through node without cmd shell interpolation", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-win-npm-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "node_modules", "npm", "bin"), { recursive: true });
  const node = path.join(root, "node.exe");
  const npm = path.join(root, "npm.cmd");
  const cli = path.join(root, "node_modules", "npm", "bin", "npm-cli.js");
  fs.writeFileSync(node, "");
  fs.writeFileSync(npm, "");
  fs.writeFileSync(cli, "");
  const task: RunTask = { id: "npm:build&erase", label: "npm: build&erase", kind: "build", source: "package.json", command: "npm.cmd", args: ["run", "build&erase"] };

  assert.deepEqual(resolveRunTaskExecution(task, { platform: "win32", env: { PATH: root } }), {
    executable: node,
    args: [cli, "run", "build&erase"],
  });
});

test("run center executes non-package Python tests without a project manifest", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-run-unittest-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "tests"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "app.py"), "def value():\n    return 1\n");
  fs.writeFileSync(path.join(workspace, "tests", "test_app.py"), "import unittest\nfrom app import value\nclass ValueTest(unittest.TestCase):\n    def test_value(self):\n        self.assertEqual(value(), 1)\n");

  assert.deepEqual(discoverRunTasks(workspace).map((task) => [task.id, task.command, task.args]), [
    ["python:unittest", process.platform === "win32" ? "python" : "python3", ["-B", "-m", "unittest", "discover", "-s", "tests"]],
  ]);
  const result = await executeRunTask(workspace, "python:unittest");
  assert.equal(result.status, "passed");
  assert.match(`${result.stdout}\n${result.stderr}`, /Ran 1 test/);
});

test("run center prefers pytest when Python project config is present", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-run-pytest-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "pytest.ini"), "[pytest]\n");
  fs.writeFileSync(path.join(workspace, "test_app.py"), "def test_ok():\n    assert True\n");

  assert.deepEqual(discoverRunTasks(workspace).filter((task) => task.kind === "test").map((task) => task.id), ["python:pytest", "python:unittest"]);
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
