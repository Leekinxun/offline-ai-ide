import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";

export interface CodexSandboxClientOptions {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  spawn?: typeof childProcess.spawn;
}

export interface CodexSandboxRpcClient {
  initialize(): Promise<void>;
  call(method: "windowsSandbox/readiness" | "windowsSandbox/setupStart", params?: unknown, timeoutMs?: number): Promise<unknown>;
  waitForNotification(method: "windowsSandbox/setupCompleted", timeoutMs?: number): Promise<unknown>;
  close(): void;
}

/** A local execution-only client: it never starts a model thread or an auth flow. */
export class CodexSandboxClient implements CodexSandboxRpcClient {
  private readonly child: childProcess.ChildProcess;
  private readonly events = new EventEmitter();
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly notifications = new Map<string, unknown[]>();
  private counter = 0;
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");
  private closed = false;
  private initialized = false;

  constructor(options: CodexSandboxClientOptions) {
    if (!options.executable || options.executable.includes("\0")) throw new Error("Invalid bundled Codex executable");
    this.child = (options.spawn ?? childProcess.spawn)(options.executable, options.args, {
      cwd: options.cwd, env: options.env, shell: false, windowsHide: true,
      detached: false, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout?.on("data", (chunk: Buffer) => this.consume(chunk));
    // Diagnostics may contain host paths. Never relay raw runtime stderr to the UI.
    this.child.stderr?.on("data", () => {});
    this.child.stdin?.on("error", () => this.fail(new Error("Windows sandbox runtime input closed")));
    this.child.on("error", () => this.fail(new Error("The bundled Windows sandbox runtime could not start")));
    this.child.on("close", () => this.fail(new Error("Windows sandbox runtime disconnected")));
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const result = await this.request("initialize", {
      clientInfo: { name: "crownforge-native-sandbox", version: "1" },
      capabilities: { experimentalApi: true },
    }, 10_000);
    if (!result || typeof result !== "object" || typeof (result as { userAgent?: unknown }).userAgent !== "string" ||
      !/\/0\.160\.0(?:\s|$)/.test((result as { userAgent: string }).userAgent)) {
      this.fail(new Error("Invalid Windows sandbox initialization response"));
      throw new Error("Invalid Windows sandbox initialization response");
    }
    this.write({ method: "initialized" });
    this.initialized = true;
  }

  call(method: "windowsSandbox/readiness" | "windowsSandbox/setupStart", params: unknown = {}, timeoutMs = 10_000): Promise<unknown> {
    if (!this.initialized) return Promise.reject(new Error("Windows sandbox runtime has not initialized"));
    if (method !== "windowsSandbox/readiness" && method !== "windowsSandbox/setupStart") return Promise.reject(new Error("Unsupported Windows sandbox RPC"));
    return this.request(method, params, timeoutMs);
  }

  waitForNotification(method: "windowsSandbox/setupCompleted", timeoutMs = 600_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Windows sandbox runtime is closed"));
    const queued = this.notifications.get(method);
    if (queued?.length) return Promise.resolve(queued.shift());
    return new Promise((resolve, reject) => {
      const finish = (value: unknown) => { clearTimeout(timer); this.events.removeListener("closed", failed); resolve(value); };
      const failed = (error: Error) => { clearTimeout(timer); this.events.removeListener(method, finish); reject(error); };
      const timer = setTimeout(() => {
        this.events.removeListener(method, finish); this.events.removeListener("closed", failed);
        reject(new Error("Windows sandbox setup timed out; check setup again before running Agent commands"));
      }, timeoutMs);
      this.events.once(method, finish); this.events.once("closed", failed);
    });
  }

  close(): void { this.fail(new Error("Windows sandbox runtime is closed")); }

  private write(value: unknown): void {
    if (this.closed || !this.child.stdin?.writable) throw new Error("Windows sandbox runtime is closed");
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Windows sandbox runtime is closed"));
    return new Promise((resolve, reject) => {
      const id = ++this.counter;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Windows sandbox runtime request timed out")); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error as Error); }
    });
  }

  private consume(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer) > 1_048_576) { this.fail(new Error("Windows sandbox runtime exceeded the protocol limit")); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        message = value as Record<string, unknown>;
      } catch { this.fail(new Error("Invalid Windows sandbox runtime protocol")); return; }
      if (typeof message.id === "number" && !message.method) {
        const request = this.pending.get(message.id);
        if (!request) { this.fail(new Error("Unknown Windows sandbox runtime response")); return; }
        this.pending.delete(message.id); clearTimeout(request.timer);
        if (message.error) request.reject(new Error("Windows sandbox runtime rejected the request"));
        else if (Object.hasOwn(message, "result")) request.resolve(message.result);
        else { request.reject(new Error("Invalid Windows sandbox runtime response")); this.fail(new Error("Invalid Windows sandbox runtime response")); }
      } else if (typeof message.method === "string" && message.id === undefined) {
        if (message.method === "windowsSandbox/setupCompleted") {
          if (this.events.listenerCount(message.method)) this.events.emit(message.method, message.params);
          else {
            const queue = this.notifications.get(message.method) ?? [];
            if (queue.length >= 4) { this.fail(new Error("Unexpected Windows sandbox setup notifications")); return; }
            queue.push(message.params); this.notifications.set(message.method, queue);
          }
        }
        // Non-execution startup notifications require no interaction.
      } else { this.fail(new Error("Unexpected Windows sandbox runtime request")); return; }
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear(); this.events.emit("closed", error);
    try { this.child.stdin?.end(); } catch { /* already closed */ }
    try { this.child.kill(); } catch { /* already exited */ }
  }
}
