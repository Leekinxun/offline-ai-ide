import type { ContextReference, FileNode } from "../types";

export function findReferenceMention(value: string, caret: number): { start: number; end: number; query: string } | null {
  const prefix = value.slice(0, caret);
  const match = prefix.match(/(?:^|\s)@([^\s@]*)$/);
  return match ? { start: caret - match[1].length - 1, end: caret, query: match[1] } : null;
}

const EXCLUDED_SEGMENTS = new Set([".git", ".history", ".checkpoints", ".team", ".tasks", ".codex", ".omx", ".crewforge", "node_modules", "dist", "build", "coverage", ".next", "vendor", ".venv"]);

export function referenceCandidates(tree: FileNode[], query: string): ContextReference[] {
  const matches: ContextReference[] = [];
  const filter = query.toLowerCase().replace(/^(?:file|folder):/, "");
  const only = query.startsWith("file:") ? "file" : query.startsWith("folder:") ? "folder" : undefined;
  const visit = (nodes: FileNode[]) => {
    for (const node of nodes) {
      if (node.path.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment) || /^\.env(?:\.|$)/i.test(segment)) || /(?:credentials|secrets?)\.(?:json|ya?ml|toml)$/i.test(node.path)) continue;
      const kind = node.type === "directory" ? "folder" : "file";
      if ((!only || only === kind) && node.path.toLowerCase().includes(filter)) matches.push({ kind, path: node.path });
      if (node.children) visit(node.children);
    }
  };
  visit(tree);
  return matches.sort((a, b) => (a.path?.length || 0) - (b.path?.length || 0) || (a.path || "").localeCompare(b.path || "")).slice(0, 30);
}

export function addContextReference(current: ContextReference[], reference: ContextReference): ContextReference[] {
  const existing = current.findIndex((item) => item.kind === reference.kind && item.path === reference.path && item.symbol === reference.symbol && JSON.stringify(item.range) === JSON.stringify(reference.range));
  if (existing >= 0) return current[existing].version === reference.version ? current : current.map((item, index) => index === existing ? reference : item);
  return current.length >= 16 ? current : [...current, reference];
}
