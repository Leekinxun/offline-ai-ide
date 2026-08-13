import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isProcessAlive } from "../utils/processLiveness.js";
import { CURRENT_CHANGE_SET_SCHEMA_VERSION } from "../chat/changeSetSchema.js";

export type MigrationState = "current" | "migrated" | "failed" | "rolled_back" | "future_version";

export interface PersistenceFormatInventoryEntry {
  id: string;
  area: string;
  pathPattern: string;
  currentSchemaVersion: number;
  compatibility: "versioned" | "legacy-reader" | "append-only" | "rebuildable";
  rollback: "backup" | "rebuild" | "not-applicable";
}

/** Machine-readable inventory for every material G001-G006 persistence family. */
export const MATERIAL_PERSISTENCE_INVENTORY: readonly PersistenceFormatInventoryEntry[] = [
  { id: "chat-history", area: "history/runs/evidence", pathPattern: ".history/*.jsonl", currentSchemaVersion: 1, compatibility: "append-only", rollback: "not-applicable" },
  { id: "agent-runs", area: "history/runs/evidence", pathPattern: ".history/runs/*.json", currentSchemaVersion: 3, compatibility: "legacy-reader", rollback: "backup" },
  { id: "completion-evidence", area: "history/runs/evidence", pathPattern: "embedded:agent-runs", currentSchemaVersion: 1, compatibility: "versioned", rollback: "backup" },
  { id: "execution-plans", area: "history/runs/evidence", pathPattern: ".history/plans/*.json", currentSchemaVersion: 2, compatibility: "legacy-reader", rollback: "backup" },
  { id: "context-manifests", area: "history/runs/evidence", pathPattern: ".history/context-manifests/*.json + context-preferences/*.json", currentSchemaVersion: 1, compatibility: "versioned", rollback: "backup" },
  { id: "change-sets", area: "history/runs/evidence", pathPattern: ".history/change-sets/*.json", currentSchemaVersion: CURRENT_CHANGE_SET_SCHEMA_VERSION, compatibility: "legacy-reader", rollback: "backup" },
  { id: "managed-worktrees", area: "history/runs/evidence", pathPattern: ".history/worktrees/*.json", currentSchemaVersion: 1, compatibility: "versioned", rollback: "backup" },
  { id: "review-artifacts", area: "history/runs/evidence", pathPattern: "derived:review-artifact/SARIF", currentSchemaVersion: 1, compatibility: "versioned", rollback: "not-applicable" },
  { id: "evidence-bundle-exports", area: "history/runs/evidence", pathPattern: ".history/evidence-bundle-exports.json + evidence-bundles/*.cfbundle", currentSchemaVersion: 1, compatibility: "versioned", rollback: "backup" },
  { id: "checkpoints", area: "checkpoints/rollback", pathPattern: ".checkpoints/index.json + .checkpoints/manifests/*.json", currentSchemaVersion: 3, compatibility: "legacy-reader", rollback: "backup" },
  { id: "mutation-journal", area: "checkpoints/rollback", pathPattern: ".checkpoints/mutations.json", currentSchemaVersion: 1, compatibility: "versioned", rollback: "backup" },
  { id: "tasks", area: "tasks/agents/messages", pathPattern: ".team/state/tasks.json", currentSchemaVersion: 1, compatibility: "legacy-reader", rollback: "backup" },
  { id: "messages", area: "tasks/agents/messages", pathPattern: ".team/state/messages.json", currentSchemaVersion: 1, compatibility: "legacy-reader", rollback: "backup" },
  { id: "team-config", area: "tasks/agents/messages", pathPattern: ".team/config.json -> .team/state/team-config.json", currentSchemaVersion: 1, compatibility: "legacy-reader", rollback: "backup" },
  { id: "team-index", area: "tasks/agents/messages", pathPattern: ".team/teams.json", currentSchemaVersion: 1, compatibility: "legacy-reader", rollback: "backup" },
  { id: "traces", area: "tasks/agents/messages/traces", pathPattern: ".history/traces/*.jsonl", currentSchemaVersion: 1, compatibility: "append-only", rollback: "not-applicable" },
  { id: "repository-index", area: "repo-index", pathPattern: ".history/repository-index/v1/**", currentSchemaVersion: 1, compatibility: "rebuildable", rollback: "rebuild" },
  { id: "provider-delivery", area: "delivery/integrations", pathPattern: ".team/state/provider-delivery.json", currentSchemaVersion: 2, compatibility: "versioned", rollback: "backup" },
  { id: "git-delivery", area: "delivery/integrations", pathPattern: ".team/state/git-delivery.json", currentSchemaVersion: 1, compatibility: "versioned", rollback: "backup" },
  { id: "delivery-feedback", area: "delivery/findings", pathPattern: ".history/delivery-feedback.json", currentSchemaVersion: 1, compatibility: "versioned", rollback: "backup" },
  { id: "review-findings", area: "delivery/findings", pathPattern: ".history/review-findings.json", currentSchemaVersion: 1, compatibility: "versioned", rollback: "backup" },
  { id: "extension-admin-policy", area: "extension-policy/profiles/hooks", pathPattern: "$CREWFORGE_ADMIN_POLICY", currentSchemaVersion: 1, compatibility: "versioned", rollback: "backup" },
  { id: "extension-workspace-policy", area: "extension-policy/profiles/hooks", pathPattern: ".codex/policy-override.json", currentSchemaVersion: 1, compatibility: "versioned", rollback: "backup" },
  { id: "plugin-manifests", area: "extension-policy/profiles/hooks", pathPattern: "plugins/*/plugin.json", currentSchemaVersion: 1, compatibility: "legacy-reader", rollback: "backup" },
  { id: "collaboration", area: "collaboration", pathPattern: ".team/collaboration-v1.json", currentSchemaVersion: 1, compatibility: "versioned", rollback: "backup" },
  { id: "model-budgets", area: "model-governance/budgets/settings", pathPattern: ".team/state/model-budgets.json", currentSchemaVersion: 1, compatibility: "versioned", rollback: "backup" },
  { id: "app-settings", area: "model-governance/budgets/settings", pathPattern: "config.appSettingsPath", currentSchemaVersion: 1, compatibility: "legacy-reader", rollback: "backup" },
] as const;

export interface MigrationRecord {
  id: string;
  formatId: string;
  relativePath: string;
  fromVersion: number;
  toVersion: number;
  state: MigrationState;
  backupPath?: string;
  beforeHash?: string;
  afterHash?: string;
  error?: string;
  startedAt: string;
  completedAt: string;
}

interface MigrationJournal { schemaVersion: 1; version: number; records: MigrationRecord[]; }
export interface MigrationStep { up: (value: Record<string, unknown>) => Record<string, unknown>; down?: (value: Record<string, unknown>) => Record<string, unknown>; }

const STATUS_PATH = path.join(".codex", "migrations", "status.json");
const BACKUPS_PATH = path.join(".codex", "migrations", "backups");
const WORKSPACE_JOURNALED_FORMAT_IDS = new Set([
  "tasks", "messages", "team-config", "model-budgets", "git-delivery", "provider-delivery",
  "mutation-journal", "collaboration", "delivery-feedback", "extension-workspace-policy",
]);

function hash(bytes: Buffer | string): string { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function canonicalWorkspace(workspaceDir: string): string { return fs.realpathSync.native(path.resolve(workspaceDir)); }
function assertSafeFile(workspaceDir: string, filePath: string): { root: string; file: string; relative: string } {
  const requestedRoot = path.resolve(workspaceDir); const requestedFile = path.resolve(filePath);
  const requestedRelative = path.relative(requestedRoot, requestedFile);
  if (requestedRelative === ".." || requestedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(requestedRelative)) throw new Error("Migration target escapes workspace");
  const root = canonicalWorkspace(workspaceDir); const file = path.resolve(root, requestedRelative);
  const relative = requestedRelative.replace(/\\/g, "/");
  let cursor = root;
  for (const segment of relative.split("/").filter(Boolean)) { cursor = path.join(cursor, segment); if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error("Migration target cannot contain symlinks"); }
  return { root, file, relative };
}
function assertStrictRelative(relativePath: string, label: string): string {
  if (!relativePath || relativePath.includes("\\") || path.posix.isAbsolute(relativePath) || path.posix.normalize(relativePath) !== relativePath || relativePath.split("/").includes("..")) {
    throw new Error(`${label} must be a normalized relative workspace path`);
  }
  return relativePath;
}
function ensureSafeDirectory(workspaceDir: string, relativeDir: string): string {
  const root = canonicalWorkspace(workspaceDir); const relative = assertStrictRelative(relativeDir.replace(/\\/g, "/"), "Migration control directory");
  let cursor = root;
  for (const segment of relative.split("/")) {
    cursor = path.join(cursor, segment);
    if (fs.existsSync(cursor)) {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Migration control path cannot contain symlinks or non-directories");
    } else {
      fs.mkdirSync(cursor, { mode: 0o700 });
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Migration control directory creation was unsafe");
    }
  }
  return cursor;
}
function validateMigrationControlPaths(workspaceDir: string): void {
  const root = canonicalWorkspace(workspaceDir);
  assertSafeFile(root, path.join(root, STATUS_PATH));
  assertSafeFile(root, path.join(root, BACKUPS_PATH));
}
function atomicWrite(file: string, bytes: Buffer | string): void {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`; const fd = fs.openSync(temp, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
function readJournal(workspaceDir: string): MigrationJournal {
  const root = canonicalWorkspace(workspaceDir); const file = assertSafeFile(root, path.join(root, STATUS_PATH)).file;
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, version: 1, records: [] };
    throw error;
  }
  try {
    const value = JSON.parse(raw) as Partial<MigrationJournal>;
    if (value.schemaVersion === 1 && Number.isSafeInteger(value.version) && Array.isArray(value.records)) return value as MigrationJournal;
  } catch { /* fail below without reflecting journal contents */ }
  throw new Error("Migration journal is corrupt or uses an unsupported schema");
}
function appendRecordUnlocked(workspaceDir: string, record: MigrationRecord): void {
  const journal = readJournal(workspaceDir); journal.version += 1; journal.records = [...journal.records, record].slice(-2_000);
  ensureSafeDirectory(workspaceDir, path.posix.dirname(STATUS_PATH.replace(/\\/g, "/")));
  const status = assertSafeFile(workspaceDir, path.join(workspaceDir, STATUS_PATH));
  atomicWrite(status.file, `${JSON.stringify(journal, null, 2)}\n`);
}
function withMigrationLock<T>(workspaceDir: string, operation: () => T): T {
  const root = canonicalWorkspace(workspaceDir); validateMigrationControlPaths(root);
  const migrationsDir = ensureSafeDirectory(root, ".codex/migrations");
  const lock = path.join(migrationsDir, "lock"); const owner = path.join(lock, "owner.json");
  const token = crypto.randomUUID(); const deadline = Date.now() + 10_000;
  while (true) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      const fd = fs.openSync(owner, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, createdAt: Date.now() })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let recoverable = false;
      try {
        const value = JSON.parse(fs.readFileSync(owner, "utf8")) as { pid?: unknown };
        const pid = Number(value.pid); const alive = isProcessAlive(pid);
        recoverable = !alive && Date.now() - fs.statSync(lock).mtimeMs > 30_000;
      } catch {
        try { recoverable = Date.now() - fs.statSync(lock).mtimeMs > 30_000; }
        catch (statError) { if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue; throw statError; }
      }
      if (recoverable) {
        const stale = `${lock}.stale-${crypto.randomUUID()}`;
        try { fs.renameSync(lock, stale); fs.rmSync(stale, { recursive: true, force: true }); continue; }
        catch { /* another process recovered it */ }
      }
      if (Date.now() >= deadline) throw new Error("Migration control is busy");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return operation(); }
  finally {
    let owned = false;
    try { owned = (JSON.parse(fs.readFileSync(owner, "utf8")) as { token?: unknown }).token === token; } catch { /* lost/corrupt owner */ }
    if (!owned) throw new Error("Migration lock ownership was lost");
    fs.unlinkSync(owner); fs.rmdirSync(lock);
  }
}
function withExclusiveTargetLock<T>(targetFile: string, operation: () => T): T {
  const lock = `${targetFile}.lock`; const token = crypto.randomUUID();
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Migration target has an active writer lock");
    throw error;
  }
  try {
    fs.writeFileSync(path.join(lock, "owner"), JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }), { flag: "wx", mode: 0o600 });
    return operation();
  } finally {
    try { const owner = JSON.parse(fs.readFileSync(path.join(lock, "owner"), "utf8")) as { token?: string }; if (owner.token === token) fs.rmSync(lock, { recursive: true, force: true }); }
    catch { /* ownership changed or lock already removed */ }
  }
}
function backup(workspaceDir: string, file: string, relative: string, migrationId: string): string {
  const backupRelative = path.join(".codex", "migrations", "backups", migrationId, relative);
  ensureSafeDirectory(workspaceDir, path.dirname(backupRelative).replace(/\\/g, "/"));
  const target = assertSafeFile(workspaceDir, path.join(workspaceDir, backupRelative)).file;
  fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, 0o600); return backupRelative.replace(/\\/g, "/");
}

function readRegularNoSymlinkFile(workspaceDir: string, filePath: string, label: string): Buffer {
  const safe = assertSafeFile(workspaceDir, filePath);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let fd: number | undefined;
  try {
    fd = fs.openSync(safe.file, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw new Error(`${label} must be a regular file`);
    const pathname = fs.lstatSync(safe.file);
    if (pathname.isSymbolicLink()) throw new Error(`${label} cannot be a symlink`);
    const current = fs.statSync(safe.file);
    if (current.dev !== opened.dev || current.ino !== opened.ino) throw new Error(`${label} changed during validation`);
    if (fs.realpathSync.native(safe.file) !== safe.file) throw new Error(`${label} cannot traverse symlinks`);
    return fs.readFileSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    throw new Error(`${label} is missing or unsafe: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export class PersistenceMigrationError extends Error {
  constructor(message: string, readonly record: MigrationRecord) { super(message); this.name = "PersistenceMigrationError"; }
}

export function migrateMaterialJson(input: {
  workspaceDir: string; filePath: string; formatId: string; currentVersion: number; legacyVersion?: number; steps: Record<number, MigrationStep>;
}): Record<string, unknown> {
  const target = assertSafeFile(input.workspaceDir, input.filePath);
  return withMigrationLock(target.root, () => withExclusiveTargetLock(target.file, () => {
    const revalidated = assertSafeFile(target.root, target.file);
    const bytes = readRegularNoSymlinkFile(target.root, revalidated.file, "Migration target");
    let value: Record<string, unknown>; const id = `migration-${Date.now()}-${crypto.randomUUID()}`; const startedAt = new Date().toISOString();
    try { const parsed = JSON.parse(bytes.toString("utf8")); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("root must be an object"); value = parsed; }
    catch (error) {
      const record: MigrationRecord = { id, formatId: input.formatId, relativePath: target.relative, fromVersion: input.legacyVersion ?? 0, toVersion: input.currentVersion, state: "failed", beforeHash: hash(bytes), error: `Invalid persisted ${input.formatId}: ${error instanceof Error ? error.message : String(error)}`, startedAt, completedAt: new Date().toISOString() };
      appendRecordUnlocked(target.root, record); throw new PersistenceMigrationError(record.error!, record);
    }
    const fromVersion = Number.isSafeInteger(value.schemaVersion) ? Number(value.schemaVersion) : (input.legacyVersion ?? 0);
    if (fromVersion === input.currentVersion) return value;
    if (fromVersion > input.currentVersion) {
      const record: MigrationRecord = { id, formatId: input.formatId, relativePath: target.relative, fromVersion, toVersion: input.currentVersion, state: "future_version", beforeHash: hash(bytes), error: "Persisted schema is newer than this server", startedAt, completedAt: new Date().toISOString() };
      appendRecordUnlocked(target.root, record); throw new PersistenceMigrationError(record.error!, record);
    }
    let backupPath: string | undefined;
    try {
      readJournal(target.root); // validate recovery metadata before source side effects
      assertSafeFile(target.root, target.file);
      backupPath = backup(target.root, target.file, target.relative, id);
      let version = fromVersion;
      while (version < input.currentVersion) {
        const step = input.steps[version]; if (!step) throw new Error(`No ${input.formatId} migration from schema ${version}`);
        value = step.up(structuredClone(value)); version += 1; value.schemaVersion = version;
      }
      const serialized = `${JSON.stringify(value, null, 2)}\n`; atomicWrite(target.file, serialized);
      appendRecordUnlocked(target.root, { id, formatId: input.formatId, relativePath: target.relative, fromVersion, toVersion: input.currentVersion, state: "migrated", backupPath, beforeHash: hash(bytes), afterHash: hash(serialized), startedAt, completedAt: new Date().toISOString() });
      return value;
    } catch (error) {
      const record: MigrationRecord = { id, formatId: input.formatId, relativePath: target.relative, fromVersion, toVersion: input.currentVersion, state: "failed", backupPath, beforeHash: hash(bytes), error: error instanceof Error ? error.message : String(error), startedAt, completedAt: new Date().toISOString() };
      appendRecordUnlocked(target.root, record); throw new PersistenceMigrationError(record.error!, record);
    }
  }));
}

export function isMigrationRollbackFormatId(formatId: string): boolean {
  return WORKSPACE_JOURNALED_FORMAT_IDS.has(formatId);
}

export function rollbackLastMigration(workspaceDir: string, formatId: string): MigrationRecord {
  if (!formatId || formatId !== formatId.trim()) throw new Error("An explicit formatId is required for rollback");
  const root = canonicalWorkspace(workspaceDir); return withMigrationLock(root, () => {
  const journal = readJournal(root);
  const rolledBackBackups = new Set(journal.records.filter((record) => record.state === "rolled_back" && record.backupPath).map((record) => record.backupPath!));
  const source = [...journal.records].reverse().find((record) => record.state === "migrated" && record.backupPath && record.formatId === formatId && !rolledBackBackups.has(record.backupPath));
  if (!source) throw new Error("No successful migration backup is available");
  const relativePath = assertStrictRelative(source.relativePath, "Migration target");
  if (!/^migration-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(source.id)) throw new Error("Migration journal contains an invalid migration id");
  const target = assertSafeFile(root, path.join(root, relativePath));
  if (target.relative !== relativePath) throw new Error("Migration journal target path is not canonical");
  const expectedBackupPath = path.posix.join(BACKUPS_PATH.replace(/\\/g, "/"), source.id, relativePath);
  if (source.backupPath !== expectedBackupPath) throw new Error("Migration journal backup path does not match the expected backup location");
  validateMigrationControlPaths(root);
  return withExclusiveTargetLock(target.file, () => {
  const current = readRegularNoSymlinkFile(root, target.file, "Migration target");
  if (!source.afterHash || !/^[0-9a-f]{64}$/i.test(source.afterHash)) throw new Error("Migration journal is missing a valid migrated-target hash");
  if (hash(current) !== source.afterHash) throw new Error("Persisted data changed after migration; rollback refused");
  if (!source.beforeHash || !/^[0-9a-f]{64}$/i.test(source.beforeHash)) throw new Error("Migration journal is missing a valid source backup hash");
  const backupFile = assertSafeFile(root, path.join(root, expectedBackupPath)).file;
  const restored = readRegularNoSymlinkFile(root, backupFile, "Migration backup");
  if (hash(restored) !== source.beforeHash) throw new Error("Migration backup hash does not match the recorded source bytes");
  assertSafeFile(root, target.file); atomicWrite(target.file, restored);
  const record: MigrationRecord = { id: `rollback-${Date.now()}-${crypto.randomUUID()}`, formatId: source.formatId, relativePath: source.relativePath, fromVersion: source.toVersion, toVersion: source.fromVersion, state: "rolled_back", backupPath: source.backupPath, beforeHash: hash(current), afterHash: hash(restored), startedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
  appendRecordUnlocked(root, record); return record;
  });
  });
}

export function getMigrationStatus(workspaceDir: string): { schemaVersion: 1; inventory: readonly PersistenceFormatInventoryEntry[]; journal: MigrationJournal; failures: MigrationRecord[]; statusError?: string } {
  const root = canonicalWorkspace(workspaceDir);
  try {
    const journal = readJournal(root);
    return { schemaVersion: 1, inventory: MATERIAL_PERSISTENCE_INVENTORY, journal, failures: journal.records.filter((record) => record.state === "failed" || record.state === "future_version") };
  } catch {
    return { schemaVersion: 1, inventory: MATERIAL_PERSISTENCE_INVENTORY, journal: { schemaVersion: 1, version: 0, records: [] }, failures: [], statusError: "Migration journal is corrupt or uses an unsupported schema; operator recovery is required" };
  }
}

const ORCHESTRATION_DEFAULTS: ReadonlyArray<{ formatId: string; relativePath: string; currentVersion: number; defaults: Record<string, unknown> }> = [
  { formatId: "tasks", relativePath: ".team/state/tasks.json", currentVersion: 1, defaults: { version: 1, nextId: 1, tasks: {} } },
  { formatId: "messages", relativePath: ".team/state/messages.json", currentVersion: 1, defaults: { version: 1, sequence: 0, messages: [] } },
  { formatId: "team-config", relativePath: ".team/state/team-config.json", currentVersion: 1, defaults: { team_name: "default", members: [], version: 1 } },
  { formatId: "model-budgets", relativePath: ".team/state/model-budgets.json", currentVersion: 1, defaults: { entries: {} } },
  { formatId: "git-delivery", relativePath: ".team/state/git-delivery.json", currentVersion: 1, defaults: { operations: {}, idempotency: {} } },
  { formatId: "provider-delivery", relativePath: ".team/state/provider-delivery.json", currentVersion: 2, defaults: { operations: {}, idempotency: {}, deliveries: {}, webhookReceipts: {}, capabilities: {} } },
  { formatId: "team-config", relativePath: ".team/config.json", currentVersion: 1, defaults: { team_name: "default", members: [], version: 1 } },
  { formatId: "mutation-journal", relativePath: ".checkpoints/mutations.json", currentVersion: 1, defaults: { records: [] } },
  { formatId: "collaboration", relativePath: ".team/collaboration-v1.json", currentVersion: 1, defaults: { version: 1, claims: [], presence: [], comments: [], reviewRequests: [], buffers: [], mergePreviews: [], mergeDecisions: [], activity: [] } },
  { formatId: "delivery-feedback", relativePath: ".history/delivery-feedback.json", currentVersion: 1, defaults: { version: 1, feedback: [] } },
  { formatId: "extension-workspace-policy", relativePath: ".codex/policy-override.json", currentVersion: 1, defaults: { version: 0, adminPolicyVersion: 1, permissions: { id: "workspace", allow: [], deny: [] }, sandbox: { readPaths: [], writePaths: [], networkOrigins: [], secretEnv: [] }, updatedAt: new Date(0).toISOString() } },
];

/** Eagerly migrates mutable orchestration families; other inventory readers migrate or rebuild on access. */
export function migrateWorkspacePersistence(workspaceDir: string): { migrated: string[]; current: string[]; skipped: Array<{ formatId: string; relativePath: string; code: "superseded" | "active_lock"; blocking: boolean; reason: string }>; failed: Array<{ formatId: string; error: string }> } {
  const root = canonicalWorkspace(workspaceDir); const result = { migrated: [] as string[], current: [] as string[], skipped: [] as Array<{ formatId: string; relativePath: string; code: "superseded" | "active_lock"; blocking: boolean; reason: string }>, failed: [] as Array<{ formatId: string; error: string }> };
  for (const spec of ORCHESTRATION_DEFAULTS) {
    if (spec.relativePath === ".team/config.json" && fs.existsSync(path.join(root, ".team", "state", "team-config.json"))) {
      if (fs.existsSync(path.join(root, spec.relativePath))) result.skipped.push({ formatId: "team-config", relativePath: spec.relativePath, code: "superseded", blocking: false, reason: "superseded by .team/state/team-config.json" });
      continue;
    }
    const filePath = path.join(root, spec.relativePath); if (!fs.existsSync(filePath)) continue;
    let before: unknown;
    try { before = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { before = undefined; }
    const version = before && typeof before === "object" && Number.isSafeInteger((before as Record<string, unknown>).schemaVersion) ? Number((before as Record<string, unknown>).schemaVersion) : 0;
    if (version === spec.currentVersion) { result.current.push(spec.formatId); continue; }
    const steps: Record<number, MigrationStep> = {};
    for (let from = 0; from < spec.currentVersion; from += 1) steps[from] = { up: (value) => ({ ...structuredClone(spec.defaults), ...value }) };
    try {
      migrateMaterialJson({ workspaceDir: root, filePath, formatId: spec.formatId, currentVersion: spec.currentVersion, legacyVersion: 0, steps });
      result.migrated.push(spec.formatId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/active writer lock/i.test(message)) result.skipped.push({ formatId: spec.formatId, relativePath: spec.relativePath, code: "active_lock", blocking: true, reason: "active orchestration store lock" });
      else result.failed.push({ formatId: spec.formatId, error: message });
    }
  }
  return result;
}
