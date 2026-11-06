import type { SelectedLineRange } from "@pierre/diffs";

export interface ReviewLineSelection {
  side: "original" | "modified";
  startLine: number;
  endLine: number;
}

/** Reveal the selected file-side line using the virtual renderer's measured layout. */
export function getDiffLineRevealScrollTop(scrollTop: number, viewportHeight: number,
  lineTop: number, lineHeight: number): number {
  if (lineTop < scrollTop || lineHeight > viewportHeight) return Math.max(0, lineTop);
  if (lineTop + lineHeight > scrollTop + viewportHeight) return Math.max(0, lineTop + lineHeight - viewportHeight);
  return scrollTop;
}

/** Review comments address one immutable file side, never visual diff rows. */
export function toReviewLineSelection(range: SelectedLineRange | null): ReviewLineSelection | null {
  if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
    || range.start < 1 || range.end < 1
    || (range.side !== "additions" && range.side !== "deletions")
    || (range.endSide !== undefined && range.endSide !== range.side)) return null;
  return {
    side: range.side === "deletions" ? "original" : "modified",
    startLine: Math.min(range.start, range.end),
    endLine: Math.max(range.start, range.end),
  };
}
