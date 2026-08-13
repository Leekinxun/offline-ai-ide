import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** A bounded, deterministic snapshot of the workspace a user approved. */
export interface ExecutionPlanApprovalFingerprint {
  version: 1;
  algorithm: "sha256";
  digest: string;
}

export interface PlanFreshnessResult {
  fresh: boolean;
  /** Deliberately safe to show in the UI/logs. */
  reason: string;
}

const EXCLUDED_SEGMENTS = new Set([".git", ".history", ".checkpoints", "node_modules", "dist"]);
const MAX_FILES = 2_000;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_GIT_OUTPUT = 512 * 1024;

export function createExecutionPlanApprovalFingerprint(
  workspaceDir: string,
  scopes: string[]
): ExecutionPlanApprovalFingerprint {
  const root = fs.realpathSync.native(path.resolve(workspaceDir));
  const hash = crypto.createHash("sha256");
  let files = 0;
  let bytes = 0;
  const add = (value: string) => hash.update(value, "utf8");
  const addFile = (relative: string, fullPath: string): void => {
    const stat = fs.lstatSync(fullPath);
    if (stat.isSymbolicLink()) {
      add(`symlink\0${relative}\0${fs.readlinkSync(fullPath)}\0`);
      return;
    }
    if (!stat.isFile()) throw new Error(`Plan freshness cannot prove unsupported path: ${relative}`);
    if (++files > MAX_FILES || (bytes += stat.size) > MAX_BYTES) {
      throw new Error("Plan freshness snapshot exceeds safe limits");
    }
    add(`file\0${relative}\0${stat.size}\0`);
    hash.update(fs.readFileSync(fullPath));
    add("\0");
  };
  const visit = (relative: string): void => {
    const fullPath = path.join(root, relative);
    const stat = fs.lstatSync(fullPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return addFile(relative, fullPath);
    const entries = fs.readdirSync(fullPath, { withFileTypes: true })
      .filter((entry) => !EXCLUDED_SEGMENTS.has(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length === 0) add(`directory\0${relative}\0`);
    for (const entry of entries) visit(`${relative}/${entry.name}`);
  };

  add("execution-plan-freshness-v1\0");
  for (const scope of [...new Set(scopes)].sort()) {
    if (isExcluded(scope)) throw new Error(`Plan freshness cannot fingerprint excluded scope: ${scope}`);
    const fullPath = path.join(root, scope);
    if (!isWithin(root, fullPath)) throw new Error("Plan freshness scope escapes workspace");
    if (!pathExistsWithoutFollowingLinks(fullPath)) {
      add(`missing\0${scope}\0`);
    } else {
      visit(scope);
    }
  }
  addGitState(root, scopes, add);
  return { version: 1, algorithm: "sha256", digest: hash.digest("hex") };
}

/**
 * Legacy records intentionally have no fingerprint: they may execute once for
 * compatibility. Their next explicitly approved amendment records a snapshot.
 */
export function checkExecutionPlanFreshness(
  workspaceDir: string,
  plan: { files: string[]; approvalFingerprint?: ExecutionPlanApprovalFingerprint }
): PlanFreshnessResult {
  if (!plan.approvalFingerprint) return { fresh: true, reason: "legacy plan has no approval fingerprint" };
  try {
    const current = createExecutionPlanApprovalFingerprint(workspaceDir, plan.files);
    return current.digest === plan.approvalFingerprint.digest
      ? { fresh: true, reason: "approved workspace snapshot matches" }
      : { fresh: false, reason: "approved workspace snapshot is stale" };
  } catch {
    return { fresh: false, reason: "approved workspace snapshot cannot be proven" };
  }
}

function addGitState(root: string, scopes: string[], add: (value: string) => void): void {
  const head = runGit(root, ["rev-parse", "--verify", "HEAD"]);
  if (head.status === 0) add(`head\0${head.stdout.trim()}\0`);
  else if (head.status === 128) add("head\0unborn\0");
  else if (head.status === 129 || head.status === -1) add("git\0unavailable\0");
  else throw new Error("Plan freshness cannot read Git HEAD");

  const status = runGit(root, ["status", "--porcelain=v1", "-uall", "--", ...scopes]);
  if (status.status === 0) {
    add(`git-status\0${status.stdout}\0`);
    const tracked = runGit(root, ["ls-files", "--stage", "--", ...scopes]);
    if (tracked.status !== 0) throw new Error("Plan freshness cannot read tracked file state");
    add(`git-tracked\0${tracked.stdout}\0`);
  }
  else if (head.status !== 0 && status.status === 128) add("git-status\0not-a-repository\0");
  else throw new Error("Plan freshness cannot read Git worktree state");
}

function runGit(root: string, args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
  if (result.error || result.stdout.length > MAX_GIT_OUTPUT) throw new Error("Plan freshness cannot run Git safely");
  return { status: result.status, stdout: result.stdout };
}

function isExcluded(relative: string): boolean {
  return relative.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function pathExistsWithoutFollowingLinks(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
