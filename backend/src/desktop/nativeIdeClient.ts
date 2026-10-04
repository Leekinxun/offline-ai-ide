import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export class NativeIdeError extends Error {
  constructor(message: string, readonly code = "FAILED") { super(message); }
}

/** Only the desktop host can enable this transport. Web deployments keep their existing services. */
export function desktopNativeIdeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CREWFORGE_DESKTOP === "1" && Boolean(env.CROWNFORGE_IDE_CORE_EXECUTABLE);
}

export interface NativeIdeEvent { event: string; params: Record<string, unknown>; }
export interface NativeIdeTreeKillInvocation { executable: string; args: string[]; }
export interface NativeIdeClientOptions {
  args?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  shutdown?: {
    graceMs?: number;
    deadlineMs?: number;
    /** Local lifecycle seams for tests; no RPC or HTTP input controls them. */
    platform?: NodeJS.Platform;
    systemRoot?: string;
    runTaskkill?: (invocation: NativeIdeTreeKillInvocation) => Promise<void>;
  };
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

function nativeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "HOME", "USERPROFILE", "SystemRoot", "WINDIR", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP", "CROWNFORGE_GIT_EXECUTABLE", "CROWNFORGE_BUNDLED_TOOLS_REQUIRED"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export function ownedNativeProcessTreeKillInvocation(pid: number, systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows"): NativeIdeTreeKillInvocation {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw new NativeIdeError("Invalid native child pid", "INVALID_PARAMS");
  if (!/^[A-Za-z]:[\\/]/.test(systemRoot) || systemRoot.includes("\0") || systemRoot.slice(2).includes(":") || systemRoot.split(/[\\/]/).includes("..")) {
    throw new NativeIdeError("Invalid Windows system directory", "RUNTIME_UNAVAILABLE");
  }
  return { executable: path.win32.join(systemRoot, "System32", "taskkill.exe"), args: ["/PID", String(pid), "/T", "/F"] };
}

function runTaskkill(invocation: NativeIdeTreeKillInvocation): Promise<void> {
  return new Promise((resolve, reject) => {
    const killer = spawn(invocation.executable, invocation.args, { shell: false, windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => { killer.kill(); reject(new NativeIdeError("Native process-tree cleanup timed out", "SHUTDOWN_TIMEOUT")); }, 4_000);
    killer.once("error", () => { clearTimeout(timer); reject(new NativeIdeError("Native process-tree cleanup could not start", "RUNTIME_UNAVAILABLE")); });
    killer.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new NativeIdeError("Native process-tree cleanup failed", "SHUTDOWN_FAILED"));
    });
  });
}

export class NativeIdeClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly events = new EventEmitter();
  private readonly pending = new Map<number, Pending>();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private sequence = 0;
  private closed = false;
  private childHasClosed = false;
  private resolveChildClosed!: () => void;
  private readonly childClosed = new Promise<void>((resolve) => { this.resolveChildClosed = resolve; });
  private closePromise?: Promise<void>;
  private readonly shutdownOptions: NonNullable<NativeIdeClientOptions["shutdown"]>;
  private readonly ready: Promise<void>;

  constructor(executable: string, options: NativeIdeClientOptions = {}) {
    if (!path.isAbsolute(executable) || !fs.statSync(executable).isFile()) throw new NativeIdeError("Desktop IDE runtime is unavailable", "RUNTIME_UNAVAILABLE");
    this.events.setMaxListeners(128);
    this.shutdownOptions = {
      ...options.shutdown,
      platform: options.shutdown?.platform ?? process.platform,
      systemRoot: options.shutdown?.systemRoot ?? process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows",
    };
    this.child = spawn(executable, options.args || [], {
      env: options.env || nativeEnvironment(), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      // Keep the pipe flowing during owner cleanup, without parsing or buffering
      // post-disconnect frames. A blocked output pipe can delay PTY shutdown.
      if (!this.closed) this.consume(this.decoder.write(chunk));
    });
    // Native diagnostics can contain workspace paths; never forward raw stderr to the UI.
    this.child.stderr.on("data", () => {});
    this.child.stdin.on("error", () => { this.fail(new NativeIdeError("Desktop IDE runtime input closed", "RUNTIME_DISCONNECTED")); void this.close(); });
    this.child.once("error", () => { this.fail(new NativeIdeError("Desktop IDE runtime could not start", "RUNTIME_UNAVAILABLE")); void this.close(); });
    this.child.once("close", () => {
      this.childHasClosed = true;
      try { this.fail(new NativeIdeError("Desktop IDE runtime stopped", "RUNTIME_DISCONNECTED")); }
      finally { this.resolveChildClosed(); }
    });
    this.ready = this.send("ping", {}, { timeoutMs: options.timeoutMs ?? 10_000 }).then((value) => {
      if (!value || typeof value !== "object" || (value as { protocolVersion?: unknown }).protocolVersion !== 1) {
        throw new NativeIdeError("Unsupported desktop IDE protocol", "PROTOCOL_MISMATCH");
      }
    }).catch((error) => { void this.close(); throw error; });
    // The first caller receives the startup error; avoid an unhandled rejection before that caller arrives.
    void this.ready.catch(() => {});
  }

  async request<T>(method: string, params: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    if (options.signal?.aborted) throw new NativeIdeError("Operation cancelled", "ABORTED");
    await this.ready;
    return this.send(method, params, options) as Promise<T>;
  }

  onEvent(listener: (event: NativeIdeEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.events.on("disconnect", listener);
    return () => this.events.off("disconnect", listener);
  }

  private send(method: string, params: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown> {
    if (this.closed) return Promise.reject(new NativeIdeError("Desktop IDE runtime disconnected", "RUNTIME_DISCONNECTED"));
    if (options.signal?.aborted) return Promise.reject(new NativeIdeError("Operation cancelled", "ABORTED"));
    if (this.pending.size >= 256) return Promise.reject(new NativeIdeError("Desktop IDE request queue is full", "BUSY"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const cancel = (code: string, message: string) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id); pending.cleanup(); reject(new NativeIdeError(message, code));
        if (!this.closed) this.child.stdin.write(`${JSON.stringify({ id: ++this.sequence, method: "rpc.cancel", params: { requestId: id } })}\n`);
      };
      const abort = () => cancel("ABORTED", "Operation cancelled");
      const timer = setTimeout(() => cancel("TIMEOUT", "Desktop IDE operation timed out"), options.timeoutMs ?? 30_000);
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
      this.pending.set(id, { resolve, reject, cleanup });
      options.signal?.addEventListener("abort", abort, { once: true });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error) this.fail(new NativeIdeError("Desktop IDE runtime input closed", "RUNTIME_DISCONNECTED"));
      });
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 32 * 1024 * 1024) { this.fail(new NativeIdeError("Desktop IDE message exceeds its limit", "PROTOCOL_ERROR")); void this.close(); return; }
    for (let newline = this.buffer.indexOf("\n"); newline >= 0; newline = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let value: { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown }; event?: unknown; params?: unknown };
      try { value = JSON.parse(line); }
      catch { this.fail(new NativeIdeError("Invalid desktop IDE message", "PROTOCOL_ERROR")); void this.close(); return; }
      if (!value || typeof value !== "object") { this.fail(new NativeIdeError("Invalid desktop IDE message", "PROTOCOL_ERROR")); void this.close(); return; }
      if (typeof value.event === "string" && value.params && typeof value.params === "object") {
        this.events.emit("event", { event: value.event, params: value.params }); continue;
      }
      if (typeof value.id !== "number") continue;
      const pending = this.pending.get(value.id);
      if (!pending) continue;
      this.pending.delete(value.id); pending.cleanup();
      if (value.error) pending.reject(new NativeIdeError(typeof value.error.message === "string" ? value.error.message : "Desktop IDE operation failed", typeof value.error.code === "string" ? value.error.code : "FAILED"));
      else pending.resolve(value.result);
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer = "";
    for (const item of this.pending.values()) { item.cleanup(); item.reject(error); }
    this.pending.clear(); this.events.emit("disconnect", error);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const graceMs = this.shutdownOptions.graceMs ?? 8_000;
    const deadlineMs = this.shutdownOptions.deadlineMs ?? 15_000;
    this.closePromise = new Promise<void>((resolve, reject) => {
      if (this.childHasClosed) { resolve(); return; }
      let forced: Promise<void> | undefined;
      let cleanupError: NativeIdeError | undefined;
      const graceTimer = setTimeout(() => {
        forced = this.forceStopOwnedChild().catch((error) => {
          // The tree tool may race a normal exit or be unavailable. The final
          // deadline reports incomplete cleanup; never target another process.
          if (!this.childHasClosed && this.child.exitCode === null && this.child.signalCode === null) {
            cleanupError = error instanceof NativeIdeError ? error : new NativeIdeError("Native process-tree cleanup failed", "SHUTDOWN_FAILED");
            try { this.child.kill("SIGKILL"); } catch { /* Preserve the tree cleanup failure and bounded deadline. */ }
          }
        });
      }, Math.min(graceMs, deadlineMs));
      const deadline = setTimeout(() => {
        clearTimeout(graceTimer);
        reject(new NativeIdeError("Desktop IDE runtime did not finish shutdown", "SHUTDOWN_TIMEOUT"));
      }, deadlineMs);
      void this.childClosed.then(async () => {
        clearTimeout(graceTimer);
        if (forced) await forced;
        clearTimeout(deadline);
        if (cleanupError) reject(cleanupError); else resolve();
      });
      // EOF tells the native owner to stop its PTYs and watchers. Request
      // rejection is distinct from observing the owned child actually close.
      try { this.child.stdin.end(); } catch { /* closed pipe; await the process */ }
    });
    // Existing event handlers can initiate cleanup without awaiting it. Awaiting
    // callers still receive failures, without startup unhandled rejections.
    void this.closePromise.catch(() => {});
    this.fail(new NativeIdeError("Desktop IDE runtime closed", "RUNTIME_DISCONNECTED"));
    return this.closePromise;
  }

  private async forceStopOwnedChild(): Promise<void> {
    if (this.childHasClosed || this.child.exitCode !== null || this.child.signalCode !== null) return;
    const pid = this.child.pid;
    if (!pid) return;
    if ((this.shutdownOptions.platform ?? process.platform) === "win32") {
      const invocation = ownedNativeProcessTreeKillInvocation(pid, this.shutdownOptions.systemRoot);
      await (this.shutdownOptions.runTaskkill ?? runTaskkill)(invocation);
    } else {
      this.child.kill("SIGKILL");
    }
  }
}

let shared: NativeIdeClient | undefined;
export function getDesktopNativeIde(): NativeIdeClient {
  if (!desktopNativeIdeEnabled()) throw new NativeIdeError("Native IDE services are desktop-only", "DESKTOP_ONLY");
  return shared ||= new NativeIdeClient(process.env.CROWNFORGE_IDE_CORE_EXECUTABLE!);
}
export async function shutdownDesktopNativeIde(): Promise<void> {
  const owned = shared;
  if (!owned) return;
  try { await owned.close(); }
  finally { if (shared === owned) shared = undefined; }
}
