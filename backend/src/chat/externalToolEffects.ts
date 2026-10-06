import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface ExternalToolEffects {
  schemaVersion: 1;
  runId: string;
  requestId?: string;
  toolCallId: string;
  toolName: string;
  startedAt: number;
  finishedAt?: number;
  rollbackCoverage: "untracked";
  observedPaths: string[];
  observationComplete: false;
}

export interface ExternalToolAudit {
  finish(): Promise<ExternalToolEffects>;
}

export class ExternalToolEffectsEvidenceError extends Error {
  readonly code = "external_tool_evidence_invalid";
  constructor(message: string, cause?: unknown) {
    super(`External-tool effects evidence is missing, invalid or unreadable: ${message}`, { cause });
    this.name = "ExternalToolEffectsEvidenceError";
  }
}

const RECEIPT_DIRECTORY = ".history/external-tools";
const MAX_RECEIPT_BYTES = 1024 * 1024;
const RECEIPT_NAME = /^[a-f0-9]{64}\.json$/;
const TEMP_RECEIPT_NAME = /^\.[a-f0-9]{64}\.json\.[0-9]+\.[a-f0-9]{8}\.tmp$/;
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !value.includes("\0");
const digest = (bytes: Buffer | string) => crypto.createHash("sha256").update(bytes).digest("hex");
const receiptKey = (runId: string, toolCallId: string, requestId?: string) => `${digest(`${runId}\0${requestId ?? ""}\0${toolCallId}`)}.json`;

function validReceipt(value: unknown): value is ExternalToolEffects {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<ExternalToolEffects>;
  return receipt.schemaVersion === 1 && identifier(receipt.runId) && identifier(receipt.toolCallId) && identifier(receipt.toolName)
    && (receipt.requestId === undefined || identifier(receipt.requestId))
    && typeof receipt.startedAt === "number" && Number.isSafeInteger(receipt.startedAt) && receipt.startedAt >= 0
    && (receipt.finishedAt === undefined || Number.isSafeInteger(receipt.finishedAt) && receipt.finishedAt >= receipt.startedAt)
    && receipt.rollbackCoverage === "untracked" && receipt.observationComplete === false
    && Array.isArray(receipt.observedPaths) && receipt.observedPaths.length === 0;
}

function ensureMetadataDirectory(workspaceDir: string): string {
  const workspace = fs.realpathSync.native(workspaceDir);
  let current = workspace;
  for (const part of RECEIPT_DIRECTORY.split("/")) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ExternalToolEffectsEvidenceError("unsafe receipt directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fs.mkdirSync(current, { mode: 0o700 });
      const created = fs.lstatSync(current);
      if (created.isSymbolicLink() || !created.isDirectory()) throw new ExternalToolEffectsEvidenceError("unsafe receipt directory");
    }
  }
  return current;
}

function receiptDirectory(workspaceDir: string): string {
  const workspace = fs.realpathSync.native(workspaceDir);
  let current = workspace;
  for (const part of RECEIPT_DIRECTORY.split("/")) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ExternalToolEffectsEvidenceError("unsafe receipt directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return current;
}

function readReceipt(workspaceDir: string, key: string): { receipt: ExternalToolEffects; bytes: Buffer } {
  if (!RECEIPT_NAME.test(key)) throw new ExternalToolEffectsEvidenceError("invalid receipt key");
  const target = path.join(receiptDirectory(workspaceDir), key);
  let descriptor: number | undefined;
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_RECEIPT_BYTES) throw new Error("unsafe receipt file");
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > MAX_RECEIPT_BYTES) throw new Error("receipt identity changed");
    receiptDirectory(workspaceDir);
    const bytes = fs.readFileSync(descriptor);
    if (bytes.byteLength !== opened.size || bytes.byteLength > MAX_RECEIPT_BYTES) throw new Error("receipt changed during read");
    const receipt: unknown = JSON.parse(bytes.toString("utf8"));
    if (!validReceipt(receipt) || receiptKey(receipt.runId, receipt.toolCallId, receipt.requestId) !== key) throw new Error("malformed or mis-scoped receipt");
    return { receipt, bytes };
  } catch (error) {
    throw new ExternalToolEffectsEvidenceError(key, error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeDurableFile(target: string, bytes: Buffer, flag: "wx" | "w"): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(target, flag === "wx"
      ? fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0)
      : fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0), 0o600);
    const written = fs.writeSync(descriptor, bytes, 0, bytes.byteLength, 0);
    if (written !== bytes.byteLength) throw new Error("receipt write was incomplete");
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function safeTemporaryReceipt(directory: string, name: string): boolean {
  if (!TEMP_RECEIPT_NAME.test(name)) return false;
  const target = path.join(directory, name);
  try {
    const stat = fs.lstatSync(target);
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= MAX_RECEIPT_BYTES;
  } catch {
    return false;
  }
}

function atomicCreateReceipt(workspaceDir: string, key: string, receipt: ExternalToolEffects): void {
  if (!validReceipt(receipt) || receiptKey(receipt.runId, receipt.toolCallId, receipt.requestId) !== key) throw new ExternalToolEffectsEvidenceError("invalid external tool identity");
  const directory = ensureMetadataDirectory(workspaceDir);
  const target = path.join(directory, key);
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  try {
    writeDurableFile(target, bytes, "wx");
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== bytes.byteLength) throw new Error("unsafe receipt file");
    fsyncDirectory(directory);
  } catch (error) {
    throw new ExternalToolEffectsEvidenceError(key, error);
  }
}

function atomicUpdateReceipt(workspaceDir: string, key: string, receipt: ExternalToolEffects, expectedBytes: Buffer): void {
  if (!validReceipt(receipt) || receiptKey(receipt.runId, receipt.toolCallId, receipt.requestId) !== key) throw new ExternalToolEffectsEvidenceError("invalid external tool identity");
  const directory = receiptDirectory(workspaceDir);
  const target = path.join(directory, key);
  const replacement = path.join(directory, `.${key}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  try {
    const current = readReceipt(workspaceDir, key);
    if (!current.bytes.equals(expectedBytes)) throw new Error("receipt changed before update");
    writeDurableFile(replacement, bytes, "wx");
    const tempStat = fs.lstatSync(replacement);
    if (!tempStat.isFile() || tempStat.isSymbolicLink() || tempStat.nlink !== 1 || tempStat.size !== bytes.byteLength) throw new Error("unsafe temporary receipt");
    const before = readReceipt(workspaceDir, key);
    if (!before.bytes.equals(expectedBytes)) throw new Error("receipt changed before commit");
    fs.renameSync(replacement, target);
    fsyncDirectory(directory);
  } catch (error) {
    throw new ExternalToolEffectsEvidenceError(key, error);
  } finally {
    fs.rmSync(replacement, { force: true });
  }
}

export function listExternalToolEffects(workspaceDir: string, selection: { runId: string; requestId?: string; expectedToolCallIds?: string[]; expectedExecutions?: Array<{ toolCallId: string; requestId?: string }> }): ExternalToolEffects[] {
  if (!identifier(selection.runId) || selection.requestId !== undefined && !identifier(selection.requestId)) throw new ExternalToolEffectsEvidenceError("invalid run selection");
  const directory = receiptDirectory(workspaceDir);
  let keys: string[];
  try { keys = fs.readdirSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !selection.expectedToolCallIds?.length && !selection.expectedExecutions?.length) return [];
    throw new ExternalToolEffectsEvidenceError("receipt directory", error);
  }
  for (const execution of selection.expectedExecutions || []) {
    if (!identifier(execution.toolCallId) || execution.requestId !== undefined && !identifier(execution.requestId)) throw new ExternalToolEffectsEvidenceError("invalid expected execution identity");
    if (selection.requestId !== undefined && execution.requestId !== selection.requestId) throw new ExternalToolEffectsEvidenceError("expected execution request identity mismatch");
    readReceipt(workspaceDir, receiptKey(selection.runId, execution.toolCallId, execution.requestId));
  }
  const result: ExternalToolEffects[] = [];
  for (const key of keys) {
    if (safeTemporaryReceipt(directory, key)) continue;
    if (!RECEIPT_NAME.test(key)) throw new ExternalToolEffectsEvidenceError("unexpected receipt directory entry");
    const { receipt } = readReceipt(workspaceDir, key);
    if (receipt.runId === selection.runId && (selection.requestId === undefined || receipt.requestId === selection.requestId)) result.push(receipt);
  }
  for (const toolCallId of selection.expectedToolCallIds || []) {
    if (!identifier(toolCallId)) throw new ExternalToolEffectsEvidenceError("invalid expected tool identity");
    if (!result.some((receipt) => receipt.toolCallId === toolCallId)) throw new ExternalToolEffectsEvidenceError("expected tool receipt is missing from the selected scope");
  }
  return result.sort((left, right) => left.startedAt - right.startedAt || left.toolCallId.localeCompare(right.toolCallId) || (left.requestId || "").localeCompare(right.requestId || ""));
}

export async function beginExternalToolEffects(workspaceDir: string, input: { runId: string; requestId?: string; toolCallId: string; toolName: string }, evidenceWorkspaceDir = workspaceDir): Promise<ExternalToolAudit> {
  const initial: ExternalToolEffects = {
    schemaVersion: 1,
    runId: input.runId,
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    startedAt: Date.now(),
    rollbackCoverage: "untracked",
    observedPaths: [],
    observationComplete: false,
  };
  if (!validReceipt(initial)) throw new ExternalToolEffectsEvidenceError("invalid external tool identity");
  const workspace = fs.realpathSync.native(workspaceDir);
  const evidenceWorkspace = fs.realpathSync.native(evidenceWorkspaceDir);
  const workspaceIdentity = fs.lstatSync(workspace, { bigint: true });
  const evidenceIdentity = fs.lstatSync(evidenceWorkspace, { bigint: true });
  const assertWorkspaceIdentity = (target: string, identity: fs.BigIntStats, label: string) => {
    const current = fs.lstatSync(target, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new ExternalToolEffectsEvidenceError(`${label} workspace root identity changed`);
    }
  };
  const key = receiptKey(input.runId, input.toolCallId, input.requestId);
  assertWorkspaceIdentity(workspace, workspaceIdentity, "execution");
  assertWorkspaceIdentity(evidenceWorkspace, evidenceIdentity, "evidence");
  atomicCreateReceipt(evidenceWorkspace, key, initial);
  let finished: Promise<ExternalToolEffects> | undefined;
  return {
    finish() {
      finished ??= (async () => {
        const final: ExternalToolEffects = { ...initial, finishedAt: Math.max(initial.startedAt, Date.now()) };
        try {
          assertWorkspaceIdentity(evidenceWorkspace, evidenceIdentity, "evidence");
          const { receipt, bytes } = readReceipt(evidenceWorkspace, key);
          if (receipt.finishedAt !== undefined) return receipt;
          atomicUpdateReceipt(evidenceWorkspace, key, final, bytes);
          return final;
        } catch {
          return initial;
        }
      })();
      return finished;
    },
  };
}
