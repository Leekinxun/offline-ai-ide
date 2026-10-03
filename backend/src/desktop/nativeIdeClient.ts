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
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

function nativeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "HOME", "USERPROFILE", "SystemRoot", "WINDIR", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export class NativeIdeClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly events = new EventEmitter();
  private readonly pending = new Map<number, Pending>();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private sequence = 0;
  private closed = false;
  private readonly ready: Promise<void>;

  constructor(executable: string, options: { args?: string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {
    if (!path.isAbsolute(executable) || !fs.statSync(executable).isFile()) throw new NativeIdeError("Desktop IDE runtime is unavailable", "RUNTIME_UNAVAILABLE");
    this.events.setMaxListeners(128);
    this.child = spawn(executable, options.args || [], {
      env: options.env || nativeEnvironment(), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(this.decoder.write(chunk)));
    // Native diagnostics can contain workspace paths; never forward raw stderr to the UI.
    this.child.stderr.on("data", () => {});
    this.child.stdin.on("error", () => this.fail(new NativeIdeError("Desktop IDE runtime input closed", "RUNTIME_DISCONNECTED")));
    this.child.once("error", () => this.fail(new NativeIdeError("Desktop IDE runtime could not start", "RUNTIME_UNAVAILABLE")));
    this.child.once("close", () => this.fail(new NativeIdeError("Desktop IDE runtime stopped", "RUNTIME_DISCONNECTED")));
    this.ready = this.send("ping", {}, { timeoutMs: options.timeoutMs ?? 10_000 }).then((value) => {
      if (!value || typeof value !== "object" || (value as { protocolVersion?: unknown }).protocolVersion !== 1) {
        throw new NativeIdeError("Unsupported desktop IDE protocol", "PROTOCOL_MISMATCH");
      }
    }).catch((error) => { this.close(); throw error; });
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
    if (Buffer.byteLength(this.buffer) > 32 * 1024 * 1024) { this.fail(new NativeIdeError("Desktop IDE message exceeds its limit", "PROTOCOL_ERROR")); this.child.kill(); return; }
    for (let newline = this.buffer.indexOf("\n"); newline >= 0; newline = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let value: { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown }; event?: unknown; params?: unknown };
      try { value = JSON.parse(line); }
      catch { this.fail(new NativeIdeError("Invalid desktop IDE message", "PROTOCOL_ERROR")); this.child.kill(); return; }
      if (!value || typeof value !== "object") { this.fail(new NativeIdeError("Invalid desktop IDE message", "PROTOCOL_ERROR")); this.child.kill(); return; }
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
    for (const item of this.pending.values()) { item.cleanup(); item.reject(error); }
    this.pending.clear(); this.events.emit("disconnect", error);
  }

  close(): void {
    if (this.closed) { this.child.kill(); return; }
    this.fail(new NativeIdeError("Desktop IDE runtime closed", "RUNTIME_DISCONNECTED"));
    // EOF tells the native owner to stop all PTYs and watchers before exiting.
    this.child.stdin.end();
    const deadline = setTimeout(() => this.child.kill(), 2_500); deadline.unref();
    this.child.once("close", () => clearTimeout(deadline));
  }
}

let shared: NativeIdeClient | undefined;
export function getDesktopNativeIde(): NativeIdeClient {
  if (!desktopNativeIdeEnabled()) throw new NativeIdeError("Native IDE services are desktop-only", "DESKTOP_ONLY");
  return shared ||= new NativeIdeClient(process.env.CROWNFORGE_IDE_CORE_EXECUTABLE!);
}
export function shutdownDesktopNativeIde(): void { shared?.close(); shared = undefined; }
