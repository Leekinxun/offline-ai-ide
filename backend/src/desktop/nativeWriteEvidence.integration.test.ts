import { createCheckpointForRuntime, pruneCheckpointBlobsForRuntime } from "../chat/checkpoints.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getDesktopNativeIde, NativeIdeError, shutdownDesktopNativeIde } from "./nativeIdeClient.js";
import { beginDesktopExternalProcess, mutateDesktopWorkspace, withDesktopWorkspaceWriter } from "./nativeWorkspaceMutation.js";
import { publishDesktopFileMutation, publishDesktopRenameMutation, listFileMutations, buildFileHash } from "../files/mutationRegistry.js";
const executable = process.env.CROWNFORGE_TEST_NATIVE_IDE ?? fileURLToPath(new URL(`../../../desktop/rust/target/debug/crownforge-ide-core${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));

test("native writes commit source and evidence together, serialize owners and keep manual secrets metadata-only", { skip: !fs.existsSync(executable), timeout: 60_000 }, async (t) => {
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "native-write-evidence-")));
  const previous = [process.env.CREWFORGE_DESKTOP, process.env.CROWNFORGE_IDE_CORE_EXECUTABLE];
  process.env.CREWFORGE_DESKTOP = "1"; process.env.CROWNFORGE_IDE_CORE_EXECUTABLE = executable;
  t.after(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); await shutdownDesktopNativeIde();
    for (const [index, name] of ["CREWFORGE_DESKTOP", "CROWNFORGE_IDE_CORE_EXECUTABLE"].entries()) { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; }
    fs.rmSync(workspace, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(workspace, "file.ts"), "export const before = 1;\n", { mode: 0o640 });
  const changed = "export const after = 2;\n";
  const first = await publishDesktopFileMutation({ workspaceDir: workspace, path: "file.ts", source: "assistant_tool", actor: "test", runId: "native-run", toolCallId: "write-1", preimageContent: "export const before = 1;\n", postimageContent: changed });
  assert.equal(fs.readFileSync(path.join(workspace, "file.ts"), "utf8"), changed);
  const record = listFileMutations(workspace, { runId: "native-run" })[0];
  assert.equal(record.id, first.records[0].id); assert.equal(record.postimageHash, buildFileHash(changed));
  assert.ok(Math.abs(record.mtimeMs - fs.statSync(path.join(workspace, "file.ts")).mtimeMs) < 5);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(workspace, "file.ts")).mode & 0o777, 0o640);
  const beforeJournal = fs.readFileSync(path.join(workspace, ".checkpoints", "mutations.json"));
  await assert.rejects(publishDesktopFileMutation({ workspaceDir: workspace, path: "file.ts", source: "assistant_tool", runId: "native-run", preimageContent: "stale image", postimageContent: "overwrite" }));
  assert.deepEqual(fs.readFileSync(path.join(workspace, ".checkpoints", "mutations.json")), beforeJournal);
  assert.equal(fs.readFileSync(path.join(workspace, "file.ts"), "utf8"), changed);
  const inode = fs.statSync(path.join(workspace, "file.ts"), { bigint: true }).ino;
  await publishDesktopRenameMutation({ workspaceDir: workspace, sourcePath: "file.ts", targetPath: "renamed.ts", content: changed, runId: "native-run", toolCallId: "rename-1" });
  assert.ok(!fs.existsSync(path.join(workspace, "file.ts")));
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(workspace, "renamed.ts"), { bigint: true }).ino, inode);
  const order: number[] = [];
  await Promise.all([withDesktopWorkspaceWriter(workspace, "agent-edit", async () => { order.push(1); await new Promise((resolve) => setTimeout(resolve, 20)); order.push(2); }), withDesktopWorkspaceWriter(workspace, "editor", async () => { order.push(3); })]);
  assert.deepEqual(order, [1, 2, 3]);
  await createCheckpointForRuntime(workspace, { label: "native checkpoint shares evidence storage" });
  let unblock!: () => void; const held = new Promise<void>((resolve) => { unblock = resolve; });
  let entered!: () => void; const entry = new Promise<void>((resolve) => { entered = resolve; });
  const holding = withDesktopWorkspaceWriter(workspace, "agent-edit", async () => { entered(); await held; }); await entry;
  let pruned = false; const pruning = pruneCheckpointBlobsForRuntime(workspace, { dryRun: false }).then(() => { pruned = true; });
  await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(pruned, false);
  unblock(); await holding; await pruning;
  for (const record of listFileMutations(workspace)) for (const hash of [record.preimageBlob, record.postimageBlob]) if (hash) assert.ok(fs.existsSync(path.join(workspace, ".checkpoints", "blobs", hash)), hash);
  const guard = await beginDesktopExternalProcess(workspace); assert.ok(guard);
  await assert.rejects(withDesktopWorkspaceWriter(workspace, "agent-edit", async () => undefined), /audit is pending/);
  await withDesktopWorkspaceWriter(workspace, "editor", async () => undefined);
  await guard.audit(() => withDesktopWorkspaceWriter(workspace, "agent-edit", async () => undefined));
  await shutdownDesktopNativeIde(); await guard.release();
  await withDesktopWorkspaceWriter(workspace, "agent-edit", async () => undefined);
  const client = getDesktopNativeIde(), request = client.request, durable = client.requestDurable;
  let lost = false;
  client.requestDurable = (async (method: string, params: Record<string, unknown>, options?: { timeoutMs?: number }) => {
    const result = await Reflect.apply(durable, client, [method, params, options]);
    if (method === "fs.transaction.commit" && !lost) { lost = true; throw new NativeIdeError("Lost commit confirmation", "OUTCOME_UNKNOWN"); }
    return result;
  }) as typeof durable;
  client.request = (async (method: string, params: Record<string, unknown>, options?: unknown) => method === "fs.transaction.status" && lost
    ? { transactionId: params.transactionId, status: "applying", entries: [], publications: [] }
    : Reflect.apply(request, client, [method, params, options])) as typeof request;
  try {
    const reconciled = await mutateDesktopWorkspace(workspace, [{ type: "writeFile", path: "unknown.txt", content: "committed despite lost confirmation", expected: { exists: false } }]);
    assert.equal(reconciled.status, "committed");
  } finally { client.request = request; client.requestDurable = durable; }
  await mutateDesktopWorkspace(workspace, [{ type: "writeFile", path: "next.txt", content: "next owner can write", expected: { exists: false } }]);
  assert.equal(fs.readFileSync(path.join(workspace, "next.txt"), "utf8"), "next owner can write");
  const secret = "NATIVE_SECRET_SHOULD_NOT_BE_COPIED_TO_WAL";
  await mutateDesktopWorkspace(workspace, [{ type: "writeFile", path: ".env", content: secret, expected: { exists: false } }]);
  if (process.platform !== "win32") {
    fs.symlinkSync(".env", path.join(workspace, "alias.txt"));
    const receipt = await mutateDesktopWorkspace(workspace, [{ type: "writeFile", path: "alias.txt", content: secret + "_UPDATED" }]);
    assert.equal(receipt.entries[0].path, "alias.txt"); assert.equal(fs.readFileSync(path.join(workspace, ".env"), "utf8"), secret + "_UPDATED");
    assert.ok(fs.lstatSync(path.join(workspace, "alias.txt")).isSymbolicLink());
  }
  const inspect = (directory: string) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name); if (entry.isDirectory()) inspect(target); else assert.ok(!fs.readFileSync(target).includes(Buffer.from(secret)), target);
  } };
  inspect(path.join(workspace, ".crewforge", "desktop-transactions"));
});
