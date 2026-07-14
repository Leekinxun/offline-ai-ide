import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildMemoryPrompt,
  loadMemorySnapshot,
  readMemory,
  writeMemory,
} from "./memory.js";

test("loads and persists user/workspace memory under .codex", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "crownforge-memory-"));
  try {
    assert.equal(loadMemorySnapshot(workspaceDir).user, "");
    writeMemory(workspaceDir, "user", "- Prefer concise answers");
    writeMemory(workspaceDir, "workspace", "- Use pnpm for frontend checks");

    const snapshot = loadMemorySnapshot(workspaceDir);
    assert.equal(snapshot.user, "- Prefer concise answers");
    assert.equal(readMemory(workspaceDir, "workspace"), "- Use pnpm for frontend checks");
    assert.match(buildMemoryPrompt(snapshot), /workspace_memory/);
    assert.match(buildMemoryPrompt(snapshot), /Prefer concise answers/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("rejects invalid memory scopes and empty content", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "crownforge-memory-"));
  try {
    assert.throws(() => readMemory(workspaceDir, "other"), /scope/);
    assert.throws(() => writeMemory(workspaceDir, "user", "  "), /non-empty/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
