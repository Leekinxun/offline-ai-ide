import path from "path";

export function safePath(rel: string, baseDir: string): string {
  const base = path.resolve(baseDir);
  const full = path.resolve(base, rel);
  if (!full.startsWith(base + path.sep) && full !== base) {
    throw new Error("Path traversal denied");
  }
  return full;
}
