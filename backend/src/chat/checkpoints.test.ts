import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createCheckpoint,
  findCheckpointForRun,
  getCheckpointStorageStats,
  listCheckpoints,
  pruneCheckpointBlobs,
  readCheckpointSettings,
  restoreCheckpoint,
  updateCheckpointRetention,
  verifyCheckpointBlobs,
} from "./checkpoints.js";

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

test("indexes run and step checkpoint metadata for targeted rollback", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-run-checkpoint-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "file.txt"), "before");
  const baseline = createCheckpoint(workspace, { runId: "run-1", kind: "run" });
  fs.writeFileSync(path.join(workspace, "file.txt"), "during");
  const step = createCheckpoint(workspace, {
    runId: "run-1",
    kind: "step",
    toolCallId: "tool-1",
  });

  assert.equal(findCheckpointForRun(workspace, "run-1")?.id, baseline.id);
  assert.equal(listCheckpoints(workspace).find((entry) => entry.id === step.id)?.toolCallId, "tool-1");
});

test("existing corrupt checkpoint index and future settings fail closed without rewriting", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-corrupt-checkpoint-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const index = path.join(workspace, ".checkpoints", "index.json"); fs.mkdirSync(path.dirname(index), { recursive: true }); fs.writeFileSync(index, "{corrupt-index");
  assert.throws(() => listCheckpoints(workspace), (error: unknown) => (error as { code?: string }).code === "checkpoint_persistence_invalid");
  assert.equal(fs.readFileSync(index, "utf8"), "{corrupt-index");
  fs.rmSync(index); const settings = path.join(workspace, ".checkpoints", "settings.json"); fs.writeFileSync(settings, JSON.stringify({ schemaVersion: 999, maxCheckpoints: 20 }));
  assert.throws(() => readCheckpointSettings(workspace), (error: unknown) => (error as { code?: string }).code === "checkpoint_persistence_invalid");
  assert.equal(JSON.parse(fs.readFileSync(settings, "utf8")).schemaVersion, 999);
});

test("corrupt checkpoint manifests block restore and pruning with typed evidence", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-corrupt-manifest-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "source.txt"), "preserve"); const checkpoint = createCheckpoint(workspace);
  const manifest = path.join(workspace, ".checkpoints", "manifests", `${checkpoint.id}.json`); fs.writeFileSync(manifest, "{corrupt-manifest");
  const typed = (error: unknown) => (error as { code?: string }).code === "checkpoint_persistence_invalid";
  assert.throws(() => restoreCheckpoint(workspace, checkpoint.id), typed);
  assert.throws(() => pruneCheckpointBlobs(workspace), typed);
  assert.equal(fs.readFileSync(path.join(workspace, "source.txt"), "utf8"), "preserve");
  assert.equal(fs.readFileSync(manifest, "utf8"), "{corrupt-manifest");
});

test("schema-v2 checkpoints deduplicate unchanged blobs and verify their contents", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-blob-checkpoint-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "one.txt"), "one");
  fs.writeFileSync(path.join(workspace, "two.txt"), "two");
  createCheckpoint(workspace);
  assert.equal(fs.readdirSync(path.join(workspace, ".checkpoints", "blobs")).length, 2);
  fs.writeFileSync(path.join(workspace, "one.txt"), "one changed");
  const second = createCheckpoint(workspace);
  const blobs = fs.readdirSync(path.join(workspace, ".checkpoints", "blobs"));
  assert.equal(blobs.length, 3);
  assert.equal(verifyCheckpointBlobs(workspace, second.id).valid, true);
  fs.writeFileSync(path.join(workspace, ".checkpoints", "blobs", blobs[0]), "corrupt");
  const verified = verifyCheckpointBlobs(workspace, second.id);
  assert.equal(verified.valid, false);
  assert.ok(verified.corrupt.length + verified.missing.length > 0);
  const secondManifest = JSON.parse(fs.readFileSync(path.join(workspace, ".checkpoints", "manifests", `${second.id}.json`), "utf8"));
  fs.unlinkSync(path.join(workspace, ".checkpoints", "blobs", secondManifest.changes[0].sha256));
  assert.equal(verifyCheckpointBlobs(workspace, second.id).missing.length > 0, true);
  assert.deepEqual(pruneCheckpointBlobs(workspace), []);
});

test("legacy files snapshots remain listable and restorable", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-legacy-checkpoint-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const id = "1234567890-deadbeef";
  fs.mkdirSync(path.join(workspace, ".checkpoints", id, "files"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".checkpoints", id, "files", "old.txt"), "old");
  fs.writeFileSync(path.join(workspace, ".checkpoints", "index.json"), JSON.stringify([{ id, label: "legacy", createdAt: 1234567890, fileCount: 1, totalBytes: 3, files: ["old.txt"] }]));
  assert.equal(listCheckpoints(workspace)[0]?.label, "legacy");
  fs.writeFileSync(path.join(workspace, "old.txt"), "new");
  restoreCheckpoint(workspace, id);
  assert.equal(fs.readFileSync(path.join(workspace, "old.txt"), "utf8"), "old");
});

test("v3 manifests store only deltas and restore file deletions", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-v3-delta-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "a.txt"), "a1"); fs.writeFileSync(path.join(workspace, "b.txt"), "b1");
  createCheckpoint(workspace);
  fs.writeFileSync(path.join(workspace, "a.txt"), "a2");
  const modified = createCheckpoint(workspace);
  const modifiedManifest = JSON.parse(fs.readFileSync(path.join(workspace, ".checkpoints", "manifests", `${modified.id}.json`), "utf8"));
  assert.equal(modifiedManifest.version, 3); assert.deepEqual(modifiedManifest.changes.map((change: any) => [change.operation, change.path]), [["upsert", "a.txt"]]);
  fs.unlinkSync(path.join(workspace, "b.txt")); const deleted = createCheckpoint(workspace);
  const deletedManifest = JSON.parse(fs.readFileSync(path.join(workspace, ".checkpoints", "manifests", `${deleted.id}.json`), "utf8"));
  assert.deepEqual(deletedManifest.changes, [{ operation: "delete", path: "b.txt" }]);
  fs.writeFileSync(path.join(workspace, "b.txt"), "later"); restoreCheckpoint(workspace, deleted.id);
  assert.equal(fs.existsSync(path.join(workspace, "b.txt")), false); assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), "a2");
});

test("v3 verifier detects parent cycles and restore preflight makes no writes", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-v3-cycle-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "file.txt"), "one"); const first = createCheckpoint(workspace);
  fs.writeFileSync(path.join(workspace, "file.txt"), "two"); const second = createCheckpoint(workspace);
  const firstPath = path.join(workspace, ".checkpoints", "manifests", `${first.id}.json`); const firstManifest = JSON.parse(fs.readFileSync(firstPath, "utf8")); firstManifest.parentId = second.id; fs.writeFileSync(firstPath, JSON.stringify(firstManifest));
  assert.equal(verifyCheckpointBlobs(workspace, second.id).valid, false);
  const count = listCheckpoints(workspace).length; fs.writeFileSync(path.join(workspace, "file.txt"), "manual");
  assert.throws(() => restoreCheckpoint(workspace, second.id), /cycle/);
  assert.equal(listCheckpoints(workspace).length, count); assert.equal(fs.readFileSync(path.join(workspace, "file.txt"), "utf8"), "manual");
});

test("v2 restore rejects traversal, invalid blob ids, and duplicate paths before writes", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-v2-safety-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const id = "1234567891-cafebabe"; const content = Buffer.from("safe"); const sha256 = crypto.createHash("sha256").update(content).digest("hex");
  fs.mkdirSync(path.join(workspace, ".checkpoints", "blobs"), { recursive: true }); fs.mkdirSync(path.join(workspace, ".checkpoints", "manifests"), { recursive: true }); fs.writeFileSync(path.join(workspace, ".checkpoints", "blobs", sha256), content);
  fs.writeFileSync(path.join(workspace, ".checkpoints", "index.json"), JSON.stringify([{ id, label: "v2", createdAt: 1234567891, fileCount: 1, totalBytes: 4, files: ["safe.txt"], storageVersion: 2 }]));
  const manifestPath = path.join(workspace, ".checkpoints", "manifests", `${id}.json`); const writeManifest = (files: any[]) => fs.writeFileSync(manifestPath, JSON.stringify({ version: 2, checkpointId: id, files }));
  fs.writeFileSync(path.join(workspace, "sentinel.txt"), "unchanged");
  for (const files of [[{ path: "../../escape", sha256, size: 4 }], [{ path: "safe.txt", sha256: "../bad", size: 4 }], [{ path: "safe.txt", sha256, size: 4 }, { path: "safe.txt", sha256, size: 4 }]]) { writeManifest(files); assert.throws(() => restoreCheckpoint(workspace, id)); assert.equal(fs.readFileSync(path.join(workspace, "sentinel.txt"), "utf8"), "unchanged"); assert.equal(listCheckpoints(workspace).length, 1); }
});

test("retention compacts the retained v3 boundary without breaking its chain", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-v3-retention-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  let latest: ReturnType<typeof createCheckpoint> | undefined;
  for (let index = 0; index < 15; index += 1) { fs.writeFileSync(path.join(workspace, "file.txt"), String(index)); latest = createCheckpoint(workspace); }
  assert.equal(listCheckpoints(workspace).length, 12); assert.ok(latest); assert.equal(verifyCheckpointBlobs(workspace, latest.id).valid, true);
  fs.writeFileSync(path.join(workspace, "file.txt"), "manual"); restoreCheckpoint(workspace, latest.id); assert.equal(fs.readFileSync(path.join(workspace, "file.txt"), "utf8"), "14");
});

test("restore rejects symlinked manifests and blobs during preflight", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-storage-symlink-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "file.txt"), "checkpoint"); const checkpoint = createCheckpoint(workspace);
  const manifest = path.join(workspace, ".checkpoints", "manifests", `${checkpoint.id}.json`); const externalManifest = path.join(workspace, "external-manifest.json"); fs.copyFileSync(manifest, externalManifest); fs.rmSync(manifest); fs.symlinkSync(externalManifest, manifest);
  fs.writeFileSync(path.join(workspace, "file.txt"), "manual"); const count = listCheckpoints(workspace).length;
  assert.throws(() => restoreCheckpoint(workspace, checkpoint.id), /manifest/); assert.equal(listCheckpoints(workspace).length, count); assert.equal(fs.readFileSync(path.join(workspace, "file.txt"), "utf8"), "manual");
  fs.rmSync(manifest); fs.copyFileSync(externalManifest, manifest); const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")); const sha = parsed.changes[0].sha256; const blob = path.join(workspace, ".checkpoints", "blobs", sha); const externalBlob = path.join(workspace, "external-blob"); fs.copyFileSync(blob, externalBlob); fs.rmSync(blob); fs.symlinkSync(externalBlob, blob);
  assert.equal(verifyCheckpointBlobs(workspace, checkpoint.id).valid, false); assert.throws(() => restoreCheckpoint(workspace, checkpoint.id)); assert.equal(fs.readFileSync(path.join(workspace, "file.txt"), "utf8"), "manual");
});

test("manifest aggregate size is bounded before blob reads", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-aggregate-limit-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const id = "1234567892-feedface"; fs.mkdirSync(path.join(workspace, ".checkpoints", "manifests"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".checkpoints", "index.json"), JSON.stringify([{ id, label: "large", createdAt: 1234567892, fileCount: 33, totalBytes: 70_000_000, files: [], storageVersion: 2 }]));
  const files = Array.from({ length: 33 }, (_, index) => ({ path: `file-${index}.bin`, sha256: "a".repeat(64), size: 2 * 1024 * 1024 })); fs.writeFileSync(path.join(workspace, ".checkpoints", "manifests", `${id}.json`), JSON.stringify({ version: 2, checkpointId: id, files }));
  fs.writeFileSync(path.join(workspace, "sentinel.txt"), "manual"); assert.throws(() => restoreCheckpoint(workspace, id), /64 MB/); assert.equal(fs.readFileSync(path.join(workspace, "sentinel.txt"), "utf8"), "manual"); assert.equal(listCheckpoints(workspace).length, 1);
});

test("legacy restore rejects symlinked snapshot files", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-legacy-symlink-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const id = "1234567893-acde1234"; const filesRoot = path.join(workspace, ".checkpoints", id, "files"); fs.mkdirSync(filesRoot, { recursive: true }); const external = path.join(workspace, "external.txt"); fs.writeFileSync(external, "outside"); fs.symlinkSync(external, path.join(filesRoot, "file.txt")); fs.writeFileSync(path.join(workspace, ".checkpoints", "index.json"), JSON.stringify([{ id, label: "legacy", createdAt: 1234567893, fileCount: 1, totalBytes: 7, files: ["file.txt"] }]));
  assert.throws(() => restoreCheckpoint(workspace, id), /unsafe/); assert.equal(listCheckpoints(workspace).length, 1);
});

test("absent retention settings use defaults, enforce bounds, and shrink a valid chain", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-settings-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  assert.equal(readCheckpointSettings(workspace).maxCheckpoints, 12); assert.throws(() => updateCheckpointRetention(workspace, { maxCheckpoints: 3 }), RangeError); assert.throws(() => updateCheckpointRetention(workspace, { maxCheckpoints: 101 }), RangeError);
  let latest: ReturnType<typeof createCheckpoint> | undefined; for (let index = 0; index < 8; index += 1) { fs.writeFileSync(path.join(workspace, "file.txt"), String(index)); latest = createCheckpoint(workspace); }
  const dryRun = updateCheckpointRetention(workspace, { maxCheckpoints: 4, dryRun: true }); assert.equal(dryRun.removedCheckpointIds.length, 4); assert.equal(listCheckpoints(workspace).length, 8);
  const applied = updateCheckpointRetention(workspace, { maxCheckpoints: 4 }); assert.equal(applied.stats.checkpointCount, 4); assert.equal(applied.settings.maxCheckpoints, 4); assert.ok(applied.stats.logicalBytes > 0); assert.ok(applied.stats.blobBytes > 0); assert.ok(applied.stats.manifestBytes > 0); assert.ok(latest); assert.equal(verifyCheckpointBlobs(workspace, latest.id).valid, true); assert.deepEqual(getCheckpointStorageStats(workspace).retention, { schemaVersion: 1, maxCheckpoints: 4 });
});
