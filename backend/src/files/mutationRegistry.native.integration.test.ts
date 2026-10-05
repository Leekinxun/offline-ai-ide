import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import express from "express";
import { buildFileHash, captureCheckpointMutationsDetailedAsync, fileMutationRevision, keepFileMutations, keepFileMutationsAsync, keepRunMutationBatchAsync, listFileMutations, listMutationEvidenceGaps, MutationReviewConflictError, readMutationBytes, recordFileMutation, reloadMutationJournal, rollbackFileMutations, rollbackFileMutationsAsync, type FileMutationRecord } from "./mutationRegistry.js";
import { createCheckpoint } from "../chat/checkpoints.js";
import { AgentRunRecorder } from "../chat/runHistory.js";
import { readRunChanges } from "../chat/runChanges.js";
import { getDesktopNativeIde, NativeIdeError, shutdownDesktopNativeIde } from "../desktop/nativeIdeClient.js";
import { withDesktopWorkspaceWriter } from "../desktop/nativeWorkspaceMutation.js";
import { chatRouter } from "../routes/chat.js";
import { checkpointsRouter } from "../routes/checkpoints.js";

const executable = process.env.CROWNFORGE_TEST_NATIVE_IDE || fileURLToPath(new URL(`../../../desktop/rust/target/debug/crownforge-ide-core${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
const nativeOptions = { skip: !fs.existsSync(executable), timeout: 30_000 };

async function fixture(t: test.TestContext) {
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-native-review-")));
  const recorder = new AgentRunRecorder(workspace, "run", "conversation", "code");
  await recorder.start(); await recorder.finish("stopped");
  const originalDesktop = process.env.CREWFORGE_DESKTOP;
  const originalCore = process.env.CROWNFORGE_IDE_CORE_EXECUTABLE;
  t.after(async () => {
    await shutdownDesktopNativeIde();
    if (originalDesktop === undefined) delete process.env.CREWFORGE_DESKTOP; else process.env.CREWFORGE_DESKTOP = originalDesktop;
    if (originalCore === undefined) delete process.env.CROWNFORGE_IDE_CORE_EXECUTABLE; else process.env.CROWNFORGE_IDE_CORE_EXECUTABLE = originalCore;
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  const add = (file: string, before: string | undefined, after: string | undefined, requestId = "turn") => {
    const record = recordFileMutation({ workspaceDir: workspace, path: file, source: "assistant_tool", runId: "run", requestId, preimageContent: before, postimageContent: after });
    const target = path.join(workspace, file);
    if (after === undefined) fs.rmSync(target, { force: true }); else fs.writeFileSync(target, after);
    return record;
  };
  const enable = () => { process.env.CREWFORGE_DESKTOP = "1"; process.env.CROWNFORGE_IDE_CORE_EXECUTABLE = executable; };
  return { workspace, add, enable, journal: path.join(workspace, ".checkpoints/mutations.json") };
}

async function withoutNodePublication<T>(workspace: string, work: () => Promise<T>): Promise<T> {
  const methods = ["writeFileSync", "renameSync", "unlinkSync", "mkdirSync", "rmSync", "copyFileSync", "appendFileSync"] as const;
  const originals = methods.map((method) => [method, fs[method]] as const);
  const attempted: string[] = [];
  for (const [method, original] of originals) Reflect.set(fs, method, (...args: unknown[]) => {
    const affected = args.slice(0, method === "renameSync" || method === "copyFileSync" ? 2 : 1);
    if (affected.some((entry) => typeof entry === "string" && (entry === workspace || entry.startsWith(`${workspace}${path.sep}`) && !entry.startsWith(path.join(workspace, ".history/repository-index")) && !entry.startsWith(path.join(workspace, ".team"))))) { attempted.push(`${method} ${String(args[0])}`); throw new Error(`Node ${method} must not publish desktop review data`); }
    return Reflect.apply(original, fs, args);
  });
  try { return await work(); }
  finally { for (const [method, original] of originals) Reflect.set(fs, method, original); assert.deepEqual(attempted, []); }
}

async function observeNativeTransactions<T>(work: (plans: Array<{ files: Array<{ path: string }>; publications: Array<{ namespace: string }> }>) => Promise<T>): Promise<T> {
  const client = getDesktopNativeIde(); const original = client.requestDurable;
  const plans: Array<{ files: Array<{ path: string }>; publications: Array<{ namespace: string }> }> = [];
  client.requestDurable = (async (method: string, params: Record<string, unknown>, options?: unknown) => { if (method === "fs.transaction.begin" && (params.publications as Array<{ namespace: string }> | undefined)?.some((publication) => publication.namespace === "mutationJournal")) plans.push(params as unknown as typeof plans[number]); try { return await Reflect.apply(original, client, [method, params, options]); } catch (error) { if (error instanceof Error) error.message = `${method}: ${error.message}`; throw error; } }) as typeof original;
  try { return await work(plans); } finally { client.requestDurable = original; }
}

function expectedFileRevisions(records: FileMutationRecord[]): Record<string, string> {
  return Object.fromEntries([...new Set(records.map((record) => record.path))].map((file) => [file, fileMutationRevision(records.filter((record) => record.path === file))]));
}

test("desktop keep and keep-all publish immutable evidence and review metadata only through Rust", nativeOptions, async (t) => {
  const f = await fixture(t);
  const first = f.add("a.txt", "old A\nkeep\nold B\n", "new A\nkeep\nnew B\n");
  const second = f.add("b.txt", undefined, "created"); f.enable();
  const before = fs.readFileSync(f.journal); const revision = fileMutationRevision([first]);
  await withoutNodePublication(f.workspace, () => observeNativeTransactions(async (plans) => {
    assert.throws(() => keepFileMutations(f.workspace, { runId: "run", path: first.path }), /asynchronous/);
    assert.throws(() => rollbackFileMutations(f.workspace, { runId: "run" }), /asynchronous/);
    assert.deepEqual(await keepFileMutationsAsync(f.workspace, { runId: "run", path: first.path, hunkIds: [first.hunks![0].id], expectedRevision: revision }), [first.id]);
    assert.equal(plans.length, 1); assert.equal(plans[0].files.length, 0);
    assert.ok(plans[0].publications.some((publication) => publication.namespace === "mutationJournal")); assert.ok(plans[0].publications.some((publication) => publication.namespace === "mutationBlob"));
    const partial = listFileMutations(f.workspace).reverse();
    assert.deepEqual(partial.find((record) => record.id === first.id)?.keptHunkIds, [first.hunks![0].id]);
    await assert.rejects(keepFileMutationsAsync(f.workspace, { runId: "run", path: first.path, expectedRevision: revision }), MutationReviewConflictError);
    assert.deepEqual(new Set(await keepRunMutationBatchAsync(f.workspace, { runId: "run", ids: [first.id, second.id], expectedFileRevisions: expectedFileRevisions(partial) })), new Set([first.id, second.id]));
    assert.equal(plans.length, 2);
    const complete = listFileMutations(f.workspace).reverse(); const persisted = fs.readFileSync(f.journal);
    assert.deepEqual(await keepRunMutationBatchAsync(f.workspace, { runId: "run", ids: [first.id, second.id], expectedFileRevisions: expectedFileRevisions(complete) }), []);
    assert.equal(plans.length, 2); assert.deepEqual(fs.readFileSync(f.journal), persisted);
  }));
  assert.notDeepEqual(fs.readFileSync(f.journal), before);
  assert.equal(fs.readFileSync(path.join(f.workspace, first.path), "utf8"), "new A\nkeep\nnew B\n"); assert.equal(fs.readFileSync(path.join(f.workspace, second.path), "utf8"), "created");
});

test("desktop rollback replays sequences, anchored hunks, and existence in one durable batch", nativeOptions, async (t) => {
  const f = await fixture(t);
  const first = f.add("a.txt", "old A\nkeep\nold B\n", "new A\nkeep\nold B\n", "one");
  const last = f.add("a.txt", "new A\nkeep\nold B\n", "new A\nkeep\nnew B\n", "two");
  const created = f.add("created.txt", undefined, ""); const deleted = f.add("deleted.txt", "restored", undefined);
  const transientCreate = f.add("transient.txt", undefined, "temporary"); const transientDelete = f.add("transient.txt", "temporary", undefined); f.enable();
  await withoutNodePublication(f.workspace, () => observeNativeTransactions(async (plans) => {
    assert.deepEqual((await rollbackFileMutationsAsync(f.workspace, { ids: [first.id], hunkIds: [first.hunks![0].id] })).applied, [first.id]);
    assert.equal(fs.readFileSync(path.join(f.workspace, "a.txt"), "utf8"), "old A\nkeep\nnew B\n");
    assert.deepEqual(new Set((await rollbackFileMutationsAsync(f.workspace, { runId: "run" })).applied), new Set([last.id, first.id, created.id, deleted.id, transientCreate.id, transientDelete.id]));
    assert.equal(plans.length, 2); assert.deepEqual(new Set(plans[1].files.map((file) => file.path)), new Set(["a.txt", "created.txt", "deleted.txt"]));
    reloadMutationJournal(f.workspace);
    assert.deepEqual(new Set((await rollbackFileMutationsAsync(f.workspace, { runId: "run" })).alreadyReverted), new Set([last.id, first.id, created.id, deleted.id, transientCreate.id, transientDelete.id])); assert.equal(plans.length, 2);
  }));
  assert.equal(fs.readFileSync(path.join(f.workspace, "a.txt"), "utf8"), "old A\nkeep\nold B\n"); assert.equal(fs.existsSync(path.join(f.workspace, "created.txt")), false); assert.equal(fs.existsSync(path.join(f.workspace, "transient.txt")), false); assert.equal(fs.readFileSync(path.join(f.workspace, "deleted.txt"), "utf8"), "restored");
});

test("desktop refuse and skip-conflicts preserve unrelated files and review state", nativeOptions, async (t) => {
  const f = await fixture(t); const safe = f.add("safe.txt", "before", "after"); const conflict = f.add("conflict.txt", "before", "after");
  fs.writeFileSync(path.join(f.workspace, conflict.path), "human edit"); f.enable(); const before = fs.readFileSync(f.journal);
  await withoutNodePublication(f.workspace, () => observeNativeTransactions(async (plans) => {
    const refused = await rollbackFileMutationsAsync(f.workspace, { runId: "run" }); assert.deepEqual(refused.applied, []); assert.equal(refused.conflicts.length, 1); assert.equal(plans.length, 0); assert.deepEqual(fs.readFileSync(f.journal), before);
    const skipped = await rollbackFileMutationsAsync(f.workspace, { runId: "run" }, { strategy: "skip-conflicts" }); assert.deepEqual(skipped.applied, [safe.id]); assert.equal(skipped.conflicts.length, 1); assert.equal(plans.length, 1); assert.deepEqual(plans[0].files.map((file) => file.path), [safe.path]);
  }));
  assert.equal(fs.readFileSync(path.join(f.workspace, safe.path), "utf8"), "before"); assert.equal(fs.readFileSync(path.join(f.workspace, conflict.path), "utf8"), "human edit"); assert.equal(listFileMutations(f.workspace).find((record) => record.id === conflict.id)?.revertedAt, undefined);
});

test("native rollback rejects a racing target before publishing any files or journal state", nativeOptions, async (t) => {
  const f = await fixture(t); const a = f.add("a.txt", "old a", "new a"); const b = f.add("b.txt", "old b", "new b"); const journal = fs.readFileSync(f.journal); f.enable();
  const client = getDesktopNativeIde(); const original = client.requestDurable; const write = fs.writeFileSync;
  client.requestDurable = (async (method: string, params: Record<string, unknown>, options?: unknown) => { if (method === "fs.transaction.commit") write(path.join(f.workspace, b.path), "racing human edit"); return Reflect.apply(original, client, [method, params, options]); }) as typeof original;
  try { await withoutNodePublication(f.workspace, () => assert.rejects(rollbackFileMutationsAsync(f.workspace, { runId: "run" }), (error: unknown) => error instanceof NativeIdeError && error.code === "CONFLICT")); } finally { client.requestDurable = original; }
  assert.equal(fs.readFileSync(path.join(f.workspace, a.path), "utf8"), "new a"); assert.equal(fs.readFileSync(path.join(f.workspace, b.path), "utf8"), "racing human edit"); assert.deepEqual(fs.readFileSync(f.journal), journal); assert.ok(listFileMutations(f.workspace).every((record) => record.revertedAt === undefined));
});

test("desktop review rechecks revisions after waiting for its writer lease", nativeOptions, async (t) => {
  const f = await fixture(t); const record = f.add("a.txt", "before", "after"); f.enable(); const expectedRevision = fileMutationRevision([record]);
  let entered!: () => void; const admission = new Promise<void>((resolve) => { entered = resolve; }); let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  const blocking = withDesktopWorkspaceWriter(f.workspace, "rollback", async () => { entered(); await held; await keepFileMutationsAsync(f.workspace, { runId: "run", path: record.path }); });
  await admission; const pending = keepFileMutationsAsync(f.workspace, { runId: "run", path: record.path, expectedRevision }); release(); await blocking; await assert.rejects(pending, MutationReviewConflictError);
});

test("chat keep, keep-all, scoped rollback and checkpoint rollback await native publication receipts", nativeOptions, async (t) => {
  const f = await fixture(t); const first = f.add("a.txt", "old A\nkeep\nold B\n", "new A\nkeep\nnew B\n"); const second = f.add("b.txt", "before B", "after B"); f.enable();
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { (req as any).userSession = { workspaceDir: f.workspace, username: "owner", token: "native-review", isolated: false }; next(); }); app.use("/chat", chatRouter); app.use("/checkpoints", checkpointsRouter);
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); assert(address && typeof address === "object");
  const post = (route: string, body: unknown) => fetch(`http://127.0.0.1:${address.port}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  await withoutNodePublication(f.workspace, () => observeNativeTransactions(async (plans) => {
    let changes = readRunChanges(f.workspace, "run", first.path);
    const keep = await post("/chat/runs/run/changes/keep", { path: first.path, expectedRevision: changes.files[0].revision, hunkIds: [first.hunks![0].id] }); assert.equal(keep.status, 200, JSON.stringify(await keep.json())); assert.equal(plans.length, 1); assert.ok(listFileMutations(f.workspace).find((record) => record.id === first.id)?.keptHunkIds?.length);
    changes = readRunChanges(f.workspace, "run"); const all = await post("/chat/runs/run/changes/keep-all", { expectedRevision: changes.revision }); assert.equal(all.status, 200, JSON.stringify(await all.json())); assert.equal(plans.length, 2); assert.ok(listFileMutations(f.workspace).every((record) => record.keptAt !== undefined));
    changes = readRunChanges(f.workspace, "run", first.path); const revert = await post("/chat/runs/run/revert", { path: first.path, ids: [first.id], expectedRevision: changes.files[0].revision }); assert.equal(revert.status, 200, JSON.stringify(await revert.json())); assert.equal(fs.readFileSync(path.join(f.workspace, first.path), "utf8"), "old A\nkeep\nold B\n");
    const checkpoint = await post("/checkpoints/mutations/rollback", { ids: [second.id] }); assert.equal(checkpoint.status, 200, JSON.stringify(await checkpoint.json())); assert.equal(fs.readFileSync(path.join(f.workspace, second.path), "utf8"), "before B"); assert.equal(plans.length, 4);
  }));
});


test("desktop checkpoint capture commits binary bytes, text hunks and explicit gaps in one native journal", nativeOptions, async (t) => {
  const f = await fixture(t);
  const oldBinary = Buffer.from([0, 1, 255]); const newBinary = Buffer.from([0, 2, 128]);
  fs.writeFileSync(path.join(f.workspace, "image.bin"), oldBinary);
  fs.writeFileSync(path.join(f.workspace, "text.txt"), "before text\n");
  fs.writeFileSync(path.join(f.workspace, "deleted.txt"), "deleted image");
  const checkpoint = createCheckpoint(f.workspace, { kind: "step", runId: "run", toolCallId: "capture" });
  fs.writeFileSync(path.join(f.workspace, "image.bin"), newBinary);
  fs.writeFileSync(path.join(f.workspace, "text.txt"), "after text\n");
  fs.writeFileSync(path.join(f.workspace, "empty.txt"), "");
  fs.writeFileSync(path.join(f.workspace, "large.txt"), "x".repeat(2 * 1024 * 1024 + 1));
  fs.unlinkSync(path.join(f.workspace, "deleted.txt")); f.enable();
  await withoutNodePublication(f.workspace, () => observeNativeTransactions(async (plans) => {
    let preflights = 0;
    const captured = await captureCheckpointMutationsDetailedAsync(f.workspace, { checkpointId: checkpoint.id, runId: "run", requestId: "turn", toolCallId: "capture" }, { preflight: () => { preflights++; } });
    assert.equal(preflights, 2); assert.equal(plans.length, 1); assert.equal(plans[0].files.length, 0);
    assert.deepEqual(captured.records.map((record) => record.path), ["deleted.txt", "empty.txt", "image.bin", "text.txt"]);
    assert.deepEqual(captured.skipped, [{ path: "large.txt", reason: "oversized" }]);
    const binary = captured.records.find((record) => record.path === "image.bin")!;
    assert.equal(binary.rollbackScope, "whole-file"); assert.equal(binary.preimageBinary, true); assert.equal(binary.postimageBinary, true); assert.equal(binary.postimageHash, buildFileHash(newBinary));
    assert.deepEqual(readMutationBytes(f.workspace, binary, "preimage"), oldBinary); assert.deepEqual(readMutationBytes(f.workspace, binary, "postimage"), newBinary);
    assert.ok(captured.records.find((record) => record.path === "text.txt")?.hunks?.length);
    assert.deepEqual(captured.records.map((record) => record.sequence), [1, 2, 3, 4]);
    reloadMutationJournal(f.workspace);
    assert.deepEqual(listMutationEvidenceGaps(f.workspace, { runId: "run" }).map((gap) => [gap.path, gap.reason]), [["large.txt", "oversized"]]);
    assert.deepEqual((await rollbackFileMutationsAsync(f.workspace, { ids: [binary.id] })).applied, [binary.id]);
    assert.deepEqual(fs.readFileSync(path.join(f.workspace, "image.bin")), oldBinary);
  }));
});
