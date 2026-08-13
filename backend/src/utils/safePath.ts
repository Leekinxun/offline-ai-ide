import fs from "node:fs";
import path from "path";

function isContained(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function realpath(value: string): string {
  return fs.realpathSync.native(value);
}

/**
 * Resolves a workspace-relative path without allowing a symlink to cross the
 * workspace boundary. Existing entries are resolved fully; for a new entry we
 * resolve its nearest existing parent, which is the point at which a symlink
 * could otherwise redirect a write.
 */
export function safePath(rel: string, baseDir: string): string {
  const base = path.resolve(baseDir);
  const full = path.resolve(base, rel);
  if (!isContained(full, base)) {
    throw new Error("Path traversal denied");
  }

  let realBase: string;
  try {
    realBase = realpath(base);
  } catch {
    throw new Error("Workspace root is unavailable");
  }

  let probe = full;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) throw new Error("Path traversal denied");
    probe = parent;
  }
  let realProbe: string;
  try {
    realProbe = realpath(probe);
  } catch {
    throw new Error("Path is unavailable");
  }
  if (!isContained(realProbe, realBase)) {
    throw new Error("Path escapes workspace through a symbolic link");
  }
  return full;
}
