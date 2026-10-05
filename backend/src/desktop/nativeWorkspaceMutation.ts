import crypto from "node:crypto";
import { getDesktopNativeIde, NativeIdeError } from "./nativeIdeClient.js";

export interface NativeMutationExpected {
  exists?: boolean;
  sha256?: string;
  file?: boolean;
  directory?: boolean;
}

export type NativeMutationOperation =
  | { type: "writeFile"; path: string; content?: string; contentBase64?: string; expected?: NativeMutationExpected; overwrite?: boolean }
  | { type: "mkdir"; path: string; recursive?: boolean }
  | { type: "delete"; path: string; recursive?: boolean; expected?: NativeMutationExpected }
  | { type: "rename"; path: string; newPath: string }
  | { type: "copy"; path: string; newPath: string };

export interface NativeMutationReceipt {
  path: string;
  previousPath?: string;
  operation: "writeFile" | "mkdir" | "delete" | "rename" | "copy";
  exists: boolean;
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
  sha256: string;
}

export interface NativeMutationResult {
  transactionId: string;
  status: "committed" | string;
  entries: NativeMutationReceipt[];
  publications?: NativePublicationReceipt[];
}

export type DesktopWriterIntent = "editor" | "agent-edit" | "rollback" | "checkpoint" | "changeset";

export interface NativePublicationReceipt {
  namespace: string;
  key: string;
  sha256: string;
  mtimeMs: number;
}

export interface NativeTransactionFilePlan {
  path: string;
  operation: "write" | "delete" | "deleteTree" | "mkdir" | "rename" | "moveTree" | "copyTree";
  toPath?: string;
  expected: NativeMutationExpected;
  output?: NativeTransactionBlobRef;
}

export interface NativeTransactionBlobRef {
  blobId: string;
  size: number;
  sha256: string;
  modifiedAtMs?: number;
  mode?: number;
}

export interface NativeTransactionPublicationPlan {
  namespace: "mutationJournal" | "mutationBlob" | "repositoryIndex" | "changeSetWal";
  key: string;
  expected: NativeMutationExpected;
  blobId: string;
  size: number;
  sha256: string;
}

export class NativeMutationTooLargeError extends Error {
  constructor(message = "Desktop native mutation payload is too large") {
    super(message);
    this.name = "NativeMutationTooLargeError";
  }
}

export function nativeMutationTransactionId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function mutationContent(operation: NativeMutationOperation): Buffer | undefined {
  if (operation.type !== "writeFile") return undefined;
  if (operation.contentBase64 !== undefined) return Buffer.from(operation.contentBase64, "base64");
  return Buffer.from(operation.content ?? "", "utf8");
}

function blobId(prefix: string, filePath: string, index: number): string {
  return `${prefix}-${index}-${crypto.createHash("sha256").update(filePath).digest("hex").slice(0, 16)}`;
}

function toFilePlan(operation: NativeMutationOperation, index: number): { plan: NativeTransactionFilePlan; blob?: Buffer } {
  switch (operation.type) {
    case "writeFile": {
      const blob = mutationContent(operation) ?? Buffer.alloc(0);
      const digest = sha256(blob);
      const id = blobId("file", operation.path, index);
      return {
        blob,
        plan: {
          path: operation.path,
          operation: "write",
          expected: operation.expected ?? {},
          output: { blobId: id, size: blob.byteLength, sha256: digest },
        },
      };
    }
    case "mkdir":
      return { plan: { path: operation.path, operation: "mkdir", expected: {} } };
    case "delete":
      return { plan: { path: operation.path, operation: operation.recursive ? "deleteTree" : "delete", expected: operation.expected ?? {} } };
    case "rename":
      return { plan: { path: operation.path, operation: "rename", toPath: operation.newPath, expected: {} } };
    case "copy":
      return { plan: { path: operation.path, operation: "copyTree", toPath: operation.newPath, expected: {} } };
  }
}

async function sendBlob(
  leaseToken: string,
  transactionId: string,
  ref: { blobId: string; sha256: string },
  bytes: Buffer,
  options: { signal?: AbortSignal } = {}
): Promise<void> {
  const client = getDesktopNativeIde();
  for (let offset = 0; offset < bytes.byteLength || (bytes.byteLength === 0 && offset === 0);) {
    options.signal?.throwIfAborted();
    const end = bytes.byteLength === 0 ? 0 : Math.min(offset + 512 * 1024, bytes.byteLength);
    const chunk = bytes.subarray(offset, end);
    await client.request("fs.transaction.chunk", {
      leaseToken,
      transactionId,
      blobId: ref.blobId,
      offset,
      dataBase64: chunk.toString("base64"),
      ...(end === bytes.byteLength ? { sha256: ref.sha256 } : {}),
    }, { signal: options.signal, timeoutMs: 60_000 });
    if (bytes.byteLength === 0) break;
    offset = end;
  }
}

async function commitDesktopTransaction(input: {
  workspaceDir: string;
  intent: DesktopWriterIntent;
  transactionId: string;
  files: NativeTransactionFilePlan[];
  blobs: Array<{ ref: { blobId: string; sha256: string }; bytes: Buffer }>;
  publications?: NativeTransactionPublicationPlan[];
  signal?: AbortSignal;
}): Promise<NativeMutationResult> {
  const client = getDesktopNativeIde();
  const owner = { kind: input.intent === "editor" ? "user" : input.intent === "checkpoint" || input.intent === "changeset" ? "integration" : "agent", id: input.intent };
  const admission = await client.request<{ admissionToken: string }>("fs.writer.admit", {
    workspaceDir: input.workspaceDir,
    owner,
    intent: input.intent,
    ttlMs: 300_000,
  }, { signal: input.signal, timeoutMs: 30_000 });
  const lease = await client.request<{ leaseToken: string }>("fs.writer.acquire", {
    admissionToken: admission.admissionToken,
  }, { signal: input.signal, timeoutMs: 30_000 });
  try {
    await client.request("fs.transaction.begin", {
      leaseToken: lease.leaseToken,
      transactionId: input.transactionId,
      mode: input.publications?.length ? "privateBackup" : "metadataOnly",
      files: input.files,
      publications: input.publications ?? [],
    }, { signal: input.signal, timeoutMs: 30_000 });
    for (const blob of input.blobs) await sendBlob(lease.leaseToken, input.transactionId, blob.ref, blob.bytes, { signal: input.signal });
    const result = await client.requestDurable<NativeMutationResult>("fs.transaction.commit", {
      leaseToken: lease.leaseToken,
      transactionId: input.transactionId,
    }, { timeoutMs: 120_000 });
    if (result.status !== "committed") throw new NativeIdeError(`Desktop transaction requires attention: ${result.status}`, "CONFLICT");
    return result;
  } catch (error) {
    if (!(error instanceof NativeIdeError && error.code === "OUTCOME_UNKNOWN")) {
      await client.request("fs.transaction.abort", {
        leaseToken: lease.leaseToken,
        transactionId: input.transactionId,
      }, { timeoutMs: 30_000 }).catch(() => undefined);
    }
    throw error;
  } finally {
    await client.request("fs.writer.release", { leaseToken: lease.leaseToken }, { timeoutMs: 10_000 }).catch(() => undefined);
  }
}

export async function withDesktopWorkspaceWriter<T>(
  workspaceDir: string,
  intent: DesktopWriterIntent,
  work: () => Promise<T>
): Promise<T> {
  const client = getDesktopNativeIde();
  const owner = { kind: intent === "editor" ? "user" : intent === "checkpoint" || intent === "changeset" ? "integration" : "agent", id: intent };
  const admission = await client.request<{ admissionToken: string }>("fs.writer.admit", { workspaceDir, owner, intent, ttlMs: 300_000 }, { timeoutMs: 30_000 });
  const lease = await client.request<{ leaseToken: string }>("fs.writer.acquire", { admissionToken: admission.admissionToken }, { timeoutMs: 30_000 });
  try {
    return await work();
  } finally {
    await client.request("fs.writer.release", { leaseToken: lease.leaseToken }, { timeoutMs: 10_000 }).catch(() => undefined);
  }
}

export async function mutateDesktopWorkspace(
  workspaceDir: string,
  operations: NativeMutationOperation[],
  options: { transactionId?: string; signal?: AbortSignal; intent?: DesktopWriterIntent } = {}
): Promise<NativeMutationResult> {
  if (options.signal?.aborted) throw new NativeIdeError("Operation cancelled", "ABORTED");
  const transactionId = options.transactionId || nativeMutationTransactionId("workspace");
  const plans = operations.map(toFilePlan);
  return commitDesktopTransaction({
    workspaceDir,
    intent: options.intent ?? "editor",
    transactionId,
    files: plans.map((entry) => entry.plan),
    blobs: plans.flatMap((entry) => entry.blob && entry.plan.output ? [{ ref: entry.plan.output, bytes: entry.blob }] : []),
    signal: options.signal,
  });
}

export async function commitDesktopWorkspacePublication(
  workspaceDir: string,
  input: {
    intent: DesktopWriterIntent;
    transactionId?: string;
    files: NativeTransactionFilePlan[];
    blobs: Array<{ blobId: string; bytes: Buffer }>;
    publications?: Array<Omit<NativeTransactionPublicationPlan, "size" | "sha256"> & { bytes: Buffer }>;
    signal?: AbortSignal;
  }
): Promise<NativeMutationResult> {
  const fileBlobs = input.blobs.map((blob) => ({ ref: { blobId: blob.blobId, sha256: sha256(blob.bytes) }, bytes: blob.bytes }));
  const publicationBlobs = (input.publications ?? []).map((publication, index) => {
    const id = publication.blobId || blobId("publication", publication.key, index);
    return {
      publication: { ...publication, blobId: id, size: publication.bytes.byteLength, sha256: sha256(publication.bytes) },
      blob: { ref: { blobId: id, sha256: sha256(publication.bytes) }, bytes: publication.bytes },
    };
  });
  return commitDesktopTransaction({
    workspaceDir,
    intent: input.intent,
    transactionId: input.transactionId || nativeMutationTransactionId(input.intent),
    files: input.files,
    blobs: [...fileBlobs, ...publicationBlobs.map((entry) => entry.blob)],
    publications: publicationBlobs.map(({ publication }) => {
      const { bytes: _bytes, ...plan } = publication;
      return plan;
    }),
    signal: input.signal,
  });
}

export function nativeMutationHttpStatus(error: unknown): number {
  if (error instanceof NativeMutationTooLargeError) return 413;
  if (!(error instanceof NativeIdeError)) return 500;
  if (error.code === "PATH_ESCAPE") return 403;
  if (error.code === "NOT_FOUND") return 404;
  if (error.code === "CONFLICT" || error.code === "BUSY") return 409;
  if (error.code === "LIMIT_EXCEEDED" || error.code === "INVALID_REQUEST") return 400;
  return 503;
}

export function nativeMutationErrorCode(error: unknown): string | undefined {
  if (error instanceof NativeMutationTooLargeError) return "NATIVE_MUTATION_TOO_LARGE";
  return error instanceof NativeIdeError ? error.code : undefined;
}
