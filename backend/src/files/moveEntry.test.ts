import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MoveEntryError, moveWorkspaceEntry } from "./moveEntry.js";

function withWorkspace(run: (workspaceDir: string) => void): void {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ide-move-"));
  try {
    run(workspaceDir);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
}

function expectMoveError(code: string, run: () => void): void {
  assert.throws(run, (error) => error instanceof MoveEntryError && error.code === code);
}

test("moves a file into another workspace directory", () => {
  withWorkspace((workspaceDir) => {
    fs.mkdirSync(path.join(workspaceDir, "target"));
    fs.writeFileSync(path.join(workspaceDir, "notes.txt"), "moved");

    const result = moveWorkspaceEntry(workspaceDir, "notes.txt", "target");

    assert.deepEqual(result, {
      sourcePath: "notes.txt",
      path: "target/notes.txt",
      type: "file",
    });
    assert.equal(fs.existsSync(path.join(workspaceDir, "notes.txt")), false);
    assert.equal(fs.readFileSync(path.join(workspaceDir, "target/notes.txt"), "utf8"), "moved");
  });
});

test("moves a directory with its nested contents", () => {
  withWorkspace((workspaceDir) => {
    fs.mkdirSync(path.join(workspaceDir, "source/nested"), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, "target"));
    fs.writeFileSync(path.join(workspaceDir, "source/nested/value.txt"), "moved");

    const result = moveWorkspaceEntry(workspaceDir, "source", "target");

    assert.equal(result.path, "target/source");
    assert.equal(result.type, "directory");
    assert.equal(fs.existsSync(path.join(workspaceDir, "source")), false);
    assert.equal(fs.readFileSync(path.join(workspaceDir, "target/source/nested/value.txt"), "utf8"), "moved");
  });
});

test("rejects conflicts and moving a directory into itself", () => {
  withWorkspace((workspaceDir) => {
    fs.mkdirSync(path.join(workspaceDir, "source/nested"), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, "target/source"), { recursive: true });

    expectMoveError("MOVE_CONFLICT", () =>
      moveWorkspaceEntry(workspaceDir, "source", "target")
    );
    expectMoveError("MOVE_INTO_SELF", () =>
      moveWorkspaceEntry(workspaceDir, "source", "source/nested")
    );
  });
});

test("rejects invalid targets, outside paths, and symbolic links", () => {
  withWorkspace((workspaceDir) => {
    fs.writeFileSync(path.join(workspaceDir, "item.txt"), "source");
    fs.writeFileSync(path.join(workspaceDir, "target.txt"), "not a directory");
    fs.mkdirSync(path.join(workspaceDir, "real-target"));
    fs.symlinkSync("real-target", path.join(workspaceDir, "linked-target"));

    expectMoveError("MOVE_TARGET_NOT_DIRECTORY", () =>
      moveWorkspaceEntry(workspaceDir, "item.txt", "target.txt")
    );
    expectMoveError("MOVE_TARGET_NOT_FOUND", () =>
      moveWorkspaceEntry(workspaceDir, "item.txt", "missing")
    );
    expectMoveError("MOVE_UNSUPPORTED_ENTRY", () =>
      moveWorkspaceEntry(workspaceDir, "item.txt", "linked-target")
    );
    assert.throws(
      () => moveWorkspaceEntry(workspaceDir, "../outside.txt", ""),
      /Path traversal denied/
    );
  });
});
