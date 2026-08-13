import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { captureChangeSet } from "../chat/changeSets.js";
import { listChangeSetReviewRuns, scheduleChangeSetReview, setChangeSetReviewRunnerForTests } from "../chat/changeSetReviewRun.js";
import { createManagedWorktree } from "../chat/worktrees.js";
import { GitDeliveryError, GitDeliveryService } from "../integrations/gitDelivery/service.js";
import type { GitDeliveryActor, GitOperation } from "../integrations/gitDelivery/types.js";

const execFileAsync = promisify(execFile);
const owner: GitDeliveryActor = { username: "operator", isAdmin: false, teamRole: "owner" };

function git(directory: string, args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repository(t: test.TestContext): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-git-delivery-"));
  const directory = path.join(parent, "repo");
  fs.mkdirSync(directory);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  git(directory, ["init", "-b", "main"]);
  git(directory, ["config", "user.email", "delivery@example.com"]);
  git(directory, ["config", "user.name", "Delivery Test"]);
  fs.writeFileSync(path.join(directory, "a.txt"), "base\n");
  fs.writeFileSync(path.join(directory, "parent-staged.txt"), "base staged\n");
  fs.writeFileSync(path.join(directory, "parent-dirty.txt"), "base dirty\n");
  fs.writeFileSync(path.join(directory, "conflict.txt"), "base\n");
  git(directory, ["add", "."]);
  git(directory, ["commit", "-m", "base"]);
  return directory;
}

function approve(service: GitDeliveryService, operation: GitOperation, actor = owner): GitOperation {
  return service.approve(operation.id, operation.version, operation.preflight.approvalDigest, actor, "Reviewed exact Git operation");
}

async function independentlyReview(t: test.TestContext, directory: string, changeSetId: string): Promise<void> {
  setChangeSetReviewRunnerForTests(async () => []);
  t.after(() => setChangeSetReviewRunnerForTests());
  scheduleChangeSetReview(directory, changeSetId, "delivery-test");
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const run = listChangeSetReviewRuns(directory, changeSetId)[0];
    if (run?.status === "completed") return;
    if (run?.status === "failed") throw new Error(run.error || "review failed");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("review did not complete");
}

test("uses durable idempotency, CAS approval and role/branch policy", (t) => {
  const directory = repository(t);
  const base = git(directory, ["rev-parse", "HEAD"]);
  const service = new GitDeliveryService(directory);
  assert.throws(() => service.prepare({ idempotencyKey: "viewer", input: { action: "create_branch", branch: "crewforge/viewer", baseSha: base } }, { username: "viewer", isAdmin: false, teamRole: "viewer" }), (error: unknown) => error instanceof GitDeliveryError && error.code === "PREFLIGHT_FAILED");
  assert.throws(() => service.prepare({ idempotencyKey: "member-main", input: { action: "create_branch", branch: "feature/member", baseSha: base } }, { username: "member", isAdmin: false, teamRole: "member" }), /crewforge/i);

  const prepared = service.prepare({ idempotencyKey: "same-key", input: { action: "create_branch", branch: "crewforge/idempotent", baseSha: base } }, owner);
  const duplicate = service.prepare({ idempotencyKey: "same-key", input: { action: "create_branch", branch: "crewforge/idempotent", baseSha: base } }, owner);
  assert.equal(duplicate.id, prepared.id);
  assert.throws(() => service.prepare({ idempotencyKey: "same-key", input: { action: "create_branch", branch: "crewforge/other", baseSha: base } }, owner), /Idempotency key/i);
  assert.throws(() => service.approve(prepared.id, prepared.version - 1, prepared.preflight.approvalDigest, owner), (error: unknown) => error instanceof GitDeliveryError && error.code === "VERSION_CONFLICT" && error.current?.id === prepared.id);

  const completed = approve(service, service.get(prepared.id));
  assert.equal(completed.status, "completed");
  assert.equal(git(directory, ["rev-parse", "refs/heads/crewforge/idempotent"]), base);
  assert.throws(() => service.approve(completed.id, completed.version, completed.preflight.approvalDigest, owner), /awaiting approval/i);
});

test("detects preflight drift and never moves a branch checked out in a live worktree", (t) => {
  const directory = repository(t);
  const base = git(directory, ["rev-parse", "HEAD"]);
  const service = new GitDeliveryService(directory);
  const prepared = service.prepare({ idempotencyKey: "drift", input: { action: "create_branch", branch: "crewforge/drift", baseSha: base } }, owner);
  git(directory, ["branch", "crewforge/drift", base]);
  const conflicted = approve(service, prepared);
  assert.equal(conflicted.status, "conflicted");
  assert.equal(conflicted.conflicts?.[0]?.code, "STALE_PREFLIGHT");
  assert.equal(git(directory, ["rev-parse", "refs/heads/crewforge/drift"]), base);
  assert.throws(() => service.prepare({ idempotencyKey: "live", input: { action: "fast_forward", branch: "main", expectedHeadSha: base, sourceSha: base } }, owner), /checked out/i);
});

test("commits only an independently reviewed immutable ChangeSet without touching parent HEAD, index or dirty files", async (t) => {
  const directory = repository(t);
  const base = git(directory, ["rev-parse", "HEAD"]);
  const worktree = createManagedWorktree(directory, { name: "delivery", ownerId: "writer" });
  fs.writeFileSync(path.join(worktree.path, "a.txt"), "reviewed immutable change\n");
  fs.writeFileSync(path.join(worktree.path, "new file -> \u65b0.txt"), "special path\n");
  git(worktree.path, ["add", "."]);
  git(worktree.path, ["commit", "-m", "child change"]);
  const changeSet = captureChangeSet(directory, worktree.id, { command: "node --test", passed: true });
  await independentlyReview(t, directory, changeSet.id);

  fs.writeFileSync(path.join(directory, "parent-staged.txt"), "human staged\n");
  git(directory, ["add", "parent-staged.txt"]);
  fs.writeFileSync(path.join(directory, "parent-dirty.txt"), "human dirty\n");
  fs.writeFileSync(path.join(directory, "human untracked\n\u65b0.txt"), "human untracked\n");
  const indexBefore = git(directory, ["ls-files", "-s"]);
  const stagedBefore = git(directory, ["diff", "--cached", "--binary"]);
  const mainBefore = git(directory, ["rev-parse", "main"]);

  const service = new GitDeliveryService(directory);
  const prepared = service.prepare({ idempotencyKey: "immutable-change-set", input: { action: "commit_change_set", branch: "crewforge/reviewed", changeSetId: changeSet.id, subject: "Ship reviewed revision" } }, owner);
  const completed = approve(service, prepared);
  assert.equal(completed.status, "completed");
  const delivered = git(directory, ["rev-parse", "refs/heads/crewforge/reviewed"]);
  assert.equal(git(directory, ["show", `${delivered}:a.txt`]), "reviewed immutable change");
  assert.equal(git(directory, ["show", `${delivered}:new file -> \u65b0.txt`]), "special path");
  assert.equal(git(directory, ["rev-parse", `${delivered}^`]), base);
  assert.match(git(directory, ["show", "-s", "--format=%B", delivered]), /^Ship reviewed revision[\s\S]*ChangeSet: [a-f0-9]{64}[\s\S]*Reviewed-Revision: [a-f0-9]{64}[\s\S]*Evidence-SHA256: [a-f0-9]{64}/);
  assert.equal(git(directory, ["rev-parse", "main"]), mainBefore);
  assert.equal(git(directory, ["ls-files", "-s"]), indexBefore);
  assert.equal(git(directory, ["diff", "--cached", "--binary"]), stagedBefore);
  assert.equal(fs.readFileSync(path.join(directory, "parent-dirty.txt"), "utf8"), "human dirty\n");
  assert.equal(fs.readFileSync(path.join(directory, "human untracked\n\u65b0.txt"), "utf8"), "human untracked\n");
});

function divergentBranch(directory: string, branch: string, text: string): string {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-delivery-conflict-"));
  try {
    git(directory, ["worktree", "add", "-b", branch, temporary, "HEAD"]);
    fs.writeFileSync(path.join(temporary, "conflict.txt"), `${text}\n`);
    git(temporary, ["add", "conflict.txt"]);
    git(temporary, ["commit", "-m", text]);
    return git(temporary, ["rev-parse", "HEAD"]);
  } finally {
    git(directory, ["worktree", "remove", "--force", temporary]);
  }
}

test("rebase and cherry-pick conflicts leave the live delivery refs unchanged", (t) => {
  const directory = repository(t);
  const base = git(directory, ["rev-parse", "HEAD"]);
  const cherryHead = divergentBranch(directory, "crewforge/cherry-target", "target cherry");
  const rebaseHead = divergentBranch(directory, "crewforge/rebase-target", "target rebase");
  fs.writeFileSync(path.join(directory, "conflict.txt"), "source conflict\n");
  git(directory, ["add", "conflict.txt"]);
  git(directory, ["commit", "-m", "source conflict"]);
  const source = git(directory, ["rev-parse", "HEAD"]);
  const service = new GitDeliveryService(directory);

  const cherry = service.prepare({ idempotencyKey: "cherry-conflict", input: { action: "cherry_pick", branch: "crewforge/cherry-target", expectedHeadSha: cherryHead, commits: [source] } }, owner);
  const cherryResult = approve(service, cherry);
  assert.equal(cherryResult.status, "conflicted");
  assert.equal(git(directory, ["rev-parse", "refs/heads/crewforge/cherry-target"]), cherryHead);

  const rebase = service.prepare({ idempotencyKey: "rebase-conflict", input: { action: "rebase", branch: "crewforge/rebase-target", expectedHeadSha: rebaseHead, upstreamSha: base, ontoSha: source } }, owner);
  const rebaseResult = approve(service, rebase);
  assert.equal(rebaseResult.status, "conflicted");
  assert.equal(git(directory, ["rev-parse", "refs/heads/crewforge/rebase-target"]), rebaseHead);
});

test("pushes only an exact configured ref with a lease and rejects upstream drift", (t) => {
  const directory = repository(t);
  const bare = path.join(path.dirname(directory), "remote.git");
  execFileSync("git", ["init", "--bare", bare], { stdio: "ignore" });
  git(directory, ["remote", "add", "origin", bare]);
  const service = new GitDeliveryService(directory);
  const firstSha = git(directory, ["rev-parse", "HEAD"]);
  const first = service.prepare({ idempotencyKey: "push-first", input: { action: "push", remote: "origin", localSha: firstSha, remoteRef: "refs/heads/crewforge/delivery", expectedRemoteSha: null } }, owner);
  assert.equal(first.risk, "high");
  assert.equal(approve(service, first).status, "completed");
  assert.equal(git(bare, ["rev-parse", "refs/heads/crewforge/delivery"]), firstSha);

  fs.writeFileSync(path.join(directory, "a.txt"), "desired\n");
  git(directory, ["add", "a.txt"]);
  git(directory, ["commit", "-m", "desired"]);
  const desired = git(directory, ["rev-parse", "HEAD"]);
  const drift = service.prepare({ idempotencyKey: "push-drift", input: { action: "push", remote: "origin", localSha: desired, remoteRef: "refs/heads/crewforge/delivery", expectedRemoteSha: firstSha } }, owner);
  fs.writeFileSync(path.join(directory, "a.txt"), "upstream drift\n");
  git(directory, ["add", "a.txt"]);
  git(directory, ["commit", "-m", "drift"]);
  const upstream = git(directory, ["rev-parse", "HEAD"]);
  git(directory, ["push", "origin", `${upstream}:refs/heads/crewforge/delivery`]);
  const result = approve(service, drift);
  assert.equal(result.status, "conflicted");
  assert.equal(result.conflicts?.[0]?.code, "UPSTREAM_DRIFT");
  assert.equal(git(bare, ["rev-parse", "refs/heads/crewforge/delivery"]), upstream);
});

test("reconciles approved and interrupted operations after restart and redacts configured remote URLs", (t) => {
  const directory = repository(t);
  const base = git(directory, ["rev-parse", "HEAD"]);
  const service = new GitDeliveryService(directory);
  const queued = service.prepare({ idempotencyKey: "queued-restart", input: { action: "create_branch", branch: "crewforge/resume-queued", baseSha: base } }, owner);
  service.store.approve(queued.id, queued.version, queued.preflight.approvalDigest, owner.username);
  const resumed = new GitDeliveryService(directory).reconcile().find((operation) => operation.id === queued.id);
  assert.equal(resumed?.status, "completed");
  assert.equal(git(directory, ["rev-parse", "refs/heads/crewforge/resume-queued"]), base);

  const interrupted = service.prepare({ idempotencyKey: "running-restart", input: { action: "create_branch", branch: "crewforge/resume-running", baseSha: base } }, owner);
  service.store.approve(interrupted.id, interrupted.version, interrupted.preflight.approvalDigest, owner.username);
  const claimed = service.store.claim(interrupted.id, -1);
  service.store.checkpoint(interrupted.id, claimed.lease!.ownerToken, { ref: "refs/heads/crewforge/resume-running", headSha: base, phase: "prepared" });
  git(directory, ["update-ref", "refs/heads/crewforge/resume-running", base]);
  const statePath = path.join(directory, ".team", "state", "git-delivery.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as { operations: Record<string, GitOperation> };
  state.operations[interrupted.id].lease = { ownerPid: 2_147_483_647, ownerToken: claimed.lease!.ownerToken, expiresAt: Date.now() - 1 };
  fs.writeFileSync(statePath, JSON.stringify(state));
  const recovered = new GitDeliveryService(directory).reconcile().find((operation) => operation.id === interrupted.id);
  assert.equal(recovered?.status, "completed");

  const secret = "never-persist-this-password";
  git(directory, ["remote", "add", "credentialed", `https://user:${secret}@example.invalid/private.git`]);
  service.prepare({ idempotencyKey: "secret-url", input: { action: "push", remote: "credentialed", localSha: base, remoteRef: "refs/heads/crewforge/secret-test", expectedRemoteSha: null } }, owner);
  const persisted = fs.readFileSync(statePath, "utf8") + fs.readFileSync(path.join(directory, ".history", "traces", "events.jsonl"), "utf8");
  assert.equal(persisted.includes(secret), false);
  assert.equal(persisted.includes("example.invalid/private.git"), false);
});

test("cross-process prepare races converge on one durable operation", async (t) => {
  const directory = repository(t);
  const base = git(directory, ["rev-parse", "HEAD"]);
  const moduleUrl = new URL("../integrations/gitDelivery/service.ts", import.meta.url).href;
  const script = `import(${JSON.stringify(moduleUrl)}).then(({GitDeliveryService})=>{const op=new GitDeliveryService(process.env.DELIVERY_REPO).prepare({idempotencyKey:'race',input:{action:'create_branch',branch:'crewforge/race',baseSha:process.env.DELIVERY_SHA}},{username:'operator',isAdmin:false,teamRole:'owner'});process.stdout.write(op.id)})`;
  const environment = { ...process.env, DELIVERY_REPO: directory, DELIVERY_SHA: base };
  const [first, second] = await Promise.all([
    execFileAsync(process.execPath, ["--import", "tsx", "-e", script], { cwd: process.cwd(), env: environment }),
    execFileAsync(process.execPath, ["--import", "tsx", "-e", script], { cwd: process.cwd(), env: environment }),
  ]);
  assert.equal(first.stdout, second.stdout);
  const operations = new GitDeliveryService(directory).list();
  assert.equal(operations.filter((operation) => operation.id === first.stdout).length, 1);
});
