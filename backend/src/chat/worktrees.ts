import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WORKTREE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface ManagedWorktree {
  id: string;
  path: string;
  branch?: string;
  head?: string;
  /** Commit from which this isolated checkout was created. */
  baseSha?: string;
  status?: "active" | "captured" | "reviewed" | "integrated" | "rejected" | "running" | "ready_for_review" | "applying" | "applied" | "needs_revision" | "needs_attention" | "failed";
  ownerId?: string;
  parentRunId?: string;
  runId?: string;
  toolId?: string;
  reviewState?: "pending" | "approved" | "rejected" | "revision_requested";
  bare?: boolean;
  detached?: boolean;
}

interface WorktreeMetadata {
  schemaVersion: 1;
  id: string;
  baseSha: string;
  branch: string;
  status: NonNullable<ManagedWorktree["status"]>;
  ownerId?: string;
  parentRunId?: string;
  runId?: string;
  toolId?: string;
  reviewState: NonNullable<ManagedWorktree["reviewState"]>;
  createdAt: string;
}

const WORKTREE_STATUSES = new Set<NonNullable<ManagedWorktree["status"]>>(["active", "captured", "reviewed", "integrated", "rejected", "running", "ready_for_review", "applying", "applied", "needs_revision", "needs_attention", "failed"]);
const REVIEW_STATES = new Set<NonNullable<ManagedWorktree["reviewState"]>>(["pending", "approved", "rejected", "revision_requested"]);

export class WorktreeMetadataCorruptionError extends Error {
  readonly code = "worktree_metadata_corrupt";
  constructor(readonly metadataPath: string, reason: string, cause?: unknown) {
    super(`Managed worktree metadata is corrupt or unreadable: ${reason}`, { cause });
    this.name = "WorktreeMetadataCorruptionError";
  }
}

function git(workspaceDir: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", workspaceDir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: string | Buffer }).stderr?.toString().trim();
    throw new Error(stderr || (error instanceof Error ? error.message : "Git command failed"));
  }
}

function repositoryRoot(workspaceDir: string): string {
  return path.resolve(git(workspaceDir, ["rev-parse", "--show-toplevel"]));
}

function managedRoot(repository: string): string {
  return path.join(path.dirname(repository), ".crownforge-worktrees", path.basename(repository));
}

function metadataPath(repository: string, id: string): string {
  return path.join(repository, ".history", "worktrees", `${id}.json`);
}

function readMetadata(repository: string, id: string): WorktreeMetadata | undefined {
  const file = metadataPath(repository, id);
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new WorktreeMetadataCorruptionError(file, "persisted source cannot be read", error);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(source); }
  catch (error) { throw new WorktreeMetadataCorruptionError(file, "persisted source is not valid JSON", error); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new WorktreeMetadataCorruptionError(file, "persisted root must be an object");
  const value = parsed as Partial<WorktreeMetadata>;
  if (value.schemaVersion !== 1) throw new WorktreeMetadataCorruptionError(file, "unsupported schema version");
  if (value.id !== id || typeof value.baseSha !== "string" || !value.baseSha || typeof value.branch !== "string" || !value.branch || typeof value.status !== "string" || !WORKTREE_STATUSES.has(value.status as NonNullable<ManagedWorktree["status"]>) || typeof value.reviewState !== "string" || !REVIEW_STATES.has(value.reviewState as NonNullable<ManagedWorktree["reviewState"]>) || typeof value.createdAt !== "string" || !value.createdAt) {
    throw new WorktreeMetadataCorruptionError(file, "required fields are missing or invalid");
  }
  return value as WorktreeMetadata;
}

function writeMetadata(repository: string, metadata: WorktreeMetadata): void {
  const file = metadataPath(repository, metadata.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); fs.renameSync(temporary, file);
}

export function updateManagedWorktreeMetadata(repository: string, id: string, status: NonNullable<ManagedWorktree["status"]>, reviewState: NonNullable<ManagedWorktree["reviewState"]>): void {
  if (!WORKTREE_ID_PATTERN.test(id)) throw new Error("Invalid worktree id");
  const metadata = readMetadata(repository, id);
  if (!metadata) return;
  writeMetadata(repository, { ...metadata, status, reviewState });
}

function normalizeBranch(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/^refs\/heads\//, "");
}

export function listManagedWorktrees(workspaceDir: string): ManagedWorktree[] {
  const repository = repositoryRoot(workspaceDir);
  const root = managedRoot(repository);
  const records = git(repository, ["worktree", "list", "--porcelain"])
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  return records.flatMap((block) => {
    const values: Record<string, string> = {};
    const flags = new Set<string>();
    for (const line of block.split(/\r?\n/)) {
      const space = line.indexOf(" ");
      if (space < 0) flags.add(line);
      else values[line.slice(0, space)] = line.slice(space + 1);
    }
    const worktreePath = values.worktree ? path.resolve(values.worktree) : "";
    const relative = path.relative(root, worktreePath);
    if (!worktreePath || relative.startsWith("..") || path.isAbsolute(relative)) return [];
    const id = relative.split(path.sep)[0];
    if (!WORKTREE_ID_PATTERN.test(id)) return [];
    const metadata = readMetadata(repository, id);
    return [{
      id,
      path: worktreePath,
      branch: normalizeBranch(values.branch),
      head: values.HEAD,
      baseSha: metadata?.baseSha,
      status: metadata?.status,
      ownerId: metadata?.ownerId,
      parentRunId: metadata?.parentRunId,
      runId: metadata?.runId,
      toolId: metadata?.toolId,
      reviewState: metadata?.reviewState,
      bare: flags.has("bare"),
      detached: flags.has("detached"),
    }];
  });
}

export function createManagedWorktree(
  workspaceDir: string,
  input: { name?: string; revision?: string; baseSha?: string; ownerId?: string; runId?: string; toolId?: string; parentRunId?: string; childRunId?: string; toolCallId?: string } = {}
): ManagedWorktree {
  const repository = repositoryRoot(workspaceDir);
  const suffix = crypto.randomBytes(3).toString("hex");
  const requested = typeof input.name === "string"
    ? input.name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
    : "";
  const id = `${requested || Date.now()}-${suffix}`;
  const requestedBase = input.baseSha ?? input.revision;
  const revision = typeof requestedBase === "string" && requestedBase.trim()
    ? requestedBase.trim()
    : "HEAD";
  if (revision.startsWith("-") || revision.length > 200) throw new Error("Invalid worktree revision");
  // Resolve before creating the branch: a worktree is always anchored to an explicit commit.
  const baseSha = git(repository, ["rev-parse", "--verify", `${revision}^{commit}`]);
  const branch = `crownforge/${id}`;
  const target = path.join(managedRoot(repository), id);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  git(repository, ["worktree", "add", "-b", branch, target, baseSha]);
  writeMetadata(repository, { schemaVersion: 1, id, baseSha, branch, status: "running", ownerId: input.ownerId, parentRunId: input.parentRunId, runId: input.childRunId ?? input.runId, toolId: input.toolCallId ?? input.toolId, reviewState: "pending", createdAt: new Date().toISOString() });
  return listManagedWorktrees(repository).find((entry) => entry.id === id) || {
    id,
    path: target,
    branch,
    baseSha,
    status: "running",
    ownerId: input.ownerId,
    parentRunId: input.parentRunId,
    runId: input.runId,
    toolId: input.toolId,
    reviewState: "pending",
  };
}

export function removeManagedWorktree(
  workspaceDir: string,
  id: string
): ManagedWorktree {
  const normalized = id.trim();
  if (!WORKTREE_ID_PATTERN.test(normalized)) throw new Error("Invalid worktree id");
  const repository = repositoryRoot(workspaceDir);
  const existing = listManagedWorktrees(repository).find((entry) => entry.id === normalized);
  if (!existing) throw new Error("Managed worktree not found");
  const dirty = git(existing.path, ["status", "--porcelain"]);
  if (dirty) throw new Error("Refusing to remove dirty managed worktree");
  const metadata = readMetadata(repository, normalized);
  if (metadata && metadata.status !== "integrated" && metadata.status !== "rejected") {
    throw new Error("Refusing to remove unreviewed or unintegrated managed worktree");
  }
  git(repository, ["worktree", "remove", existing.path]);
  return existing;
}
