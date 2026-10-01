import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRunRecorder } from "./runHistory.js";
import { readRunChanges } from "./runChanges.js";
import { keepFileMutations, recordFileMutation, reloadMutationJournal, rollbackFileMutations } from "../files/mutationRegistry.js";

async function fixture(t: test.TestContext): Promise<string> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-run-changes-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const recorder = new AgentRunRecorder(workspace, "run", "conversation", "code");
  await recorder.start(); await recorder.finish("completed");
  return workspace;
}

test("run changes use fixed journal images after later disk edits and across rollback", async (t) => {
  const workspace = await fixture(t);
  const first = recordFileMutation({ workspaceDir: workspace, path: "src/a.ts", source: "assistant_tool", runId: "run", preimageContent: "const a = 1;\n", postimageContent: "const a = 2;\n" });
  const last = recordFileMutation({ workspaceDir: workspace, path: "src/a.ts", source: "assistant_tool", runId: "run", preimageContent: "const a = 2;\n", postimageContent: "const a = 3;\nexport { a };\n" });
  const summary = readRunChanges(workspace, "run");
  assert.equal("original" in summary.files[0], false);
  assert.equal("postimage" in summary.files[0].hunks[0], false);
  assert.deepEqual(summary.files[0].mutationIds, [first.id, last.id]);
  assert.equal(summary.files[0].additions, 2); assert.equal(summary.files[0].deletions, 1);
  const before = readRunChanges(workspace, "run", "src/a.ts");
  assert.equal(before.files[0].original, "const a = 1;\n");
  assert.equal(before.files[0].modified, "const a = 3;\nexport { a };\n");
  fs.mkdirSync(path.join(workspace, "src"));
  fs.writeFileSync(path.join(workspace, "src/a.ts"), "user edit");
  assert.deepEqual(readRunChanges(workspace, "run", "src/a.ts"), before);
  fs.writeFileSync(path.join(workspace, "src/a.ts"), before.files[0].modified!);
  assert.equal(rollbackFileMutations(workspace, { runId: "run" }).applied.length, 2);
  const reverted = readRunChanges(workspace, "run", "src/a.ts");
  assert.equal(reverted.files[0].original, before.files[0].original);
  assert.equal(reverted.files[0].modified, before.files[0].modified);
  assert.equal(reverted.files[0].rollbackState, "reverted");
  assert.notEqual(reverted.revision, before.revision);
});

test("run changes reject unowned runs and unsafe or unrelated file selections", async (t) => {
  const workspace = await fixture(t);
  recordFileMutation({ workspaceDir: workspace, path: "source.txt", source: "assistant_tool", runId: "run", preimageContent: "before", postimageContent: "after" });
  for (const input of ["../outside", "/etc/passwd", ".history/runs/run.json", "C:\\secret", "nested/../source.txt", "source.txt\0"]) {
    assert.throws(() => readRunChanges(workspace, "run", input), /Invalid change path/);
  }
  assert.throws(() => readRunChanges(workspace, "missing"), /Run not found/);
  assert.throws(() => readRunChanges(workspace, "../run"), /Invalid run id/);
  assert.throws(() => readRunChanges(workspace, "run", "missing.txt"), /Run file change not found/);
  const record = path.join(workspace, ".history/runs/run.json");
  const original = fs.readFileSync(record, "utf8");
  fs.writeFileSync(record, original.replace('"runId": "run"', '"runId": "other"'));
  assert.throws(() => readRunChanges(workspace, "run"), /does not belong/);
});

test("missing, corrupted, binary and oversized evidence returns explicit unavailability", async (t) => {
  const workspace = await fixture(t);
  const missing = recordFileMutation({ workspaceDir: workspace, path: "missing.txt", source: "assistant_tool", runId: "run", preimageContent: "missing-before", postimageContent: "missing-after" });
  fs.unlinkSync(path.join(workspace, ".checkpoints/blobs", missing.postimageBlob!));
  const corrupt = recordFileMutation({ workspaceDir: workspace, path: "corrupt.txt", source: "assistant_tool", runId: "run", preimageContent: "corrupt-before", postimageContent: "corrupt-after" });
  fs.writeFileSync(path.join(workspace, ".checkpoints/blobs", corrupt.preimageBlob!), "broken");
  recordFileMutation({ workspaceDir: workspace, path: "binary.dat", source: "assistant_tool", runId: "run", postimageContent: "\0binary" });
  recordFileMutation({ workspaceDir: workspace, path: "huge.txt", source: "assistant_tool", runId: "run", postimageContent: "a".repeat(2 * 1024 * 1024 + 1) });
  const changes = readRunChanges(workspace, "run");
  assert.ok(changes.files.every((file) => file.unavailableReason && file.original === undefined && file.modified === undefined));
  assert.equal(changes.files.find((file) => file.path === "binary.dat")?.isBinary, true);
  assert.equal(changes.files.find((file) => file.path === "huge.txt")?.isTooLarge, true);
  assert.equal(JSON.stringify(changes).includes(workspace), false);
});

test("journal and blob symlinks cannot expose files outside the workspace", async (t) => {
  const workspace = await fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-private-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const mutation = recordFileMutation({ workspaceDir: workspace, path: "source.txt", source: "assistant_tool", runId: "run", preimageContent: "before", postimageContent: "after" });
  fs.writeFileSync(path.join(outside, "private"), "private");
  const blob = path.join(workspace, ".checkpoints/blobs", mutation.postimageBlob!);
  fs.unlinkSync(blob); fs.symlinkSync(path.join(outside, "private"), blob);
  const changes = readRunChanges(workspace, "run", "source.txt");
  assert.ok(changes.files[0].unavailableReason);
  assert.equal(changes.files[0].modified, undefined);
  assert.equal(JSON.stringify(changes).includes(outside), false);
});

test("interleaved edits are unavailable instead of attributing another actor's changes", async (t) => {
  const workspace = await fixture(t);
  recordFileMutation({ workspaceDir: workspace, path: "source.txt", source: "assistant_tool", runId: "run", preimageContent: "A", postimageContent: "B" });
  recordFileMutation({ workspaceDir: workspace, path: "source.txt", source: "assistant_tool", runId: "other", preimageContent: "B", postimageContent: "X" });
  recordFileMutation({ workspaceDir: workspace, path: "source.txt", source: "assistant_tool", runId: "run", preimageContent: "X", postimageContent: "C" });
  const file = readRunChanges(workspace, "run", "source.txt").files[0];
  assert.equal(file.unavailableReason, "interleaved_changes");
  assert.equal(file.original, undefined); assert.equal(file.modified, undefined);
});

test("legacy runs without a mutation journal have no fallback to working-tree diff", async (t) => {
  const workspace = await fixture(t);
  fs.writeFileSync(path.join(workspace, "source.txt"), "unrelated");
  const changes = readRunChanges(workspace, "run");
  assert.deepEqual(changes.files, []);
  assert.equal(changes.unavailableReason, "mutation_evidence_unavailable");
});

test("request-scoped changes and rollback preserve earlier turns within the same run", async (t) => {
  const workspace = await fixture(t);
  const first = recordFileMutation({ workspaceDir: workspace, path: "source.txt", source: "assistant_tool", runId: "run", requestId: "turn-one", preimageContent: "A", postimageContent: "B" });
  const last = recordFileMutation({ workspaceDir: workspace, path: "source.txt", source: "assistant_tool", runId: "run", requestId: "turn-two", preimageContent: "B", postimageContent: "C" });
  fs.writeFileSync(path.join(workspace, "source.txt"), "C");
  const changes = readRunChanges(workspace, "run", "source.txt", "turn-two");
  assert.equal(changes.requestId, "turn-two");
  assert.deepEqual(changes.files[0].mutationIds, [last.id]);
  assert.equal(changes.files[0].original, "B"); assert.equal(changes.files[0].modified, "C");
  assert.deepEqual(rollbackFileMutations(workspace, { runId: "other", requestId: "turn-two", ids: [last.id] }).applied, []);
  assert.deepEqual(rollbackFileMutations(workspace, { runId: "run", requestId: "turn-two" }).applied, [last.id]);
  assert.equal(fs.readFileSync(path.join(workspace, "source.txt"), "utf8"), "B");
  assert.deepEqual(rollbackFileMutations(workspace, { runId: "run" }).applied, [first.id]);
  assert.equal(fs.readFileSync(path.join(workspace, "source.txt"), "utf8"), "A");
});

test("keep decisions survive reload and apply only to the selected recorded version", async (t) => {
  const workspace = await fixture(t);
  const mutation = recordFileMutation({ workspaceDir: workspace, path: "source.txt", source: "assistant_tool", runId: "run",
    preimageContent: "A=old\nkeep\nB=old\n", postimageContent: "A=new\nkeep\nB=new\n" });
  fs.writeFileSync(path.join(workspace, "source.txt"), "A=new\nkeep\nB=new\n");
  const originalRevision = readRunChanges(workspace, "run").files[0].revision;
  keepFileMutations(workspace, { runId: "run", path: "source.txt", ids: [mutation.id], hunkIds: [mutation.hunks![0].id] });
  reloadMutationJournal(workspace);
  let file = readRunChanges(workspace, "run", "source.txt").files[0];
  assert.equal(file.reviewState, "partially_kept"); assert.equal(file.hunks[0].kept, true); assert.equal(file.hunks[1].kept, false);
  assert.notEqual(file.revision, originalRevision);
  keepFileMutations(workspace, { runId: "run", path: "source.txt" });
  reloadMutationJournal(workspace);
  file = readRunChanges(workspace, "run", "source.txt").files[0];
  assert.equal(file.reviewState, "kept"); assert.ok(file.hunks.every((hunk) => hunk.kept));
  rollbackFileMutations(workspace, { runId: "run", path: "source.txt" });
  reloadMutationJournal(workspace);
  file = readRunChanges(workspace, "run", "source.txt").files[0];
  assert.equal(file.rollbackState, "reverted");
  assert.deepEqual(keepFileMutations(workspace, { runId: "run", path: "source.txt" }), []);
});
