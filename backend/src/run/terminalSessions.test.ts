import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { TerminalSessions, type TerminalIdentity, type TerminalProcess } from "./terminalSessions.js";
import { SessionManager, sessionManager, setSessionManagerForTests } from "../auth/sessionManager.js";
import { canWriteActiveWorkspace, setTeamManagerForTests } from "../team/sessionBridge.js";
import { TeamManager } from "../team/teamManager.js";
import { handleTerminalWs, launchTerminalProcess, stopTerminalSessionsForToken, stopTerminalSessionsForWorkspaceChange } from "../ws/terminal.js";

class Socket {
  readyState = WebSocket.OPEN as number;
  frames: any[] = [];
  send(data: string) { this.frames.push(JSON.parse(data)); }
  close() { this.readyState = WebSocket.CLOSED; }
}
function rig(t: test.TestContext, graceMs = 30, maxBufferBytes = 100) {
  const identities = new Map<string, TerminalIdentity>([
    ['window-a', { namespace: 'login-a', windowToken: 'window-a', username: 'alice', workspace: '/a' }],
    ['window-refresh', { namespace: 'login-a', windowToken: 'window-refresh', username: 'alice', workspace: '/a' }],
    ['window-other', { namespace: 'login-b', windowToken: 'window-other', username: 'alice', workspace: '/a' }],
    ['window-b', { namespace: 'login-a', windowToken: 'window-b', username: 'alice', workspace: '/b' }],
    ['isolated-a', { namespace: 'isolated-a', windowToken: 'isolated-a', username: 'alice', workspace: '/a' }],
  ]);
  let starts = 0; let kills = 0; const writes: string[] = []; const outputs: Array<(data: string) => void> = [];
  const service = new TerminalSessions({ graceMs, maxBufferBytes, sweepMs: 0, resolveWindow: (token) => identities.get(token) || null,
    launch: () => { const pid = ++starts; const process: TerminalProcess = { pid, write: (value) => { writes.push(value); }, resize() {}, terminate: () => { kills++; }, onData: (fn) => { outputs.push(fn); }, onExit() {} }; return process; },
  });
  t.after(() => service.shutdown());
  return { service, identities, writes, outputs, counts: () => ({ starts, kills }) };
}
const request = () => ({ clientKey: crypto.randomUUID(), documentId: crypto.randomUUID(), cursor: 0 });

test('transport loss retains one process, replays cursor output, and never replays input', (t) => {
  const r = rig(t); const a = new Socket(); const req = request();
  const binding = r.service.attach('window-a', a, req); const ready = a.frames[0];
  r.outputs[0]('first'); r.service.input(binding.sessionId, binding.lease, 'window-a', 'once\n');
  r.service.detach(binding.sessionId, binding.lease); r.outputs[0]('while-detached');
  const b = new Socket(); const next = r.service.attach('window-refresh', b, { ...req, documentId: crypto.randomUUID(), sessionId: ready.sessionId, ticket: ready.ticket, cursor: 1 });
  assert.equal(b.frames[0].pid, ready.pid); assert.deepEqual(r.counts(), { starts: 1, kills: 0 });
  assert.deepEqual(b.frames.filter((x) => x.type === 'output').map((x) => x.data), ['while-detached']);
  assert.deepEqual(r.writes, ['once\n']);
  assert.throws(() => r.service.input(binding.sessionId, binding.lease, 'window-a', 'old-writer'), /authorization_revoked/);
  r.service.stopOwned(next.sessionId, next.lease, 'window-refresh'); assert.equal(r.service.size, 0); assert.equal(r.counts().kills, 1);
});

test('login/workspace/isolated boundaries and a single writer reject copied credentials', (t) => {
  const r = rig(t); const a = new Socket(); const req = request();
  const first = r.service.attach('window-a', a, req); const credential = a.frames[0];
  for (const token of ['window-b', 'window-other', 'isolated-a']) assert.throws(() => r.service.attach(token, new Socket(), { ...req, sessionId: credential.sessionId, ticket: credential.ticket }), /session_unavailable/);
  assert.throws(() => r.service.attach('window-refresh', new Socket(), { ...req, documentId: crypto.randomUUID(), sessionId: credential.sessionId, ticket: credential.ticket }), /session_in_use/);
  const independent = new Socket(); r.service.attach('window-refresh', independent, request());
  assert.notEqual(independent.frames[0].sessionId, first.sessionId); assert.equal(r.counts().starts, 2);
});

test('same-document attach retries tolerate a lost ready packet and old close callbacks', (t) => {
  const r = rig(t); const req = request(); const a = new Socket();
  const first = r.service.attach('window-a', a, req);
  const b = new Socket(); const second = r.service.attach('window-a', b, req);
  r.service.detach(first.sessionId, first.lease);
  r.service.input(second.sessionId, second.lease, 'window-a', 'still-live');
  assert.equal(r.counts().starts, 1); assert.equal(r.service.size, 1);
  r.service.detach(second.sessionId, second.lease);
  const old = b.frames[0]; const doc = crypto.randomUUID();
  const c = new Socket(); r.service.attach('window-refresh', c, { ...req, documentId: doc, sessionId: old.sessionId, ticket: old.ticket });
  const d = new Socket(); const latest = r.service.attach('window-refresh', d, { ...req, documentId: doc, sessionId: old.sessionId, ticket: old.ticket });
  assert.equal(d.frames[0].pid, old.pid);
  r.service.acknowledge(latest.sessionId, latest.lease, 'window-refresh', d.frames[0].ticket);
  r.service.detach(latest.sessionId, latest.lease);
  assert.throws(() => r.service.attach('window-a', new Socket(), { ...req, sessionId: old.sessionId, ticket: old.ticket }), /invalid_resume/);
});

test('grace expiry, logout, role loss and workspace changes clean detached sessions', async (t) => {
  const r = rig(t); const a = new Socket(); const binding = r.service.attach('window-a', a, request());
  r.service.detach(binding.sessionId, binding.lease);
  await new Promise((resolve) => setTimeout(resolve, 50)); assert.equal(r.service.size, 0);
  const cases = [() => r.service.stopForToken('login-a'), () => { r.identities.delete('window-a'); r.service.sweep(); }, () => r.service.stopForWorkspaceChange('window-a', '/a')];
  for (const stop of cases) {
    r.identities.set('window-a', { namespace: 'login-a', windowToken: 'window-a', username: 'alice', workspace: '/a' });
    const b = r.service.attach('window-a', new Socket(), request()); r.service.detach(b.sessionId, b.lease); stop(); assert.equal(r.service.size, 0);
  }
  assert.equal(r.counts().kills, 4);
});

test('output retention is bounded and reconnect reports truncation; explicit close works detached', (t) => {
  const r = rig(t, 1000, 10); const req = request(); const a = new Socket(); const binding = r.service.attach('window-a', a, req); const creds = a.frames[0];
  for (const data of ['12345', 'abcde', 'FGHIJ']) r.outputs[0](data);
  r.service.detach(binding.sessionId, binding.lease);
  const b = new Socket(); const resumed = r.service.attach('window-a', b, { ...req, sessionId: creds.sessionId, ticket: creds.ticket, cursor: 0 });
  assert.equal(b.frames.some((x) => x.type === 'gap'), true);
  assert.equal(b.frames.filter((x) => x.type === 'output').map((x) => x.data).join(''), 'abcdeFGHIJ');
  r.service.detach(resumed.sessionId, resumed.lease);
  r.service.closeClient('window-a', { ...req, sessionId: creds.sessionId, ticket: creds.ticket });
  r.service.closeClient('window-a', { ...req, sessionId: creds.sessionId, ticket: creds.ticket });
  assert.equal(r.counts().kills, 1);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Terminal event timeout'); await new Promise((resolve) => setTimeout(resolve, 10)); }
}
function actualFixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-terminal-real-')); const users = path.join(root, 'users.json');
  fs.writeFileSync(users, JSON.stringify({ allowedRoots: [root], users: [{ username: 'alice', password: 'secret', defaultWorkspace: root, isAdmin: true }] }));
  const manager = new SessionManager(users); const prior = sessionManager; setSessionManagerForTests(manager);
  setTeamManagerForTests(new TeamManager(path.join(root, 'teams')));
  const unsubscribe = manager.onSessionRevoked(stopTerminalSessionsForToken);
  const workspaceUnsubscribe = manager.onWorkspaceChanged(stopTerminalSessionsForWorkspaceChange);
  const login = manager.login('alice', 'secret')!;
  t.after(() => { manager.logout(login.token); unsubscribe(); workspaceUnsubscribe(); setSessionManagerForTests(prior); setTeamManagerForTests(null); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, manager, login };
}

test('real framed WS reconnect keeps the original shell and output through a rotated child token', async (t) => {
  const { manager, login } = actualFixture(t);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve)); const address = server.address(); assert(address && typeof address !== 'string');
  server.on('connection', (ws, req) => { const token = new URL(req.url!, 'http://localhost').searchParams.get('token'); const session = manager.getSession(token); assert(session); handleTerminalWs(ws, session, { framed: true }); });
  const clients: WebSocket[] = [];
  t.after(async () => { for (const ws of server.clients) ws.terminate(); for (const client of clients) client.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const connect = async (token: string) => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/?token=${token}`); const frames: any[] = [];
    socket.on('message', (raw) => frames.push(JSON.parse(raw.toString()))); clients.push(socket);
    await new Promise<void>((resolve) => socket.once('open', resolve)); return { socket, frames };
  };
  const first = manager.createWindowSession(login.token); const a = await connect(first.token); const clientKey = crypto.randomUUID();
  a.socket.send(JSON.stringify({ type: 'attach', clientKey, documentId: crypto.randomUUID(), cursor: 0 }));
  await waitFor(() => a.frames.some((x) => x.type === 'ready')); const ready = a.frames.find((x) => x.type === 'ready');
  a.socket.send(JSON.stringify({ type: 'input', data: "printf '__BEFORE_'; printf 'DROP__:%s\\n' $$\n" }));
  await waitFor(() => /__BEFORE_DROP__:\d+/.test(a.frames.filter((x) => x.type === 'output').map((x) => x.data).join('')));
  const shellPid = a.frames.filter((x) => x.type === 'output').map((x) => x.data).join('').match(/__BEFORE_DROP__:(\d+)/)![1];
  a.socket.terminate(); await new Promise((resolve) => setTimeout(resolve, 50));
  const refreshed = manager.createWindowSession(login.token); const b = await connect(refreshed.token);
  b.socket.send(JSON.stringify({ type: 'attach', sessionId: ready.sessionId, ticket: ready.ticket, clientKey, documentId: crypto.randomUUID(), cursor: 0 }));
  await waitFor(() => b.frames.some((x) => x.type === 'ready'));
  assert.equal(b.frames.find((x) => x.type === 'ready').pid, ready.pid);
  await waitFor(() => b.frames.filter((x) => x.type === 'output').map((x) => x.data).join('').includes(`__BEFORE_DROP__:${shellPid}`));
  b.socket.send(JSON.stringify({ type: 'input', data: "printf '__AFTER_'; printf 'DROP__:%s\\n' $$\n" }));
  await waitFor(() => b.frames.filter((x) => x.type === 'output').map((x) => x.data).join('').includes(`__AFTER_DROP__:${shellPid}`));
  b.socket.send(JSON.stringify({ type: 'stop' })); await waitFor(() => b.frames.some((x) => x.type === 'exit' && x.reason === 'user_closed'));
});

test('forced Python PTY fallback keeps a running command detached and supports termination', async (t) => {
  const { root, manager, login } = actualFixture(t);
  const window = manager.createWindowSession(login.token);
  const service = new TerminalSessions({ launch: (cwd) => launchTerminalProcess(cwd, true), sweepMs: 0,
    resolveWindow: (token) => { const session = manager.getSession(token); if (!session || !canWriteActiveWorkspace(session)) return null; const namespace = manager.getVerifiedSessionNamespace(session); return namespace ? { namespace, windowToken: token, username: session.username, workspace: root } : null; },
  });
  t.after(() => service.shutdown()); const a = new Socket(); const req = request(); const binding = service.attach(window.token, a, req); const ready = a.frames[0];
  service.input(binding.sessionId, binding.lease, window.token, "sleep 1; printf '__FALLBACK_DONE__\\n'\n");
  service.detach(binding.sessionId, binding.lease);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const b = new Socket(); service.attach(window.token, b, { ...req, sessionId: ready.sessionId, ticket: ready.ticket, cursor: 0 });
  assert.equal(b.frames[0].pid, ready.pid);
  await waitFor(() => /(?:^|\r?\n)__FALLBACK_DONE__\r?\n/.test(b.frames.filter((x) => x.type === 'output').map((x) => x.data).join('')));
  service.stop(ready.sessionId); assert.equal(service.size, 0);
});

test('native PTY adapter forwards data, resize and exit without depending on a network connection', async (t) => {
  const { setTerminalPtyForTests } = await import('../ws/terminal.js');
  let onData!: (data: string) => void; let onExit!: (event: { exitCode: number; signal?: number }) => void;
  const writes: string[] = []; const sizes: number[][] = [];
  const binding = { spawn: (_shell: string, _args: string[], options: { cwd: string }) => {
    assert.equal(options.cwd, '/verified-fixture');
    return { pid: 2147483000, write: (data: string) => writes.push(data), resize: (cols: number, rows: number) => sizes.push([cols, rows]),
      onData: (fn: typeof onData) => { onData = fn; }, onExit: (fn: typeof onExit) => { onExit = fn; }, kill: () => { throw new Error('must not kill an exited PTY'); } };
  } };
  setTerminalPtyForTests(binding as unknown as typeof import('node-pty'));
  t.after(() => setTerminalPtyForTests());
  const process = launchTerminalProcess('/verified-fixture'); const received: string[] = []; const ended: unknown[] = [];
  process.onData((data) => received.push(data)); process.onExit((code, signal) => ended.push([code, signal]));
  process.write('input'); process.resize(100, 30); onData('output'); onExit({ exitCode: 0, signal: 15 }); process.terminate();
  assert.deepEqual(writes, ['input']); assert.deepEqual(sizes, [[100, 30]]); assert.deepEqual(received, ['output']); assert.deepEqual(ended, [[0, 15]]);
});
