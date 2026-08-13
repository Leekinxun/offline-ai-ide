export function resolveVisibleTreeIndex(currentIndex: number, itemCount: number, key: string): number | null {
  if (itemCount <= 0) return null;
  if (key === "ArrowDown") return Math.min(itemCount - 1, currentIndex + 1);
  if (key === "ArrowUp") return Math.max(0, currentIndex - 1);
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  return null;
}
