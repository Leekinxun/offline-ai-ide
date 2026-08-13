import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCheckpoint } from "../chat/checkpoints.js";
import { captureCheckpointMutationsDetailed, listFileMutations, listMutationEvidenceGaps, MutationJournalEvidenceError, recordFileMutation, reloadMutationJournal, rollbackFileMutations } from "./mutationRegistry.js";

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
  const records = captureCheckpointMutationsDetailed(workspace, { checkpointId: baseline.id, runId: "run", toolCallId: "tool" }).records;
  assert.deepEqual(records.map((record) => record.path), ["source.txt"]);
  assert.deepEqual(listFileMutations(workspace, { path: ".history/runtime.json" }), []);
  assert.throws(() => recordFileMutation({ workspaceDir: workspace, path: ".history/runtime.json", source: "assistant_tool", postimageContent: "internal" }));
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

test("capture bounds binary and oversized files and reports skipped mutations", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-bounded-capture-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "binary.bin"), Buffer.from([0, 1, 2]));
  const baseline = createCheckpoint(workspace);
  fs.writeFileSync(path.join(workspace, "binary.bin"), Buffer.from([0, 3, 4]));
  fs.writeFileSync(path.join(workspace, "huge.txt"), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  const result = captureCheckpointMutationsDetailed(workspace, { checkpointId: baseline.id, runId: "run", toolCallId: "tool" });
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.skipped, [{ path: "binary.bin", reason: "binary" }, { path: "huge.txt", reason: "oversized" }]);
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
  assert.deepEqual(result.skipped, [{ path: "source.txt", reason: "unreadable" }]);
  assert.equal(listMutationEvidenceGaps(workspace, { runId: "run" })[0]?.reason, "unreadable");
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
