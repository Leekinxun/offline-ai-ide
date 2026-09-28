import type { ReviewFile, ReviewHunk } from "../components/runReviewPolicy";
import { normalizeWorkspaceRelativePath } from "./fileUpdatePolicy";

export interface EditorReviewBlock {
  id: string;
  originalStartLine: number;
  modifiedStartLine: number;
  removed: string[];
  added: string[];
}
export interface PositionedReviewHunk {
  hunk: ReviewHunk;
  blockId: string;
  startLine: number;
  endLine: number;
}
export interface EditorReviewLayout {
  blocks: EditorReviewBlock[];
  positionedHunks: PositionedReviewHunk[];
  unavailableHunks: ReviewHunk[];
  largeDiff: boolean;
}
export interface EditorReviewSnapshot {
  path: string; modelUri: string; modelVersion: number; content: string; revision: string;
}

function lines(value: string): string[] { return value ? value.split(/(?<=\n)/) : []; }

/** Return exact line changes. Large ambiguous middles fall back to full review. */
function lineBlocks(original: string, modified: string): EditorReviewBlock[] | null {
  const before = lines(original); const after = lines(modified);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let oldEnd = before.length; let newEnd = after.length;
  while (oldEnd > prefix && newEnd > prefix && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  const oldCount = oldEnd - prefix; const newCount = newEnd - prefix;
  if (!oldCount && !newCount) return [];
  if (!oldCount || !newCount) return [{ id: `${prefix}:${prefix}`, originalStartLine: prefix + 1, modifiedStartLine: prefix + 1, removed: before.slice(prefix, oldEnd), added: after.slice(prefix, newEnd) }];
  if (oldCount * newCount > 250_000) return null;
  const width = newCount + 1; const matrix = new Uint32Array((oldCount + 1) * width);
  for (let i = oldCount - 1; i >= 0; i--) for (let j = newCount - 1; j >= 0; j--) {
    matrix[i * width + j] = before[prefix + i] === after[prefix + j]
      ? matrix[(i + 1) * width + j + 1] + 1
      : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1]);
  }
  const blocks: EditorReviewBlock[] = [];
  let i = 0; let j = 0; let start: [number, number] | undefined;
  const flush = () => {
    if (!start) return;
    blocks.push({ id: `${prefix + start[0]}:${prefix + start[1]}`, originalStartLine: prefix + start[0] + 1,
      modifiedStartLine: prefix + start[1] + 1, removed: before.slice(prefix + start[0], prefix + i), added: after.slice(prefix + start[1], prefix + j) });
    start = undefined;
  };
  while (i < oldCount || j < newCount) {
    if (i < oldCount && j < newCount && before[prefix + i] === after[prefix + j]) { flush(); i++; j++; }
    else {
      start ??= [i, j];
      if (j === newCount || (i < oldCount && matrix[(i + 1) * width + j] >= matrix[i * width + j + 1])) i++;
      else j++;
    }
  }
  flush();
  return blocks;
}

export function matchesRecordedEditorFile(file: ReviewFile | null | undefined, path: string, content: string, dirty: boolean): file is ReviewFile {
  return Boolean(file && !dirty && file.modifiedExists && file.hasChanges && file.rollbackState !== "reverted"
    && !file.unavailableReason && !file.isBinary && !file.isTooLarge
    && typeof file.original === "string" && typeof file.modified === "string"
    && normalizeWorkspaceRelativePath(file.path) === normalizeWorkspaceRelativePath(path) && file.modified === content);
}

export function buildEditorReviewLayout(file: ReviewFile, path: string, content: string, dirty: boolean): EditorReviewLayout | null {
  if (!matchesRecordedEditorFile(file, path, content, dirty)) return null;
  const blocks = lineBlocks(file.original!, file.modified!);
  if (!blocks) return { blocks: [], positionedHunks: [], unavailableHunks: file.hunks.filter((hunk) => !hunk.reverted), largeDiff: true };
  const positionedHunks: PositionedReviewHunk[] = []; const unavailableHunks: ReviewHunk[] = [];
  const latestMutationId = file.mutationIds[file.mutationIds.length - 1];
  for (const hunk of file.hunks) {
    if (hunk.reverted) continue;
    // Earlier mutations have no full intermediate image/anchor in this API.
    // A coincidental match in the latest text cannot establish their location.
    if (hunk.truncated || typeof hunk.preimage !== "string" || typeof hunk.postimage !== "string" || hunk.mutationId !== latestMutationId) { unavailableHunks.push(hunk); continue; }
    let block: EditorReviewBlock | undefined; let startLine = 0; let endLine = 0;
    if (hunk.postimage) {
      const offset = content.indexOf(hunk.postimage);
      if (offset >= 0 && content.lastIndexOf(hunk.postimage) === offset) {
        startLine = content.slice(0, offset).split("\n").length;
        endLine = content.slice(0, offset + hunk.postimage.length - 1).split("\n").length;
        block = blocks.find((entry) => entry.added.length > 0 && startLine >= entry.modifiedStartLine && endLine < entry.modifiedStartLine + entry.added.length);
      }
    } else if (file.mutationIds.length === 1 && hunk.preimage) {
      const matches = blocks.filter((entry) => !entry.added.length && entry.removed.join("") === hunk.preimage);
      if (matches.length === 1) { block = matches[0]; startLine = block.modifiedStartLine; endLine = startLine; }
    }
    if (block) positionedHunks.push({ hunk, blockId: block.id, startLine, endLine });
    else unavailableHunks.push(hunk);
  }
  return { blocks, positionedHunks, unavailableHunks, largeDiff: false };
}

export function canApplyEditorReviewAction(
  snapshot: EditorReviewSnapshot,
  current: Omit<EditorReviewSnapshot, "revision"> & { dirty: boolean; readOnly: boolean },
  file: ReviewFile | null | undefined,
  hunk: ReviewHunk,
  decision: "keep" | "revert",
  state: { busy: boolean; running: boolean },
): boolean {
  if (current.dirty || current.readOnly || state.busy || (decision === "revert" && state.running)
    || current.modelUri !== snapshot.modelUri || current.modelVersion !== snapshot.modelVersion
    || current.content !== snapshot.content || current.path !== snapshot.path
    || !file || file.revision !== snapshot.revision) return false;
  const layout = buildEditorReviewLayout(file, current.path, current.content, current.dirty);
  const positioned = layout?.positionedHunks.find((entry) => entry.hunk.id === hunk.id && entry.hunk.mutationId === hunk.mutationId);
  return Boolean(positioned && !positioned.hunk.reverted && (decision !== "keep" || !positioned.hunk.kept));
}
