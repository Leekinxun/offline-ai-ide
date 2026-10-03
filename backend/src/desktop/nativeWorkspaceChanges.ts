import path from "node:path";
import { performance } from "node:perf_hooks";
import { getDesktopNativeIde, NativeIdeError } from "./nativeIdeClient.js";

interface Cursor { epoch: string; revision: number; }
interface ChangeVersion { cursor: Cursor; changed: boolean; rescanRequired: boolean; }
type RequestVersion = (workspaceDir: string, after: Cursor | undefined, signal?: AbortSignal) => Promise<ChangeVersion>;
interface WorkspaceState { cursor?: Cursor; watermark: number; tail: Promise<void>; pending: number; touched: number; }

function validVersion(value: ChangeVersion): boolean {
  return Boolean(value && typeof value === "object" && value.cursor &&
    typeof value.cursor.epoch === "string" && value.cursor.epoch.length > 0 && value.cursor.epoch.length <= 128 &&
    Number.isSafeInteger(value.cursor.revision) && value.cursor.revision >= 0 &&
    typeof value.changed === "boolean" && typeof value.rescanRequired === "boolean");
}

/** Projects native cursors onto the existing HTTP watermark. The watermark is
 * an opaque refresh cursor; fs.read continues to return the actual file mtime. */
export class DesktopWorkspaceChanges {
  private readonly workspaces = new Map<string, WorkspaceState>();
  constructor(private readonly requestVersion: RequestVersion, private readonly now: () => number = Date.now,
    private readonly elapsed: () => number = () => performance.now()) {}

  async read(workspaceDir: string, since: number, signal?: AbortSignal): Promise<{ changed: boolean; latestMtime: number }> {
    if (!Number.isFinite(since) || since < 0 || since >= Number.MAX_SAFE_INTEGER - 2) {
      throw new NativeIdeError("Invalid desktop change watermark", "INVALID_PARAMS");
    }
    const key = path.resolve(workspaceDir);
    let state = this.workspaces.get(key);
    if (!state) {
      for (const [workspace, cached] of this.workspaces) {
        if (!cached.pending && this.elapsed() - cached.touched > 600_000) this.workspaces.delete(workspace);
      }
      if (this.workspaces.size >= 64) throw new NativeIdeError("Desktop change tracker is full", "BUSY");
      state = { watermark: 0, tail: Promise.resolve(), pending: 0, touched: this.elapsed() };
      this.workspaces.set(key, state);
    }
    if (state.pending >= 64) throw new NativeIdeError("Desktop change query queue is full", "BUSY");
    const cached = state;
    cached.pending++;
    const operation = cached.tail.then(async () => {
      if (signal?.aborted) throw new NativeIdeError("Operation cancelled", "ABORTED");
      const result = await this.requestVersion(key, cached.cursor, signal);
      if (signal?.aborted) throw new NativeIdeError("Operation cancelled", "ABORTED");
      if (!validVersion(result)) throw new NativeIdeError("Invalid desktop change version", "PROTOCOL_ERROR");
      const cursorChanged = !cached.cursor || result.cursor.epoch !== cached.cursor.epoch || result.cursor.revision !== cached.cursor.revision;
      if (cursorChanged || result.changed || result.rescanRequired || since > cached.watermark) {
        const watermark = Math.max(Math.floor(this.now()), cached.watermark + 1, Math.floor(since) + 1);
        if (!Number.isSafeInteger(watermark)) throw new NativeIdeError("Desktop change watermark exhausted", "LIMIT_EXCEEDED");
        cached.watermark = watermark;
      }
      cached.cursor = { ...result.cursor };
      cached.touched = this.elapsed();
      return { changed: since < cached.watermark, latestMtime: Math.max(since, cached.watermark) };
    });
    cached.tail = operation.then(() => {}, () => {});
    try { return await operation; } finally { cached.pending--; }
  }
}

const changes = new DesktopWorkspaceChanges((workspaceDir, after, signal) =>
  getDesktopNativeIde().request<ChangeVersion>("fs.changeVersion", { workspaceDir, ...(after ? { after } : {}) }, { signal }));

export function readDesktopWorkspaceChanges(workspaceDir: string, since: number, signal?: AbortSignal) {
  return changes.read(workspaceDir, since, signal);
}
