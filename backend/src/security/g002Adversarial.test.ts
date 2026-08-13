import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyChangeSetDecision, captureChangeSet, ChangeSetStoreCorruptionError, getChangeSet, preflightChangeSetDecision } from "../chat/changeSets.js";
import { scheduleChangeSetReview } from "../chat/changeSetReviewRun.js";
import { restoreCheckpoint, verifyCheckpointBlobs } from "../chat/checkpoints.js";
import { createManagedWorktree } from "../chat/worktrees.js";
import { recordFileMutation, rollbackFileMutations } from "../files/mutationRegistry.js";
import { safePath } from "../utils/safePath.js";
import { evaluateNetworkAccess, normalizeNetworkHost } from "../agent/networkPolicy.js";
import { PolicyAuditLog } from "../agent/policyAudit.js";
import { runWorkspaceProcess } from "../agent/processSandbox.js";
import { redactSecrets } from "../agent/secretRedaction.js";
import { evaluateShellCommand } from "../agent/toolPolicy.js";

function temporary(t: test.TestContext, prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function git(directory: string, args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repository(t: test.TestContext): string {
  const directory = path.join(temporary(t, "crewforge-g002-repo-"), "repo");
  fs.mkdirSync(directory);
  git(directory, ["init"]); git(directory, ["config", "user.email", "g002@example.test"]); git(directory, ["config", "user.name", "G002"]);
  fs.writeFileSync(path.join(directory, "shared.txt"), "base\n");
  git(directory, ["add", "."]); git(directory, ["commit", "-m", "base"]);
  return directory;
}

test("checkpoint restore rejects legacy, v2, and future manifest paths that escape the workspace", (t) => {
  const workspace = temporary(t, "crewforge-g002-checkpoint-");
  const outside = path.join(path.dirname(workspace), `g002-escaped-${Date.now()}`);
  t.after(() => fs.rmSync(outside, { force: true }));
  const id = "1234567890-deadbeef";
  const hash = crypto.createHash("sha256").update("payload").digest("hex");
  fs.mkdirSync(path.join(workspace, ".checkpoints", "blobs"), { recursive: true });
  fs.mkdirSync(path.join(workspace, ".checkpoints", "manifests"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".checkpoints", "blobs", hash), "payload");
  fs.writeFileSync(path.join(workspace, ".checkpoints", "manifests", `${id}.json`), JSON.stringify({ version: 2, checkpointId: id, files: [{ path: "../../" + path.basename(outside), sha256: hash, size: 7 }] }));
  fs.writeFileSync(path.join(workspace, ".checkpoints", "index.json"), JSON.stringify([{ id, label: "untrusted-v2", createdAt: 1, fileCount: 1, totalBytes: 7, files: [], storageVersion: 2, manifest: path.join(workspace, ".checkpoints", "manifests", `${id}.json`) }]));

  assert.throws(() => restoreCheckpoint(workspace, id), /path traversal|escape|invalid/i);
  assert.equal(fs.existsSync(outside), false, "a hostile checkpoint must not write outside its workspace");

  // v3 changes use the same untrusted paths and must receive the same boundary check.
  const v3 = "1234567891-deadbeef";
  fs.writeFileSync(path.join(workspace, ".checkpoints", "manifests", `${v3}.json`), JSON.stringify({ version: 3, checkpointId: v3, changes: [{ operation: "upsert", path: "../../" + path.basename(outside), sha256: hash, size: 7 }] }));
  fs.writeFileSync(path.join(workspace, ".checkpoints", "index.json"), JSON.stringify([{ id: v3, label: "untrusted-v3", createdAt: 2, fileCount: 1, totalBytes: 7, files: [], storageVersion: 3, manifest: path.join(workspace, ".checkpoints", "manifests", `${v3}.json`) }]));
  assert.throws(() => restoreCheckpoint(workspace, v3), /path|unsafe|invalid/i);

  const legacy = "1234567892-deadbeef";
  fs.mkdirSync(path.join(workspace, ".checkpoints", legacy, "files"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".checkpoints", legacy, "files", "sentinel"), "payload");
  fs.writeFileSync(path.join(workspace, ".checkpoints", "index.json"), JSON.stringify([{ id: legacy, label: "untrusted-legacy", createdAt: 3, fileCount: 1, totalBytes: 7, files: ["../../" + path.basename(outside)] }]));
  assert.throws(() => restoreCheckpoint(workspace, legacy), /path|unsafe|invalid/i);
});

test("checkpoint integrity detects blob corruption before restoring a v2 checkpoint", (t) => {
  const workspace = temporary(t, "crewforge-g002-integrity-");
  const checkpoint = "1234567893-deadbeef";
  const original = "trusted"; const hash = crypto.createHash("sha256").update(original).digest("hex");
  fs.mkdirSync(path.join(workspace, ".checkpoints", "blobs"), { recursive: true });
  fs.mkdirSync(path.join(workspace, ".checkpoints", "manifests"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".checkpoints", "blobs", hash), "tampered");
  fs.writeFileSync(path.join(workspace, ".checkpoints", "manifests", `${checkpoint}.json`), JSON.stringify({ version: 2, checkpointId: checkpoint, files: [{ path: "a.txt", sha256: hash, size: original.length }] }));
  fs.writeFileSync(path.join(workspace, ".checkpoints", "index.json"), JSON.stringify([{ id: checkpoint, label: "v2", createdAt: 1, fileCount: 1, totalBytes: original.length, files: ["a.txt"], storageVersion: 2, manifest: path.join(workspace, ".checkpoints", "manifests", `${checkpoint}.json`) }]));
  assert.equal(verifyCheckpointBlobs(workspace, checkpoint).valid, false);
  assert.throws(() => restoreCheckpoint(workspace, checkpoint), /corrupt/i);
});

test("manual edits conflict while an exact selected hunk rolls back independently", (t) => {
  const workspace = temporary(t, "crewforge-g002-hunks-");
  const file = path.join(workspace, "a.txt");
  fs.writeFileSync(file, "first=after\nsecond=after\nmanual=kept\n");
  const mutation = recordFileMutation({ workspaceDir: workspace, path: "a.txt", source: "assistant_tool", runId: "run", toolCallId: "tool", preimageContent: "first=before\nsecond=before\n", postimageContent: "first=after\nsecond=after\nmanual=kept\n", hunks: [{ id: "first", preimage: "first=before", postimage: "first=after" }, { id: "second", preimage: "second=before", postimage: "second=after" }] });
  const first = rollbackFileMutations(workspace, { ids: [mutation.id], hunkIds: ["first"] });
  assert.deepEqual(first.applied, [mutation.id]);
  assert.equal(fs.readFileSync(file, "utf8"), "first=before\nsecond=after\nmanual=kept\n");
  fs.writeFileSync(file, "first=before\nsecond=manual-edit\nmanual=kept\n");
  const conflict = rollbackFileMutations(workspace, { ids: [mutation.id], hunkIds: ["second"] });
  assert.equal(conflict.applied.length, 0); assert.equal(conflict.conflicts.length, 1);
});

test("safe path rejects traversal and existing-parent symlink escapes, including creates", { skip: process.platform === "win32" }, (t) => {
  const workspace = temporary(t, "crewforge-g002-path-");
  const outside = temporary(t, "crewforge-g002-outside-");
  fs.symlinkSync(outside, path.join(workspace, "redirect"));
  assert.throws(() => safePath("../outside", workspace), /traversal/i);
  assert.throws(() => safePath("redirect/new-file.txt", workspace), /symbolic link/i);
});

test("shell policy rejects composition and alternate interpreters unless the narrow compatibility grant is present", () => {
  for (const command of ["echo ok; id", "echo ok | sh", "bash -c id", "python -c 'print(1)'", "$(id)", "echo ok > ../escape"]) {
    assert.equal(evaluateShellCommand(command).allowed, false, command);
  }
  assert.equal(evaluateShellCommand("printf ok | wc -c", { compatibilityShellAuthorized: true }).allowed, true);
});

test("process abort reaches ordinary grandchildren promptly and inherited secret canaries stay absent", { skip: process.platform === "win32" }, async (t) => {
  const workspace = temporary(t, "crewforge-g002-process-");
  const marker = path.join(workspace, "grandchild-survived");
  const secret = "G002_PROCESS_SECRET";
  process.env[secret] = "canary-never-visible";
  try {
    const controller = new AbortController();
    const grandchild = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad'), 700)`;
    const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); setInterval(() => {}, 10000)`;
    const started = Date.now();
    const pending = runWorkspaceProcess({ executable: process.execPath, args: ["-e", parent], cwd: workspace, signal: controller.signal, env: { G002_EXPLICIT: "only-this" } });
    setTimeout(() => controller.abort(), 30);
    assert.match(await pending, /stopped/i); assert.ok(Date.now() - started < 5_000);
    const canary = await runWorkspaceProcess({ executable: process.execPath, args: ["-e", `process.stdout.write(String(process.env.${secret}) + ':' + process.env.G002_EXPLICIT)`], cwd: workspace, env: { G002_EXPLICIT: "only-this" } });
    assert.equal(canary, "undefined:only-this");
    await new Promise((resolve) => setTimeout(resolve, 900)); assert.equal(fs.existsSync(marker), false);
  } finally { delete process.env[secret]; }
});

test("network grants require an exact host and port and do not accept URL or redirect-shaped input", () => {
  assert.equal(evaluateNetworkAccess("api.example.test", 443).allowed, false);
  assert.equal(evaluateNetworkAccess("api.example.test", 443, [{ host: "api.example.test", port: 443 }]).allowed, true);
  for (const hostile of ["https://api.example.test", "api.example.test/redirect", "user@api.example.test", "*.example.test"]) assert.equal(normalizeNetworkHost(hostile), undefined, hostile);
});

test("two isolated children with one write path cannot change the parent; corruption and parent drift block review", (t) => {
  const parent = repository(t); const one = createManagedWorktree(parent, { name: "one" }); const two = createManagedWorktree(parent, { name: "two" });
  fs.writeFileSync(path.join(one.path, "shared.txt"), "one\n"); git(one.path, ["add", "shared.txt"]); git(one.path, ["commit", "-m", "one"]);
  fs.writeFileSync(path.join(two.path, "shared.txt"), "two\n"); git(two.path, ["add", "shared.txt"]); git(two.path, ["commit", "-m", "two"]);
  const first = captureChangeSet(parent, one.id); const second = captureChangeSet(parent, two.id);
  assert.equal(git(parent, ["show", "HEAD:shared.txt"]), "base");
  assert.equal(preflightChangeSetDecision(parent, second, "apply").applicable, false, "overlapping unreviewed children must block apply");
  const blob = path.join(parent, ".history", "change-sets", second.patchBlob!); const originalBlob = fs.readFileSync(blob);
  fs.writeFileSync(blob, "corrupt");
  assert.throws(() => preflightChangeSetDecision(parent, second, "apply"), ChangeSetStoreCorruptionError);
  assert.throws(() => applyChangeSetDecision(parent, second, "apply"), ChangeSetStoreCorruptionError);
  assert.equal(git(parent, ["show", "HEAD:shared.txt"]), "base");
  fs.writeFileSync(blob, originalBlob);
  // The first changeset is also blocked once the parent moves away from its recorded base.
  fs.writeFileSync(path.join(parent, "parent-only.txt"), "drift\n"); git(parent, ["add", "parent-only.txt"]); git(parent, ["commit", "-m", "drift"]);
  const drift = preflightChangeSetDecision(parent, first, "apply"); assert.equal(drift.threeWayConflict, true);
});

test("ChangeSet integrity binds dirty semantics so merge and cherry-pick cannot drop untracked bytes", async (t) => {
  for (const decision of ["apply", "merge", "cherry_pick"] as const) {
    await t.test(decision, () => {
      const parent = repository(t); const child = createManagedWorktree(parent, { name: `integrity-${decision}`, ownerId: "writer" });
      fs.writeFileSync(path.join(child.path, "shared.txt"), `${decision}\n`); git(child.path, ["add", "shared.txt"]); git(child.path, ["commit", "-m", decision]);
      fs.writeFileSync(path.join(child.path, "untracked.txt"), `must survive ${decision}\n`);
      const changeSet = captureChangeSet(parent, child.id, { passed: true });
      assert.equal(changeSet.dirty, true);
      const metadataPath = path.join(parent, ".history", "change-sets", `${changeSet.id}.json`);
      const tampered = JSON.parse(fs.readFileSync(metadataPath, "utf8")); tampered.dirty = false;
      fs.writeFileSync(metadataPath, `${JSON.stringify(tampered, null, 2)}\n`);
      assert.throws(() => getChangeSet(parent, changeSet.id), (error: unknown) => error instanceof ChangeSetStoreCorruptionError && error.recoveryStatus === "needs_attention");
      assert.throws(() => preflightChangeSetDecision(parent, changeSet.id, decision), ChangeSetStoreCorruptionError);
      assert.throws(() => scheduleChangeSetReview(parent, changeSet.id, "reviewer"), ChangeSetStoreCorruptionError);
      assert.throws(() => applyChangeSetDecision(parent, changeSet.id, decision), ChangeSetStoreCorruptionError);
      assert.equal(git(parent, ["show", "HEAD:shared.txt"]), "base");
      assert.equal(fs.existsSync(path.join(parent, "untracked.txt")), false);
    });
  }
});

test("changesets explicitly refuse protected metadata patches instead of relying on git apply failure", (t) => {
  const parent = repository(t); const child = createManagedWorktree(parent, { name: "metadata" });
  fs.mkdirSync(path.join(child.path, ".history"), { recursive: true });
  fs.writeFileSync(path.join(child.path, ".history", "policy-audit.jsonl"), "forged metadata\n");
  const protectedSet = captureChangeSet(parent, child.id);
  const protectedPreflight = preflightChangeSetDecision(parent, protectedSet, "apply");
  assert.equal(protectedPreflight.applicable, false, "a child must never deliver a patch for parent metadata");
  assert.match(protectedPreflight.reasons.join(";"), /protected|metadata|history/i);
});

test("changesets refuse symlinked patch blobs even when their digest still matches", { skip: process.platform === "win32" }, (t) => {
  const parent = repository(t); const ordinary = createManagedWorktree(parent, { name: "symlink" });
  fs.writeFileSync(path.join(ordinary.path, "shared.txt"), "ordinary\n"); git(ordinary.path, ["add", "shared.txt"]); git(ordinary.path, ["commit", "-m", "ordinary"]);
  const changeSet = captureChangeSet(parent, ordinary.id);
  const blob = path.join(parent, ".history", "change-sets", changeSet.patchBlob!);
  const external = path.join(temporary(t, "crewforge-g002-external-blob-"), "patch");
  fs.copyFileSync(blob, external); fs.rmSync(blob); fs.symlinkSync(external, blob);
  assert.throws(() => preflightChangeSetDecision(parent, changeSet, "apply"), (error: unknown) =>
    error instanceof ChangeSetStoreCorruptionError && /symlink|symbolic|regular|blob/i.test(error.message)
  );
});

test("policy audit and prompt-boundary redaction do not preserve secret canaries after tampering", (t) => {
  const file = path.join(temporary(t, "crewforge-g002-audit-"), "audit.jsonl");
  const audit = new PolicyAuditLog(file); const canary = "g002-secret-canary-123456";
  audit.append({ runId: "run-canary", workspace: "workspace", requestId: "request", toolCallId: "call", toolName: "mcp", allowed: false, input: { apiKey: canary, nested: `Bearer ${canary}` } });
  assert.equal(audit.verify().valid, true); assert.doesNotMatch(fs.readFileSync(file, "utf8"), new RegExp(canary));
  const redacted = redactSecrets({ model: "model", runId: "run-canary", mcp: { token: canary, endpoint: `https://user:${canary}@example.test/?api_key=${canary}` } });
  assert.doesNotMatch(JSON.stringify(redacted), new RegExp(canary));
  fs.appendFileSync(file, '{"tampered":true}\n'); assert.equal(audit.verify().valid, false);
});
