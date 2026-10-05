import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { notifyWorkspaceMutation } from "../files/mutationRegistry.js";
import { beginDesktopExternalToolEffects, listDesktopExternalToolEffects } from "./nativeExternalEffects.js";
import { shutdownDesktopNativeIde } from "./nativeIdeClient.js";
import { beginDesktopExternalProcess, mutateDesktopWorkspace, withDesktopWorkspaceWriter } from "./nativeWorkspaceMutation.js";

const executable = process.env.CROWNFORGE_TEST_NATIVE_IDE ?? fileURLToPath(new URL(`../../../desktop/rust/target/debug/crownforge-ide-core${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
const native = { skip: !fs.existsSync(executable), timeout: 60_000 };

async function fixture(t: TestContext): Promise<string> {
  await shutdownDesktopNativeIde();
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "native-external-effects-")));
  const previous = [process.env.CREWFORGE_DESKTOP, process.env.CROWNFORGE_IDE_CORE_EXECUTABLE];
  process.env.CREWFORGE_DESKTOP = "1";
  process.env.CROWNFORGE_IDE_CORE_EXECUTABLE = executable;
  t.after(async () => {
    await shutdownDesktopNativeIde();
    for (const [index, name] of ["CREWFORGE_DESKTOP", "CROWNFORGE_IDE_CORE_EXECUTABLE"].entries()) {
      if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index];
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  return workspace;
}

test("native external effects record metadata above checkpoint workspace limits without reading workspace contents", native, async (t) => {
  const workspace = await fixture(t);
  fs.mkdirSync(path.join(workspace, "many"));
  for (let index = 0; index < 20_001; index++) fs.writeFileSync(path.join(workspace, "many", `${index}.txt`), "");
  const large = path.join(workspace, "large.dat");
  const descriptor = fs.openSync(large, "w");
  fs.ftruncateSync(descriptor, 65 * 1024 * 1024);
  fs.closeSync(descriptor);
  const read = fs.readFileSync;
  const entries = fs.readdirSync;
  fs.readFileSync = ((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(target) === large) throw new Error("external effects must not back up workspace bytes");
    return Reflect.apply(read, fs, [target, ...args]);
  }) as typeof read;
  fs.readdirSync = ((target: fs.PathLike, ...args: unknown[]) => {
    if ([workspace, path.join(workspace, "many")].includes(String(target))) throw new Error("external effects must not scan the workspace");
    return Reflect.apply(entries, fs, [target, ...args]);
  }) as typeof entries;
  try {
    const guard = await beginDesktopExternalProcess(workspace);
    assert.ok(guard);
    try {
      const audit = await beginDesktopExternalToolEffects(workspace, { runId: "large-run", requestId: "request-1", toolCallId: "command-1", toolName: "bash" }, guard);
      assert.ok(audit);
      const initial = listDesktopExternalToolEffects(workspace, { runId: "large-run", expectedToolCallIds: ["command-1"] })[0];
      assert.equal(initial.rollbackCoverage, "untracked");
      assert.equal(initial.finishedAt, undefined);
      execFileSync(process.execPath, ["-e", "require('fs').writeFileSync('command-result.txt', 'actual shell effect')"], { cwd: workspace });
      const finishing = audit.finish();
      assert.equal(finishing, audit.finish());
      const final = await finishing;
      assert.ok(final.finishedAt);
      assert.equal(final.observationComplete, false);
      assert.deepEqual(final.observedPaths, []);
      assert.deepEqual(listDesktopExternalToolEffects(workspace, { runId: "large-run", requestId: "request-1", expectedToolCallIds: ["command-1"] }), [final]);
      assert.equal(fs.existsSync(path.join(workspace, ".checkpoints")), false);
      assert.equal(fs.readFileSync(path.join(workspace, "command-result.txt"), "utf8"), "actual shell effect");
    } finally { await guard.release(); }
  } finally { fs.readFileSync = read; fs.readdirSync = entries; }
});

test("native external metadata finish permits human edits and refuses source publication in its audit scope", native, async (t) => {
  const workspace = await fixture(t);
  const guard = await beginDesktopExternalProcess(workspace);
  assert.ok(guard);
  try {
    const audit = await beginDesktopExternalToolEffects(workspace, { runId: "human-run", toolCallId: "tool-1", toolName: "mcp_fixture" }, guard);
    assert.ok(audit);
    await guard.audit(() => withDesktopWorkspaceWriter(workspace, "agent-edit", async () => {
      await assert.rejects(guard.metadata(() => mutateDesktopWorkspace(workspace, [{ type: "writeFile", path: "nested-forbidden.txt", content: "must not publish" }], { intent: "agent-edit" })), /cannot publish workspace files/);
    }));
    assert.equal(fs.existsSync(path.join(workspace, "nested-forbidden.txt")), false);
    await mutateDesktopWorkspace(workspace, [{ type: "writeFile", path: "human.txt", content: "user saved" }], { intent: "editor" });
    notifyWorkspaceMutation({ workspaceDir: workspace, path: "human.txt", operation: "create" });
    await assert.rejects(guard.audit(async () => undefined), /Concurrent edits/);
    const final = await audit.finish();
    assert.ok(final.finishedAt);
    assert.equal(final.rollbackCoverage, "untracked");
    await assert.rejects(guard.metadata(() => mutateDesktopWorkspace(workspace, [{ type: "writeFile", path: "forbidden.txt", content: "must not publish" }], { intent: "agent-edit" })), /cannot publish workspace files/);
    assert.equal(fs.existsSync(path.join(workspace, "forbidden.txt")), false);
    assert.equal(fs.readFileSync(path.join(workspace, "human.txt"), "utf8"), "user saved");
  } finally { await guard.release(); }
});

test("native external effects refuse corrupted and deleted expected receipts", native, async (t) => {
  const workspace = await fixture(t);
  const audit = await beginDesktopExternalToolEffects(workspace, { runId: "corrupt-run", toolCallId: "tool-1", toolName: "bash" });
  assert.ok(audit);
  await audit.finish();
  const directory = path.join(workspace, ".history/external-tools");
  const receipt = path.join(directory, fs.readdirSync(directory)[0]);
  const original = fs.readFileSync(receipt);
  fs.writeFileSync(receipt, "{malformed");
  assert.throws(() => listDesktopExternalToolEffects(workspace, { runId: "corrupt-run" }), /invalid or unreadable/);
  fs.writeFileSync(receipt, original);
  fs.unlinkSync(receipt);
  assert.throws(() => listDesktopExternalToolEffects(workspace, { runId: "corrupt-run", expectedToolCallIds: ["tool-1"] }), /missing, invalid or unreadable/);
});

test("native external effects initial publication preserves unresolved transaction admission fences", native, async (t) => {
  const workspace = await fixture(t);
  await mutateDesktopWorkspace(workspace, [{ type: "writeFile", path: "source.txt", content: "preserve" }], { transactionId: "blocked-transaction", intent: "editor" });
  const receiptPath = path.join(workspace, ".crewforge/desktop-transactions/blocked-transaction/transaction.json");
  const plan = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  plan.phase = "needs_attention";
  plan.attention = "fixture interrupted transaction";
  fs.writeFileSync(receiptPath, JSON.stringify(plan));
  const guard = await beginDesktopExternalProcess(workspace);
  assert.ok(guard);
  try {
    await assert.rejects(beginDesktopExternalToolEffects(workspace, { runId: "blocked-run", toolCallId: "tool-1", toolName: "bash" }, guard), /unresolved transactions requiring attention/);
    assert.deepEqual(listDesktopExternalToolEffects(workspace, { runId: "blocked-run" }), []);
    assert.equal(fs.readFileSync(path.join(workspace, "source.txt"), "utf8"), "preserve");
  } finally { await guard.release(); }
});

test("native external effects finish errors preserve untracked intent without becoming execution failures", native, async (t) => {
  const workspace = await fixture(t);
  const audit = await beginDesktopExternalToolEffects(workspace, { runId: "finish-error-run", toolCallId: "tool-1", toolName: "bash" });
  assert.ok(audit);
  const directory = path.join(workspace, ".history/external-tools");
  fs.writeFileSync(path.join(directory, fs.readdirSync(directory)[0]), "{corrupt during command");
  const finished = await audit.finish();
  assert.equal(finished.finishedAt, undefined);
  assert.equal(finished.rollbackCoverage, "untracked");
  assert.equal(finished.observationComplete, false);
  assert.throws(() => listDesktopExternalToolEffects(workspace, { runId: "finish-error-run", expectedToolCallIds: ["tool-1"] }), /missing, invalid or unreadable/);
});

test("native delegated effects belong to the parent run while retaining the physical child's recovery fence", native, async (t) => {
  const container = await fixture(t);
  const parent = path.join(container, "parent");
  const child = path.join(container, "child");
  fs.mkdirSync(parent);
  fs.mkdirSync(child);
  const guard = await beginDesktopExternalProcess(child);
  assert.ok(guard);
  try {
    const audit = await beginDesktopExternalToolEffects(child, { runId: "child-run", requestId: "child-request", toolCallId: "child-command", toolName: "bash" }, guard, parent);
    assert.ok(audit);
    const initial = listDesktopExternalToolEffects(parent, { runId: "child-run", expectedToolCallIds: ["child-command"] });
    assert.equal(initial.length, 1);
    assert.equal(initial[0].finishedAt, undefined);
    assert.deepEqual(listDesktopExternalToolEffects(child, { runId: "child-run" }), []);
    execFileSync(process.execPath, ["-e", "require('fs').writeFileSync('child-result.txt', 'child effect')"], { cwd: child });
    await mutateDesktopWorkspace(child, [{ type: "writeFile", path: "human.txt", content: "human save during child command" }], { intent: "editor" });
    notifyWorkspaceMutation({ workspaceDir: child, path: "human.txt", operation: "create" });
    const final = await audit.finish();
    assert.ok(final.finishedAt);
    assert.deepEqual(listDesktopExternalToolEffects(parent, { runId: "child-run", requestId: "child-request", expectedToolCallIds: ["child-command"] }), [final]);
    assert.equal(fs.readFileSync(path.join(child, "child-result.txt"), "utf8"), "child effect");
    assert.equal(fs.existsSync(path.join(parent, "child-result.txt")), false);
  } finally { await guard.release(); }

  await mutateDesktopWorkspace(child, [{ type: "writeFile", path: "source.txt", content: "preserve" }], { transactionId: "blocked-child", intent: "editor" });
  const transaction = path.join(child, ".crewforge/desktop-transactions/blocked-child/transaction.json");
  const plan = JSON.parse(fs.readFileSync(transaction, "utf8"));
  plan.phase = "needs_attention";
  plan.attention = "fixture physical child transaction needs recovery";
  fs.writeFileSync(transaction, JSON.stringify(plan));
  const blocked = await beginDesktopExternalProcess(child);
  assert.ok(blocked);
  try {
    await assert.rejects(beginDesktopExternalToolEffects(child, { runId: "blocked-child-run", toolCallId: "blocked-command", toolName: "bash" }, blocked, parent), /unresolved transactions requiring attention/);
    assert.deepEqual(listDesktopExternalToolEffects(parent, { runId: "blocked-child-run" }), []);
    assert.equal(fs.readFileSync(path.join(child, "source.txt"), "utf8"), "preserve");
  } finally { await blocked.release(); }
});

test("native delegated effects never publish finish into a replaced parent evidence root", native, async (t) => {
  const container = await fixture(t);
  const parent = path.join(container, "parent");
  const child = path.join(container, "child");
  fs.mkdirSync(parent);
  fs.mkdirSync(child);
  const guard = await beginDesktopExternalProcess(child);
  assert.ok(guard);
  try {
    const audit = await beginDesktopExternalToolEffects(child, { runId: "replaced-parent-run", toolCallId: "child-command", toolName: "bash" }, guard, parent);
    assert.ok(audit);
    const evidence = path.join(parent, ".history/external-tools");
    const key = fs.readdirSync(evidence)[0];
    const initial = fs.readFileSync(path.join(evidence, key));
    fs.renameSync(parent, `${parent}-original`);
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(evidence, key), initial);
    const finished = await audit.finish();
    assert.equal(finished.finishedAt, undefined);
    assert.deepEqual(fs.readFileSync(path.join(evidence, key)), initial);
    assert.deepEqual(fs.readFileSync(path.join(`${parent}-original`, ".history/external-tools", key)), initial);
  } finally { await guard.release(); }
});

test("native external effects preserve reused tool IDs across steering request identities", native, async (t) => {
  const workspace = await fixture(t);
  const first = await beginDesktopExternalToolEffects(workspace, { runId: "steered-run", requestId: "request-1", toolCallId: "reused-id", toolName: "bash" });
  const second = await beginDesktopExternalToolEffects(workspace, { runId: "steered-run", requestId: "request-2", toolCallId: "reused-id", toolName: "bash" });
  assert.ok(first);
  assert.ok(second);
  const expectedExecutions = [{ requestId: "request-1", toolCallId: "reused-id" }, { requestId: "request-2", toolCallId: "reused-id" }];
  const initial = listDesktopExternalToolEffects(workspace, { runId: "steered-run", expectedExecutions });
  assert.equal(initial.length, 2);
  assert.ok(initial.every((receipt) => receipt.finishedAt === undefined));
  await first.finish();
  await second.finish();
  for (const requestId of ["request-1", "request-2"]) {
    const receipts = listDesktopExternalToolEffects(workspace, { runId: "steered-run", requestId, expectedExecutions: [{ requestId, toolCallId: "reused-id" }], expectedToolCallIds: ["reused-id"] });
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].requestId, requestId);
    assert.ok(receipts[0].finishedAt);
  }
  const directory = path.join(workspace, ".history/external-tools");
  const secondKey = fs.readdirSync(directory).find((key) => JSON.parse(fs.readFileSync(path.join(directory, key), "utf8")).requestId === "request-2");
  assert.ok(secondKey);
  fs.unlinkSync(path.join(directory, secondKey));
  assert.throws(() => listDesktopExternalToolEffects(workspace, { runId: "steered-run", expectedExecutions }), /missing, invalid or unreadable/);
  assert.throws(() => listDesktopExternalToolEffects(workspace, { runId: "steered-run", requestId: "request-2", expectedToolCallIds: ["reused-id"] }), /missing/);
  assert.equal(listDesktopExternalToolEffects(workspace, { runId: "steered-run", requestId: "request-1", expectedExecutions: [expectedExecutions[0]] }).length, 1);
});
