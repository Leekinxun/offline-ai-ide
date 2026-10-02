import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildFileVersion, listFileMutations, prepareFileMutationBatch, recordFileMutation,
  reloadMutationJournal, rollbackFileMutations, subscribeWorkspaceMutations,
} from "../files/mutationRegistry.js";
import { assertFileVersion, rememberFileRead } from "./fileEditSafety.js";
import { renameWorkspaceFile, type RenameFileContext } from "./renameFile.js";

function fixture(t: test.TestContext, content = "# 题目\r\n保留内容与换行 😀\r\n") {
  const workspaceDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-rename-")));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const sourcePath = "interview/q1 with spaces/题目.md";
  const targetPath = "interview/q1 with spaces/TASK.md";
  const source = path.join(workspaceDir, sourcePath);
  const target = path.join(workspaceDir, targetPath);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, content);
  fs.chmodSync(source, 0o640);
  const context: RenameFileContext = { actorName: "alice", agentProfileId: "code", runId: "rename-run", requestId: "request-1", toolCallId: "rename-1" };
  const read = (actor = context, end = content.length) => rememberFileRead(workspaceDir, sourcePath, content, 0, end, actor);
  const rename = (extra: Record<string, unknown> = {}, actor = context) => renameWorkspaceFile({ workspaceDir, source_path: sourcePath, target_path: targetPath, ...extra }, actor);
  const assertUnchanged = () => {
    assert.equal(fs.readFileSync(source, "utf8"), content);
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(fs.readdirSync(path.dirname(source)), ["题目.md"]);
  };
  return { workspaceDir, sourcePath, targetPath, source, target, content, context, read, rename, assertUnchanged };
}

test("rename preserves Chinese paths, bytes, permissions, inode, and emits one scoped rename event", (t) => {
  const f = fixture(t);
  f.read();
  const original = fs.statSync(f.source);
  const events: unknown[] = [];
  const unsubscribe = subscribeWorkspaceMutations((event) => { if (event.workspaceDir === f.workspaceDir) events.push(event); });
  t.after(unsubscribe);
  const result = f.rename();
  assert.equal(result.changed, true);
  assert.equal(result.sourcePath, f.sourcePath);
  assert.equal(result.path, f.targetPath);
  assert.equal(result.content, f.content);
  assert.equal(result.version, buildFileVersion(f.content));
  assert.equal(result.mutationIds.length, 2);
  assert.equal(fs.existsSync(f.source), false);
  assert.deepEqual(fs.readFileSync(f.target), Buffer.from(f.content));
  const renamed = fs.statSync(f.target);
  assert.equal(renamed.ino, original.ino);
  assert.equal(renamed.mode & 0o777, original.mode & 0o777);
  assert.equal(renamed.nlink, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(f.source)), ["TASK.md"]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { workspaceDir: f.workspaceDir, path: f.targetPath, previousPath: f.sourcePath, operation: "rename", recordedAt: (events[0] as { recordedAt: number }).recordedAt });
  assert.doesNotThrow(() => assertFileVersion(f.workspaceDir, f.targetPath, f.content, undefined, true, f.context));
});

test("a normalized same-path rename is an explicit no-op without a journal", (t) => {
  const f = fixture(t);
  f.read();
  const result = f.rename({ source_path: `./${f.sourcePath}`, target_path: f.sourcePath.replaceAll("/", "\\") });
  assert.equal(result.changed, false);
  assert.deepEqual(result.mutationIds, []);
  f.assertUnchanged();
  assert.equal(fs.existsSync(path.join(f.workspaceDir, ".checkpoints")), false);
});

test("a workspace root alias keeps the same journal identity as its session", (t) => {
  const f = fixture(t);
  const alias = path.join(f.workspaceDir, "workspace-alias");
  fs.symlinkSync(f.workspaceDir, alias);
  const result = renameWorkspaceFile({ workspaceDir: alias, source_path: f.sourcePath, target_path: f.targetPath, expected_version: buildFileVersion(f.content) }, f.context);
  assert.equal(result.changed, true);
  assert.equal(listFileMutations(alias, { runId: f.context.runId }).length, 2);
  assert.equal(rollbackFileMutations(alias, { runId: f.context.runId }).applied.length, 2);
  f.assertUnchanged();
});

test("rename requires a complete current read by the same actor or an explicit version", (t) => {
  const f = fixture(t);
  assert.throws(() => f.rename(), /Read .* before modifying/);
  f.read(f.context, 3);
  assert.throws(() => f.rename(), /Only part/);
  f.read();
  assert.throws(() => f.rename({}, { ...f.context, actorName: "bob" }), /Read .* before modifying/);
  assert.throws(() => f.rename({}, { ...f.context, runId: "other-run" }), /Read .* before modifying/);
  for (const version of ["missing", "invalid", 1, buildFileVersion("older")]) assert.throws(() => f.rename({ expected_version: version }));
  f.assertUnchanged();
  const result = f.rename({ expected_version: buildFileVersion(f.content) }, { ...f.context, runId: "resumed" });
  assert.equal(result.changed, true);
});

test("a stale read cannot rename a later user edit", (t) => {
  const f = fixture(t);
  f.read();
  fs.writeFileSync(f.source, "user draft saved");
  assert.throws(() => f.rename(), /File changed since it was read/);
  assert.equal(fs.readFileSync(f.source, "utf8"), "user draft saved");
  assert.equal(fs.existsSync(f.target), false);
  assert.equal(listFileMutations(f.workspaceDir).length, 0);
});

test("rename rejects protected, secret, generated, escaped, and malformed paths on both ends", (t) => {
  const f = fixture(t);
  f.read();
  for (const value of ["../outside.md", "/outside.md", ".git/config", ".checkpoints/entry", "users.json", "app-settings.json", ".env", "secrets.json", "node_modules/a.md", "dist/a.md", "a\0b", "", null]) {
    assert.throws(() => f.rename({ target_path: value }));
    assert.throws(() => f.rename({ source_path: value }));
  }
  f.assertUnchanged();
});

test("rename rejects missing sources and parents, existing targets, directories, and hard links", (t) => {
  const f = fixture(t);
  f.read();
  assert.throws(() => f.rename({ source_path: "missing.md" }), /File not found/);
  assert.throws(() => f.rename({ target_path: "missing/TASK.md" }), /parent directory does not exist/);
  assert.throws(() => f.rename({ source_path: "interview" }), /not a regular file/);
  assert.throws(() => f.rename({ target_path: "interview" }), /already exists/);
  fs.writeFileSync(f.target, "target owned by user");
  assert.throws(() => f.rename(), /already exists/);
  assert.equal(fs.readFileSync(f.target, "utf8"), "target owned by user");
  fs.unlinkSync(f.target);
  const alias = path.join(f.workspaceDir, "alias.md");
  fs.linkSync(f.source, alias);
  assert.throws(() => f.rename(), /hard-linked/);
  assert.equal(fs.readFileSync(alias, "utf8"), f.content);
  fs.unlinkSync(alias);
  f.assertUnchanged();
});

test("rename never follows source, destination, or parent symlinks including dangling links", (t) => {
  const f = fixture(t);
  f.read();
  fs.symlinkSync(f.source, path.join(f.workspaceDir, "source-link.md"));
  assert.throws(() => f.rename({ source_path: "source-link.md", expected_version: buildFileVersion(f.content) }), /symbolic links/);
  fs.symlinkSync("missing.md", f.target);
  assert.throws(() => f.rename(), /already exists/);
  assert.equal(fs.lstatSync(f.target).isSymbolicLink(), true);
  fs.unlinkSync(f.target);
  fs.symlinkSync(path.dirname(f.source), path.join(f.workspaceDir, "parent-link"));
  assert.throws(() => f.rename({ target_path: "parent-link/TASK.md" }), /symbolic links/);
  assert.throws(() => f.rename({ source_path: "parent-link/题目.md", expected_version: buildFileVersion(f.content) }), /symbolic links/);
  f.assertUnchanged();
});

test("binary and invalid UTF-8 inputs cannot create un-restorable text evidence", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.source, Buffer.from([0x61, 0x00, 0x62]));
  assert.throws(() => f.rename({ expected_version: buildFileVersion("a\0b") }), /binary/);
  fs.writeFileSync(f.source, Buffer.from([0xc3, 0x28]));
  assert.throws(() => f.rename({ expected_version: buildFileVersion("�(") }), /binary|lossless UTF-8/);
  assert.deepEqual(fs.readFileSync(f.source), Buffer.from([0xc3, 0x28]));
  assert.equal(fs.existsSync(f.target), false);
});

test("corrupt journals and invalid request identifiers fail before moving source data", (t) => {
  const f = fixture(t);
  f.read();
  assert.throws(() => f.rename({}, { ...f.context, requestId: "invalid id" }), /Invalid mutation request id/);
  fs.mkdirSync(path.join(f.workspaceDir, ".checkpoints"), { recursive: true });
  fs.writeFileSync(path.join(f.workspaceDir, ".checkpoints/mutations.json"), "{broken");
  assert.throws(() => f.rename(), /Mutation journal evidence/);
  f.assertUnchanged();
});

test("exclusive destination creation refuses a racing file without overwriting it", (t) => {
  const f = fixture(t);
  f.read();
  const link = fs.linkSync;
  t.mock.method(fs, "linkSync", (source: fs.PathLike, target: fs.PathLike) => {
    if (String(target) === f.target) fs.writeFileSync(f.target, "racing user file", { flag: "wx" });
    return link(source, target);
  });
  assert.throws(() => f.rename(), /EEXIST/);
  assert.equal(fs.readFileSync(f.source, "utf8"), f.content);
  assert.equal(fs.readFileSync(f.target, "utf8"), "racing user file");
  assert.deepEqual(fs.readdirSync(path.dirname(f.source)).sort(), ["TASK.md", "题目.md"]);
  assert.equal(listFileMutations(f.workspaceDir).length, 0);
});

test("failed source unlink and cross-device link leave the original intact without journal entries", (t) => {
  const f = fixture(t);
  f.read();
  const unlink = fs.unlinkSync;
  const unlinkMock = t.mock.method(fs, "unlinkSync", (target: fs.PathLike) => {
    if (String(target) === f.source) throw new Error("injected source unlink failure");
    return unlink(target);
  });
  assert.throws(() => f.rename(), /injected source unlink failure/);
  f.assertUnchanged();
  unlinkMock.mock.restore();
  const link = fs.linkSync;
  t.mock.method(fs, "linkSync", (source: fs.PathLike, target: fs.PathLike) => {
    if (String(target) === f.target) throw Object.assign(new Error("EXDEV: cross-device rename is unavailable"), { code: "EXDEV" });
    return link(source, target);
  });
  assert.throws(() => f.rename(), /EXDEV/);
  f.assertUnchanged();
  assert.equal(listFileMutations(f.workspaceDir).length, 0);
});

test("journal preparation failure occurs before source unlink or destination creation", (t) => {
  const f = fixture(t);
  f.read();
  fs.mkdirSync(path.join(f.workspaceDir, ".checkpoints"));
  fs.writeFileSync(path.join(f.workspaceDir, ".checkpoints/blobs"), "blocked storage");
  assert.throws(() => f.rename());
  f.assertUnchanged();
});

test("journal commit failure restores source bytes and mode without persisting half a rename", (t) => {
  const f = fixture(t);
  f.read();
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (source: fs.PathLike, target: fs.PathLike) => {
    if (String(target).endsWith("/mutations.json")) throw new Error("injected journal commit failure");
    return rename(source, target);
  });
  assert.throws(() => f.rename(), /injected journal commit failure/);
  f.assertUnchanged();
  assert.equal(fs.statSync(f.source).mode & 0o777, 0o640);
  assert.equal(listFileMutations(f.workspaceDir).length, 0);
});

test("failed journal commit preserves a concurrent destination replacement and restores source", (t) => {
  const f = fixture(t);
  f.read();
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (source: fs.PathLike, target: fs.PathLike) => {
    if (String(target).endsWith("/mutations.json")) {
      fs.unlinkSync(f.target);
      fs.writeFileSync(f.target, "concurrent target");
      throw new Error("journal commit failure after target replacement");
    }
    return rename(source, target);
  });
  assert.throws(() => f.rename(), /journal commit failure/);
  assert.equal(fs.readFileSync(f.source, "utf8"), f.content);
  assert.equal(fs.readFileSync(f.target, "utf8"), "concurrent target");
  assert.equal(listFileMutations(f.workspaceDir).length, 0);
});

test("failed journal commit never overwrites a concurrent source, retaining recoverable original data", (t) => {
  const f = fixture(t);
  f.read();
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (source: fs.PathLike, target: fs.PathLike) => {
    if (String(target).endsWith("/mutations.json")) {
      fs.writeFileSync(f.source, "concurrent source", { flag: "wx" });
      throw new Error("journal failure");
    }
    return rename(source, target);
  });
  assert.throws(() => f.rename(), /recovery data is retained/);
  assert.equal(fs.readFileSync(f.source, "utf8"), "concurrent source");
  assert.equal(fs.readFileSync(f.target, "utf8"), f.content);
  const recovery = fs.readdirSync(path.dirname(f.source)).find((name) => name.includes(".rename-"));
  assert.ok(recovery);
  assert.equal(fs.readFileSync(path.join(path.dirname(f.source), recovery), "utf8"), f.content);
  assert.equal(listFileMutations(f.workspaceDir).length, 0);
});

test("ten renames persist twenty correlated records and undo the complete run", (t) => {
  const f = fixture(t);
  fs.rmSync(path.join(f.workspaceDir, "interview"), { recursive: true });
  const originals = new Map<string, string>();
  for (let index = 1; index <= 10; index += 1) {
    const sourcePath = `interview/目录 ${index}/题目.md`;
    const targetPath = `interview/目录 ${index}/TASK.md`;
    const content = `题目 ${index}\r\n`;
    fs.mkdirSync(path.dirname(path.join(f.workspaceDir, sourcePath)), { recursive: true });
    fs.writeFileSync(path.join(f.workspaceDir, sourcePath), content);
    originals.set(sourcePath, content);
    renameWorkspaceFile({ workspaceDir: f.workspaceDir, source_path: sourcePath, target_path: targetPath, expected_version: buildFileVersion(content) }, { ...f.context, toolCallId: `rename-${index}` });
  }
  reloadMutationJournal(f.workspaceDir);
  const records = listFileMutations(f.workspaceDir, { runId: f.context.runId });
  assert.equal(records.length, 20);
  assert.equal(records.filter((record) => record.operation === "delete").length, 10);
  assert.equal(records.filter((record) => record.operation === "create").length, 10);
  assert.ok(records.every((record) => record.requestId === f.context.requestId && record.actor === f.context.actorName));
  const reverted = rollbackFileMutations(f.workspaceDir, { runId: f.context.runId });
  assert.equal(reverted.applied.length, 20);
  assert.deepEqual(reverted.conflicts, []);
  assert.deepEqual(reverted.unavailable, []);
  for (const [sourcePath, content] of originals) {
    assert.deepEqual(fs.readFileSync(path.join(f.workspaceDir, sourcePath)), Buffer.from(content));
    assert.equal(fs.existsSync(path.join(f.workspaceDir, sourcePath.replace("题目.md", "TASK.md"))), false);
  }
});

test("request rollback leaves earlier edits from another request intact", (t) => {
  const f = fixture(t);
  const prior = "older text";
  recordFileMutation({ workspaceDir: f.workspaceDir, path: f.sourcePath, source: "assistant_tool", runId: f.context.runId, requestId: "earlier-request", toolCallId: "earlier-edit", preimageContent: prior, postimageContent: f.content });
  f.read();
  f.rename();
  const reverted = rollbackFileMutations(f.workspaceDir, { runId: f.context.runId, requestId: f.context.requestId });
  assert.equal(reverted.applied.length, 2);
  assert.deepEqual(reverted.conflicts, []);
  f.assertUnchanged();
  assert.equal(listFileMutations(f.workspaceDir, { requestId: "earlier-request" })[0].revertedAt, undefined);
});

test("prepared mutation batches reject concurrent journals without discarding the new writer", (t) => {
  const f = fixture(t);
  const prepared = prepareFileMutationBatch([{ workspaceDir: f.workspaceDir, path: "a.md", source: "assistant_tool", runId: "r", postimageContent: "a" }]);
  t.after(prepared.cancel);
  const concurrent = recordFileMutation({ workspaceDir: f.workspaceDir, path: "b.md", source: "assistant_tool", runId: "other", postimageContent: "b" });
  assert.throws(() => prepared.commit(), /journal changed/);
  prepared.cancel();
  assert.deepEqual(listFileMutations(f.workspaceDir).map((record) => record.id), [concurrent.id]);
});
