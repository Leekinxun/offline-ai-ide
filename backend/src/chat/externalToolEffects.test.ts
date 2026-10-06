import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { beginExternalToolEffects, ExternalToolEffectsEvidenceError, listExternalToolEffects } from "./externalToolEffects.js";

function fixture(t: test.TestContext): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-external-effects-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  return workspace;
}

function receiptPath(workspace: string, runId: string, toolCallId: string, requestId?: string): string {
  const key = crypto.createHash("sha256").update(`${runId}\0${requestId ?? ""}\0${toolCallId}`).digest("hex");
  return path.join(workspace, ".history", "external-tools", `${key}.json`);
}

test("external tool audit writes durable unfinished intent before finish", async (t) => {
  const workspace = fixture(t);
  const audit = await beginExternalToolEffects(workspace, { runId: "run", requestId: "turn", toolCallId: "shell-1", toolName: "bash" });
  const initial = listExternalToolEffects(workspace, { runId: "run", requestId: "turn", expectedExecutions: [{ toolCallId: "shell-1", requestId: "turn" }] });
  assert.equal(initial.length, 1);
  assert.equal(initial[0].finishedAt, undefined);
  assert.equal(initial[0].rollbackCoverage, "untracked");
  assert.deepEqual(initial[0].observedPaths, []);
  assert.equal(initial[0].observationComplete, false);

  const finished = await audit.finish();
  assert.equal(finished.finishedAt !== undefined, true);
  assert.equal(listExternalToolEffects(workspace, { runId: "run" })[0].finishedAt, finished.finishedAt);
});

test("external tool audit keeps unfinished intent when finish metadata update fails", async (t) => {
  const workspace = fixture(t);
  const audit = await beginExternalToolEffects(workspace, { runId: "run", requestId: "turn", toolCallId: "shell-1", toolName: "bash" });
  const target = receiptPath(workspace, "run", "shell-1", "turn");
  fs.writeFileSync(target, JSON.stringify({ schemaVersion: 1, runId: "other", toolCallId: "shell-1", toolName: "bash" }));
  const result = await audit.finish();
  assert.equal(result.finishedAt, undefined);
  assert.throws(
    () => listExternalToolEffects(workspace, { runId: "run", expectedExecutions: [{ toolCallId: "shell-1", requestId: "turn" }] }),
    ExternalToolEffectsEvidenceError,
  );
});

test("external tool receipts fail closed for missing, corrupt, hardlinked, symlinked, oversized, and mis-scoped evidence", async (t) => {
  const workspace = fixture(t);
  assert.throws(
    () => listExternalToolEffects(workspace, { runId: "run", expectedExecutions: [{ toolCallId: "missing", requestId: "turn" }] }),
    ExternalToolEffectsEvidenceError,
  );

  await beginExternalToolEffects(workspace, { runId: "run", requestId: "turn", toolCallId: "shell-1", toolName: "bash" });
  const target = receiptPath(workspace, "run", "shell-1", "turn");
  const hardlink = path.join(workspace, ".history", "external-tools", `${"b".repeat(64)}.json`);
  fs.linkSync(target, hardlink);
  assert.throws(() => listExternalToolEffects(workspace, { runId: "run" }), ExternalToolEffectsEvidenceError);
  fs.rmSync(hardlink);

  const symlink = path.join(workspace, ".history", "external-tools", `${"c".repeat(64)}.json`);
  fs.symlinkSync(target, symlink);
  assert.throws(() => listExternalToolEffects(workspace, { runId: "run" }), ExternalToolEffectsEvidenceError);
  fs.rmSync(symlink);

  fs.writeFileSync(path.join(workspace, ".history", "external-tools", `${"d".repeat(64)}.json`), "{broken");
  assert.throws(() => listExternalToolEffects(workspace, { runId: "run" }), ExternalToolEffectsEvidenceError);
  fs.rmSync(path.join(workspace, ".history", "external-tools", `${"d".repeat(64)}.json`));

  fs.writeFileSync(path.join(workspace, ".history", "external-tools", `${"a".repeat(64)}.json`), Buffer.alloc(1024 * 1024 + 1));
  assert.throws(() => listExternalToolEffects(workspace, { runId: "run" }), ExternalToolEffectsEvidenceError);
  fs.rmSync(path.join(workspace, ".history", "external-tools", `${"a".repeat(64)}.json`));

  fs.writeFileSync(target, JSON.stringify({ schemaVersion: 1, runId: "run", requestId: "turn", toolCallId: "wrong", toolName: "bash", startedAt: 1, rollbackCoverage: "untracked", observedPaths: [], observationComplete: false }));
  assert.throws(
    () => listExternalToolEffects(workspace, { runId: "run", expectedExecutions: [{ toolCallId: "shell-1", requestId: "turn" }] }),
    ExternalToolEffectsEvidenceError,
  );
});

test("receipt listing ignores only safe generated temporary files", async (t) => {
  const workspace = fixture(t);
  await beginExternalToolEffects(workspace, { runId: "run", requestId: "turn", toolCallId: "shell-1", toolName: "bash" });
  const directory = path.join(workspace, ".history", "external-tools");
  const temporary = path.join(directory, `.${"e".repeat(64)}.json.${process.pid}.1234abcd.tmp`);
  fs.writeFileSync(temporary, "{}");
  assert.equal(listExternalToolEffects(workspace, { runId: "run" }).length, 1);
  fs.rmSync(temporary);

  fs.symlinkSync(receiptPath(workspace, "run", "shell-1", "turn"), temporary);
  assert.throws(() => listExternalToolEffects(workspace, { runId: "run" }), ExternalToolEffectsEvidenceError);
});
