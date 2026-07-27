import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DocumentFormatError,
  formatPythonDocument,
  getDiagnostics,
  startDiagnosticsSession,
  stopDiagnosticsSession,
} from "./service.js";

test("diagnostics sessions expose a persistent lifecycle", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-diagnostics-"));
  t.after(() => {
    stopDiagnosticsSession(workspace);
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  const started = await startDiagnosticsSession(workspace);
  assert.equal(started.session.status, "watching");
  assert.equal(started.session.generation, 1);
  assert.equal(getDiagnostics(workspace).session.status, "watching");
  assert.equal(stopDiagnosticsSession(workspace).session.status, "stopped");
});

test("formats unsaved Python content through Ruff stdin", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-format-"));
  const fakeRuff = path.join(workspace, "fake-ruff");
  fs.writeFileSync(fakeRuff, `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  if (args[0] !== "format" || args[1] !== "--stdin-filename" || args[3] !== "-" || !args[2].endsWith("sample.py")) process.exit(2);
  if (input !== "value=[1,2]\\n") process.exit(3);
  process.stdout.write("value = [1, 2]\\n");
});
`, { mode: 0o755 });
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  const result = await formatPythonDocument(workspace, "sample.py", "value=[1,2]\n", fakeRuff);
  assert.deepEqual(result, { content: "value = [1, 2]\n", changed: true, tool: "ruff" });
});

test("rejects formatter paths outside the active workspace", async () => {
  await assert.rejects(
    () => formatPythonDocument(process.cwd(), "../outside.py", "value=1\n"),
    (error) => error instanceof DocumentFormatError && error.code === "INVALID_PATH"
  );
});

test("reports a missing Ruff executable", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-format-missing-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  await assert.rejects(
    () => formatPythonDocument(workspace, "sample.py", "value=1\n", path.join(workspace, "missing-ruff")),
    (error) => error instanceof DocumentFormatError && error.code === "RUFF_MISSING"
  );
});
