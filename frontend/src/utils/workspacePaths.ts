import { FileNode, OpenFile, TeamRole } from "../types";

/**
 * 相对路径规范化工具函数：
 * 1. 统一 Windows 反斜杠 `\` 为 `/`；
 * 2. 若误传工作区绝对路径，自动剥离工作区前缀；
 * 3. 剔除前导 `./` 和多余的正斜杠 `/`，保证全局使用纯净唯一的相对路径。
 */
export function normalizeWorkspaceRelativePath(rawPath: string, workspaceDir?: string): string {
  if (!rawPath) return "";
  let normalized = rawPath.replace(/\\/g, "/").trim();
  if (workspaceDir) {
    const wsNormalized = workspaceDir.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalized.toLowerCase().startsWith(wsNormalized.toLowerCase() + "/")) {
      normalized = normalized.slice(wsNormalized.length + 1);
    }
  }
  return normalized.replace(/^\.\//, "").replace(/^\/+/, "");
}

export function isSameWorkspacePath(
  left: string | null | undefined,
  right: string | null | undefined,
  workspaceDir?: string
): boolean {
  if (!left || !right) return left === right;
  return normalizeWorkspaceRelativePath(left, workspaceDir) === normalizeWorkspaceRelativePath(right, workspaceDir);
}

export function isPathEqualOrDescendant(candidate: string, target: string): boolean {
  return candidate === target || candidate.startsWith(`${target}/`);
}

export function remapMovedPath(candidate: string, oldPath: string, newPath: string): string {
  if (candidate === oldPath) return newPath;
  return candidate.startsWith(`${oldPath}/`)
    ? `${newPath}${candidate.slice(oldPath.length)}`
    : candidate;
}

export function pruneNestedPaths(paths: string[]): string[] {
  const uniquePaths = Array.from(new Set(paths.filter(Boolean))).sort(
    (left, right) => left.length - right.length || left.localeCompare(right)
  );
  const pruned: string[] = [];

  for (const currentPath of uniquePaths) {
    if (pruned.some((path) => isPathEqualOrDescendant(currentPath, path))) {
      continue;
    }
    pruned.push(currentPath);
  }

  return pruned;
}

export function collectVisiblePaths(nodes: FileNode[]): Set<string> {
  const paths = new Set<string>();
  const visit = (entries: FileNode[]) => {
    for (const node of entries) {
      paths.add(node.path);
      if (node.children) {
        visit(node.children);
      }
    }
  };
  visit(nodes);
  return paths;
}

export function isReadOnlyTeamRole(role: TeamRole | null | undefined): boolean {
  return role === "viewer";
}

export function isDebuggablePath(path: string): boolean {
  return /\.(?:js|mjs|cjs|py|pyw)$/i.test(path);
}

export function buildClearedRemoteState(): Pick<
  OpenFile,
  | "remoteUpdated"
  | "remoteContent"
  | "remoteVersion"
  | "remoteUpdatedAt"
  | "remoteConflictReason"
  | "remoteConflictSource"
  | "remoteConflictActor"
> {
  return {
    remoteUpdated: false,
    remoteContent: undefined,
    remoteVersion: undefined,
    remoteUpdatedAt: undefined,
    remoteConflictReason: undefined,
    remoteConflictSource: undefined,
    remoteConflictActor: undefined,
  };
}
