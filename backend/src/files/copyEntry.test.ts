import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CopyEntryError, copyWorkspaceEntry } from "./copyEntry.js";

function withWorkspace(run: (workspaceDir: string) => void): void {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ide-copy-"));
  try {
    run(workspaceDir);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
}

function expectCopyError(code: string, run: () => void): void {
  assert.throws(run, (error) => error instanceof CopyEntryError && error.code === code);
}

test("copies a file into another workspace directory without changing the source", () => {
  withWorkspace((workspaceDir) => {
    fs.mkdirSync(path.join(workspaceDir, "target"));
    fs.writeFileSync(path.join(workspaceDir, "notes.json"), '{"ready":true}');

    const result = copyWorkspaceEntry(workspaceDir, "notes.json", "target");

    assert.deepEqual(result, {
      sourcePath: "notes.json",
      path: "target/notes.json",
      type: "file",
    });
    assert.equal(fs.readFileSync(path.join(workspaceDir, "notes.json"), "utf8"), '{"ready":true}');
    assert.equal(fs.readFileSync(path.join(workspaceDir, "target/notes.json"), "utf8"), '{"ready":true}');
  });
});

test("recursively copies a directory and its nested contents", () => {
  withWorkspace((workspaceDir) => {
    fs.mkdirSync(path.join(workspaceDir, "source/nested"), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, "target"));
    fs.writeFileSync(path.join(workspaceDir, "source/nested/value.txt"), "copied");

    const result = copyWorkspaceEntry(workspaceDir, "source", "target");

    assert.equal(result.path, "target/source");
    assert.equal(result.type, "directory");
    assert.equal(fs.readFileSync(path.join(workspaceDir, "target/source/nested/value.txt"), "utf8"), "copied");
  });
});

test("rejects an existing destination instead of overwriting it", () => {
  withWorkspace((workspaceDir) => {
    fs.mkdirSync(path.join(workspaceDir, "target"));
    fs.writeFileSync(path.join(workspaceDir, "item.txt"), "source");
    fs.writeFileSync(path.join(workspaceDir, "target/item.txt"), "existing");

    expectCopyError("COPY_CONFLICT", () =>
      copyWorkspaceEntry(workspaceDir, "item.txt", "target")
    );
    assert.equal(fs.readFileSync(path.join(workspaceDir, "target/item.txt"), "utf8"), "existing");
  });
});

test("rejects copying a directory into itself or a descendant", () => {
  withWorkspace((workspaceDir) => {
    fs.mkdirSync(path.join(workspaceDir, "source/nested"), { recursive: true });

    expectCopyError("COPY_INTO_SELF", () =>
      copyWorkspaceEntry(workspaceDir, "source", "source")
    );
    expectCopyError("COPY_INTO_SELF", () =>
      copyWorkspaceEntry(workspaceDir, "source", "source/nested")
    );
  });
});

test("rejects invalid targets and paths outside the workspace", () => {
  withWorkspace((workspaceDir) => {
    fs.writeFileSync(path.join(workspaceDir, "item.txt"), "source");
    fs.writeFileSync(path.join(workspaceDir, "target.txt"), "not a directory");

    expectCopyError("COPY_TARGET_NOT_DIRECTORY", () =>
      copyWorkspaceEntry(workspaceDir, "item.txt", "target.txt")
    );
    expectCopyError("COPY_TARGET_NOT_FOUND", () =>
      copyWorkspaceEntry(workspaceDir, "item.txt", "missing")
    );
    assert.throws(
      () => copyWorkspaceEntry(workspaceDir, "../outside.txt", ""),
      /Path traversal denied/
    );
  });
});

test("rejects symbolic-link sources and paste targets", () => {
  withWorkspace((workspaceDir) => {
    fs.mkdirSync(path.join(workspaceDir, "real-target"));
    fs.writeFileSync(path.join(workspaceDir, "item.txt"), "source");
    fs.symlinkSync("item.txt", path.join(workspaceDir, "linked-item.txt"));
    fs.symlinkSync("real-target", path.join(workspaceDir, "linked-target"));

    expectCopyError("COPY_UNSUPPORTED_ENTRY", () =>
      copyWorkspaceEntry(workspaceDir, "linked-item.txt", "real-target")
    );
    expectCopyError("COPY_UNSUPPORTED_ENTRY", () =>
      copyWorkspaceEntry(workspaceDir, "item.txt", "linked-target")
    );
  });
});
