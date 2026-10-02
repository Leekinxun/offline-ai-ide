import crypto from "node:crypto";
import { WebSocket } from "ws";

export interface TerminalProcess {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  terminate(): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (code: number | null, signal?: number | string) => void): void;
}
export interface TerminalIdentity { namespace: string; windowToken: string; username: string; workspace: string; }
export interface TerminalSocket { readyState: number; bufferedAmount?: number; send(data: string): void; close(code?: number, reason?: string): void; }
export interface TerminalAttach { sessionId?: string; ticket?: string; cursor?: number; clientKey: string; documentId: string; raw?: boolean; }
interface Output { seq: number; data: string; bytes: number; truncated?: boolean; }
interface Record {
  id: string; identity: TerminalIdentity; key: string; ticket: string; sourceTicket?: string;
  documentId: string; resumeWindow: string; process: TerminalProcess; output: Output[]; bytes: number; seq: number;
  pendingAck?: boolean;
  writer?: { socket: TerminalSocket; lease: string; raw: boolean }; detachedAt?: number; timer?: ReturnType<typeof setTimeout>;
}
export class TerminalSessionError extends Error {
  constructor(readonly code: string) { super(code); }
}

/** Process ownership is independent of transport ownership. No input is replayed. */
export class TerminalSessions {
  private readonly records = new Map<string, Record>();
  private readonly creationKeys = new Map<string, string>();
  private readonly sweepTimer?: ReturnType<typeof setInterval>;
  constructor(private readonly options: {
    launch: (workspace: string) => TerminalProcess;
    resolveWindow: (token: string) => TerminalIdentity | null;
    graceMs?: number; maxBufferBytes?: number; sweepMs?: number;
  }) {
    if ((options.sweepMs ?? 1000) > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), options.sweepMs ?? 1000);
      this.sweepTimer.unref?.();
    }
  }
  get size(): number { return this.records.size; }
  private identity(token: string): TerminalIdentity {
    const identity = this.options.resolveWindow(token);
    if (!identity) throw new TerminalSessionError("authorization_revoked");
    return identity;
  }
  private matches(record: Record, identity: TerminalIdentity): boolean {
    return record.identity.namespace === identity.namespace && record.identity.username === identity.username
      && record.identity.workspace === identity.workspace;
  }
  attach(windowToken: string, socket: TerminalSocket, request: TerminalAttach): { sessionId: string; lease: string } {
    const identity = this.identity(windowToken);
    for (const value of [request.clientKey, request.documentId]) if (typeof value !== "string" || !/^[A-Za-z0-9-]{8,100}$/.test(value)) throw new TerminalSessionError("invalid_request");
    if (request.cursor !== undefined && (!Number.isSafeInteger(request.cursor) || request.cursor < 0)) throw new TerminalSessionError("invalid_request");
    let record: Record | undefined;
    if (request.sessionId) {
      record = this.records.get(request.sessionId);
      if (!record || !this.matches(record, identity)) throw new TerminalSessionError("session_unavailable");
      if ((request.cursor ?? 0) > record.seq) throw new TerminalSessionError("invalid_request");
      const currentOwner = this.options.resolveWindow(record.identity.windowToken);
      if (!currentOwner || !this.matches(record, currentOwner)) { this.stop(record.id, "authorization_revoked"); throw new TerminalSessionError("session_unavailable"); }
      const sameDocument = record.documentId === request.documentId && record.resumeWindow === windowToken;
      if (record.writer && !sameDocument) throw new TerminalSessionError("session_in_use");
      if (request.ticket !== record.ticket && !(record.pendingAck && request.ticket === record.sourceTicket && (sameDocument || !record.writer))) throw new TerminalSessionError("invalid_resume");
      if (!sameDocument) {
        record.sourceTicket = request.ticket;
        record.ticket = crypto.randomBytes(32).toString("base64url");
        record.pendingAck = true;
      }
    } else {
      const key = `${identity.namespace}\0${identity.workspace}\0${request.clientKey}`;
      const prior = this.creationKeys.get(key);
      record = prior ? this.records.get(prior) : undefined;
      // A random per-tab creation key also recovers a lost initial ready frame.
      if (record && (record.resumeWindow !== windowToken || record.documentId !== request.documentId)) {
        if (record.writer) throw new TerminalSessionError("session_in_use");
        if (!this.matches(record, identity)) throw new TerminalSessionError("session_unavailable");
        record.sourceTicket = record.ticket; record.ticket = crypto.randomBytes(32).toString("base64url"); record.pendingAck = true;
      }
      if (!record) {
        if (this.records.size >= 64 || [...this.records.values()].filter((item) => item.identity.username === identity.username).length >= 8) throw new TerminalSessionError("terminal_limit");
        const process = this.options.launch(identity.workspace);
        record = { id: crypto.randomUUID(), identity, key, ticket: crypto.randomBytes(32).toString("base64url"),
          documentId: request.documentId, resumeWindow: windowToken, process, output: [], bytes: 0, seq: 0 };
        this.records.set(record.id, record); this.creationKeys.set(key, record.id);
        const owned = record;
        process.onData((data) => this.output(owned, data));
        process.onExit((exitCode, signal) => this.finish(owned, "process_exited", exitCode, signal));
      }
    }
    const owner = this.options.resolveWindow(record.identity.windowToken);
    if (!owner || !this.matches(record, owner)) { this.stop(record.id, "authorization_revoked"); throw new TerminalSessionError("session_unavailable"); }
    const oldWriter = record.writer;
    if (record.timer) clearTimeout(record.timer);
    record.timer = undefined; record.detachedAt = undefined;
    record.identity = identity; record.documentId = request.documentId; record.resumeWindow = windowToken;
    const lease = crypto.randomUUID(); record.writer = { socket, lease, raw: Boolean(request.raw) };
    if (oldWriter && oldWriter.socket !== socket) oldWriter.socket.close(4000, "Connection replaced");
    this.send(record, { type: "ready", sessionId: record.id, ticket: record.ticket, pid: record.process.pid, nextCursor: record.seq, graceMs: this.options.graceMs ?? 120_000 });
    const cursor = request.cursor ?? 0;
    if (cursor < (record.output[0]?.seq ?? 1) - 1) this.send(record, { type: "gap", firstCursor: record.output[0]?.seq ?? record.seq, nextCursor: record.seq });
    for (const event of record.output) if (event.seq > cursor) {
      if (event.truncated) this.send(record, { type: "gap", firstCursor: event.seq, nextCursor: event.seq });
      this.send(record, { type: "output", seq: event.seq, data: event.data });
    }
    return { sessionId: record.id, lease };
  }
  private send(record: Record, frame: { type: string; [key: string]: unknown }): void {
    const writer = record.writer;
    if (!writer || writer.socket.readyState !== WebSocket.OPEN) return;
    if ((writer.socket.bufferedAmount ?? 0) > 1_048_576) { writer.socket.close(4000, "Output backpressure"); this.detach(record.id, writer.lease); return; }
    try {
      if (writer.raw) { if (frame.type === "output") writer.socket.send(String(frame.data)); }
      else writer.socket.send(JSON.stringify(frame));
    } catch { this.detach(record.id, writer.lease); }
  }
  private output(record: Record, data: string): void {
    if (!this.records.has(record.id) || !data) return;
    const limit = this.options.maxBufferBytes ?? 131_072;
    let retained = data;
    const oversized = Buffer.byteLength(retained) > limit;
    if (oversized) {
      const bytes = Buffer.from(retained);
      let offset = bytes.length - limit;
      while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset++;
      retained = bytes.subarray(offset).toString("utf8");
    }
    const event = { seq: ++record.seq, data: retained, bytes: Buffer.byteLength(retained), truncated: oversized };
    record.output.push(event); record.bytes += event.bytes;
    while (record.output.length > 1024 || record.bytes > limit) record.bytes -= record.output.shift()!.bytes;
    if (oversized) this.send(record, { type: "gap", firstCursor: event.seq, nextCursor: event.seq });
    this.send(record, { type: "output", seq: event.seq, data: retained });
  }
  input(id: string, lease: string, windowToken: string, data: string): void {
    const record = this.writer(id, lease, windowToken);
    if (typeof data !== "string" || Buffer.byteLength(data) > 16_384) throw new TerminalSessionError("invalid_input");
    record.process.write(data);
  }
  resize(id: string, lease: string, windowToken: string, cols: number, rows: number): void {
    const record = this.writer(id, lease, windowToken);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 500 || rows > 500) throw new TerminalSessionError("invalid_resize");
    record.process.resize(cols, rows);
  }
  private writer(id: string, lease: string, token: string): Record {
    const record = this.records.get(id); const identity = this.identity(token);
    if (!record || record.writer?.lease !== lease || record.identity.windowToken !== token || !this.matches(record, identity)) throw new TerminalSessionError("authorization_revoked");
    return record;
  }
  detach(id: string, lease: string): void {
    const record = this.records.get(id);
    if (!record || record.writer?.lease !== lease) return;
    if (record.writer.raw) { this.stop(id, "legacy_connection_closed"); return; }
    record.writer = undefined; record.detachedAt = Date.now();
    record.timer = setTimeout(() => this.stop(id, "grace_expired"), this.options.graceMs ?? 120_000); record.timer.unref?.();
  }
  stopOwned(id: string, lease: string, windowToken: string): void { this.writer(id, lease, windowToken); this.stop(id, "user_closed"); }
  acknowledge(id: string, lease: string, token: string, ticket: string): void {
    const record = this.writer(id, lease, token);
    if (ticket !== record.ticket) throw new TerminalSessionError("invalid_resume");
    record.pendingAck = false; record.sourceTicket = undefined;
  }
  closeClient(windowToken: string, request: TerminalAttach): void {
    const identity = this.identity(windowToken);
    const id = request.sessionId || this.creationKeys.get(`${identity.namespace}\0${identity.workspace}\0${request.clientKey}`);
    const record = id ? this.records.get(id) : undefined;
    if (!record) return;
    if (!this.matches(record, identity)) throw new TerminalSessionError("session_unavailable");
    const sameDocument = record.documentId === request.documentId && record.resumeWindow === windowToken;
    if (!sameDocument && record.writer) throw new TerminalSessionError("session_in_use");
    if (request.sessionId && request.ticket !== record.ticket && !(record.pendingAck && request.ticket === record.sourceTicket)) throw new TerminalSessionError("invalid_resume");
    this.stop(record.id, "user_closed");
  }
  private finish(record: Record, reason: string, exitCode: number | null, signal?: number | string): void {
    if (!this.records.delete(record.id)) return;
    this.creationKeys.delete(record.key); if (record.timer) clearTimeout(record.timer);
    this.send(record, { type: "exit", reason, exitCode, ...(signal === undefined ? {} : { signal }) });
    record.writer?.socket.close(reason === "authorization_revoked" || reason === "workspace_changed" ? 1008 : 1000, reason);
    record.writer = undefined;
    record.process.terminate();
  }
  stop(id: string, reason = "user_closed"): void {
    const record = this.records.get(id); if (!record) return;
    this.finish(record, reason, null);
  }
  stopForToken(token: string): void {
    for (const record of [...this.records.values()]) if (record.identity.windowToken === token || record.identity.namespace === token) this.stop(record.id, "authorization_revoked");
  }
  stopForWorkspaceChange(token: string, workspace: string): void {
    for (const record of [...this.records.values()]) if (record.identity.windowToken === token && record.identity.workspace === workspace) this.stop(record.id, "workspace_changed");
  }
  sweep(): void {
    for (const record of [...this.records.values()]) {
      const identity = this.options.resolveWindow(record.identity.windowToken);
      if (!identity || !this.matches(record, identity)) this.stop(record.id, "authorization_revoked");
    }
  }
  shutdown(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const id of [...this.records.keys()]) this.stop(id, "server_shutdown");
  }
}
