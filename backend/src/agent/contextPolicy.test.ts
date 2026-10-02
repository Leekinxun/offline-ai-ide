import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONTEXT_FILE_LIMIT, evaluateContextPath, readAuthorizedWorkspaceBytes, readAuthorizedWorkspaceFile } from "./contextPolicy.js";

test("context policy rejects control data, secrets, generated content, binary, oversized, and symlinks", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-context-policy-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-context-outside-"));
  t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(workspace, "safe.ts"), "export const safe = true;\n");
  fs.writeFileSync(path.join(workspace, "generated.ts"), "// @generated\nexport const generated = true;\n");
  fs.writeFileSync(path.join(workspace, "binary.dat"), Buffer.from([1, 0, 2]));
  fs.writeFileSync(path.join(workspace, "secret.ts"), "export const apiKey = \"sk-live_LEAKCANARY_123456789\";\n");
  fs.writeFileSync(path.join(outside, "escape.ts"), "export const escaped = true;\n");
  fs.symlinkSync(path.join(outside, "escape.ts"), path.join(workspace, "escape.ts"));

  assert.equal(readAuthorizedWorkspaceFile(workspace, "safe.ts").content.includes("safe"), true);
  for (const protectedPath of [".history/run.json", ".tasks/state.json", ".transcripts/full.jsonl", ".env", "credentials.json"]) {
    assert.equal(evaluateContextPath(protectedPath).allowed, false);
  }
  assert.throws(() => readAuthorizedWorkspaceFile(workspace, "generated.ts"), /generated/);
  assert.throws(() => readAuthorizedWorkspaceFile(workspace, "binary.dat"), /binary/);
  assert.throws(() => readAuthorizedWorkspaceFile(workspace, "secret.ts"), /secret/);
  assert.throws(() => readAuthorizedWorkspaceFile(workspace, "safe.ts", 2), /oversized/);
  assert.throws(() => readAuthorizedWorkspaceFile(workspace, "escape.ts"), /symlink/);
});

test("authorized byte reads keep workspace boundaries without admitting binary as context", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-context-bytes-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-context-bytes-outside-"));
  t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(workspace, "data.sqlite"), Buffer.from([0x53, 0x51, 0x4c, 0, 1, 2]));
  fs.writeFileSync(path.join(workspace, "generated.ts"), "// @generated\nexport const generated = true;\n");
  fs.writeFileSync(path.join(workspace, ".env"), "TOKEN=secret\n");
  fs.writeFileSync(path.join(workspace, "large.bin"), Buffer.alloc(DEFAULT_CONTEXT_FILE_LIMIT + 1, 1));
  fs.writeFileSync(path.join(outside, "outside.bin"), Buffer.from([1, 2, 3]));
  fs.symlinkSync(path.join(outside, "outside.bin"), path.join(workspace, "linked.bin"));

  const bytes = readAuthorizedWorkspaceBytes(workspace, "data.sqlite");
  assert.equal(bytes.buffer.includes(0), true);
  assert.throws(() => readAuthorizedWorkspaceFile(workspace, "data.sqlite"), /binary/);
  for (const denied of ["generated.ts", ".env", "linked.bin", "large.bin", "../outside.bin"]) {
    assert.throws(() => readAuthorizedWorkspaceBytes(workspace, denied), /authorized|oversized|symlink|invalid_path/, denied);
  }
});
