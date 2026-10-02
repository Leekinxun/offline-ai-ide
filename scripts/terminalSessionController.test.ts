import assert from 'node:assert/strict';
import test from 'node:test';
import { readTerminalTabs, saveTerminalTabs, reconnectDelay, TerminalSessionController } from '../frontend/src/components/terminalSessionController.js';

const storage = () => { const items = new Map<string, string>(); return { getItem: (k: string) => items.get(k) || null, setItem: (k: string, v: string) => { items.set(k, v); } }; };
test('refresh restores workspace terminal credentials but new/copied documents do not inherit a writer', () => {
  const s = storage(); const tabs = [{ id: 'client-uuid-test', title: 'Test', sessionId: 'opaque-server-id', ticket: 'opaque-ticket' }];
  saveTerminalTabs(s, '/workspace/a', tabs);
  assert.deepEqual(readTerminalTabs(s, '/workspace/a', 'reload'), tabs);
  assert.deepEqual(readTerminalTabs(s, '/workspace/a', 'back_forward'), tabs);
  assert.deepEqual(readTerminalTabs(s, '/workspace/a', 'navigate'), []);
  assert.deepEqual(readTerminalTabs(s, '/workspace/b', 'reload'), []);
  assert.deepEqual([0, 1, 2, 3, 4, 20].map(reconnectDelay), [1000, 2000, 4000, 8000, 15000, 15000]);
});

class FakeSocket {
  static OPEN = 1;
  readyState = 1; sent: any[] = [];
  onopen: (() => void) | null = null; onmessage: ((e: {data: string}) => void) | null = null;
  onclose: ((e: {code: number; wasClean: boolean; reason: string}) => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000, wasClean: true, reason: '' }); }
  frame(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

test('framed terminal control never reaches display, output is deduped, and disconnected input is discarded', async (t) => {
  const previous = { window: globalThis.window, websocket: globalThis.WebSocket, fetch: globalThis.fetch };
  Object.assign(globalThis, { window: { location: { protocol: 'https:', host: 'fixture.invalid' } }, WebSocket: FakeSocket });
  const posts: unknown[] = [];
  globalThis.fetch = (async (_url, init) => { posts.push(JSON.parse(String(init?.body))); return Response.json({ stopped: true }); }) as typeof fetch;
  t.after(() => { Object.assign(globalThis, { window: previous.window, WebSocket: previous.websocket, fetch: previous.fetch }); });
  const socket = new FakeSocket(); const output: string[] = []; const creds: unknown[] = [];
  const controller = new TerminalSessionController({ token: 'current-child', tab: { id: 'client-id-123', title: 'Test', sessionId: 'same-pty', ticket: 'ticket-before' }, documentId: 'document-id-test',
    write: (data) => output.push(data), status() {}, credentials: (id, ticket) => creds.push([id, ticket]), size: () => ({ cols: 80, rows: 24 }), socketFactory: () => socket as unknown as WebSocket });
  t.after(() => controller.dispose());
  controller.connect(); socket.onopen?.();
  assert.deepEqual(socket.sent[0], { type: 'attach', clientKey: 'client-id-123', documentId: 'document-id-test', sessionId: 'same-pty', ticket: 'ticket-before', cursor: 0 });
  socket.frame({ type: 'ready', sessionId: 'same-pty', ticket: 'ticket-after', pid: 123 });
  socket.frame({ type: 'pong', nonce: 1 });
  assert.deepEqual(output, []); assert.deepEqual(creds, [['same-pty', 'ticket-after']]);
  socket.frame({ type: 'output', seq: 1, data: '{"type":"pong"}\n' });
  socket.frame({ type: 'output', seq: 1, data: 'duplicate' });
  assert.deepEqual(output, ['{"type":"pong"}\n']);
  controller.input('typed-once'); socket.readyState = 3; controller.input('must-not-replay');
  assert.equal(socket.sent.filter((packet) => packet.type === 'input').length, 1);
  controller.stop(); assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], { clientKey: 'client-id-123', documentId: 'document-id-test', sessionId: 'same-pty', ticket: 'ticket-after' });
});
