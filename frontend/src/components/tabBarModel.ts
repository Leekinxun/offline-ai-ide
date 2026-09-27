export interface TabFileLike {
  path: string;
  name: string;
}

export function normalizeTabPath(path: string): string {
  return path.replace(/\\/g, "/").trim().replace(/^\.\//, "").replace(/^\/+/, "");
}

export function tabPathIdentity(path: string): string {
  return normalizeTabPath(path);
}

export function isSameTabPath(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return left === right;
  return tabPathIdentity(left) === tabPathIdentity(right);
}

export function uniqueTabFiles<T extends { path: string }>(openFiles: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const file of openFiles) {
    const key = tabPathIdentity(file.path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(file);
  }
  return result;
}

export function getTabPathLabels<T extends TabFileLike>(openFiles: T[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const file of openFiles) {
    const peers = openFiles.filter((candidate) => candidate.name === file.name);
    if (peers.length < 2) continue;
    const parentParts = normalizeTabPath(file.path).split("/").slice(0, -1);
    for (let depth = 1; depth <= parentParts.length; depth += 1) {
      const suffix = parentParts.slice(-depth).join("/");
      const unique = peers.every((candidate) => {
        if (isSameTabPath(candidate.path, file.path)) return true;
        const candidateParent = normalizeTabPath(candidate.path).split("/").slice(0, -1);
        return candidateParent.slice(-depth).join("/") !== suffix;
      });
      if (unique) {
        labels.set(file.path, suffix);
        break;
      }
    }
  }
  return labels;
}
