import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";

interface DapResponse {
  seq: number;
  type: "response";
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: unknown;
}

export interface DapEvent {
  seq: number;
  type: "event";
  event: string;
  body?: any;
}

interface DapReverseRequest {
  seq: number;
  type: "request";
  command: string;
  arguments?: unknown;
}

type DapMessage = DapResponse | DapEvent | DapReverseRequest;

interface PendingRequest {
  command: string;
  resolve: (body: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class DapClient extends EventEmitter {
  private sequence = 1;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, PendingRequest>();
  private closed = false;

  constructor(
    readable: Readable,
    private readonly writable: Writable
  ) {
    super();
    readable.on("data", (chunk) => this.consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    readable.once("error", (error) => this.dispose(error));
    readable.once("end", () => this.dispose(new Error("Debug adapter output closed")));
    writable.once("error", (error) => this.dispose(error));
  }

  request(command: string, args: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<any> {
    if (this.closed || !this.writable.writable) {
      return Promise.reject(new Error("Debug adapter is not connected"));
    }
    const seq = this.sequence++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`Debug adapter command timed out: ${command}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(seq, { command, resolve, reject, timer });
      this.write({ seq, type: "request", command, arguments: args });
    });
  }

  dispose(error = new Error("Debug adapter closed")): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("close", error);
  }

  private write(message: Record<string, unknown>): void {
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    this.writable.write(`Content-Length: ${payload.length}\r\n\r\n`);
    this.writable.write(payload);
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length > 0) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const lengthMatch = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        this.dispose(new Error("Debug adapter sent an invalid DAP header"));
        return;
      }
      const contentLength = Number(lengthMatch[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + contentLength) return;
      const payload = this.buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + contentLength);
      try {
        this.handle(JSON.parse(payload) as DapMessage);
      } catch (error) {
        this.dispose(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }

  private handle(message: DapMessage): void {
    if (message.type === "response") {
      const pending = this.pending.get(message.request_seq);
      if (!pending) return;
      this.pending.delete(message.request_seq);
      clearTimeout(pending.timer);
      if (message.success) {
        pending.resolve(message.body || {});
      } else {
        pending.reject(new Error(message.message || `${pending.command} failed`));
      }
      return;
    }
    if (message.type === "event") {
      this.emit("event", message);
      return;
    }
    this.write({
      seq: this.sequence++,
      type: "response",
      request_seq: message.seq,
      success: false,
      command: message.command,
      message: `CrownForge does not support adapter request: ${message.command}`,
    });
  }
}
