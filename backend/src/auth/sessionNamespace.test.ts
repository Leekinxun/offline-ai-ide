import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SessionManager } from './sessionManager.js';

function fixture(t: test.TestContext) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-session-namespace-')));
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  const file = path.join(root, 'users.json');
  fs.writeFileSync(file, JSON.stringify({ allowedRoots: [root], users: [{ username: 'alice', password: 'fixture-password', defaultWorkspace: a, isAdmin: true }] }));
  const manager = new SessionManager(file);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { manager, a: fs.realpathSync.native(a), b: fs.realpathSync.native(b), root };
}

test('verified namespaces survive child rotation but keep isolated sessions separate', (t) => {
  const { manager, a, root } = fixture(t);
  const login = manager.login('alice', 'fixture-password')!;
  const first = manager.createWindowSession(login.token, a);
  const rotated = manager.createWindowSession(login.token, a);
  const worktree = path.join(root, '.crownforge-worktrees', 'project', 'fixture');
  fs.mkdirSync(worktree, { recursive: true });
  const isolated = manager.createIsolatedSession(login.token, worktree);
  assert.equal(manager.getVerifiedSessionNamespace(manager.getSession(first.token)!), login.token);
  assert.equal(manager.getVerifiedSessionNamespace(manager.getSession(rotated.token)!), login.token);
  assert.equal(manager.getVerifiedSessionNamespace(manager.getSession(isolated.token)!), isolated.token);
  assert.equal(manager.getVerifiedSessionNamespace({ ...manager.getSession(first.token)!, username: 'forged' }), null);
  const stale = manager.getSession(rotated.token)!;
  manager.logout(login.token);
  assert.equal(manager.getVerifiedSessionNamespace(stale), null);
});

test('successful workspace switches notify observers, invalid and unchanged selections do not', (t) => {
  const { manager, a, b, root } = fixture(t);
  const login = manager.login('alice', 'fixture-password')!;
  const changes: Array<[string, string, string]> = [];
  const unsubscribe = manager.onWorkspaceChanged((token, before, after) => changes.push([token, before, after]));
  assert.deepEqual(manager.changeWorkspace(login.token, b), { workspaceDir: b });
  assert.deepEqual(changes, [[login.token, a, b]]);
  assert.deepEqual(manager.changeWorkspace(login.token, b), { workspaceDir: b });
  assert.equal(manager.changeWorkspace(login.token, path.join(root, 'missing')), null);
  assert.equal(changes.length, 1);
  unsubscribe();
  manager.changeWorkspace(login.token, a);
  assert.equal(changes.length, 1);
});
