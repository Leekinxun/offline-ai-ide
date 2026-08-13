import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

export type GitChangeKind = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface GitStatusEntry {
  path: string;
  previousPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  kind: GitChangeKind;
}

export interface GitStatusSnapshot {
  isRepo: true;
  branch: string;
  headSha: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
  updatedAt: number;
}

const CONFLICT_STATUSES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

function unquoteGitPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  try {
    return JSON.parse(trimmed) as string;
  } catch {
    return trimmed.slice(1, -1);
  }
}

function kindForStatus(indexStatus: string, worktreeStatus: string, recordType?: string): GitChangeKind {
  const pair = `${indexStatus}${worktreeStatus}`;
  if (recordType === "u" || CONFLICT_STATUSES.has(pair)) return "conflicted";
  if (recordType === "?" || pair === "??") return "untracked";
  if (recordType === "2" || indexStatus === "R") return "renamed";
  if (indexStatus === "A" || worktreeStatus === "A") return "added";
  if (indexStatus === "D" || worktreeStatus === "D") return "deleted";
  return "modified";
}

function parseGitStatusV1Output(output: string): Omit<GitStatusSnapshot, "isRepo" | "updatedAt"> {
  const lines = output.split(/\r?\n/).filter(Boolean);
  const branchLine = lines.find((line) => line.startsWith("## ")) || "## HEAD";
  const branchDescription = branchLine.slice(3).trim();
  const branch = branchDescription.split("...")[0] || "HEAD";
  const upstreamMatch = branchDescription.match(/\.\.\.([^ ]+)/);
  const aheadMatch = branchDescription.match(/ahead (\d+)/);
  const behindMatch = branchDescription.match(/behind (\d+)/);
  const entries = lines
    .filter((line) => !line.startsWith("## "))
    .map((line): GitStatusEntry => {
      const indexStatus = line[0] || " ";
      const worktreeStatus = line[1] || " ";
      const rawPath = line.slice(3).trim();
      const pathParts = rawPath.split(" -> ").map(unquoteGitPath);
      const kind = kindForStatus(indexStatus, worktreeStatus);
      return {
        path: pathParts[pathParts.length - 1] || rawPath,
        ...(pathParts.length > 1 ? { previousPath: pathParts[0] } : {}),
        indexStatus,
        worktreeStatus,
        kind,
      };
    });

  return {
    branch,
    headSha: null,
    upstream: upstreamMatch?.[1] || null,
    ahead: Number(aheadMatch?.[1] || 0),
    behind: Number(behindMatch?.[1] || 0),
    entries,
  };
}

/** Parse `git status --porcelain=v2 --branch -z` without interpreting paths as lines.
 * Rename records consume the following NUL field as their original path. */
export function parseGitStatusV2Output(output: string): Omit<GitStatusSnapshot, "isRepo" | "updatedAt"> {
  const records = output.split("\0");
  let branch = "HEAD";
  let headSha: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const entries: GitStatusEntry[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith("# branch.oid ")) {
      const oid = record.slice("# branch.oid ".length).trim();
      headSha = oid === "(initial)" ? null : oid;
      continue;
    }
    if (record.startsWith("# branch.head ")) {
      const value = record.slice("# branch.head ".length).trim();
      branch = value === "(detached)" ? "HEAD" : value;
      continue;
    }
    if (record.startsWith("# branch.upstream ")) {
      upstream = record.slice("# branch.upstream ".length).trim() || null;
      continue;
    }
    if (record.startsWith("# branch.ab ")) {
      const match = record.match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }
    if (record.startsWith("? ")) {
      entries.push({ path: record.slice(2), indexStatus: "?", worktreeStatus: "?", kind: "untracked" });
      continue;
    }
    const ordinary = record.match(/^1 ([^ ]{2}) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ ([\s\S]*)$/);
    if (ordinary) {
      const [indexStatus, worktreeStatus] = ordinary[1];
      entries.push({ path: ordinary[2], indexStatus, worktreeStatus, kind: kindForStatus(indexStatus, worktreeStatus, "1") });
      continue;
    }
    const renamed = record.match(/^2 ([^ ]{2}) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ ([\s\S]*)$/);
    if (renamed) {
      const [indexStatus, worktreeStatus] = renamed[1];
      const previousPath = records[++index];
      if (previousPath === undefined) throw new Error("Malformed porcelain v2 rename record");
      entries.push({ path: renamed[2], previousPath, indexStatus, worktreeStatus, kind: kindForStatus(indexStatus, worktreeStatus, "2") });
      continue;
    }
    const unmerged = record.match(/^u ([^ ]{2}) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ ([\s\S]*)$/);
    if (unmerged) {
      const [indexStatus, worktreeStatus] = unmerged[1];
      entries.push({ path: unmerged[2], indexStatus, worktreeStatus, kind: "conflicted" });
    }
  }
  return { branch, headSha, upstream, ahead, behind, entries };
}

/** Backward-compatible parser for persisted/tests using porcelain v1. */
export function parseGitStatusOutput(output: string): Omit<GitStatusSnapshot, "isRepo" | "updatedAt"> {
  return output.includes("\0") || output.startsWith("# branch.")
    ? parseGitStatusV2Output(output)
    : parseGitStatusV1Output(output);
}

export function resolveGitWorkspaceContext(workspaceDir: string): {
  repoRoot: string;
  workspacePrefix: string;
} {
  const resolvedWorkspace = fs.realpathSync.native(path.resolve(workspaceDir));
  const repoRoot = fs.realpathSync.native(path.resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: resolvedWorkspace,
    encoding: "utf-8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()));
  const relative = path.relative(repoRoot, resolvedWorkspace);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Workspace is outside the Git repository");
  }
  return {
    repoRoot,
    workspacePrefix: relative.split(path.sep).join("/"),
  };
}

export function toRepositoryRelativePath(workspaceDir: string, relPath: string): string {
  const { workspacePrefix } = resolveGitWorkspaceContext(workspaceDir);
  const normalized = relPath.split(path.sep).join("/").replace(/^\.\//, "");
  return workspacePrefix ? `${workspacePrefix}/${normalized}` : normalized;
}

export function scopeGitStatusEntries(
  entries: GitStatusEntry[],
  workspacePrefix: string
): GitStatusEntry[] {
  if (!workspacePrefix) return entries;
  const prefix = `${workspacePrefix.replace(/\/$/, "")}/`;
  const relativePath = (value: string | undefined): string | undefined => {
    if (!value?.startsWith(prefix)) return undefined;
    return value.slice(prefix.length);
  };
  return entries.flatMap((entry) => {
    const scopedPath = relativePath(entry.path);
    if (!scopedPath) return [];
    const previousPath = relativePath(entry.previousPath);
    return [{
      ...entry,
      path: scopedPath,
      ...(previousPath ? { previousPath } : { previousPath: undefined }),
    }];
  });
}

export function readGitStatus(workspaceDir: string): GitStatusSnapshot {
  const { repoRoot, workspacePrefix } = resolveGitWorkspaceContext(workspaceDir);
  const args = ["-c", "core.quotepath=false", "status", "--porcelain=v2", "--branch", "-z", "-uall"];
  if (workspacePrefix) args.push("--", workspacePrefix);
  const output = execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf-8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = parseGitStatusOutput(output);
  return {
    isRepo: true,
    ...parsed,
    entries: scopeGitStatusEntries(parsed.entries, workspacePrefix),
    updatedAt: Date.now(),
  };
}
