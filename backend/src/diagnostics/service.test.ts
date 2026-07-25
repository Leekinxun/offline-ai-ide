import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getDiagnostics, startDiagnosticsSession, stopDiagnosticsSession } from "./service.js";

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
