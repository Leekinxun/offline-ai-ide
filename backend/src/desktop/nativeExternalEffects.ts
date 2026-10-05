import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { desktopNativeIdeEnabled } from "./nativeIdeClient.js";
import { commitDesktopWorkspacePublication, withDesktopWorkspaceWriter, type DesktopExternalProcessGuard } from "./nativeWorkspaceMutation.js";

export interface DesktopExternalToolEffects {
  schemaVersion: 1;
  runId: string;
  requestId?: string;
  toolCallId: string;
  toolName: string;
  startedAt: number;
  finishedAt?: number;
  rollbackCoverage: "untracked";
  observedPaths: string[];
  observationComplete: boolean;
}

export interface DesktopExternalToolAudit {
  finish(): Promise<DesktopExternalToolEffects>;
}

export class DesktopExternalToolEvidenceError extends Error {
  readonly code = "external_tool_evidence_invalid";
  constructor(message: string, cause?: unknown) {
    super(`External-tool effects evidence is missing, invalid or unreadable: ${message}`, { cause });
    this.name = "DesktopExternalToolEvidenceError";
  }
}
export { DesktopExternalToolEvidenceError as DesktopExternalToolEffectsEvidenceError };

const RECEIPT_DIRECTORY = ".history/external-tools";
const MAX_RECEIPT_BYTES = 1024 * 1024;
const RECEIPT_NAME = /^[a-f0-9]{64}\.json$/;
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !value.includes("\0");
const digest = (bytes: Buffer | string) => crypto.createHash("sha256").update(bytes).digest("hex");
const receiptKey = (runId: string, toolCallId: string, requestId?: string) => `${digest(`${runId}\0${requestId ?? ""}\0${toolCallId}`)}.json`;

function validReceipt(value: unknown): value is DesktopExternalToolEffects {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<DesktopExternalToolEffects>;
  return receipt.schemaVersion === 1 && identifier(receipt.runId) && identifier(receipt.toolCallId) && identifier(receipt.toolName)
    && (receipt.requestId === undefined || identifier(receipt.requestId))
    && typeof receipt.startedAt === "number" && Number.isSafeInteger(receipt.startedAt) && receipt.startedAt >= 0
    && (receipt.finishedAt === undefined || Number.isSafeInteger(receipt.finishedAt) && receipt.finishedAt >= receipt.startedAt)
    && receipt.rollbackCoverage === "untracked" && typeof receipt.observationComplete === "boolean"
    && Array.isArray(receipt.observedPaths) && receipt.observedPaths.length <= 4096
    && receipt.observedPaths.every((relative) => typeof relative === "string" && relative.length > 0 && !path.isAbsolute(relative)
      && !/^[A-Za-z]:/.test(relative) && !relative.includes("\0") && !relative.includes("\\") && !relative.split("/").some((part) => !part || part === "." || part === ".."));
}

function receiptDirectory(workspaceDir: string): string {
  const workspace = fs.realpathSync.native(workspaceDir);
  let current = workspace;
  for (const part of RECEIPT_DIRECTORY.split("/")) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new DesktopExternalToolEvidenceError("unsafe receipt directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return current;
}

function readReceipt(workspaceDir: string, key: string): { receipt: DesktopExternalToolEffects; bytes: Buffer } {
  if (!RECEIPT_NAME.test(key)) throw new DesktopExternalToolEvidenceError("invalid receipt key");
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
    throw new DesktopExternalToolEvidenceError(key, error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/** Returns metadata only. Expected executions preserve request-scoped tool identity;
 * the legacy tool-ID helper only verifies matching IDs within the selected scope. */
export function listDesktopExternalToolEffects(workspaceDir: string, selection: { runId: string; requestId?: string; expectedToolCallIds?: string[]; expectedExecutions?: Array<{ toolCallId: string; requestId?: string }> }): DesktopExternalToolEffects[] {
  if (!identifier(selection.runId) || selection.requestId !== undefined && !identifier(selection.requestId)) throw new DesktopExternalToolEvidenceError("invalid run selection");
  const directory = receiptDirectory(workspaceDir);
  let keys: string[];
  try { keys = fs.readdirSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !selection.expectedToolCallIds?.length && !selection.expectedExecutions?.length) return [];
    throw new DesktopExternalToolEvidenceError("receipt directory", error);
  }
  for (const execution of selection.expectedExecutions || []) {
    if (!identifier(execution.toolCallId) || execution.requestId !== undefined && !identifier(execution.requestId)) throw new DesktopExternalToolEvidenceError("invalid expected execution identity");
    if (selection.requestId !== undefined && execution.requestId !== selection.requestId) throw new DesktopExternalToolEvidenceError("expected execution request identity mismatch");
    readReceipt(workspaceDir, receiptKey(selection.runId, execution.toolCallId, execution.requestId));
  }
  const result: DesktopExternalToolEffects[] = [];
  for (const key of keys) {
    if (!RECEIPT_NAME.test(key)) throw new DesktopExternalToolEvidenceError("unexpected receipt directory entry");
    const { receipt } = readReceipt(workspaceDir, key);
    if (receipt.runId === selection.runId && (selection.requestId === undefined || receipt.requestId === selection.requestId)) result.push(receipt);
  }
  for (const toolCallId of selection.expectedToolCallIds || []) {
    if (!identifier(toolCallId)) throw new DesktopExternalToolEvidenceError("invalid expected tool identity");
    if (!result.some((receipt) => receipt.toolCallId === toolCallId)) throw new DesktopExternalToolEvidenceError("expected tool receipt is missing from the selected scope");
  }
  return result.sort((left, right) => left.startedAt - right.startedAt || left.toolCallId.localeCompare(right.toolCallId) || (left.requestId || "").localeCompare(right.requestId || ""));
}

/** Durable intent metadata precedes arbitrary effects; no workspace bytes are copied.
 * Delegated callers supply their trusted run-owner workspace as the evidence root. */
export async function beginDesktopExternalToolEffects(workspaceDir: string, input: { runId: string; requestId?: string; toolCallId: string; toolName: string }, guard?: DesktopExternalProcessGuard, evidenceWorkspaceDir = workspaceDir): Promise<DesktopExternalToolAudit | undefined> {
  if (!desktopNativeIdeEnabled()) return undefined;
  const initial: DesktopExternalToolEffects = { schemaVersion: 1, runId: input.runId, ...(input.requestId !== undefined ? { requestId: input.requestId } : {}), toolCallId: input.toolCallId, toolName: input.toolName, startedAt: Date.now(), rollbackCoverage: "untracked", observedPaths: [], observationComplete: false };
  if (!validReceipt(initial)) throw new DesktopExternalToolEvidenceError("invalid external tool identity");
  const workspace = fs.realpathSync.native(workspaceDir);
  const evidenceWorkspace = fs.realpathSync.native(evidenceWorkspaceDir);
  const evidenceIdentity = fs.lstatSync(evidenceWorkspace, { bigint: true });
  const assertEvidenceIdentity = () => {
    const current = fs.lstatSync(evidenceWorkspace, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== evidenceIdentity.dev || current.ino !== evidenceIdentity.ino) {
      throw new DesktopExternalToolEvidenceError("evidence workspace root identity changed");
    }
  };
  const key = receiptKey(input.runId, input.toolCallId, input.requestId);
  const publish = (receipt: DesktopExternalToolEffects, expectedBytes?: Buffer) => withDesktopWorkspaceWriter(evidenceWorkspace, "agent-edit", async () => {
    assertEvidenceIdentity();
    receiptDirectory(evidenceWorkspace);
    await commitDesktopWorkspacePublication(evidenceWorkspace, { intent: "agent-edit", files: [], blobs: [], publications: [{ namespace: "externalToolEffects", key, blobId: "external-tool-effects", expected: expectedBytes === undefined ? { exists: false } : { exists: true, file: true, sha256: digest(expectedBytes) }, bytes: Buffer.from(JSON.stringify(receipt)) }] });
  });
  // Evidence may belong to the parent run, but execution recovery belongs to
  // the physical child workspace and must complete before the tool can run.
  if (guard) await guard.audit(() => withDesktopWorkspaceWriter(workspace, "external-audit", async () => undefined));
  else await withDesktopWorkspaceWriter(workspace, "agent-edit", async () => undefined);
  const evidenceGuard = workspace === evidenceWorkspace ? guard : undefined;
  if (evidenceGuard) await evidenceGuard.audit(() => publish(initial)); else await publish(initial);
  let finished: Promise<DesktopExternalToolEffects> | undefined;
  return {
    finish() {
      finished ??= (async () => {
        // Path coverage remains unknown until the native observer has a drain barrier.
        try {
          const { markRepositoryIndexDirty } = await import("../indexing/repositoryIndex.js");
          markRepositoryIndexDirty(workspace);
        } catch { /* unavailable observation cannot replace the actual command exit */ }
        const final: DesktopExternalToolEffects = { ...initial, finishedAt: Math.max(initial.startedAt, Date.now()) };
        try {
          assertEvidenceIdentity();
          const { receipt, bytes } = readReceipt(evidenceWorkspace, key);
          if (receipt.finishedAt !== undefined) return receipt;
          if (evidenceGuard) await evidenceGuard.metadata(() => publish(final, bytes)); else await publish(final, bytes);
          return final;
        } catch {
          // The durable unfinished receipt still records untracked effects. Audit
          // failure must not replace the process's actual exit status.
          return initial;
        }
      })();
      return finished;
    },
  };
}
