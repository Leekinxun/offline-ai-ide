import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { applyChangeSetDecision, captureChangeSet, ChangeSetIntegrationConflictError, getChangeSet, recoverInterruptedChangeSet, setChangeSetIntegrationHookForTests } from "./changeSets.js";
import { createManagedWorktree } from "./worktrees.js";
import { independentlyReviewForRelease, releaseTestCommit, releaseTestGit, releaseTestRepository } from "./changeSetReleaseTestSupport.js";

async function runChangeSetChild(script: string): Promise<{ code?: string; recoveryStatus?: string; name?: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: path.resolve(".") });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(stderr || `child exited ${code}`));
      try { resolve(JSON.parse(stdout.trim())); } catch { reject(new Error(`invalid child output: ${stdout}\n${stderr}`)); }
    });
  });
}

test("live after-write-ahead recovery callers conflict without rolling back an active integration", async (t) => {
  for (const decision of ["apply", "merge", "cherry_pick"] as const) await t.test(decision, async (t) => {
    const directory = releaseTestRepository(t);
    const worktree = createManagedWorktree(directory, { name: `live-${decision}` });
    releaseTestCommit(worktree.path, `live-${decision}\n`);
    const changeSet = captureChangeSet(directory, worktree.id, { passed: true });
    await independentlyReviewForRelease(t, directory, changeSet.id);
    let conflicts = 0;
    setChangeSetIntegrationHookForTests((stage) => {
      if (stage !== "after_write_ahead") return;
      for (let index = 0; index < 2; index += 1) assert.throws(() => recoverInterruptedChangeSet(directory, changeSet.id), (error: unknown) => {
        if (error instanceof ChangeSetIntegrationConflictError) conflicts += 1;
        return error instanceof ChangeSetIntegrationConflictError;
      });
    });
    t.after(() => setChangeSetIntegrationHookForTests(undefined));
    const result = applyChangeSetDecision(directory, changeSet, decision);
    setChangeSetIntegrationHookForTests(undefined);
    assert.equal(conflicts, 2);
    assert.equal(result.changeSet.status, "applied");
    assert.equal(getChangeSet(directory, changeSet.id).status, "applied");
    assert.equal(releaseTestGit(directory, ["show", "HEAD:a.txt"]), `live-${decision}`);
  });
});

test("stale ChangeSet integration locks fail closed across child processes without parent mutation", async (t) => {
  const directory = releaseTestRepository(t);
  const worktree = createManagedWorktree(directory, { name: "stale-integration" });
  releaseTestCommit(worktree.path, "stale-integration\n");
  const changeSet = captureChangeSet(directory, worktree.id, { passed: true });
  await independentlyReviewForRelease(t, directory, changeSet.id);
  const lock = path.join(directory, ".history", "change-sets", "integration.lock");
  const owner = { pid: 2_147_483_647, token: "stale-owner", createdAt: Date.now() - 120_000 };
  fs.writeFileSync(lock, JSON.stringify(owner), { flag: "wx" });
  const originalHead = releaseTestGit(directory, ["rev-parse", "HEAD"]);
  const modulePath = JSON.stringify(path.resolve("src/chat/changeSets.ts"));
  const repository = JSON.stringify(directory);
  const id = JSON.stringify(changeSet.id);
  const [applyResult, recoverResult] = await Promise.all([
    runChangeSetChild(`const m=await import(${modulePath});try{m.applyChangeSetDecision(${repository},${id},"apply");console.log(JSON.stringify({name:"unexpected"}))}catch(e){console.log(JSON.stringify({name:e.name,code:e.code,recoveryStatus:e.recoveryStatus}))}`),
    runChangeSetChild(`const m=await import(${modulePath});try{m.recoverInterruptedChangeSet(${repository},${id});console.log(JSON.stringify({name:"unexpected"}))}catch(e){console.log(JSON.stringify({name:e.name,code:e.code,recoveryStatus:e.recoveryStatus}))}`),
  ]);
  for (const result of [applyResult, recoverResult]) assert.deepEqual(result, { name: "ChangeSetLockRecoveryRequiredError", code: "change_set_lock_recovery_required", recoveryStatus: "needs_attention" });
  assert.equal(releaseTestGit(directory, ["rev-parse", "HEAD"]), originalHead);
  assert.equal(fs.readFileSync(path.join(directory, "a.txt"), "utf8"), "base\n");
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, "utf8")), owner);
});

test("stale ChangeSet transition locks reject competing child decisions without last-writer-wins", async (t) => {
  const directory = releaseTestRepository(t);
  const worktree = createManagedWorktree(directory, { name: "stale-transition" });
  releaseTestCommit(worktree.path, "stale-transition\n");
  const changeSet = captureChangeSet(directory, worktree.id, { passed: true });
  const lock = path.join(directory, ".history", "change-sets", `${changeSet.id}.transition.lock`);
  const owner = { pid: 2_147_483_647, token: "stale-owner", createdAt: Date.now() - 120_000 };
  fs.writeFileSync(lock, JSON.stringify(owner), { flag: "wx" });
  const modulePath = JSON.stringify(path.resolve("src/chat/changeSets.ts"));
  const repository = JSON.stringify(directory);
  const id = JSON.stringify(changeSet.id);
  const invoke = (decision: string) => runChangeSetChild(`const m=await import(${modulePath});try{m.applyChangeSetDecision(${repository},${id},${JSON.stringify(decision)});console.log(JSON.stringify({name:"unexpected"}))}catch(e){console.log(JSON.stringify({name:e.name,code:e.code,recoveryStatus:e.recoveryStatus}))}`);
  const results = await Promise.all([invoke("reject"), invoke("request_revision")]);
  for (const result of results) assert.deepEqual(result, { name: "ChangeSetLockRecoveryRequiredError", code: "change_set_lock_recovery_required", recoveryStatus: "needs_attention" });
  assert.equal(getChangeSet(directory, changeSet.id).status, "ready_for_review");
  assert.equal(getChangeSet(directory, changeSet.id).transitionVersion, changeSet.transitionVersion);
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, "utf8")), owner);
});

test("stale reused-pid, EPERM, and malformed ChangeSet locks require explicit recovery", async (t) => {
  const directory = releaseTestRepository(t);
  const worktree = createManagedWorktree(directory, { name: "uncertain-lock" });
  releaseTestCommit(worktree.path, "uncertain-lock\n");
  const changeSet = captureChangeSet(directory, worktree.id, { passed: true });
  const lock = path.join(directory, ".history", "change-sets", "integration.lock");
  const modulePath = JSON.stringify(path.resolve("src/chat/changeSets.ts"));
  const repository = JSON.stringify(directory);
  const id = JSON.stringify(changeSet.id);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "reused-pid-token", createdAt: Date.now() - 120_000 }), { flag: "wx" });
  const denied = await runChangeSetChild(`process.kill=()=>{const e=new Error("denied");e.code="EPERM";throw e};const m=await import(${modulePath});try{m.recoverInterruptedChangeSet(${repository},${id});console.log(JSON.stringify({name:"unexpected"}))}catch(e){console.log(JSON.stringify({name:e.name,code:e.code,recoveryStatus:e.recoveryStatus}))}`);
  assert.deepEqual(denied, { name: "ChangeSetLockRecoveryRequiredError", code: "change_set_lock_recovery_required", recoveryStatus: "needs_attention" });
  fs.rmSync(lock);
  fs.writeFileSync(lock, "not-json", { flag: "wx" });
  const malformed = await runChangeSetChild(`const m=await import(${modulePath});try{m.recoverInterruptedChangeSet(${repository},${id});console.log(JSON.stringify({name:"unexpected"}))}catch(e){console.log(JSON.stringify({name:e.name,code:e.code,recoveryStatus:e.recoveryStatus}))}`);
  assert.deepEqual(malformed, { name: "ChangeSetLockRecoveryRequiredError", code: "change_set_lock_recovery_required", recoveryStatus: "needs_attention" });
  assert.equal(fs.readFileSync(lock, "utf8"), "not-json");
});
