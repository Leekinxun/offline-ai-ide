import type { FileTree as TreeModel } from "@pierre/trees";
import type { FileNode } from "../types";

/** Trees uses a trailing slash to distinguish directories, including empty ones. */
export function toTreePath(node: FileNode): string {
  return node.type === "directory" ? `${node.path}/` : node.path;
}

export function fromTreePath(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

/** Preserve the backend's directory-first ordering rather than sorting it again. */
export function buildTreeInput(nodes: readonly FileNode[]) {
  const paths: string[] = [];
  const directoryPaths: string[] = [];
  const nodesByPath = new Map<string, FileNode>();
  const visit = (entries: readonly FileNode[]) => {
    for (const node of entries) {
      const path = toTreePath(node);
      paths.push(path);
      nodesByPath.set(node.path, node);
      if (node.type === "directory") {
        directoryPaths.push(path);
        visit(node.children || []);
      }
    }
  };
  visit(nodes);
  return { paths, directoryPaths, nodesByPath };
}

export function getExpandedTreePaths(model: TreeModel, directoryPaths: readonly string[]): string[] {
  return directoryPaths.filter((path) => {
    const item = model.getItem(path);
    return item !== null && "isExpanded" in item && item.isExpanded();
  });
}

/** resetPaths expands ancestors of saved descendants; restore collapsed parents too. */
export function restoreTreeExpansion(model: TreeModel, directoryPaths: readonly string[], expandedPaths: readonly string[]): void {
  const expanded = new Set(expandedPaths);
  for (const path of directoryPaths) {
    const item = model.getItem(path);
    if (item && "expand" in item && expanded.has(path) && !item.isExpanded()) item.expand();
  }
  for (const path of [...directoryPaths].reverse()) {
    const item = model.getItem(path);
    if (item && "collapse" in item && !expanded.has(path) && item.isExpanded()) item.collapse();
  }
}

/** Active editors never enter the batch-selection set. */
export function syncTreeSelection(model: TreeModel, selectedPaths: ReadonlySet<string>): void {
  for (const path of model.getSelectedPaths()) {
    if (!selectedPaths.has(fromTreePath(path))) model.getItem(path)?.deselect();
  }
  for (const path of selectedPaths) {
    const item = model.getItem(path);
    if (item && !item.isSelected()) item.select();
  }
}
