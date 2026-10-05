import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { desktopNativeIdeEnabled, getDesktopNativeIde, NativeIdeError, shutdownDesktopNativeIde, type NativeIdeClient } from "./nativeIdeClient.js";

export interface NativeMutationExpected {
  exists?: boolean;
  sha256?: string;
  file?: boolean;
  directory?: boolean;
  identity?: { device: string; inode: string; nlink: number };
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

export type DesktopWriterIntent = "editor" | "agent-edit" | "rollback" | "checkpoint" | "changeset" | "index" | "external-audit";
interface WriterContext { workspace: string; admissionToken: string; leaseToken: string; client: NativeIdeClient; active: boolean; }
const writerContext = new AsyncLocalStorage<WriterContext>();
interface ExternalAuditContext { active: boolean; workspace: string; externalToken: string; owner: { kind: "agent"; id: string }; }
const externalAuditContext = new AsyncLocalStorage<ExternalAuditContext>();
const activeExternalProcesses = new Map<string, DesktopExternalProcessGuard>();
export interface DesktopExternalProcessGuard {
  audit<T>(work: () => Promise<T>): Promise<T>;
  assertUnchanged(): void;
  release(): Promise<void>;
}

/** Advisory reservation: human saves remain allowed; Agent/integration writers wait for audit. */
export async function beginDesktopExternalProcess(workspaceDir: string): Promise<DesktopExternalProcessGuard | undefined> {
  if (!desktopNativeIdeEnabled()) return undefined;
  const workspace = fs.realpathSync.native(workspaceDir), client = getDesktopNativeIde();
  const owner = { kind: "agent" as const, id: crypto.randomUUID() };
  const { subscribeWorkspaceMutations } = await import("../files/mutationRegistry.js");
  const conflicts = new Set<string>();
  const unsubscribe = subscribeWorkspaceMutations((event) => {
    if (fs.existsSync(event.workspaceDir) && fs.realpathSync.native(event.workspaceDir) === workspace) conflicts.add(event.path);
  });
  let externalToken: string;
  try { externalToken = (await client.requestDurable<{ externalToken: string }>("fs.writer.externalBegin", { workspaceDir: workspace, owner, ownerPid: process.pid, intent: "external-process" })).externalToken; }
  catch (error) {
    if (!(error instanceof NativeIdeError) || error.code !== "OUTCOME_UNKNOWN") { unsubscribe(); throw error; }
    try { externalToken = (await client.requestDurable<{ externalToken: string }>("fs.writer.externalBegin", { workspaceDir: workspace, owner, ownerPid: process.pid, intent: "external-process" })).externalToken; }
    catch (retryError) { unsubscribe(); throw retryError; }
  }
  let released = false;
  const guard: DesktopExternalProcessGuard = {
    assertUnchanged() { if (conflicts.size) throw new NativeIdeError(`Concurrent edits prevent command attribution: ${[...conflicts].slice(0, 20).join(", ")}`, "CONFLICT"); },
    async audit(work) {
      guard.assertUnchanged();
      const context = { active: true, workspace, externalToken, owner };
      try { return await externalAuditContext.run(context, work); }
      finally { context.active = false; }
    },
    async release() {
      if (released) return;
      try { await client.requestDurable("fs.writer.externalEnd", { externalToken, workspaceDir: workspace }); }
      catch (error) {
        if (!(error instanceof NativeIdeError) || !["RUNTIME_DISCONNECTED", "OUTCOME_UNKNOWN"].includes(error.code)) throw error;
        await shutdownDesktopNativeIde();
        await getDesktopNativeIde().requestDurable("fs.writer.externalEnd", { externalToken, workspaceDir: workspace });
      }
      released = true; unsubscribe(); if (activeExternalProcesses.get(workspace) === guard) activeExternalProcesses.delete(workspace);
    },
  };
  activeExternalProcesses.set(workspace, guard); return guard;
}

const writerQueues = new Map<string, Promise<void>>();
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export function desktopWorkspaceWriterActive(workspaceDir: string): boolean {
  const current = writerContext.getStore();
  return Boolean(current?.active && current.workspace === fs.realpathSync.native(workspaceDir));
}

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
  return withDesktopWorkspaceWriter(input.workspaceDir, input.intent, async () => {
    const context = writerContext.getStore()!;
    const client = context.client;
    const lease = { leaseToken: context.leaseToken };
    try {
      input.signal?.throwIfAborted();
      await client.requestDurable("fs.transaction.begin", {
        leaseToken: lease.leaseToken,
        transactionId: input.transactionId,
        mode: input.intent === "editor" ? "metadataOnly" : "privateBackup",
        files: input.files.slice(0, 128),
        publications: (input.publications ?? []).slice(0, 128),
      }, { timeoutMs: 30_000 });
      for (let offset = 128; offset < Math.max(input.files.length, input.publications?.length ?? 0); offset += 128) {
        input.signal?.throwIfAborted();
        await client.requestDurable("fs.transaction.appendPlans", { leaseToken: lease.leaseToken, transactionId: input.transactionId,
          files: input.files.slice(offset, offset + 128), publications: (input.publications ?? []).slice(offset, offset + 128) });
      }
      for (const blob of input.blobs) await sendBlob(lease.leaseToken, input.transactionId, blob.ref, blob.bytes, { signal: input.signal });
      const result = await client.requestDurable<NativeMutationResult>("fs.transaction.commit", {
        leaseToken: lease.leaseToken,
        transactionId: input.transactionId,
      }, { timeoutMs: 120_000 });
      if (result.status !== "committed") throw new NativeIdeError(`Desktop transaction ${input.transactionId} requires attention: ${result.status}`, "CONFLICT");
      return result;
    } catch (error) {
      if (error instanceof NativeIdeError && error.code === "OUTCOME_UNKNOWN") {
        let receipt: NativeMutationResult;
        try { receipt = await client.request("fs.transaction.status", { workspaceDir: context.workspace, transactionId: input.transactionId }); }
        catch {
          await shutdownDesktopNativeIde();
          receipt = await getDesktopNativeIde().request("fs.transaction.recover", { workspaceDir: context.workspace, transactionId: input.transactionId });
        }
        if (["begun", "prepared", "applying", "committing"].includes(receipt.status)) {
          // Keep cleanup ownership until the old Core has exited. A lost receipt
          // must not strand a live-PID writer lock after background completion.
          await shutdownDesktopNativeIde();
          receipt = await getDesktopNativeIde().request("fs.transaction.recover", { workspaceDir: context.workspace, transactionId: input.transactionId });
        }
        if (receipt.status === "committed") return receipt;
        throw new NativeIdeError(`Publication outcome requires recovery: ${input.transactionId} (${receipt.status})`, "OUTCOME_UNKNOWN");
      } else {
        await client.request("fs.transaction.abort", {
          leaseToken: lease.leaseToken,
          transactionId: input.transactionId,
        }, { timeoutMs: 30_000 }).catch(() => undefined);
      }
      throw error;
    }
  });
}

export async function withDesktopWorkspaceWriter<T>(
  workspaceDir: string,
  intent: DesktopWriterIntent,
  work: () => Promise<T>
): Promise<T> {
  if (!desktopNativeIdeEnabled()) return work();
  const workspace = fs.realpathSync.native(workspaceDir);
  if (writerContext.getStore()?.active && writerContext.getStore()?.workspace === workspace) return work();
  const external = externalAuditContext.getStore();
  const audit = external?.active && external.workspace === workspace ? external : undefined;
  if (!audit && activeExternalProcesses.has(workspace) && intent !== "editor" && intent !== "index") throw new NativeIdeError("Agent command audit is pending for this workspace", "BUSY");
  const previous = writerQueues.get(workspace) ?? Promise.resolve();
  let resolveQueue!: () => void;
  const complete = new Promise<void>((resolve) => { resolveQueue = resolve; });
  const queue = previous.catch(() => {}).then(() => complete);
  writerQueues.set(workspace, queue);
  await previous.catch(() => {});
  const owner = audit?.owner ?? { kind: intent === "editor" ? "user" : intent === "checkpoint" || intent === "changeset" || intent === "index" ? "integration" : "agent", id: crypto.randomUUID() };
  let client: NativeIdeClient | undefined;
  let leaseToken: string | undefined;
  let admissionToken: string | undefined;
  let context: WriterContext | undefined;
  try {
    client = getDesktopNativeIde();
    const admission = await client.requestDurable<{ admissionToken: string }>("fs.writer.admit", { workspaceDir, owner, intent: audit ? "external-audit" : intent, ...(audit ? { externalToken: audit.externalToken } : {}), ttlMs: 300_000 }, { timeoutMs: 30_000 });
    admissionToken = admission.admissionToken;
    const deadline = Date.now() + 30_000;
    while (!leaseToken) {
      try { leaseToken = (await client.requestDurable<{ leaseToken: string }>("fs.writer.acquire", { admissionToken: admission.admissionToken })).leaseToken; }
      catch (error) {
        if (!(error instanceof NativeIdeError) || error.code !== "BUSY" || Date.now() >= deadline) throw error;
        if (!audit && activeExternalProcesses.has(workspace) && intent !== "editor" && intent !== "index") throw error;
        await pause(25);
      }
    }
    context = { workspace, admissionToken: admission.admissionToken, leaseToken, client, active: true };
    return await writerContext.run(context, work);
  } finally {
    if (context) context.active = false;
    if (leaseToken && client) await client.requestDurable("fs.writer.release", { leaseToken }, { timeoutMs: 10_000 }).catch(() => undefined);
    if (admissionToken && client) await client.requestDurable("fs.writer.revoke", { admissionToken }, { timeoutMs: 10_000 }).catch(() => undefined);
    resolveQueue();
    if (writerQueues.get(workspace) === queue) writerQueues.delete(workspace);
  }
}

export async function mutateDesktopWorkspace(
  workspaceDir: string,
  operations: NativeMutationOperation[],
  options: { transactionId?: string; signal?: AbortSignal; intent?: DesktopWriterIntent } = {}
): Promise<NativeMutationResult> {
  if (options.signal?.aborted) throw new NativeIdeError("Operation cancelled", "ABORTED");
  const transactionId = options.transactionId || nativeMutationTransactionId("workspace");
  return withDesktopWorkspaceWriter(workspaceDir, options.intent ?? "editor", async () => {
    const context = writerContext.getStore()!;
    const workspace = context.workspace;
    const aliases = new Map<string, string>();
    const prepared = [] as Array<{ plan: NativeTransactionFilePlan; blob?: Buffer }>;
    for (const [index, operation] of operations.entries()) {
      let relative = operation.path;
      // Manual editor saves preserve the existing safe in-workspace symlink behavior.
      // Agent plans never enter this resolver and remain strict no-link mutations.
      if (operation.type === "writeFile" && (options.intent ?? "editor") === "editor") {
        const requested = path.resolve(workspace, relative);
        let ancestor = requested;
        const suffix: string[] = [];
        while (!fs.existsSync(ancestor) && ancestor !== workspace) { suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
        const candidate = path.join(fs.realpathSync.native(ancestor), ...suffix);
        const physical = path.relative(workspace, candidate);
        if (!physical || physical === ".." || physical.startsWith(`..${path.sep}`) || path.isAbsolute(physical)) throw new NativeIdeError("Save target escapes workspace", "PATH_ESCAPE");
        relative = physical.split(path.sep).join("/");
        aliases.set(relative, operation.path);
      }
      const item = toFilePlan({ ...operation, path: relative }, index);
      {
        const snapshot = await context.client.request<{ exists: boolean; kind: string; sha256?: string }>("fs.writer.inspect", { admissionToken: context.admissionToken, path: relative });
        item.plan.expected = { exists: snapshot.exists, ...(snapshot.exists ? { file: snapshot.kind === "file", directory: snapshot.kind === "directory", ...(snapshot.sha256 ? { sha256: snapshot.sha256 } : {}) } : {}), ...item.plan.expected };
        if (operation.type === "writeFile" && operation.overwrite === false && operation.expected === undefined) item.plan.expected.exists = false;
      }
      prepared.push(item);
    }
    const result = await commitDesktopTransaction({ workspaceDir, intent: options.intent ?? "editor", transactionId,
      files: prepared.map((entry) => entry.plan),
      blobs: prepared.flatMap((entry) => entry.blob && entry.plan.output ? [{ ref: entry.plan.output, bytes: entry.blob }] : []), signal: options.signal });
    return { ...result, entries: result.entries.map((entry) => ({ ...entry, path: aliases.get(entry.path) ?? entry.path })) };
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
