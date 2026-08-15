import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { UserSession } from "../auth/sessionManager.js";
import { buildCollaborationSnapshot } from "./snapshot.js";

test("collaboration snapshot treats a new non-Git workspace as having no change sets", (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-non-git-snapshot-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const session = {
    workspaceDir,
    teammateManager: { listDetails: () => [] },
    taskManager: { listTasks: () => [] },
  } as unknown as UserSession;

  const snapshot = buildCollaborationSnapshot(session, null);

  assert.deepEqual(snapshot.ownership.changeSets, []);
  assert.deepEqual(snapshot.ownership.claims, []);
  assert.deepEqual(snapshot.ownership.tasks, []);
});

test("collaboration snapshot does not hide a corrupt Git change-set store", (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-corrupt-snapshot-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", workspaceDir]);
  const storeDir = path.join(workspaceDir, ".history", "change-sets");
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, "corrupt.json"), "{not-json\n");
  const session = {
    workspaceDir,
    teammateManager: { listDetails: () => [] },
    taskManager: { listTasks: () => [] },
  } as unknown as UserSession;

  assert.throws(
    () => buildCollaborationSnapshot(session, null),
    /Change set store is corrupt or unreadable/
  );
});
