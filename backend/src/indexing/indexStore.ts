import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IndexedRepositoryFile, RepositoryIndexMeta } from "./types.js";
import { isProcessAlive } from "../utils/processLiveness.js";

const STORE_DIR = path.join(".history", "repository-index", "v1");
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 10;

interface StoreLock { ownerToken: string; ownerPid: number; createdAt: number; }
interface IndexShard { schemaVersion: 1; files: Record<string, IndexedRepositoryFile>; }

const processAlive = isProcessAlive;

function pause(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function atomicWrite(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function normalizeFile(value: unknown): IndexedRepositoryFile | null {
  if (!value || typeof value !== "object") return null;
  const file = value as IndexedRepositoryFile;
  if (typeof file.path !== "string" || typeof file.contentHash !== "string" || typeof file.indexedAt !== "number") return null;
  if (!Array.isArray(file.symbols) || !Array.isArray(file.imports) || !Array.isArray(file.references)) return null;
  return file;
}

export function canonicalWorkspace(workspaceDir: string): string {
  return fs.realpathSync.native(path.resolve(workspaceDir));
}

export function repositoryPartitionId(workspaceDir: string): string {
  return crypto.createHash("sha256").update(canonicalWorkspace(workspaceDir)).digest("hex").slice(0, 24);
}

export class RepositoryIndexStore {
  readonly workspaceRoot: string;
  readonly partitionId: string;
  readonly rootDir: string;
  private readonly lockPath: string;
  private readonly rebuildLockPath: string;

  constructor(workspaceDir: string) {
    this.workspaceRoot = canonicalWorkspace(workspaceDir);
    this.partitionId = repositoryPartitionId(this.workspaceRoot);
    this.rootDir = path.join(this.workspaceRoot, STORE_DIR);
    this.lockPath = path.join(this.rootDir, ".lock");
    this.rebuildLockPath = path.join(this.rootDir, ".rebuild.lock");
  }

  private acquireLock(lockPath = this.lockPath, waitMs = LOCK_WAIT_MS): StoreLock {
    fs.mkdirSync(this.rootDir, { recursive: true });
    const deadline = Date.now() + waitMs;
    const lock: StoreLock = { ownerToken: crypto.randomUUID(), ownerPid: process.pid, createdAt: Date.now() };
    while (Date.now() <= deadline) {
      try {
        fs.writeFileSync(lockPath, JSON.stringify(lock), { encoding: "utf8", flag: "wx" });
        return lock;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let current: StoreLock | null = null;
        try { current = JSON.parse(fs.readFileSync(lockPath, "utf8")) as StoreLock; } catch { /* malformed locks fail closed until stale */ }
        const malformedStale = !current && (() => { try { return Date.now() - fs.statSync(lockPath).mtimeMs > 60_000; } catch { return false; } })();
        if (malformedStale || (current && !processAlive(current.ownerPid))) {
          try { fs.rmSync(lockPath, { force: true }); } catch { /* another contender recovered it */ }
          continue;
        }
        pause(LOCK_RETRY_MS);
      }
    }
    throw new Error("Repository index lock is held by a live owner");
  }

  private releaseLock(lock: StoreLock, lockPath = this.lockPath): void {
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, "utf8")) as StoreLock;
      if (current.ownerToken === lock.ownerToken && current.ownerPid === lock.ownerPid) fs.rmSync(lockPath, { force: true });
    } catch { /* lock already released or recovered */ }
  }

  withLock<T>(work: () => T): T {
    const lock = this.acquireLock();
    try { return work(); } finally { this.releaseLock(lock); }
  }

  withRebuildLock<T>(work: () => T): T {
    const lock = this.acquireLock(this.rebuildLockPath, 300_000);
    try { return work(); } finally { this.releaseLock(lock, this.rebuildLockPath); }
  }

  readMeta(): RepositoryIndexMeta | null {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(this.rootDir, "meta.json"), "utf8")) as RepositoryIndexMeta;
      if (value.schemaVersion !== 1 || value.partitionId !== this.partitionId || value.workspaceRoot !== this.workspaceRoot) return null;
      return value;
    } catch { return null; }
  }

  writeMeta(meta: RepositoryIndexMeta): void {
    if (meta.partitionId !== this.partitionId || meta.workspaceRoot !== this.workspaceRoot) throw new Error("Repository index partition mismatch");
    atomicWrite(path.join(this.rootDir, "meta.json"), meta);
  }

  shardId(filePath: string): string {
    return crypto.createHash("sha256").update(filePath).digest("hex").slice(0, 2);
  }

  readShard(id: string): Record<string, IndexedRepositoryFile> {
    if (!/^[a-f0-9]{2}$/.test(id)) throw new Error("Invalid repository index shard");
    try {
      const value = JSON.parse(fs.readFileSync(path.join(this.rootDir, "shards", `${id}.json`), "utf8")) as Partial<IndexShard>;
      if (value.schemaVersion !== 1 || !value.files || typeof value.files !== "object") return {};
      return Object.fromEntries(Object.entries(value.files).flatMap(([key, file]) => {
        const normalized = normalizeFile(file);
        return normalized && normalized.path === key ? [[key, normalized]] : [];
      }));
    } catch { return {}; }
  }

  writeShard(id: string, files: Record<string, IndexedRepositoryFile>): void {
    const target = path.join(this.rootDir, "shards", `${id}.json`);
    if (Object.keys(files).length === 0) { fs.rmSync(target, { force: true }); return; }
    atomicWrite(target, { schemaVersion: 1, files } satisfies IndexShard);
  }

  readAllFiles(): Map<string, IndexedRepositoryFile> {
    const result = new Map<string, IndexedRepositoryFile>();
    let names: string[] = [];
    try { names = fs.readdirSync(path.join(this.rootDir, "shards")); } catch { return result; }
    for (const name of names.sort()) {
      const match = name.match(/^([a-f0-9]{2})\.json$/);
      if (!match) continue;
      for (const [filePath, file] of Object.entries(this.readShard(match[1]))) result.set(filePath, file);
    }
    return result;
  }

  private replaceAllUnlocked(files: Map<string, IndexedRepositoryFile>, meta: RepositoryIndexMeta): void {
      const staged = path.join(this.rootDir, `staged-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
      fs.mkdirSync(staged, { recursive: true });
      try {
        const shards = new Map<string, Record<string, IndexedRepositoryFile>>();
        for (const [filePath, file] of files) {
          const id = this.shardId(filePath);
          const shard = shards.get(id) || {};
          shard[filePath] = file; shards.set(id, shard);
        }
        for (const [id, shard] of shards) atomicWrite(path.join(staged, `${id}.json`), { schemaVersion: 1, files: shard } satisfies IndexShard);
        const live = path.join(this.rootDir, "shards");
        const previous = path.join(this.rootDir, `previous-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
        if (fs.existsSync(live)) fs.renameSync(live, previous);
        fs.renameSync(staged, live);
        fs.rmSync(previous, { recursive: true, force: true });
        this.writeMeta(meta);
      } catch (error) {
        fs.rmSync(staged, { recursive: true, force: true });
        throw error;
      }
  }

  replaceAll(files: Map<string, IndexedRepositoryFile>, meta: RepositoryIndexMeta): void {
    this.withLock(() => this.replaceAllUnlocked(files, meta));
  }

  /** Commit a rebuild only if no mutation/rebuild advanced the durable revision. */
  replaceAllIfRevision(files: Map<string, IndexedRepositoryFile>, meta: RepositoryIndexMeta, expectedRevision: number): boolean {
    return this.withLock(() => {
      if (this.readMeta()?.revision !== expectedRevision) return false;
      this.replaceAllUnlocked(files, meta); return true;
    });
  }

  updateFiles(changes: Map<string, IndexedRepositoryFile | null>, nextMeta: (current: RepositoryIndexMeta | null, fileCount: number) => RepositoryIndexMeta): RepositoryIndexMeta {
    return this.withLock(() => {
      const currentMeta = this.readMeta();
      let fileCount = currentMeta?.fileCount || 0;
      const shardChanges = new Map<string, Array<[string, IndexedRepositoryFile | null]>>();
      for (const entry of changes) {
        const id = this.shardId(entry[0]);
        const entries = shardChanges.get(id) || []; entries.push(entry); shardChanges.set(id, entries);
      }
      for (const [id, entries] of shardChanges) {
        const shard = this.readShard(id);
        for (const [filePath, file] of entries) {
          const existed = Boolean(shard[filePath]);
          if (file) { shard[filePath] = file; if (!existed) fileCount += 1; }
          else if (existed) { delete shard[filePath]; fileCount -= 1; }
        }
        this.writeShard(id, shard);
      }
      const meta = nextMeta(currentMeta, Math.max(0, fileCount));
      this.writeMeta(meta);
      return meta;
    });
  }
}
