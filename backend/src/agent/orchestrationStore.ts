import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import { migrateMaterialJson, type MigrationStep } from "../persistence/migrations.js";
import { isProcessAlive } from "../utils/processLiveness.js";

const CANONICAL_ORCHESTRATION_FORMATS = new Set([
  "tasks", "messages", "team-config", "model-budgets", "git-delivery", "provider-delivery",
]);

/** Small synchronous JSON store with an OS-visible mkdir lock.  Every mutation
 * re-reads disk while holding the lock, which makes compare-and-swap safe across
 * independently started backend processes. */
export class OrchestrationStore<T extends object> {
  private readonly file: string;
  private readonly lock: string;
  private readonly workspaceDir: string;
  private readonly name: string;
  constructor(workspaceDir: string, name: string, private readonly initial: () => T) {
    if (!CANONICAL_ORCHESTRATION_FORMATS.has(name)) throw new Error(`Unknown canonical orchestration format: ${name}`);
    this.workspaceDir = path.resolve(workspaceDir); this.name = name;
    const dir = path.join(workspaceDir, ".team", "state");
    this.file = path.join(dir, `${name}.json`); this.lock = `${this.file}.lock`;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  private acquire(): string {
    const deadline = Date.now() + 5000;
    const token = crypto.randomUUID();
    while (true) {
      try { fs.mkdirSync(this.lock, { mode: 0o700 }); fs.writeFileSync(path.join(this.lock, "owner"), JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }), { mode: 0o600 }); return token; }
      catch (error: any) {
        if (error?.code !== "EEXIST" || Date.now() >= deadline) throw new Error("Orchestration state is busy");
        // A dead process must not wedge the workspace forever.
        try {
          const owner = JSON.parse(fs.readFileSync(path.join(this.lock, "owner"), "utf8")) as { pid?: number };
          // Never steal from a live process merely because a filesystem timestamp
          // is old; stale cleanup is only for a demonstrably dead lock owner.
          if (owner.pid && !isProcessAlive(owner.pid) && Date.now() - fs.statSync(this.lock).mtimeMs > 30_000) fs.rmSync(this.lock, { recursive: true, force: true });
        } catch { /* retry */ }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8);
      }
    }
  }
  private release(token: string): void {
    try {
      const owner = JSON.parse(fs.readFileSync(path.join(this.lock, "owner"), "utf8")) as { token?: string };
      if (owner.token === token) fs.rmSync(this.lock, { recursive: true, force: true });
    } catch { /* ownership changed or lock already released */ }
  }
  private currentVersion(): number | undefined {
    const seed = this.initial() as Record<string, unknown>;
    return Number.isSafeInteger(seed.schemaVersion) ? Number(seed.schemaVersion) : undefined;
  }
  private requiresMigration(): boolean {
    const currentVersion = this.currentVersion();
    if (currentVersion === undefined || !fs.existsSync(this.file)) return false;
    try { return Number((JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, unknown>).schemaVersion) !== currentVersion; }
    catch { return true; }
  }
  private ensureMigrated(): void {
    const seed = this.initial() as Record<string, unknown>;
    const currentVersion = this.currentVersion();
    if (currentVersion === undefined || !fs.existsSync(this.file)) return;
    const steps: Record<number, MigrationStep> = {};
    for (let version = 0; version < currentVersion; version += 1) steps[version] = { up: (value) => ({ ...structuredClone(seed), ...value }) };
    migrateMaterialJson({ workspaceDir: this.workspaceDir, filePath: this.file, formatId: this.name, currentVersion, legacyVersion: 0, steps });
  }
  private withCurrentLock<R>(operation: (state: T) => R): R {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (this.requiresMigration()) this.ensureMigrated();
      const token = this.acquire();
      try {
        const state = this.read();
        const currentVersion = this.currentVersion();
        if (currentVersion !== undefined && Number((state as Record<string, unknown>).schemaVersion) !== currentVersion) continue;
        return operation(state);
      } finally { this.release(token); }
    }
    throw new Error("Orchestration state changed schema during lock acquisition");
  }
  private read(): T {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8")) as T;
    } catch (error: any) {
      if (error?.code === "ENOENT") return this.initial();
      throw new Error(`Invalid orchestration state ${path.basename(this.file)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private write(value: T): void { const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`; const handle = fs.openSync(tmp, "w", 0o600); try { fs.writeFileSync(handle, JSON.stringify(value)); fs.fsyncSync(handle); } finally { fs.closeSync(handle); } fs.renameSync(tmp, this.file); }
  snapshot(): T { return this.withCurrentLock((state) => structuredClone(state)); }
  transact<R>(fn: (state: T) => R): R { return this.withCurrentLock((state) => { const result = fn(state); this.write(state); return result; }); }
}
