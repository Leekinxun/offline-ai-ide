export type ConflictSource = "team_member" | "external" | "assistant_tool" | "unknown";

export interface DiffHunk {
  id: string;
  localStart: number;
  localEnd: number;
  remoteStart: number;
  remoteEnd: number;
  localLines: string[];
  remoteLines: string[];
}

export interface ConflictSourceInfo {
  source: ConflictSource;
  actor?: string;
}

interface HunkBuildState {
  localStart: number;
  remoteStart: number;
  localLines: string[];
  remoteLines: string[];
}

function splitLines(value: string): string[] {
  return value.split("\n");
}

export function buildConflictHunks(localContent: string, remoteContent: string): DiffHunk[] {
  const localLines = splitLines(localContent);
  const remoteLines = splitLines(remoteContent);
  const localLength = localLines.length;
  const remoteLength = remoteLines.length;
  const matrixCellLimit = 250_000;

  if (localLength * remoteLength > matrixCellLimit) {
    return [
      {
        id: "0-0-0",
        localStart: 0,
        localEnd: localLength,
        remoteStart: 0,
        remoteEnd: remoteLength,
        localLines,
        remoteLines,
      },
    ];
  }

  const dp: number[][] = Array.from({ length: localLength + 1 }, () =>
    Array<number>(remoteLength + 1).fill(0)
  );

  for (let i = localLength - 1; i >= 0; i -= 1) {
    for (let j = remoteLength - 1; j >= 0; j -= 1) {
      dp[i][j] =
        localLines[i] === remoteLines[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const hunks: DiffHunk[] = [];
  let build: HunkBuildState | null = null;
  let i = 0;
  let j = 0;

  const flush = () => {
    if (!build) return;
    hunks.push({
      id: `${hunks.length}-${build.localStart}-${build.remoteStart}`,
      localStart: build.localStart,
      localEnd: build.localStart + build.localLines.length,
      remoteStart: build.remoteStart,
      remoteEnd: build.remoteStart + build.remoteLines.length,
      localLines: build.localLines,
      remoteLines: build.remoteLines,
    });
    build = null;
  };

  while (i < localLength && j < remoteLength) {
    if (localLines[i] === remoteLines[j]) {
      flush();
      i += 1;
      j += 1;
      continue;
    }

    if (!build) {
      build = {
        localStart: i,
        remoteStart: j,
        localLines: [],
        remoteLines: [],
      };
    }

    if (dp[i + 1][j] >= dp[i][j + 1]) {
      build.localLines.push(localLines[i]);
      i += 1;
    } else {
      build.remoteLines.push(remoteLines[j]);
      j += 1;
    }
  }

  if (!build && (i < localLength || j < remoteLength)) {
    build = {
      localStart: i,
      remoteStart: j,
      localLines: [],
      remoteLines: [],
    };
  }

  while (i < localLength) {
    if (!build) {
      build = {
        localStart: i,
        remoteStart: j,
        localLines: [],
        remoteLines: [],
      };
    }
    build.localLines.push(localLines[i]);
    i += 1;
  }

  while (j < remoteLength) {
    if (!build) {
      build = {
        localStart: i,
        remoteStart: j,
        localLines: [],
        remoteLines: [],
      };
    }
    build.remoteLines.push(remoteLines[j]);
    j += 1;
  }

  flush();
  return hunks;
}

export function applyHunkSelections(
  localContent: string,
  hunks: DiffHunk[],
  selections: Record<string, "local" | "remote">
): string {
  const localLines = splitLines(localContent);
  const result: string[] = [];
  let cursor = 0;

  for (const hunk of hunks) {
    result.push(...localLines.slice(cursor, hunk.localStart));
    result.push(...(selections[hunk.id] === "remote" ? hunk.remoteLines : hunk.localLines));
    cursor = hunk.localEnd;
  }

  result.push(...localLines.slice(cursor));
  return result.join("\n");
}

export function countRemoteSelections(
  hunks: DiffHunk[],
  selections: Record<string, "local" | "remote">
): number {
  return hunks.reduce(
    (total, hunk) => total + (selections[hunk.id] === "remote" ? 1 : 0),
    0
  );
}

export function formatLineRange(start: number, end: number): string {
  const startLine = start + 1;
  const endLine = Math.max(start + 1, end);
  return startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
}
