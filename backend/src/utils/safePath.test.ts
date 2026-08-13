import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { safePath } from "./safePath.js";

test("safePath rejects existing symlinks that point outside the workspace", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "safe-path-workspace-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "safe-path-outside-"));
  try {
    fs.writeFileSync(path.join(outside, "secret.txt"), "nope");
    fs.symlinkSync(outside, path.join(workspace, "linked"));
    assert.throws(() => safePath("linked/secret.txt", workspace), /symbolic link/);
    assert.throws(() => safePath("linked/new.txt", workspace), /symbolic link/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("safePath permits new files below a real workspace parent", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "safe-path-workspace-"));
  try {
    fs.mkdirSync(path.join(workspace, "src"));
    assert.equal(safePath("src/new.ts", workspace), path.join(workspace, "src", "new.ts"));
    assert.throws(() => safePath("../outside", workspace), /traversal/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
