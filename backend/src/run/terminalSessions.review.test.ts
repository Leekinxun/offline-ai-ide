import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { WebSocket } from "ws";
import { TerminalSessions, type TerminalIdentity, type TerminalProcess } from "./terminalSessions.js";
import { SessionManager, sessionManager, setSessionManagerForTests } from "../auth/sessionManager.js";
import { setTeamManagerForTests } from "../team/sessionBridge.js";
import { TeamManager } from "../team/teamManager.js";
import { handleTerminalWs, launchTerminalProcess, setTerminalPtyForTests, shutdownTerminalSessions } from "../ws/terminal.js";

class Socket extends EventEmitter {
  readyState = WebSocket.OPEN as number;
  bufferedAmount = 0;
  frames: Array<Record<string, any>> = [];
  send(data: string) { this.frames.push(JSON.parse(data)); }
  close(code = 1000) { this.readyState = WebSocket.CLOSED; this.emit("close", code); }
  terminate() { this.close(1006); }
  ping() {}
}

function rig(t: test.TestContext, limit = 10) {
  const identities = new Map<string, TerminalIdentity>([
    ["old-window", { namespace: "parent", windowToken: "old-window", username: "fixture", workspace: "/fixture" }],
    ["new-window", { namespace: "parent", windowToken: "new-window", username: "fixture", workspace: "/fixture" }],
  ]);
  let output!: (value: string) => void;
  let terminations = 0;
  const service = new TerminalSessions({ sweepMs: 0, graceMs: 10_000, maxBufferBytes: limit,
    resolveWindow: (token) => identities.get(token) || null,
    launch: () => ({ pid: 1, write() {}, resize() {}, terminate: () => { terminations += 1; }, onData: (listener) => { output = listener; }, onExit() {} }),
  });
  t.after(() => service.shutdown());
  return { service, output: (value: string) => output(value), terminations: () => terminations };
}
const request = () => ({ clientKey: crypto.randomUUID(), documentId: crypto.randomUUID(), cursor: 0 });

test("review: reconnect must report partial-frame output truncation even with no missing sequence", (t) => {
  const r = rig(t);
  const req = request(); const first = new Socket();
  const binding = r.service.attach("old-window", first, req);
  const ready = first.frames.find((frame) => frame.type === "ready")!;
  r.output("abcdefghijklmnopqrst");
  assert.equal(first.frames.some((frame) => frame.type === "gap"), true);
  r.service.detach(binding.sessionId, binding.lease);
  const resumed = new Socket();
  r.service.attach("new-window", resumed, { ...req, documentId: crypto.randomUUID(), sessionId: ready.sessionId, ticket: ready.ticket, cursor: 0 });
  assert.equal(resumed.frames.filter((frame) => frame.type === "output").map((frame) => frame.data).join(""), "klmnopqrst");
  assert.equal(resumed.frames.some((frame) => frame.type === "gap"), true, "a resumed window must see that its only retained frame is a truncated tail");
});

test("review: explicit close during a detached refresh can stop a session before ready rotates its ticket", (t) => {
  const r = rig(t);
  const req = request(); const first = new Socket();
  const binding = r.service.attach("old-window", first, req);
  const ready = first.frames.find((frame) => frame.type === "ready")!;
  r.service.detach(binding.sessionId, binding.lease);
  assert.doesNotThrow(() => r.service.closeClient("new-window", { ...req, documentId: crypto.randomUUID(), sessionId: ready.sessionId, ticket: ready.ticket }));
  assert.equal(r.service.size, 0);
  assert.equal(r.terminations(), 1);
});

test("review: forged session fields cannot replace live token identity or workspace", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-terminal-review-identity-"));
  const users = path.join(root, "users.json");
  fs.writeFileSync(users, JSON.stringify({ allowedRoots: [root], users: [{ username: "fixture", password: "fixture-only", defaultWorkspace: root, isAdmin: true }] }));
  const priorManager = sessionManager; const manager = new SessionManager(users);
  setSessionManagerForTests(manager); setTeamManagerForTests(new TeamManager(path.join(root, "teams")));
  t.after(() => { shutdownTerminalSessions(); setTerminalPtyForTests(); setSessionManagerForTests(priorManager); setTeamManagerForTests(null); fs.rmSync(root, { recursive: true, force: true }); });
  let cwd: string | undefined;
  setTerminalPtyForTests({ spawn: (_shell: string, _args: string[], options: { cwd: string }) => {
    cwd = options.cwd;
    return { pid: 2147483000, write() {}, resize() {}, onData() {}, onExit() {}, kill() {} };
  } } as unknown as typeof import("node-pty"));
  const login = manager.login("fixture", "fixture-only")!;
  const child = manager.createWindowSession(login.token);
  const live = manager.getSession(child.token)!;
  const forged = { ...live, username: "forged-admin", workspaceDir: "/unauthorized", isAdmin: true };
  const socket = new Socket(); handleTerminalWs(socket as unknown as WebSocket, forged, { framed: true });
  socket.emit("message", Buffer.from(JSON.stringify({ type: "attach", ...request() })));
  assert.equal(socket.frames.some((frame) => frame.type === "ready"), true);
  assert.equal(cwd, fs.realpathSync(root));
  const unregistered = new Socket();
  handleTerminalWs(unregistered as unknown as WebSocket, { ...forged, token: crypto.randomUUID() }, { framed: true });
  unregistered.emit("message", Buffer.from(JSON.stringify({ type: "attach", ...request() })));
  assert.equal(unregistered.frames.some((frame) => frame.type === "error" && frame.code === "authorization_revoked"), true);
});

async function waitFor(predicate: () => boolean, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Review terminal event timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function live(pid: number) {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[0] !== "Z";
    }
    const state = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 500 }).stdout.trim();
    return Boolean(state) && !state.startsWith("Z");
  } catch { return false; }
}

test("review: fallback forwards the actual shell's natural nonzero exit code", { skip: process.platform === "win32" || !fs.existsSync("/bin/bash") }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-terminal-review-exit-"));
  const shell = path.join(root, "fixture-shell");
  fs.writeFileSync(shell, '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n', { mode: 0o700 });
  const priorShell = process.env.SHELL; process.env.SHELL = shell;
  let terminal: TerminalProcess;
  try { terminal = launchTerminalProcess(root, true); }
  finally { if (priorShell === undefined) delete process.env.SHELL; else process.env.SHELL = priorShell; }
  let exitCode: number | null | undefined;
  let output = "";
  terminal.onData((data) => { output += data; }); terminal.onExit((code) => { exitCode = code; });
  t.after(() => { terminal.terminate(); fs.rmSync(root, { recursive: true, force: true }); });
  terminal.write(["exit 7", ""].join(String.fromCharCode(10)));
  await waitFor(() => exitCode !== undefined);
  assert.equal(exitCode, 7, `shell status must be preserved; fixture diagnostic tail: ${output.slice(-800)}`);
});

test("review: fallback close cleans an ordinary background job in a different process group", { skip: process.platform === "win32" || !fs.existsSync("/bin/bash") }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-terminal-review-background-"));
  const shell = path.join(root, "fixture-shell");
  fs.writeFileSync(shell, '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n', { mode: 0o700 });
  const priorShell = process.env.SHELL;
  process.env.SHELL = shell;
  let terminal: TerminalProcess;
  try { terminal = launchTerminalProcess(root, true); }
  finally { if (priorShell === undefined) delete process.env.SHELL; else process.env.SHELL = priorShell; }
  let output = ""; let child: number | undefined;
  terminal.onData((data) => { output += data; }); terminal.onExit(() => {});
  t.after(() => { terminal.terminate(); if (child && live(child)) { try { process.kill(child, "SIGKILL"); } catch {} } fs.rmSync(root, { recursive: true, force: true }); });
  terminal.write(["set +H", "sleep 60 &", "printf '__BG_REVIEW__:'; jobs -p", ""].join(String.fromCharCode(10)));
  try { await waitFor(() => /__BG_REVIEW__:(\d+)/.test(output)); }
  catch { throw new Error(`Review fixture output: ${JSON.stringify(output)}`); }
  child = Number(output.match(/__BG_REVIEW__:(\d+)/)![1]);
  assert.equal(live(child), true);
  terminal.terminate();
  await new Promise((resolve) => setTimeout(resolve, 2_300));
  assert.equal(live(child), false, "ordinary shell background jobs must not outlive explicit terminal close");
});
