export interface TerminalTab { id: string; title: string; sessionId?: string; ticket?: string; }
interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; }
export const terminalDocumentId = globalThis.crypto?.randomUUID?.() || `document-${Date.now()}-${Math.random().toString(36).slice(2)}`;
export function terminalStorageKey(workspace: string): string { return `crewforge-terminal-tabs:${workspace}`; }
export function readTerminalTabs(storage: StorageLike, workspace: string, navigation: string): TerminalTab[] {
  if (!['reload', 'back_forward'].includes(navigation)) return [];
  try {
    const tabs: unknown = JSON.parse(storage.getItem(terminalStorageKey(workspace)) || '[]');
    if (!Array.isArray(tabs)) return [];
    return tabs.slice(0, 8).filter((tab): tab is TerminalTab => Boolean(tab && typeof tab.id === 'string' && /^[A-Za-z0-9-]{8,100}$/.test(tab.id) && typeof tab.title === 'string'));
  } catch { return []; }
}
export function saveTerminalTabs(storage: StorageLike, workspace: string, tabs: TerminalTab[]): void {
  storage.setItem(terminalStorageKey(workspace), JSON.stringify(tabs.slice(0, 8)));
}
export function reconnectDelay(attempt: number): number { return Math.min(15_000, 1000 * 2 ** Math.min(attempt, 4)); }

/** Keeps xterm intact across transport retries. Input is only sent live. */
export class TerminalSessionController {
  private socket: WebSocket | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private cursor = 0;
  private attempt = 0;
  private disposed = false;
  private ended = false;
  private ready = false;
  private lastPong = 0;
  private retryStartedAt?: number;
  constructor(private readonly options: {
    token: string; tab: TerminalTab; documentId?: string;
    write: (data: string) => void; status: (connected: boolean, connecting: boolean) => void;
    credentials: (sessionId: string | undefined, ticket: string | undefined) => void;
    size: () => { cols: number; rows: number };
    socketFactory?: (url: string) => WebSocket;
    diagnostic?: (event: string, data: Record<string, unknown>) => void;
    message?: (key: string) => string;
  }) { options.tab = { ...options.tab }; }
  connect(): void {
    if (this.disposed || this.ended) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = (this.options.socketFactory || ((url) => new WebSocket(url)))(`${proto}//${window.location.host}/ws/terminal?protocol=2&token=${encodeURIComponent(this.options.token)}`);
    this.socket = ws; this.ready = false; this.options.status(false, true);
    const started = Date.now();
    ws.onopen = () => {
      if (this.socket !== ws || this.disposed) return;
      ws.send(JSON.stringify({ type: 'attach', clientKey: this.options.tab.id, documentId: this.options.documentId || terminalDocumentId,
        ...(this.options.tab.sessionId ? { sessionId: this.options.tab.sessionId, ticket: this.options.tab.ticket } : {}), cursor: this.cursor }));
    };
    ws.onmessage = (event) => {
      if (this.socket !== ws || this.disposed) return;
      let message; try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.type === 'ready') {
        this.options.tab.sessionId = message.sessionId; this.options.tab.ticket = message.ticket;
        this.options.credentials(message.sessionId, message.ticket);
        ws.send(JSON.stringify({ type: 'ready_ack', ticket: message.ticket }));
        this.ready = true; this.attempt = 0; this.retryStartedAt = undefined; this.lastPong = Date.now(); this.options.status(true, false);
        this.resize();
        this.heartbeat = setInterval(() => {
          if (this.socket !== ws || ws.readyState !== WebSocket.OPEN) return;
          if (Date.now() - this.lastPong > 65_000) { ws.close(4000, 'Heartbeat timeout'); return; }
          ws.send(JSON.stringify({ type: 'heartbeat', nonce: Date.now() }));
        }, 25_000);
      } else if (message.type === 'pong') this.lastPong = Date.now();
      else if (message.type === 'output' && typeof message.data === 'string' && Number.isSafeInteger(message.seq) && message.seq > this.cursor) {
        this.cursor = message.seq; this.options.write(message.data);
      } else if (message.type === 'gap') this.notice('outputTruncated', 'Earlier terminal output was truncated');
      else if (message.type === 'exit') {
        this.ended = true; this.ready = false; this.options.credentials(undefined, undefined);
        this.notice('ended', 'Terminal ended'); this.options.status(false, false);
      } else if (message.type === 'error') {
        if (message.code !== 'session_in_use') {
          this.ended = true; this.options.credentials(undefined, undefined);
          this.notice('resumeFailed', 'Terminal cannot be resumed. Open a new terminal.');
        }
      }
    };
    ws.onclose = (event) => {
      if (this.socket !== ws) return;
      this.socket = null; this.ready = false; if (this.heartbeat) clearInterval(this.heartbeat);
      this.options.diagnostic?.('closed', { code: event.code, wasClean: event.wasClean, elapsedMs: Date.now() - started });
      this.options.status(false, !this.disposed && !this.ended);
      if (this.disposed || this.ended || (event.code === 1008 && event.reason !== 'session_in_use')) { this.options.status(false, false); return; }
      this.retryStartedAt ??= Date.now();
      if (Date.now() - this.retryStartedAt > 110_000) { this.ended = true; this.options.status(false, false); this.notice('reconnectExpired', 'Terminal reconnection expired'); return; }
      this.timer = setTimeout(() => this.connect(), reconnectDelay(this.attempt++));
    };
    ws.onerror = () => { /* close owns bounded retry */ };
  }
  private notice(key: string, fallback: string): void { this.options.write(`\r\n[${this.options.message?.(`terminal.${key}`) || fallback}]\r\n`); }
  input(data: string): void { if (this.ready && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'input', data })); }
  resize(): void { if (this.ready && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'resize', ...this.options.size() })); }
  stop(): void {
    this.ended = true;
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'stop' }));
    // Explicit close also works while the WebSocket is reconnecting.
    void fetch('/api/terminal-sessions/close', { method: 'POST', headers: { Authorization: `Bearer ${this.options.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: this.options.tab.id, documentId: this.options.documentId || terminalDocumentId,
        sessionId: this.options.tab.sessionId, ticket: this.options.tab.ticket }) }).catch(() => {});
    this.dispose();
  }
  dispose(): void {
    this.disposed = true; if (this.timer) clearTimeout(this.timer); if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close(); this.socket = null;
  }
}
