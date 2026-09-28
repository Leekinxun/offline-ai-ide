import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseContextReferences, resolveContextReferences } from "./contextReferences.js";
import { buildFileVersion } from "../files/mutationRegistry.js";
import { appendConversationMessage, readConversationMessages } from "./history.js";
import { runDiagnostics } from "../diagnostics/service.js";
import { startRunTask, waitForRun } from "../run/service.js";

function workspace(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-references-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/a.ts"), "export const included = 42;\n");
  return root;
}

test("explicit file references resolve authorized server content and version, never client-supplied content", (t) => {
  const root = workspace(t);
  const resolved = resolveContextReferences(root, [{ kind: "file", path: "src/a.ts", content: "forged" }]);
  assert.deepEqual(resolved.references, [{ kind: "file", path: "src/a.ts" }]);
  assert.match(resolved.items[0].content, /export const included = 42/);
  assert.doesNotMatch(resolved.items[0].content, /forged/);
  assert.equal(resolved.items[0].source.path, "src/a.ts");
  assert.equal(resolved.items[0].source.revision, buildFileVersion("export const included = 42;\n"));
  fs.writeFileSync(path.join(root, "src/a.ts"), "new version");
  assert.match(resolveContextReferences(root, resolved.references).items[0].content, /new version/);
});

test("folder references exclude secret/generated/symlink files and report inclusion counts", (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, "src/.env"), "DO_NOT_SEND_THIS");
  fs.writeFileSync(path.join(root, "src/generated.ts"), "// @generated\nDO_NOT_SEND_THIS");
  fs.writeFileSync(path.join(root, "src/secret.ts"), 'const password = "DO_NOT_SEND_THIS";');
  fs.symlinkSync(path.join(root, "src/a.ts"), path.join(root, "src/alias.ts"));
  const resolved = resolveContextReferences(root, [{ kind: "folder", path: "src" }]);
  assert.equal(resolved.items.length, 2);
  assert.match(resolved.items[1].content, /"includedFiles":1/);
  assert.match(resolved.items[1].content, /"excludedEntries":4/);
  assert.doesNotMatch(JSON.stringify(resolved), /DO_NOT_SEND_THIS/);
});

test("invalid paths, symlink directories, secret content and unsupported kinds are rejected", (t) => {
  const root = workspace(t);
  for (const reference of [{ kind: "file", path: "../outside" }, { kind: "folder", path: "/tmp" }, { kind: "file", path: ".env" }, { kind: "symbol", path: "src/a.ts" }]) {
    assert.throws(() => resolveContextReferences(root, [reference]));
  }
  fs.symlinkSync(path.join(root, "src"), path.join(root, "linked"));
  assert.throws(() => resolveContextReferences(root, [{ kind: "folder", path: "linked" }]), /symbolic links/);
  assert.throws(() => resolveContextReferences(root, [{ kind: "file", path: "linked/a.ts" }]), /symlink/);
  fs.writeFileSync(path.join(root, "src/a.ts"), 'const password = "PROTECTED_VALUE";');
  assert.throws(() => resolveContextReferences(root, [{ kind: "file", path: "src/a.ts" }]), /secret/);
});

test("directory expansion, total tokens and reference counts are bounded with actionable errors", (t) => {
  const root = workspace(t);
  for (let i = 0; i < 21; i++) fs.writeFileSync(path.join(root, `src/file${i}.ts`), "small");
  assert.throws(() => resolveContextReferences(root, [{ kind: "folder", path: "src" }]), /20 files/);
  fs.writeFileSync(path.join(root, "huge.txt"), "x".repeat(50_000));
  assert.throws(() => resolveContextReferences(root, [{ kind: "file", path: "huge.txt" }]), /10,000-token budget/);
  assert.throws(() => parseContextReferences(Array.from({ length: 17 }, () => ({ kind: "problems" }))), /at most 16/);
});

test("selection references require the selected path and preserve user-buffer provenance", (t) => {
  const root = workspace(t);
  const references = [{ kind: "selection", path: "src/a.ts" }];
  assert.throws(() => resolveContextReferences(root, references), /selection is no longer available/);
  assert.throws(() => resolveContextReferences(root, references, { path: "other.ts", selection: "selected" }), /selection is no longer available/);
  const result = resolveContextReferences(root, references, { path: "src/a.ts", selection: "unsaved selected code" });
  assert.match(result.items[0].content, /unsaved selected code/);
  assert.equal(result.items[0].source.trust, "authenticated_user");
});

test("problems use an existing server diagnostic snapshot and do not start commands implicitly", async (t) => {
  const root = workspace(t);
  assert.throws(() => resolveContextReferences(root, [{ kind: "problems" }]), /Run the Problems check first/);
  await runDiagnostics(root);
  const result = resolveContextReferences(root, [{ kind: "problems" }]);
  assert.equal(result.items[0].source.sourceType, "explicit_workspace_diagnostics");
  assert.ok(result.items[0].source.sourceUpdatedAt);
});

test("terminal references use completed run output from this workspace and redact secrets", async (t) => {
  const root = workspace(t);
  assert.throws(() => resolveContextReferences(root, [{ kind: "terminal" }]), /No completed run/);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node output.cjs" } }));
  fs.writeFileSync(path.join(root, "output.cjs"), 'console.error("REFERENCE_RUN_FAILURE"); console.error("token=example-sensitive-value"); process.exitCode = 1;');
  const run = startRunTask(root, "npm:test");
  await waitForRun(root, run.id);
  const result = resolveContextReferences(root, [{ kind: "terminal" }]);
  assert.match(result.items[0].content, /REFERENCE_RUN_FAILURE/);
  assert.doesNotMatch(result.items[0].content, /example-sensitive-value/);
  assert.match(result.items[0].content, /REDACTED/);
  assert.equal(result.items[0].source.sourceType, "explicit_run_output");
  const other = workspace(t);
  assert.throws(() => resolveContextReferences(other, [{ kind: "terminal" }]), /No completed run/);
});

test("selected references survive persisted conversation round trips without arbitrary fields", async (t) => {
  const root = workspace(t);
  await appendConversationMessage(root, "conversation-references", { role: "user", content: "Review", timestamp: Date.now(), requestId: "request-references", contextReferences: [{ kind: "file", path: "src/a.ts" }] });
  assert.deepEqual(readConversationMessages(root, "conversation-references")[0].contextReferences, [{ kind: "file", path: "src/a.ts" }]);
});
