import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listFileMutations, lookupKnownFileMutation, rollbackFileMutations } from "../files/mutationRegistry.js";
import { TOOL_DISPATCH } from "./tools.js";

test("primary write_file and edit_file preserve exact preimages with run and tool attribution", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-primary-mutations-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspaceDir, "existing.txt"), "before");
  const context = {
    workspaceDir,
    actorName: "primary-user",
    runId: "run-primary",
    requestId: "request-primary",
    toolCallId: "write-call",
  };

  await TOOL_DISPATCH.read_file({ path: "existing.txt" }, context as never);
  await TOOL_DISPATCH.write_file({ path: "existing.txt", content: "after" }, context as never);
  const afterWriteMtimeMs = fs.statSync(path.join(workspaceDir, "existing.txt")).mtimeMs;
  assert.equal(lookupKnownFileMutation(workspaceDir, "existing.txt", { mtimeMs: afterWriteMtimeMs })?.mtimeMs, afterWriteMtimeMs);
  await TOOL_DISPATCH.write_file({ path: "created.txt", content: "created" }, {
    ...context,
    toolCallId: "create-call",
  } as never);
  await TOOL_DISPATCH.edit_file({ path: "existing.txt", old_text: "after", new_text: "edited" }, {
    ...context,
    toolCallId: "edit-call",
  } as never);

  const modified = listFileMutations(workspaceDir, { runId: "run-primary", toolCallId: "write-call" });
  assert.equal(modified.length, 1);
  assert.equal(modified[0].mtimeMs, afterWriteMtimeMs);
  assert.deepEqual(modified[0] && {
    path: modified[0].path,
    operation: modified[0].operation,
    preimageContent: modified[0].preimageContent,
    actor: modified[0].actor,
    requestId: modified[0].requestId,
  }, { path: "existing.txt", operation: "modify", preimageContent: "before", actor: "primary-user", requestId: "request-primary" });
  const created = listFileMutations(workspaceDir, { toolCallId: "create-call" });
  assert.equal(created[0]?.operation, "create");
  assert.equal(created[0]?.preimageContent, undefined);
  const edited = listFileMutations(workspaceDir, { toolCallId: "edit-call" });
  assert.deepEqual(edited[0] && {
    operation: edited[0].operation,
    preimageContent: edited[0].preimageContent,
    rollbackScope: edited[0].rollbackScope,
  }, { operation: "modify", preimageContent: "after", rollbackScope: "hunks" });
  assert.ok(edited[0]?.hunks?.length);
  assert.deepEqual(rollbackFileMutations(workspaceDir, { ids: [edited[0].id], hunkIds: [edited[0].hunks![0].id] }).applied, [edited[0].id]);
  assert.equal(fs.readFileSync(path.join(workspaceDir, "existing.txt"), "utf8"), "after");

  await TOOL_DISPATCH.write_file({ path: "created.txt", content: "created" }, {
    ...context,
    toolCallId: "no-op-call",
  } as never);
  assert.equal(listFileMutations(workspaceDir, { toolCallId: "no-op-call" }).length, 0);
});

test("write_file prepares mutation evidence before changing existing files", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-write-prepare-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const target = path.join(workspaceDir, "existing.txt");
  fs.writeFileSync(target, "before");
  const context = { workspaceDir, actorName: "primary-user", runId: "run-primary", requestId: "request-primary", toolCallId: "write-call" };
  await TOOL_DISPATCH.read_file({ path: "existing.txt" }, context as never);
  fs.mkdirSync(path.join(workspaceDir, ".checkpoints"));
  fs.writeFileSync(path.join(workspaceDir, ".checkpoints/blobs"), "blocked storage");

  const result = await TOOL_DISPATCH.write_file({ path: "existing.txt", content: "after" }, context as never);

  assert.match(String(result), /^Error:/);
  assert.equal(fs.readFileSync(target, "utf8"), "before");
});

test("write_file journal commit failure restores the old file without persisting a mutation", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-write-commit-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const target = path.join(workspaceDir, "existing.txt");
  fs.writeFileSync(target, "before");
  fs.chmodSync(target, 0o640);
  const context = { workspaceDir, actorName: "primary-user", runId: "run-primary", requestId: "request-primary", toolCallId: "write-call" };
  await TOOL_DISPATCH.read_file({ path: "existing.txt" }, context as never);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (source: fs.PathLike, destination: fs.PathLike) => {
    if (String(destination).endsWith("/mutations.json")) throw new Error("injected journal commit failure");
    return rename(source, destination);
  });

  const result = await TOOL_DISPATCH.write_file({ path: "existing.txt", content: "after" }, context as never);

  assert.match(String(result), /^Error: injected journal commit failure/);
  assert.equal(fs.readFileSync(target, "utf8"), "before");
  assert.equal(fs.statSync(target).mode & 0o777, 0o640);
  assert.equal(listFileMutations(workspaceDir).length, 0);
});

test("write_file journal commit failure deletes a newly created file", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-create-commit-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const context = { workspaceDir, actorName: "primary-user", runId: "run-primary", requestId: "request-primary", toolCallId: "create-call" };
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (source: fs.PathLike, destination: fs.PathLike) => {
    if (String(destination).endsWith("/mutations.json")) throw new Error("injected journal commit failure");
    return rename(source, destination);
  });

  const result = await TOOL_DISPATCH.write_file({ path: "created.txt", content: "created", expected_version: "missing" }, context as never);

  assert.match(String(result), /^Error: injected journal commit failure/);
  assert.equal(fs.existsSync(path.join(workspaceDir, "created.txt")), false);
  assert.equal(listFileMutations(workspaceDir).length, 0);
});

test("write_file journal commit failure preserves concurrent target changes and retained recovery data", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-write-concurrent-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const target = path.join(workspaceDir, "existing.txt");
  fs.writeFileSync(target, "before");
  const context = { workspaceDir, actorName: "primary-user", runId: "run-primary", requestId: "request-primary", toolCallId: "write-call" };
  await TOOL_DISPATCH.read_file({ path: "existing.txt" }, context as never);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (source: fs.PathLike, destination: fs.PathLike) => {
    if (String(destination).endsWith("/mutations.json")) {
      fs.writeFileSync(target, "concurrent change");
      throw new Error("journal failure after concurrent change");
    }
    return rename(source, destination);
  });

  const result = await TOOL_DISPATCH.write_file({ path: "existing.txt", content: "after" }, context as never);

  assert.match(String(result), /recovery data is retained/);
  assert.equal(fs.readFileSync(target, "utf8"), "concurrent change");
  const recovery = fs.readdirSync(workspaceDir).find((entry) => entry.includes(".agent-backup-"));
  assert.ok(recovery);
  assert.equal(fs.readFileSync(path.join(workspaceDir, recovery), "utf8"), "before");
  assert.equal(listFileMutations(workspaceDir).length, 0);
});

test("write_file commit failure does not restore over a same-content replacement", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-write-same-content-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const target = path.join(workspaceDir, "existing.txt");
  fs.writeFileSync(target, "before");
  const original = fs.statSync(target);
  const context = { workspaceDir, actorName: "primary-user", runId: "run-primary", requestId: "request-primary", toolCallId: "write-call" };
  await TOOL_DISPATCH.read_file({ path: "existing.txt" }, context as never);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (source: fs.PathLike, destination: fs.PathLike) => {
    if (String(destination).endsWith("/mutations.json")) {
      fs.unlinkSync(target);
      fs.writeFileSync(target, "after");
      throw new Error("journal failure after same-content replacement");
    }
    return rename(source, destination);
  });

  const result = await TOOL_DISPATCH.write_file({ path: "existing.txt", content: "after" }, context as never);

  assert.match(String(result), /recovery data is retained/);
  assert.equal(fs.readFileSync(target, "utf8"), "after");
  assert.notEqual(fs.statSync(target).ino, original.ino);
  const recovery = fs.readdirSync(workspaceDir).find((entry) => entry.includes(".agent-backup-"));
  assert.ok(recovery);
  assert.equal(fs.readFileSync(path.join(workspaceDir, recovery), "utf8"), "before");
  assert.equal(listFileMutations(workspaceDir).length, 0);
});

test("created-file commit failure does not delete a same-content replacement", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-create-same-content-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const target = path.join(workspaceDir, "created.txt");
  const context = { workspaceDir, actorName: "primary-user", runId: "run-primary", requestId: "request-primary", toolCallId: "create-call" };
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (source: fs.PathLike, destination: fs.PathLike) => {
    if (String(destination).endsWith("/mutations.json")) {
      fs.unlinkSync(target);
      fs.writeFileSync(target, "created");
      throw new Error("journal failure after same-content replacement");
    }
    return rename(source, destination);
  });

  const result = await TOOL_DISPATCH.write_file({ path: "created.txt", content: "created", expected_version: "missing" }, context as never);

  assert.match(String(result), /concurrent file change|file changed/i);
  assert.equal(fs.readFileSync(target, "utf8"), "created");
  assert.equal(fs.readdirSync(workspaceDir).some((entry) => entry.includes(".agent-backup-")), false);
  assert.equal(listFileMutations(workspaceDir).length, 0);
});

test("write_file restores through the same recovery path when post-write stat fails", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-write-stat-fail-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const target = path.join(workspaceDir, "existing.txt");
  fs.writeFileSync(target, "before");
  const context = { workspaceDir, actorName: "primary-user", runId: "run-primary", requestId: "request-primary", toolCallId: "write-call" };
  await TOOL_DISPATCH.read_file({ path: "existing.txt" }, context as never);
  const statSync = fs.statSync;
  let injected = false;
  t.mock.method(fs, "statSync", (targetPath: fs.PathLike) => {
    if (String(targetPath).endsWith("/existing.txt") && !injected) {
      injected = true;
      throw new Error("injected post-write stat failure");
    }
    return statSync(targetPath);
  });

  const result = await TOOL_DISPATCH.write_file({ path: "existing.txt", content: "after" }, context as never);

  assert.match(String(result), /^Error: injected post-write stat failure/);
  assert.equal(fs.readFileSync(target, "utf8"), "before");
  assert.equal(listFileMutations(workspaceDir).length, 0);
});
