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
  bare?: boolean;
  detached?: boolean;
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
    return [{
      id,
      path: worktreePath,
      branch: normalizeBranch(values.branch),
      head: values.HEAD,
      bare: flags.has("bare"),
      detached: flags.has("detached"),
    }];
  });
}

export function createManagedWorktree(
  workspaceDir: string,
  input: { name?: string; revision?: string } = {}
): ManagedWorktree {
  const repository = repositoryRoot(workspaceDir);
  const suffix = crypto.randomBytes(3).toString("hex");
  const requested = typeof input.name === "string"
    ? input.name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
    : "";
  const id = `${requested || Date.now()}-${suffix}`;
  const revision = typeof input.revision === "string" && input.revision.trim()
    ? input.revision.trim()
    : "HEAD";
  if (revision.startsWith("-") || revision.length > 200) throw new Error("Invalid worktree revision");
  const branch = `crownforge/${id}`;
  const target = path.join(managedRoot(repository), id);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  git(repository, ["worktree", "add", "-b", branch, target, revision]);
  return listManagedWorktrees(repository).find((entry) => entry.id === id) || {
    id,
    path: target,
    branch,
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
  git(repository, ["worktree", "remove", existing.path]);
  return existing;
}
