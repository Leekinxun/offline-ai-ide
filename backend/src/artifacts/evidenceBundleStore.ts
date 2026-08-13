import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isProcessAlive } from "../utils/processLiveness.js";
import { redactSecrets } from "../agent/secretRedaction.js";
import { changeSetReviewRevision, getChangeSet } from "../chat/changeSets.js";
import { canonicalJson, sha256 } from "./reviewArtifact.js";
import { createEvidenceBundle, verifyEvidenceBundle } from "./evidenceBundle.js";

export type EvidenceBundleExportStatus = "queued" | "building" | "verifying" | "ready" | "failed" | "interrupted";
export interface EvidenceBundleExportRecord {
  schemaVersion: 1;
  exportId: string;
  changeSetId: string;
  revision: string;
  options: { includeTrace: boolean; includeTestOutput: boolean; requireSignature: boolean };
  requestDigest: string;
  status: EvidenceBundleExportStatus;
  phase: string;
  progress: number;
  createdAt: number;
  updatedAt: number;
  bundleId?: string;
  bytes?: number;
  errorCode?: string;
  error?: string;
  ownerPid: number;
  ownerToken: string;
  leaseExpiresAt: number;
}
interface ExportState { schemaVersion: 1; records: EvidenceBundleExportRecord[]; }
export class EvidenceBundlePersistenceError extends Error { readonly code = "evidence_bundle_persistence_invalid"; constructor(readonly filePath: string, cause?: unknown) { super(`Evidence bundle export persistence is invalid or unreadable: ${path.basename(filePath)}`, { cause }); } }
const ACTIVE = new Set<string>(); const LEASE_MS = 60_000;
function root(workspace: string): string { return path.resolve(workspace); }
function stateFile(workspace: string): string { return path.join(root(workspace), ".history", "evidence-bundle-exports.json"); }
function bundleDir(workspace: string): string { return path.join(root(workspace), ".history", "evidence-bundles"); }
function bundleFile(workspace: string, id: string): string { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid bundle export id"); return path.join(bundleDir(workspace), `${id}.cfbundle`); }
function empty(): ExportState { return { schemaVersion: 1, records: [] }; }
function read(workspace: string): ExportState { const file = stateFile(workspace); try { const value = JSON.parse(fs.readFileSync(file, "utf8")) as ExportState; if (value.schemaVersion === 1 && Array.isArray(value.records)) return value; throw new EvidenceBundlePersistenceError(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty(); if (error instanceof EvidenceBundlePersistenceError) throw error; throw new EvidenceBundlePersistenceError(file, error); } }
function write(workspace: string, state: ExportState): void { const file = stateFile(workspace); fs.mkdirSync(path.dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`; fs.writeFileSync(temp, `${JSON.stringify(redactSecrets(state), null, 2)}\n`, { flag: "wx", mode: 0o600 }); fs.renameSync(temp, file); }
const alive = isProcessAlive;
function withLock<T>(workspace: string, operation: (state: ExportState) => T): T { const file = stateFile(workspace); const lock = `${file}.lock`; fs.mkdirSync(path.dirname(file), { recursive: true }); const token = crypto.randomUUID(); let fd: number | undefined; for (let attempt = 0; attempt < 400; attempt += 1) { try { fd = fs.openSync(lock, "wx", 0o600); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, createdAt: Date.now() })); break; } catch { try { const owner = JSON.parse(fs.readFileSync(lock, "utf8")) as { pid?: number; createdAt?: number }; if (owner.pid && !alive(owner.pid) && Date.now() - (owner.createdAt || 0) > 1_000) fs.rmSync(lock, { force: true }); } catch { /* retry */ } Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); } } if (fd === undefined) throw new Error("Evidence bundle export store is busy"); try { const state = read(workspace); const result = operation(state); write(workspace, state); return result; } finally { fs.closeSync(fd); try { const owner = JSON.parse(fs.readFileSync(lock, "utf8")) as { token?: string }; if (owner.token === token) fs.rmSync(lock, { force: true }); } catch { /* released */ } } }
function ownership() { return { ownerPid: process.pid, ownerToken: crypto.randomUUID(), leaseExpiresAt: Date.now() + LEASE_MS }; }
function publicRecord(record: EvidenceBundleExportRecord): Omit<EvidenceBundleExportRecord, "ownerPid" | "ownerToken" | "leaseExpiresAt"> { const { ownerPid: _ownerPid, ownerToken: _ownerToken, leaseExpiresAt: _leaseExpiresAt, ...value } = record; return structuredClone(value); }

export class EvidenceBundleExportStore {
  constructor(private readonly workspace: string) {}

  schedule(changeSetId: string, expectedRevision?: string, rawOptions: Partial<EvidenceBundleExportRecord["options"]> = {}): ReturnType<typeof publicRecord> {
    const changeSet = getChangeSet(this.workspace, changeSetId); const revision = changeSetReviewRevision(changeSet); if (expectedRevision && revision !== expectedRevision) throw new Error("Change set revision is stale");
    const options = { includeTrace: rawOptions.includeTrace !== false, includeTestOutput: rawOptions.includeTestOutput !== false, requireSignature: rawOptions.requireSignature === true };
    const requestDigest = sha256(canonicalJson({ changeSetId, revision, options }));
    const record = withLock(this.workspace, (state) => {
      const existing = state.records.find((item) => item.requestDigest === requestDigest && ["queued", "building", "verifying", "ready"].includes(item.status)); if (existing) return existing;
      const now = Date.now(); const created: EvidenceBundleExportRecord = { schemaVersion: 1, exportId: crypto.randomUUID(), changeSetId, revision, options, requestDigest, status: "queued", phase: "queued", progress: 0, createdAt: now, updatedAt: now, ...ownership() };
      state.records.push(created); return created;
    });
    this.dispatch(record.exportId); return publicRecord(record);
  }

  list(): Array<ReturnType<typeof publicRecord>> { this.reconcile(); return read(this.workspace).records.sort((a, b) => b.createdAt - a.createdAt).map(publicRecord); }
  get(id: string): ReturnType<typeof publicRecord> { this.reconcile(); const item = read(this.workspace).records.find((record) => record.exportId === id); if (!item) throw new Error("Evidence bundle export not found"); return publicRecord(item); }
  download(id: string): Buffer { const item = this.get(id); if (item.status !== "ready") throw new Error("Evidence bundle export is not ready"); const file = bundleFile(this.workspace, id); const bytes = fs.readFileSync(file); const verification = verifyEvidenceBundle(this.workspace, bytes); if (item.bytes !== bytes.byteLength || item.bundleId !== verification.bundleId || verification.integrity !== "verified" || verification.bindings !== "verified") throw new Error("Persisted evidence bundle failed integrity validation"); return bytes; }

  reconcile(): void {
    const enqueue = withLock(this.workspace, (state) => { const ids: string[] = []; const now = Date.now(); for (const item of state.records) { if (!["queued", "building", "verifying"].includes(item.status) || ACTIVE.has(item.exportId)) continue; if (alive(item.ownerPid) && item.leaseExpiresAt > now && item.ownerPid !== process.pid) continue; if (item.status !== "queued") item.status = "interrupted"; Object.assign(item, ownership(), { status: "queued", phase: "recovering", progress: 0, updatedAt: now }); ids.push(item.exportId); } return ids; });
    for (const id of enqueue) this.dispatch(id);
  }

  private dispatch(id: string): void { if (ACTIVE.has(id)) return; ACTIVE.add(id); queueMicrotask(() => { try { this.execute(id); } finally { ACTIVE.delete(id); } }); }
  private execute(id: string): void {
    let record = withLock(this.workspace, (state) => { const item = state.records.find((value) => value.exportId === id); if (!item || item.status !== "queued") return undefined; Object.assign(item, { status: "building", phase: "collecting", progress: 20, updatedAt: Date.now(), ...ownership() }); return structuredClone(item); });
    if (!record) return;
    try {
      const bytes = createEvidenceBundle(this.workspace, record.changeSetId, record.revision, record.options);
      withLock(this.workspace, (state) => { const item = state.records.find((value) => value.exportId === id); if (!item || item.ownerToken !== record!.ownerToken) throw new Error("Evidence bundle export ownership changed"); Object.assign(item, { status: "verifying", phase: "integrity", progress: 75, updatedAt: Date.now(), leaseExpiresAt: Date.now() + LEASE_MS }); record = structuredClone(item); });
      const verification = verifyEvidenceBundle(this.workspace, bytes); if (verification.integrity !== "verified" || verification.bindings !== "verified" || !verification.bundleId) throw new Error(verification.issues.map((item) => item.code).join(",") || "Evidence bundle verification failed");
      fs.mkdirSync(bundleDir(this.workspace), { recursive: true }); const target = bundleFile(this.workspace, id); const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`; fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, target);
      withLock(this.workspace, (state) => { const item = state.records.find((value) => value.exportId === id); if (!item || item.ownerToken !== record!.ownerToken) throw new Error("Evidence bundle export ownership changed"); Object.assign(item, { status: "ready", phase: "ready", progress: 100, updatedAt: Date.now(), bundleId: verification.bundleId, bytes: bytes.byteLength, error: undefined, errorCode: undefined }); });
    } catch (error) {
      withLock(this.workspace, (state) => { const item = state.records.find((value) => value.exportId === id); if (!item) return; Object.assign(item, { status: "failed", phase: "failed", updatedAt: Date.now(), errorCode: "bundle_export_failed", error: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 1_000) }); });
    }
  }
}
