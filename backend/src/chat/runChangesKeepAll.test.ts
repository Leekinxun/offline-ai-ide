import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import { AgentRunRecorder } from "./runHistory.js";
import { createCheckpoint } from "./checkpoints.js";
import { keepAllRunChanges, readRunChanges, RunChangesKeepError } from "./runChanges.js";
import { captureCheckpointMutationsDetailed, keepFileMutations, listFileMutations, MutationReviewConflictError, recordFileMutation, rollbackFileMutations } from "../files/mutationRegistry.js";
import { chatRouter } from "../routes/chat.js";
import { setActiveTeamId, setTeamManagerForTests } from "../team/sessionBridge.js";
import { TeamManager } from "../team/teamManager.js";
import type { UserSession } from "../auth/sessionManager.js";

async function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-keep-all-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const recorder = new AgentRunRecorder(root, "run", "conversation", "code");
  await recorder.start(); await recorder.finish("stopped");
  const journal = path.join(root, ".checkpoints/mutations.json");
  const add = (file: string, before: string | undefined, after: string, requestId = "turn", runId = "run") => {
    const record = recordFileMutation({ workspaceDir: root, path: file, source: "assistant_tool", actor: "owner", runId, requestId, preimageContent: before, postimageContent: after });
    fs.writeFileSync(path.join(root, file), after);
    return record;
  };
  return { root, journal, add };
}

test("keep-all confirms multiple files in one journal commit, preserves disk and fixed diff, and remains undoable", async (t) => {
  const f = await fixture(t);
  const a = f.add("a.ts", "before A\n", "after A\n");
  const b = f.add("b.ts", "before B\n", "after B\n");
  fs.writeFileSync(path.join(f.root, "human.txt"), "unrelated human work");
  const before = readRunChanges(f.root, "run");
  const diff = readRunChanges(f.root, "run", "a.ts").files[0];
  const rename = fs.renameSync; let commits = 0;
  fs.renameSync = ((from, to) => { if (String(to) === f.journal) commits++; return rename(from, to); }) as typeof fs.renameSync;
  let kept: ReturnType<typeof keepAllRunChanges>;
  try { kept = keepAllRunChanges(f.root, "run", before.revision); }
  finally { fs.renameSync = rename; }
  assert.equal(commits, 1);
  assert.deepEqual(new Set(kept.kept), new Set([a.id, b.id]));
  assert.ok(kept.files.every((file) => file.reviewState === "kept"));
  assert.notEqual(kept.revision, before.revision);
  assert.equal(fs.readFileSync(path.join(f.root, "a.ts"), "utf8"), "after A\n");
  assert.equal(fs.readFileSync(path.join(f.root, "b.ts"), "utf8"), "after B\n");
  const keptDiff = readRunChanges(f.root, "run", "a.ts").files[0];
  assert.equal(keptDiff.original, diff.original); assert.equal(keptDiff.modified, diff.modified);
  assert.equal(rollbackFileMutations(f.root, { runId: "run" }).applied.length, 2);
  assert.equal(fs.readFileSync(path.join(f.root, "a.ts"), "utf8"), "before A\n");
  assert.equal(fs.readFileSync(path.join(f.root, "b.ts"), "utf8"), "before B\n");
  assert.equal(fs.readFileSync(path.join(f.root, "human.txt"), "utf8"), "unrelated human work");
});

test("the batch compares the entire selected summary and never confirms later additions", async (t) => {
  const f = await fixture(t);
  const a = f.add("a.ts", "before", "after");
  const old = readRunChanges(f.root, "run");
  const b = f.add("b.ts", undefined, "new file");
  const bytes = fs.readFileSync(f.journal, "utf8");
  assert.throws(() => keepAllRunChanges(f.root, "run", old.revision), (error: unknown) => error instanceof RunChangesKeepError && error.reason === "stale");
  assert.equal(fs.readFileSync(f.journal, "utf8"), bytes);
  const kept = keepAllRunChanges(f.root, "run", readRunChanges(f.root, "run").revision);
  assert.deepEqual(new Set(kept.kept), new Set([a.id, b.id]));
  const newer = f.add("a.ts", "after", "another edit");
  assert.equal(listFileMutations(f.root, { runId: "run" }).find((record) => record.id === newer.id)?.keptAt, undefined);
  assert.throws(() => keepAllRunChanges(f.root, "run", kept.revision), RunChangesKeepError);
});

test("request-scoped keep-all leaves earlier and foreign run mutations pending", async (t) => {
  const f = await fixture(t);
  const earlier = f.add("earlier.ts", "A", "B", "first-turn");
  const selected = f.add("selected.ts", "A", "B", "selected-turn");
  const foreign = f.add("foreign.ts", "A", "B", "selected-turn", "other-run");
  const expected = readRunChanges(f.root, "run", undefined, "selected-turn");
  f.add("later.ts", "A", "B", "later-turn");
  const result = keepAllRunChanges(f.root, "run", expected.revision, "selected-turn");
  assert.equal(result.requestId, "selected-turn");
  assert.deepEqual(result.kept, [selected.id]);
  assert.equal(result.files.length, 1);
  const records = listFileMutations(f.root);
  assert.equal(records.find((record) => record.id === earlier.id)?.keptAt, undefined);
  assert.equal(records.find((record) => record.id === foreign.id)?.keptAt, undefined);
});

test("fully kept, individually reviewed hunks and reverted files make keep-all a byte-for-byte no-op", async (t) => {
  const f = await fixture(t);
  const hunks = f.add("hunks.ts", "A=old\nkeep\nB=old\n", "A=new\nkeep\nB=new\n");
  f.add("file.ts", undefined, "whole-file creation");
  f.add("revert.ts", "before", "after");
  keepFileMutations(f.root, { runId: "run", path: "hunks.ts", hunkIds: hunks.hunks!.map((hunk) => hunk.id) });
  assert.equal(readRunChanges(f.root, "run", "hunks.ts").files[0].reviewState, "kept");
  assert.equal(readRunChanges(f.root, "run", "file.ts").files[0].reviewState, "pending");
  keepFileMutations(f.root, { runId: "run", path: "file.ts" });
  rollbackFileMutations(f.root, { runId: "run", path: "revert.ts" });
  const before = readRunChanges(f.root, "run");
  const bytes = fs.readFileSync(f.journal, "utf8"); const stat = fs.statSync(f.journal);
  const result = keepAllRunChanges(f.root, "run", before.revision);
  assert.deepEqual(result.kept, []); assert.equal(result.revision, before.revision);
  assert.equal(fs.readFileSync(f.journal, "utf8"), bytes); assert.equal(fs.statSync(f.journal).mtimeMs, stat.mtimeMs);
});

test("any missing, corrupt, binary, oversized or incomplete pending evidence refuses every file", async (t) => {
  for (const kind of ["missing", "corrupt", "binary", "oversized", "gap"] as const) await t.test(kind, async (t) => {
    const f = await fixture(t);
    const valid = f.add("a-valid.ts", "before", "after");
    if (kind === "gap") {
      const checkpoint = createCheckpoint(f.root, { kind: "step", runId: "run", toolCallId: "gap-step" });
      fs.writeFileSync(path.join(f.root, "z-invalid.bin"), Buffer.alloc(2 * 1024 * 1024 + 1, 1));
      captureCheckpointMutationsDetailed(f.root, { checkpointId: checkpoint.id, runId: "run", requestId: "turn", toolCallId: "gap-step" });
    } else {
      const invalid = f.add("z-invalid.ts", "before-invalid", kind === "binary" ? "\0binary" : kind === "oversized" ? "x".repeat(2 * 1024 * 1024 + 1) : "after-invalid");
      if (kind === "missing") fs.unlinkSync(path.join(f.root, ".checkpoints/blobs", invalid.postimageBlob!));
      if (kind === "corrupt") fs.writeFileSync(path.join(f.root, ".checkpoints/blobs", invalid.postimageBlob!), "corrupted evidence");
    }
    const changes = readRunChanges(f.root, "run");
    const bytes = fs.readFileSync(f.journal, "utf8");
    assert.throws(() => keepAllRunChanges(f.root, "run", changes.revision), (error: unknown) => error instanceof RunChangesKeepError && error.reason === "unavailable");
    assert.equal(fs.readFileSync(f.journal, "utf8"), bytes);
    assert.equal(valid.keptAt, undefined);
    assert.ok(listFileMutations(f.root, { runId: "run" }).every((record) => record.keptAt === undefined));
  });
});

test("a failed journal commit does not publish partially kept records in memory or on disk", async (t) => {
  const f = await fixture(t);
  const a = f.add("a.ts", "before", "after"); const b = f.add("b.ts", "before", "after");
  const expected = readRunChanges(f.root, "run").revision;
  const before = fs.readFileSync(f.journal, "utf8");
  const rename = fs.renameSync;
  fs.renameSync = ((from, to) => { if (String(from).includes(".keep-") && String(to) === f.journal) throw Object.assign(new Error("simulated commit failure"), { code: "EIO" }); return rename(from, to); }) as typeof fs.renameSync;
  try { assert.throws(() => keepAllRunChanges(f.root, "run", expected), /commit failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(a.keptAt, undefined); assert.equal(b.keptAt, undefined);
  assert.equal(fs.readFileSync(f.journal, "utf8"), before);
  assert.ok(listFileMutations(f.root, { runId: "run" }).every((record) => record.keptAt === undefined));
  assert.equal(fs.readdirSync(path.dirname(f.journal)).some((name) => name.includes(".keep-")), false);
});

test("a mutation arriving while a batch journal is prepared causes CAS rejection without lost or kept new edits", async (t) => {
  const f = await fixture(t);
  f.add("a.ts", "before", "after");
  const expected = readRunChanges(f.root, "run").revision;
  const write = fs.writeFileSync; let injected = false;
  fs.writeFileSync = ((file, ...args: unknown[]) => {
    Reflect.apply(write, fs, [file, ...args]);
    if (!injected && String(file).includes(".keep-")) { injected = true; f.add("later.ts", undefined, "later edit"); }
  }) as typeof fs.writeFileSync;
  try { assert.throws(() => keepAllRunChanges(f.root, "run", expected), MutationReviewConflictError); }
  finally { fs.writeFileSync = write; }
  const records = listFileMutations(f.root, { runId: "run" });
  assert.equal(records.length, 2); assert.ok(records.every((record) => record.keptAt === undefined));
});

test("HTTP keep-all enforces current workspace, run ownership, request scope, read-only access and whole-summary CAS", async (t) => {
  const f = await fixture(t); const other = await fixture(t);
  f.add("a.ts", "before", "after", "selected"); f.add("b.ts", "before", "after", "other");
  const teamStore = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-keep-all-teams-"));
  const manager = new TeamManager(teamStore);
  setTeamManagerForTests(manager);
  t.after(() => { setTeamManagerForTests(null); fs.rmSync(teamStore, { recursive: true, force: true }); });
  const team = manager.createTeam({ username: "owner", teamName: "Review", workspaceDir: f.root });
  manager.joinTeamByInvite(manager.createInvite(team.id, "owner", "viewer").code, "viewer");
  const sessions = { owner: { workspaceDir: f.root, username: "owner", token: "owner-token" }, viewer: { workspaceDir: f.root, username: "viewer", token: "viewer-token" }, foreign: { workspaceDir: other.root, username: "outside", token: "outside-token" } };
  setActiveTeamId(sessions.owner as UserSession, team.id); setActiveTeamId(sessions.viewer as UserSession, team.id);
  t.after(() => { setActiveTeamId(sessions.owner as UserSession, null); setActiveTeamId(sessions.viewer as UserSession, null); });
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { const session = sessions[req.header("X-Test-Session") as keyof typeof sessions]; if (!session) return res.status(401).end(); (req as any).userSession = session; next(); });
  app.use(chatRouter);
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const post = (body: unknown, session = "owner", runId = "run", workspaceHeader?: string) => fetch(`${origin}/runs/${runId}/changes/keep-all`, { method: "POST", headers: { "Content-Type": "application/json", "X-Test-Session": session, ...(workspaceHeader ? { "X-Workspace-Dir": workspaceHeader } : {}) }, body: JSON.stringify(body) });
  const scoped = readRunChanges(f.root, "run", undefined, "selected"); const bytes = fs.readFileSync(f.journal, "utf8");
  assert.equal((await post({ expectedRevision: scoped.revision, requestId: "selected" }, "viewer")).status, 403);
  assert.equal((await post({ expectedRevision: scoped.revision }, "owner", "missing-run")).status, 404);
  assert.equal((await post({ expectedRevision: scoped.revision }, "owner", "run", other.root)).status, 409);
  assert.equal((await post({ expectedRevision: scoped.revision }, "foreign")).status, 409);
  assert.equal((await post({ expectedRevision: scoped.files[0].revision, requestId: "selected" })).status, 409);
  assert.equal((await post({ expectedRevision: scoped.revision, requestId: 2 })).status, 400);
  assert.equal((await post({ expectedRevision: scoped.revision, path: "a.ts" })).status, 400);
  assert.equal(fs.readFileSync(f.journal, "utf8"), bytes);
  const response = await post({ expectedRevision: scoped.revision, requestId: "selected" });
  assert.equal(response.status, 200);
  const result = await response.json() as { requestId: string; kept: string[]; files: Array<{ path: string; reviewState: string }> };
  assert.equal(result.requestId, "selected"); assert.equal(result.kept.length, 1);
  assert.deepEqual(result.files.map((file) => [file.path, file.reviewState]), [["a.ts", "kept"]]);
  assert.equal(readRunChanges(f.root, "run", "b.ts").files[0].reviewState, "pending");
});
