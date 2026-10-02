import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCheckpoint, restoreCheckpoint } from "../chat/checkpoints.js";
import { captureCheckpointMutationsDetailed, fileMutationRevision, keepFileMutations, keepRunMutationBatch, listFileMutations, listMutationEvidenceGaps, MutationJournalEvidenceError, readMutationBytes, readMutationImage, recordFileMutation, reloadMutationJournal, rollbackFileMutations } from "./mutationRegistry.js";

test("older snapshots containing binary caches remain restorable without creating validation gaps", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-old-cache-snapshot-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "app.py"), "value = 1\n");
  const checkpoint = createCheckpoint(workspace);
  const manifestPath = path.join(workspace, ".checkpoints/manifests", `${checkpoint.id}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const cache = Buffer.from([0, 1, 2]); const sha256 = crypto.createHash("sha256").update(cache).digest("hex");
  fs.writeFileSync(path.join(workspace, ".checkpoints/blobs", sha256), cache);
  manifest.changes.push({ operation: "upsert", path: "__pycache__/app.cpython-312.pyc", sha256, size: cache.length });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.writeFileSync(path.join(workspace, "app.py"), "value = 2\n");
  const capture = captureCheckpointMutationsDetailed(workspace, { checkpointId: checkpoint.id, runId: "old-cache", toolCallId: "check" });
  assert.deepEqual(capture.records.map((record) => record.path), ["app.py"]);
  assert.deepEqual(capture.skipped, []);
  assert.deepEqual(listMutationEvidenceGaps(workspace), []);
  restoreCheckpoint(workspace, checkpoint.id);
  assert.equal(fs.readFileSync(path.join(workspace, "app.py"), "utf8"), "value = 1\n");
});

test("mutation rollback refuses manual edits and can target a run tool and file", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-mutations-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const first = recordFileMutation({ workspaceDir: workspace, path: "a.txt", source: "assistant_tool", runId: "run", toolCallId: "tool-a", preimageContent: "before-a", postimageContent: "after-a" });
  const second = recordFileMutation({ workspaceDir: workspace, path: "b.txt", source: "assistant_tool", runId: "run", toolCallId: "tool-b", preimageContent: "before-b", postimageContent: "after-b" });
  fs.writeFileSync(path.join(workspace, "a.txt"), "manual");
  fs.writeFileSync(path.join(workspace, "b.txt"), "after-b");
  const refused = rollbackFileMutations(workspace, { runId: "run" });
  assert.equal(refused.applied.length, 0);
  assert.equal(refused.conflicts[0]?.id, first.id);
  const targeted = rollbackFileMutations(workspace, { toolCallId: "tool-b", path: "b.txt" });
  assert.deepEqual(targeted.applied, [second.id]);
  assert.equal(fs.readFileSync(path.join(workspace, "b.txt"), "utf8"), "before-b");
  assert.equal(listFileMutations(workspace, { toolCallId: "tool-a" })[0]?.id, first.id);
});

test("mutation journal reloads safely, rejects invalid paths, and supports exact selected hunks", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-mutation-journal-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "hunks.txt"), "A=after\nB=after\nmanual tail\n");
  const mutation = recordFileMutation({ workspaceDir: workspace, path: "hunks.txt", source: "assistant_tool", runId: "run", toolCallId: "tool", preimageContent: "A=before\nB=before\n", postimageContent: "A=after\nB=after\nmanual tail\n", hunks: [{ id: "hunk-a", preimage: "A=before", postimage: "A=after" }, { id: "hunk-b", preimage: "B=before", postimage: "B=after" }] });
  reloadMutationJournal(workspace);
  assert.equal(listFileMutations(workspace)[0]?.id, mutation.id);
  assert.deepEqual(rollbackFileMutations(workspace, { ids: [mutation.id], hunkIds: ["hunk-a"] }).applied, [mutation.id]);
  assert.equal(fs.readFileSync(path.join(workspace, "hunks.txt"), "utf8"), "A=before\nB=after\nmanual tail\n");
  assert.throws(() => recordFileMutation({ workspaceDir: workspace, path: "../escape.txt", source: "assistant_tool", postimageContent: "x" }));
  const journal = path.join(workspace, ".checkpoints", "mutations.json");
  fs.writeFileSync(journal, "{broken");
  assert.throws(() => listFileMutations(workspace), MutationJournalEvidenceError);
  assert.equal(fs.readFileSync(journal, "utf8"), "{broken");
});

test("whole-file create and delete roll back at file boundaries", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-mutation-boundaries-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "new.txt"), "new");
  const created = recordFileMutation({ workspaceDir: workspace, path: "new.txt", source: "assistant_tool", runId: "r", toolCallId: "create", postimageContent: "new" });
  assert.deepEqual(rollbackFileMutations(workspace, { ids: [created.id] }).applied, [created.id]);
  assert.equal(fs.existsSync(path.join(workspace, "new.txt")), false);
  const deleted = recordFileMutation({ workspaceDir: workspace, path: "old.txt", source: "assistant_tool", runId: "r", toolCallId: "delete", preimageContent: "old" });
  assert.deepEqual(rollbackFileMutations(workspace, { ids: [deleted.id] }).applied, [deleted.id]);
  assert.equal(fs.readFileSync(path.join(workspace, "old.txt"), "utf8"), "old");
});

test("checkpoint mutation capture excludes protected runtime artifacts", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-mutation-internal-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "source.txt"), "before");
  const baseline = createCheckpoint(workspace);
  fs.writeFileSync(path.join(workspace, "source.txt"), "after");
  for (const directory of [".history", ".team", ".codex", ".omx", ".crewforge"]) {
    fs.mkdirSync(path.join(workspace, directory), { recursive: true });
    fs.writeFileSync(path.join(workspace, directory, "runtime.json"), "internal");
  }
  const records = captureCheckpointMutationsDetailed(workspace, { checkpointId: baseline.id, runId: "run", requestId: "turn-one", toolCallId: "tool" }).records;
  assert.deepEqual(records.map((record) => record.path), ["source.txt"]);
  assert.equal(records[0].requestId, "turn-one");
  assert.deepEqual(listFileMutations(workspace, { path: ".history/runtime.json" }), []);
  assert.throws(() => recordFileMutation({ workspaceDir: workspace, path: ".history/runtime.json", source: "assistant_tool", postimageContent: "internal" }));
});

test("checkpoint mutation capture ignores Python and Ruff cache artifacts", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-mutation-cache-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "source.py"), "before\n");
  const baseline = createCheckpoint(workspace);
  fs.writeFileSync(path.join(workspace, "source.py"), "after\n");
  fs.mkdirSync(path.join(workspace, "__pycache__"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "__pycache__", "source.cpython-312.pyc"), Buffer.from([0, 1, 2]));
  fs.mkdirSync(path.join(workspace, ".ruff_cache"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".ruff_cache", "cache.bin"), Buffer.from([0, 3, 4]));
  const result = captureCheckpointMutationsDetailed(workspace, { checkpointId: baseline.id, runId: "run", requestId: "turn-one", toolCallId: "tool" });
  assert.deepEqual(result.records.map((record) => record.path), ["source.py"]);
  assert.deepEqual(result.skipped, []);
});

test("checkpoint mutation capture ignores Python and Ruff cache artifacts", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-mutation-cache-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "app.py"), "value = 1\n");
  const baseline = createCheckpoint(workspace);
  fs.mkdirSync(path.join(workspace, "pkg", "__pycache__"), { recursive: true });
  fs.mkdirSync(path.join(workspace, ".ruff_cache"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "app.py"), "value = 2\n");
  fs.writeFileSync(path.join(workspace, "pkg", "__pycache__", "app.cpython-312.pyc"), Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(workspace, ".ruff_cache", "CACHEDIR.TAG"), "cache");

  const result = captureCheckpointMutationsDetailed(workspace, { checkpointId: baseline.id, runId: "run", toolCallId: "tool" });
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.records.map((record) => record.path), ["app.py"]);
});

test("rollback refuses symlink-swapped files and parents without partial writes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-symlink-rollback-")); const workspace = path.join(root, "workspace"); const outside = path.join(root, "outside"); fs.mkdirSync(workspace); fs.mkdirSync(outside);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "safe.txt"), "after-safe"); fs.writeFileSync(path.join(workspace, "victim.txt"), "after-victim"); fs.writeFileSync(path.join(outside, "sentinel.txt"), "outside");
  const safe = recordFileMutation({ workspaceDir: workspace, path: "safe.txt", source: "assistant_tool", runId: "run", preimageContent: "before-safe", postimageContent: "after-safe" });
  const victim = recordFileMutation({ workspaceDir: workspace, path: "victim.txt", source: "assistant_tool", runId: "run", preimageContent: "before-victim", postimageContent: "after-victim" });
  fs.rmSync(path.join(workspace, "victim.txt")); fs.symlinkSync(path.join(outside, "sentinel.txt"), path.join(workspace, "victim.txt"));
  const mixed = rollbackFileMutations(workspace, { ids: [safe.id, victim.id] });
  assert.equal(mixed.applied.length, 0); assert.equal(mixed.unavailable.length, 1); assert.equal(fs.readFileSync(path.join(workspace, "safe.txt"), "utf8"), "after-safe"); assert.equal(fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8"), "outside");

  fs.mkdirSync(path.join(workspace, "nested")); fs.writeFileSync(path.join(workspace, "nested", "file.txt"), "after"); const nested = recordFileMutation({ workspaceDir: workspace, path: "nested/file.txt", source: "assistant_tool", preimageContent: "before", postimageContent: "after" });
  fs.rmSync(path.join(workspace, "nested"), { recursive: true }); fs.mkdirSync(path.join(outside, "nested")); fs.writeFileSync(path.join(outside, "nested", "file.txt"), "outside-parent"); fs.symlinkSync(path.join(outside, "nested"), path.join(workspace, "nested"));
  assert.equal(rollbackFileMutations(workspace, { ids: [nested.id] }).applied.length, 0); assert.equal(fs.readFileSync(path.join(outside, "nested", "file.txt"), "utf8"), "outside-parent");
});

test("create rollback never removes a symlink or its outside target", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-create-symlink-")); const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace); const outside = path.join(root, "outside.txt"); fs.writeFileSync(outside, "sentinel");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "created.txt"), "created"); const created = recordFileMutation({ workspaceDir: workspace, path: "created.txt", source: "assistant_tool", runId: "run", postimageContent: "created" }); fs.rmSync(path.join(workspace, "created.txt")); fs.symlinkSync(outside, path.join(workspace, "created.txt"));
  const result = rollbackFileMutations(workspace, { ids: [created.id] }); assert.equal(result.applied.length, 0); assert.ok(result.unavailable.length > 0); assert.equal(fs.readFileSync(outside, "utf8"), "sentinel"); assert.equal(fs.lstatSync(path.join(workspace, "created.txt")).isSymbolicLink(), true);
});

test("capture auto-generates selectable non-adjacent text hunks", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-auto-hunks-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "multi.txt"), "one old\nstable\ntwo old\n");
  const baseline = createCheckpoint(workspace);
  fs.writeFileSync(path.join(workspace, "multi.txt"), "one new\nstable\ntwo new\n");
  const [record] = captureCheckpointMutationsDetailed(workspace, { checkpointId: baseline.id, runId: "run", toolCallId: "tool" }).records;
  assert.equal(record.hunks?.length, 2);
  const firstHunk = record.hunks?.[0]; assert.ok(firstHunk);
  assert.deepEqual(rollbackFileMutations(workspace, { ids: [record.id], hunkIds: [firstHunk.id] }).applied, [record.id]);
  assert.equal(fs.readFileSync(path.join(workspace, "multi.txt"), "utf8"), "one old\nstable\ntwo new\n");
});

test("checkpoint capture records bounded SQLite/binary create as auditable bytes", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-binary-create-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "data"), { recursive: true });
  const baseline = createCheckpoint(workspace);
  const sqlite = Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.from([1, 2, 3, 4])]);
  fs.writeFileSync(path.join(workspace, "data/issues.sqlite"), sqlite);
  const result = captureCheckpointMutationsDetailed(workspace, { checkpointId: baseline.id, runId: "run", requestId: "turn", toolCallId: "demo", actor: "agent" });
  assert.deepEqual(result.skipped, []);
  assert.equal(result.records.length, 1);
  const [record] = result.records;
  assert.equal(record.path, "data/issues.sqlite");
  assert.equal(record.operation, "create");
  assert.equal(record.postimageBinary, true);
  assert.equal(record.postimageSize, sqlite.length);
  assert.equal(record.postimageHash, crypto.createHash("sha256").update(sqlite).digest("hex"));
  assert.equal(record.runId, "run");
  assert.equal(record.requestId, "turn");
  assert.equal(record.toolCallId, "demo");
  assert.deepEqual(readMutationBytes(workspace, record, "postimage"), sqlite);
  assert.throws(() => readMutationImage(workspace, record, "postimage"), /binary/);
  assert.deepEqual(listMutationEvidenceGaps(workspace, { runId: "run" }), []);
  reloadMutationJournal(workspace);
  const [persisted] = listFileMutations(workspace, { runId: "run" });
  assert.equal(persisted.postimageBinary, true);
  assert.equal(persisted.postimageSize, sqlite.length);
  assert.deepEqual(readMutationBytes(workspace, persisted, "postimage"), sqlite);
  assert.deepEqual(rollbackFileMutations(workspace, { ids: [persisted.id] }).applied, [persisted.id]);
  assert.equal(fs.existsSync(path.join(workspace, "data/issues.sqlite")), false);
});

test("checkpoint capture records binary update and delete with reversible whole-file bytes", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-binary-update-delete-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "data"), { recursive: true });
  const first = Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.from([1, 1, 1])]);
  const second = Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.from([2, 2, 2, 2])]);
  const file = path.join(workspace, "data/issues.sqlite");
  fs.writeFileSync(file, first);
  const baseline = createCheckpoint(workspace);
  fs.writeFileSync(file, second);
  const update = captureCheckpointMutationsDetailed(workspace, { checkpointId: baseline.id, runId: "run", toolCallId: "update" });
  assert.deepEqual(update.skipped, []);
  assert.equal(update.records[0].preimageBinary, true);
  assert.equal(update.records[0].postimageBinary, true);
  assert.equal(update.records[0].preimageSize, first.length);
  assert.equal(update.records[0].postimageSize, second.length);
  assert.deepEqual(readMutationBytes(workspace, update.records[0], "preimage"), first);
  assert.deepEqual(readMutationBytes(workspace, update.records[0], "postimage"), second);
  assert.deepEqual(rollbackFileMutations(workspace, { ids: [update.records[0].id] }).applied, [update.records[0].id]);
  assert.deepEqual(fs.readFileSync(file), first);

  const deleteBaseline = createCheckpoint(workspace);
  fs.unlinkSync(file);
  const removed = captureCheckpointMutationsDetailed(workspace, { checkpointId: deleteBaseline.id, runId: "run-delete", toolCallId: "delete" });
  assert.deepEqual(removed.skipped, []);
  assert.equal(removed.records[0].operation, "delete");
  assert.equal(removed.records[0].preimageBinary, true);
  assert.equal(removed.records[0].postimageBinary, undefined);
  assert.deepEqual(readMutationBytes(workspace, removed.records[0], "preimage"), first);
  assert.equal(readMutationBytes(workspace, removed.records[0], "postimage"), undefined);
  assert.deepEqual(rollbackFileMutations(workspace, { ids: [removed.records[0].id] }).applied, [removed.records[0].id]);
  assert.deepEqual(fs.readFileSync(file), first);
});

test("binary rollback does not permanently block earlier text whole-file and hunk history", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-mixed-binary-text-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const file = path.join(workspace, "mixed.txt");
  fs.writeFileSync(file, "one\n");
  const textBaseline = createCheckpoint(workspace);
  fs.writeFileSync(file, "two\n");
  const [text] = captureCheckpointMutationsDetailed(workspace, { checkpointId: textBaseline.id, runId: "run-text", toolCallId: "text" }).records;
  const binaryBaseline = createCheckpoint(workspace);
  const binary = Buffer.from([0, 1, 2, 3]);
  fs.writeFileSync(file, binary);
  const [binaryRecord] = captureCheckpointMutationsDetailed(workspace, { checkpointId: binaryBaseline.id, runId: "run-binary", toolCallId: "binary" }).records;

  assert.deepEqual(rollbackFileMutations(workspace, { ids: [binaryRecord.id] }).applied, [binaryRecord.id]);
  assert.equal(fs.readFileSync(file, "utf8"), "two\n");
  assert.deepEqual(rollbackFileMutations(workspace, { ids: [text.id] }).applied, [text.id]);
  assert.equal(fs.readFileSync(file, "utf8"), "one\n");
});

test("one rollback batch can undo a later binary mutation and an earlier text whole-file mutation", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-mixed-batch-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const file = path.join(workspace, "mixed.txt");
  fs.writeFileSync(file, "one\n");
  const textBaseline = createCheckpoint(workspace);
  fs.writeFileSync(file, "two\n");
  const [text] = captureCheckpointMutationsDetailed(workspace, { checkpointId: textBaseline.id, runId: "run", toolCallId: "text" }).records;
  const binaryBaseline = createCheckpoint(workspace);
  fs.writeFileSync(file, Buffer.from([0, 9, 9]));
  const [binaryRecord] = captureCheckpointMutationsDetailed(workspace, { checkpointId: binaryBaseline.id, runId: "run", toolCallId: "binary" }).records;
  const result = rollbackFileMutations(workspace, { runId: "run" });
  assert.deepEqual(result.applied, [binaryRecord.id, text.id]);
  assert.deepEqual(result.unavailable, []);
  assert.deepEqual(result.conflicts, []);
  assert.equal(fs.readFileSync(file, "utf8"), "one\n");
});

test("partial text hunk rollback still works after a later binary mutation is restored", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-mixed-hunk-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const file = path.join(workspace, "mixed.txt");
  fs.writeFileSync(file, "A=one\nB=one\n");
  const textBaseline = createCheckpoint(workspace);
  fs.writeFileSync(file, "A=two\nB=one\n");
  const [text] = captureCheckpointMutationsDetailed(workspace, { checkpointId: textBaseline.id, runId: "run-text", toolCallId: "text" }).records;
  const hunkId = text.hunks![0].id;
  const binaryBaseline = createCheckpoint(workspace);
  fs.writeFileSync(file, Buffer.from([0, 7, 7, 7]));
  const [binaryRecord] = captureCheckpointMutationsDetailed(workspace, { checkpointId: binaryBaseline.id, runId: "run-binary", toolCallId: "binary" }).records;
  assert.deepEqual(rollbackFileMutations(workspace, { ids: [binaryRecord.id] }).applied, [binaryRecord.id]);
  assert.equal(fs.readFileSync(file, "utf8"), "A=two\nB=one\n");
  assert.deepEqual(rollbackFileMutations(workspace, { ids: [text.id], hunkIds: [hunkId] }).applied, [text.id]);
  assert.equal(fs.readFileSync(file, "utf8"), "A=one\nB=one\n");
});

test("no-NUL invalid UTF-8 and PNG-like bytes are captured as binary without loss", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-invalid-utf8-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const baseline = createCheckpoint(workspace);
  const invalid = Buffer.from([0xff, 0xfe, 0xfd, 0x41]);
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fs.writeFileSync(path.join(workspace, "invalid.bin"), invalid);
  fs.writeFileSync(path.join(workspace, "image.png"), pngHeader);
  const result = captureCheckpointMutationsDetailed(workspace, { checkpointId: baseline.id, runId: "run", toolCallId: "bytes" });
  assert.deepEqual(result.skipped, []);
  const byPath = new Map(result.records.map((record) => [record.path, record]));
  assert.equal(byPath.get("invalid.bin")?.postimageBinary, true);
  assert.equal(byPath.get("image.png")?.postimageBinary, true);
  assert.deepEqual(readMutationBytes(workspace, byPath.get("invalid.bin")!, "postimage"), invalid);
  assert.deepEqual(readMutationBytes(workspace, byPath.get("image.png")!, "postimage"), pngHeader);
  assert.throws(() => readMutationImage(workspace, byPath.get("invalid.bin")!, "postimage"), /binary/);
});

test("complete binary evidence can be kept while legacy binary records still fail batch review", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-binary-keep-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const baseline = createCheckpoint(workspace);
  const bytes = Buffer.from([0, 1, 2, 3]);
  fs.writeFileSync(path.join(workspace, "artifact.bin"), bytes);
  const [binary] = captureCheckpointMutationsDetailed(workspace, { checkpointId: baseline.id, runId: "run", toolCallId: "binary" }).records;
  const legacy = recordFileMutation({ workspaceDir: workspace, path: "legacy.bin", source: "assistant_tool", runId: "legacy-run", toolCallId: "legacy", postimageContent: "\0legacy" });
  const expectedFileRevisions = {
    "artifact.bin": fileMutationRevision([binary]),
  };
  assert.deepEqual(keepRunMutationBatch(workspace, { runId: "run", ids: [binary.id], expectedFileRevisions }), [binary.id]);
  assert.throws(() => keepRunMutationBatch(workspace, { runId: "legacy-run", ids: [legacy.id], expectedFileRevisions: { "legacy.bin": fileMutationRevision([legacy]) } }), MutationJournalEvidenceError);
});

test("capture bounds oversized and unreadable files and reports skipped mutations", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-bounded-capture-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const baseline = createCheckpoint(workspace);
  fs.writeFileSync(path.join(workspace, "huge.txt"), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  const result = captureCheckpointMutationsDetailed(workspace, { checkpointId: baseline.id, runId: "run", toolCallId: "tool" });
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.skipped, [{ path: "huge.txt", reason: "oversized" }]);
  assert.deepEqual(listMutationEvidenceGaps(workspace, { runId: "run", toolCallId: "tool" }).map(({ path, reason }) => ({ path, reason })), result.skipped);
  reloadMutationJournal(workspace);
  assert.deepEqual(listMutationEvidenceGaps(workspace, { runId: "run" }).map(({ path, reason }) => ({ path, reason })), result.skipped);
});

test("unreadable checkpoint evidence is persisted as a skipped mutation", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-unreadable-capture-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "source.txt"), "before");
  const baseline = createCheckpoint(workspace);
  const manifest = JSON.parse(fs.readFileSync(baseline.manifest!, "utf8")) as {
    changes: Array<{ operation: "upsert" | "delete"; path: string; sha256?: string }>;
  };
  const source = manifest.changes.find((entry) => entry.operation === "upsert" && entry.path === "source.txt")!;
  assert.ok(source.sha256);
  fs.rmSync(path.join(workspace, ".checkpoints", "blobs", source.sha256));
  fs.writeFileSync(path.join(workspace, "source.txt"), "after");
  const result = captureCheckpointMutationsDetailed(workspace, { checkpointId: baseline.id, runId: "run", toolCallId: "tool" });
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.skipped, [{ path: "source.txt", reason: "unreadable" }]);
  assert.equal(listMutationEvidenceGaps(workspace, { runId: "run" })[0]?.reason, "unreadable");
});

test("tampered checkpoint binary blobs are rejected before mutation evidence is recorded", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-tampered-checkpoint-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const original = Buffer.from([0, 1, 2, 3]);
  fs.writeFileSync(path.join(workspace, "artifact.bin"), original);
  const baseline = createCheckpoint(workspace);
  const manifest = JSON.parse(fs.readFileSync(baseline.manifest!, "utf8")) as {
    changes: Array<{ operation: "upsert" | "delete"; path: string; sha256?: string; size?: number }>;
  };
  const artifact = manifest.changes.find((entry) => entry.operation === "upsert" && entry.path === "artifact.bin")!;
  assert.ok(artifact.sha256);
  assert.equal(artifact.size, original.byteLength);
  fs.writeFileSync(path.join(workspace, ".checkpoints", "blobs", artifact.sha256), Buffer.from([0, 9, 9, 9]));
  fs.writeFileSync(path.join(workspace, "artifact.bin"), Buffer.from([0, 4, 5, 6]));
  const result = captureCheckpointMutationsDetailed(workspace, { checkpointId: baseline.id, runId: "run", toolCallId: "tool" });
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.skipped, [{ path: "artifact.bin", reason: "unreadable" }]);
  assert.deepEqual(listMutationEvidenceGaps(workspace, { runId: "run" }).map(({ path, reason }) => ({ path, reason })), result.skipped);
});

test("existing corrupt mutation blob paths fail closed instead of being reused", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-corrupt-mutation-blob-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const baseline = createCheckpoint(workspace);
  const bytes = Buffer.from([0, 7, 8, 9]);
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  fs.mkdirSync(path.join(workspace, ".checkpoints", "blobs"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".checkpoints", "blobs", hash), Buffer.from([0, 0, 0, 0]));
  fs.writeFileSync(path.join(workspace, "artifact.bin"), bytes);
  assert.throws(
    () => captureCheckpointMutationsDetailed(workspace, { checkpointId: baseline.id, runId: "run", toolCallId: "tool" }),
    /Mutation blob hash mismatch/,
  );
  assert.deepEqual(listFileMutations(workspace, { runId: "run" }), []);
});

test("future and unreadable mutation journals fail closed while ENOENT remains empty", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-journal-errors-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  assert.deepEqual(listFileMutations(workspace), []);
  const directory = path.join(workspace, ".checkpoints"); fs.mkdirSync(directory, { recursive: true });
  const journal = path.join(directory, "mutations.json");
  fs.writeFileSync(journal, JSON.stringify({ schemaVersion: 2, records: [] }));
  assert.throws(() => listFileMutations(workspace), (error: unknown) => error instanceof MutationJournalEvidenceError && error.code === "mutation_journal_evidence_invalid");
  assert.equal(JSON.parse(fs.readFileSync(journal, "utf8")).schemaVersion, 2);
  fs.rmSync(journal); fs.mkdirSync(journal);
  assert.throws(() => listFileMutations(workspace), MutationJournalEvidenceError);
  assert.equal(fs.lstatSync(journal).isDirectory(), true);
});


test("same-millisecond changes replay backwards once per file and repeat safely after reload", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-rollback-chain-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  t.mock.method(Date, "now", () => 123456789);
  const a = recordFileMutation({ workspaceDir: workspace, path: "a.txt", source: "assistant_tool", runId: "run", preimageContent: "A", postimageContent: "B" });
  const b = recordFileMutation({ workspaceDir: workspace, path: "a.txt", source: "assistant_tool", runId: "run", preimageContent: "B", postimageContent: "C" });
  assert.notEqual(a.id, b.id);
  assert.deepEqual(listFileMutations(workspace).map((entry) => entry.id), [b.id, a.id]);
  fs.writeFileSync(path.join(workspace, "a.txt"), "C");
  fs.writeFileSync(path.join(workspace, "user.txt"), "keep");
  const rename = t.mock.method(fs, "renameSync");
  const result = rollbackFileMutations(workspace, { runId: "run" });
  assert.equal(rename.mock.calls.filter((call) => call.arguments[1] === path.join(workspace, "a.txt")).length, 1);
  assert.deepEqual(result.applied, [b.id, a.id]);
  assert.deepEqual(result.conflicts, []);
  assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), "A");
  assert.equal(fs.readFileSync(path.join(workspace, "user.txt"), "utf8"), "keep");
  reloadMutationJournal(workspace);
  fs.writeFileSync(path.join(workspace, "a.txt"), "new user edit");
  const repeated = rollbackFileMutations(workspace, { runId: "run" });
  assert.deepEqual(repeated.applied, []);
  assert.deepEqual(repeated.alreadyReverted, [b.id, a.id]);
  assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), "new user edit");
});

test("create then edit and edit then delete restore correct existence", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-rollback-existence-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  recordFileMutation({ workspaceDir: workspace, path: "created.txt", source: "assistant_tool", runId: "run", postimageContent: "" });
  recordFileMutation({ workspaceDir: workspace, path: "created.txt", source: "assistant_tool", runId: "run", preimageContent: "", postimageContent: "new" });
  recordFileMutation({ workspaceDir: workspace, path: "deleted.txt", source: "assistant_tool", runId: "run", preimageContent: "old", postimageContent: "updated" });
  recordFileMutation({ workspaceDir: workspace, path: "deleted.txt", source: "assistant_tool", runId: "run", preimageContent: "updated" });
  fs.writeFileSync(path.join(workspace, "created.txt"), "new");
  const result = rollbackFileMutations(workspace, { runId: "run" });
  assert.equal(result.applied.length, 4);
  assert.deepEqual(result.conflicts, []);
  assert.equal(fs.existsSync(path.join(workspace, "created.txt")), false);
  assert.equal(fs.readFileSync(path.join(workspace, "deleted.txt"), "utf8"), "old");
});

test("interleaved user or other-run edits refuse the entire batch", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-rollback-interleave-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  recordFileMutation({ workspaceDir: workspace, path: "a.txt", source: "assistant_tool", runId: "run", preimageContent: "A", postimageContent: "B" });
  recordFileMutation({ workspaceDir: workspace, path: "a.txt", source: "assistant_tool", runId: "other", preimageContent: "B", postimageContent: "X" });
  recordFileMutation({ workspaceDir: workspace, path: "a.txt", source: "assistant_tool", runId: "run", preimageContent: "X", postimageContent: "C" });
  recordFileMutation({ workspaceDir: workspace, path: "safe.txt", source: "assistant_tool", runId: "run", preimageContent: "safe-before", postimageContent: "safe-after" });
  fs.writeFileSync(path.join(workspace, "a.txt"), "C");
  fs.writeFileSync(path.join(workspace, "safe.txt"), "safe-after");
  const result = rollbackFileMutations(workspace, { runId: "run" });
  assert.equal(result.applied.length, 0);
  assert.equal(result.conflicts.length, 1);
  assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), "C");
  assert.equal(fs.readFileSync(path.join(workspace, "safe.txt"), "utf8"), "safe-after");
  const skipped = rollbackFileMutations(workspace, { runId: "run" }, { strategy: "skip-conflicts" });
  assert.equal(skipped.applied.length, 1);
  assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), "C");
  assert.equal(fs.readFileSync(path.join(workspace, "safe.txt"), "utf8"), "safe-before");
});

test("partial hunk rollback persists and a following whole-file rollback knows its changed postimage", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-rollback-hunk-state-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const mutation = recordFileMutation({ workspaceDir: workspace, path: "a.txt", source: "assistant_tool", runId: "run",
    preimageContent: "first=old\nunchanged\nlast=old\n", postimageContent: "first=new\nunchanged\nlast=new\n" });
  fs.writeFileSync(path.join(workspace, "a.txt"), "first=new\nunchanged\nlast=new\n");
  const hunkId = mutation.hunks![0].id;
  assert.equal(rollbackFileMutations(workspace, { ids: [mutation.id], hunkIds: [hunkId] }).applied.length, 1);
  reloadMutationJournal(workspace);
  assert.deepEqual(rollbackFileMutations(workspace, { ids: [mutation.id], hunkIds: [hunkId] }).alreadyReverted, [mutation.id]);
  assert.deepEqual(rollbackFileMutations(workspace, { runId: "run" }).applied, [mutation.id]);
  assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), mutation.preimageContent);
});

test("an absent file never matches a user-created empty file during delete rollback", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-rollback-empty-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  recordFileMutation({ workspaceDir: workspace, path: "a.txt", source: "assistant_tool", runId: "run", preimageContent: "old" });
  fs.writeFileSync(path.join(workspace, "a.txt"), "");
  const result = rollbackFileMutations(workspace, { runId: "run" });
  assert.equal(result.conflicts.length, 1);
  assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), "");
});

test("tampered or missing blobs refuse all rollback writes", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-rollback-blob-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const mutation = recordFileMutation({ workspaceDir: workspace, path: "a.txt", source: "assistant_tool", runId: "run", preimageContent: "before", postimageContent: "after" });
  fs.writeFileSync(path.join(workspace, "a.txt"), "after");
  fs.writeFileSync(path.join(workspace, ".checkpoints", "blobs", mutation.preimageBlob!), "tampered");
  const result = rollbackFileMutations(workspace, { runId: "run" });
  assert.equal(result.applied.length, 0); assert.equal(result.unavailable.length, 1);
  assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), "after");
});

test("hunk rollback refuses a matching snippet moved into an unrelated function", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-hunk-location-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const before = "function a() {\n  return 1;\n}\nfunction b() {\n  return 9;\n}\n";
  const after = before.replace("return 1", "return 2");
  const user = "function a() {\n  return 3;\n}\nfunction b() {\n  return 2;\n}\n";
  const mutation = recordFileMutation({ workspaceDir: workspace, path: "a.ts", source: "assistant_tool", runId: "run", preimageContent: before, postimageContent: after });
  fs.writeFileSync(path.join(workspace, "a.ts"), user);
  const result = rollbackFileMutations(workspace, { ids: [mutation.id], hunkIds: [mutation.hunks![0].id] });
  assert.equal(result.applied.length, 0);
  assert.equal(result.conflicts.length, 1);
  assert.equal(fs.readFileSync(path.join(workspace, "a.ts"), "utf8"), user);
});

test("hunk offsets and unchanged context identify duplicate code in different functions", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-hunk-duplicate-context-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const before = "function a() {\n  return 1;\n}\nfunction b() {\n  return 2;\n}\n";
  const after = before.replace("return 1", "return 2");
  const mutation = recordFileMutation({ workspaceDir: workspace, path: "a.ts", source: "assistant_tool", runId: "run", preimageContent: before, postimageContent: after });
  fs.writeFileSync(path.join(workspace, "a.ts"), after);
  const result = rollbackFileMutations(workspace, { ids: [mutation.id], hunkIds: [mutation.hunks![0].id] });
  assert.deepEqual(result.applied, [mutation.id]);
  assert.equal(fs.readFileSync(path.join(workspace, "a.ts"), "utf8"), before);
});

test("hunk rollback maps a proven insertion before its unchanged context and retains it", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-hunk-prefix-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const before = "// header\nfunction a() {\n  return 1;\n}\n";
  const after = before.replace("return 1", "return 2");
  const mutation = recordFileMutation({ workspaceDir: workspace, path: "a.ts", source: "assistant_tool", runId: "run", preimageContent: before, postimageContent: after });
  fs.writeFileSync(path.join(workspace, "a.ts"), "// user note\n" + after);
  assert.deepEqual(rollbackFileMutations(workspace, { ids: [mutation.id], hunkIds: [mutation.hunks![0].id] }).applied, [mutation.id]);
  assert.equal(fs.readFileSync(path.join(workspace, "a.ts"), "utf8"), "// user note\n" + before);
});

test("legacy hunk snippets only apply to their exact effective postimage", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-hunk-legacy-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const before = "header\nold\nfooter\n"; const after = "header\nnew\nfooter\n";
  const mutation = recordFileMutation({ workspaceDir: workspace, path: "a.txt", source: "assistant_tool", runId: "run", preimageContent: before, postimageContent: after, hunks: [{ id: "legacy", preimage: "old\n", postimage: "new\n" }] });
  fs.writeFileSync(path.join(workspace, "a.txt"), "note\n" + after);
  assert.equal(rollbackFileMutations(workspace, { ids: [mutation.id], hunkIds: ["legacy"] }).conflicts.length, 1);
  assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), "note\n" + after);
  fs.writeFileSync(path.join(workspace, "a.txt"), after);
  assert.deepEqual(rollbackFileMutations(workspace, { ids: [mutation.id], hunkIds: ["legacy"] }).applied, [mutation.id]);
  assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), before);
});

test("an earlier partial rollback is carried through later mutations before whole-run rollback", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-hunk-chain-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const before = "first=old\nseparator\nlast=old\n";
  const middle = "first=new\nseparator\nlast=old\n";
  const after = "first=new\nseparator\nlast=new\n";
  const first = recordFileMutation({ workspaceDir: workspace, path: "a.txt", source: "assistant_tool", runId: "run", requestId: "one", preimageContent: before, postimageContent: middle });
  const last = recordFileMutation({ workspaceDir: workspace, path: "a.txt", source: "assistant_tool", runId: "run", requestId: "two", preimageContent: middle, postimageContent: after });
  fs.writeFileSync(path.join(workspace, "a.txt"), after);
  assert.deepEqual(rollbackFileMutations(workspace, { ids: [first.id], hunkIds: [first.hunks![0].id] }).applied, [first.id]);
  assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), "first=old\nseparator\nlast=new\n");
  reloadMutationJournal(workspace);
  const result = rollbackFileMutations(workspace, { runId: "run" });
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.applied, [last.id, first.id]);
  assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), before);
  assert.deepEqual(rollbackFileMutations(workspace, { runId: "run" }).alreadyReverted, [last.id, first.id]);
});

test("request rollback preserves an earlier undone insertion and keep decisions do not change the replay", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-hunk-insertion-chain-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const before = "header\nseparator\nlast=old\nfooter\n";
  const middle = "header\ninserted\nseparator\nlast=old\nfooter\n";
  const after = middle.replace("last=old", "last=new");
  const first = recordFileMutation({ workspaceDir: workspace, path: "a.txt", source: "assistant_tool", runId: "run", requestId: "one", preimageContent: before, postimageContent: middle });
  const last = recordFileMutation({ workspaceDir: workspace, path: "a.txt", source: "assistant_tool", runId: "run", requestId: "two", preimageContent: middle, postimageContent: after });
  keepFileMutations(workspace, { runId: "run", path: "a.txt", ids: [last.id], hunkIds: [last.hunks![0].id] });
  fs.writeFileSync(path.join(workspace, "a.txt"), after);
  assert.equal(first.hunks![0].preimage, "");
  assert.deepEqual(rollbackFileMutations(workspace, { ids: [first.id], hunkIds: [first.hunks![0].id] }).applied, [first.id]);
  reloadMutationJournal(workspace);
  const result = rollbackFileMutations(workspace, { runId: "run", requestId: "two" });
  assert.deepEqual(result.applied, [last.id]);
  assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), before);
  assert.deepEqual(listFileMutations(workspace, { requestId: "two" })[0].keptHunkIds, [last.hunks![0].id]);
  assert.deepEqual(rollbackFileMutations(workspace, { runId: "run" }).applied, [first.id]);
});

test("a deleted-line hunk restores at its recorded boundary without replacing another block", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-hunk-deletion-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const before = "header\nremoved\nseparator\nlast=old\nfooter\n";
  const middle = "header\nseparator\nlast=old\nfooter\n";
  const after = middle.replace("last=old", "last=new");
  const first = recordFileMutation({ workspaceDir: workspace, path: "a.txt", source: "assistant_tool", runId: "run", preimageContent: before, postimageContent: middle });
  const last = recordFileMutation({ workspaceDir: workspace, path: "a.txt", source: "assistant_tool", runId: "run", preimageContent: middle, postimageContent: after });
  fs.writeFileSync(path.join(workspace, "a.txt"), after);
  assert.equal(first.hunks![0].postimage, "");
  assert.deepEqual(rollbackFileMutations(workspace, { ids: [first.id], hunkIds: [first.hunks![0].id] }).applied, [first.id]);
  assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), before.replace("last=old", "last=new"));
  assert.deepEqual(rollbackFileMutations(workspace, { runId: "run" }).applied, [last.id, first.id]);
  assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), before);
});

test("existing partial decisions do not hide a later manual divergence during whole-run rollback", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-hunk-chain-diverged-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const before = "first=old\nseparator\nlast=old\n";
  const middle = "first=new\nseparator\nlast=old\n";
  const after = middle.replace("last=old", "last=new");
  const first = recordFileMutation({ workspaceDir: workspace, path: "a.txt", source: "assistant_tool", runId: "run", preimageContent: before, postimageContent: middle });
  recordFileMutation({ workspaceDir: workspace, path: "a.txt", source: "assistant_tool", runId: "run", preimageContent: middle, postimageContent: after });
  fs.writeFileSync(path.join(workspace, "a.txt"), after);
  rollbackFileMutations(workspace, { ids: [first.id], hunkIds: [first.hunks![0].id] });
  const edited = "first=old\nseparator\nlast=user\n";
  fs.writeFileSync(path.join(workspace, "a.txt"), edited);
  const result = rollbackFileMutations(workspace, { runId: "run" });
  assert.equal(result.applied.length, 0);
  assert.equal(result.conflicts.length, 1);
  assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), edited);
});

test("empty text replacements retain file existence and can be reversed as anchored hunks", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-hunk-empty-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  for (const [index, [before, after]] of [["content\n", ""], ["", "content\n"]].entries()) {
    const filePath = `${index}.txt`;
    const mutation = recordFileMutation({ workspaceDir: workspace, path: filePath, source: "assistant_tool", runId: "run", preimageContent: before, postimageContent: after });
    fs.writeFileSync(path.join(workspace, filePath), after);
    assert.equal(mutation.hunks?.length, 1);
    assert.deepEqual(rollbackFileMutations(workspace, { ids: [mutation.id], hunkIds: [mutation.hunks![0].id] }).applied, [mutation.id]);
    assert.equal(fs.readFileSync(path.join(workspace, filePath), "utf8"), before);
  }
});

test("tampered anchor offsets are rejected before any rollback write", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-hunk-anchor-integrity-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const before = "header\nold\nfooter\n"; const after = "header\nnew\nfooter\n";
  const mutation = recordFileMutation({ workspaceDir: workspace, path: "a.txt", source: "assistant_tool", runId: "run", preimageContent: before, postimageContent: after });
  fs.writeFileSync(path.join(workspace, "a.txt"), after);
  const journalPath = path.join(workspace, ".checkpoints", "mutations.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  journal.records[0].hunks[0].anchor.afterOffset += 1;
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  const result = rollbackFileMutations(workspace, { ids: [mutation.id], hunkIds: [mutation.hunks![0].id] });
  assert.equal(result.applied.length, 0);
  assert.equal(result.unavailable.length, 1);
  assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), after);
});
