import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCheckpoint, listCheckpoints, restoreCheckpoint } from "./checkpoints.js";

test("checkpoint restores captured source files and removes later workspace files", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-checkpoint-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "app.ts"), "export const version = 1;\n");
  fs.mkdirSync(path.join(workspace, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".codex", "MEMORY.md"), "private metadata\n");

  const checkpoint = createCheckpoint(workspace, { label: "Before code task" });
  assert.equal(checkpoint.fileCount, 1);
  assert.equal(listCheckpoints(workspace)[0]?.label, "Before code task");

  fs.writeFileSync(path.join(workspace, "src", "app.ts"), "export const version = 2;\n");
  fs.writeFileSync(path.join(workspace, "src", "new.ts"), "temporary\n");
  restoreCheckpoint(workspace, checkpoint.id);

  assert.equal(fs.readFileSync(path.join(workspace, "src", "app.ts"), "utf-8"), "export const version = 1;\n");
  assert.equal(fs.existsSync(path.join(workspace, "src", "new.ts")), false);
  assert.equal(fs.readFileSync(path.join(workspace, ".codex", "MEMORY.md"), "utf-8"), "private metadata\n");

  const rollback = listCheckpoints(workspace).find((entry) => entry.label.startsWith("Before restore"));
  assert.ok(rollback);
  restoreCheckpoint(workspace, rollback.id);
  assert.equal(fs.readFileSync(path.join(workspace, "src", "app.ts"), "utf-8"), "export const version = 2;\n");
  assert.equal(fs.readFileSync(path.join(workspace, "src", "new.ts"), "utf-8"), "temporary\n");
});
