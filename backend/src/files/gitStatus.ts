import { execFileSync } from "child_process";

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

export function parseGitStatusOutput(output: string): Omit<GitStatusSnapshot, "isRepo" | "updatedAt"> {
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
      const pair = `${indexStatus}${worktreeStatus}`;
      const kind: GitChangeKind = CONFLICT_STATUSES.has(pair)
        ? "conflicted"
        : pair === "??"
          ? "untracked"
          : indexStatus === "A" || worktreeStatus === "A"
            ? "added"
            : indexStatus === "D" || worktreeStatus === "D"
              ? "deleted"
              : indexStatus === "R"
                ? "renamed"
                : "modified";
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
    upstream: upstreamMatch?.[1] || null,
    ahead: Number(aheadMatch?.[1] || 0),
    behind: Number(behindMatch?.[1] || 0),
    entries,
  };
}

export function readGitStatus(workspaceDir: string): GitStatusSnapshot {
  const output = execFileSync("git", ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-b", "-uall"], {
    cwd: workspaceDir,
    encoding: "utf-8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { isRepo: true, ...parseGitStatusOutput(output), updatedAt: Date.now() };
}
