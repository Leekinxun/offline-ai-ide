import fs from "fs";
import crypto from "node:crypto";
import path from "node:path";
import { WebSocket } from "ws";
import { spawn, spawnSync } from "child_process";
import { StringDecoder } from "node:string_decoder";
import { isSamePath, sessionManager, type UserSession } from "../auth/sessionManager.js";
import { TerminalSessions, TerminalSessionError, type TerminalProcess, type TerminalSocket, type TerminalAttach } from "../run/terminalSessions.js";
import { canWriteActiveWorkspace } from "../team/sessionBridge.js";
import { desktopNativeIdeEnabled } from "../desktop/nativeIdeClient.js";
import { launchDesktopPty } from "../desktop/nativeIdeServices.js";

const INHERITED_ENV = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP", "HOME"] as const;
const WINDOWS_ENV = ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA"] as const;

/**
 * Terminal sessions are an interactive user-controlled workspace feature, not
 * an AI sandbox.  Keep the launcher environment deliberately small so host
 * credentials and runtime injection knobs do not cross this boundary.
 */
export function terminalEnvironment(platform: NodeJS.Platform = process.platform): Record<string, string> {
  const env: Record<string, string> = {};
  const keys = platform === "win32" ? [...INHERITED_ENV, ...WINDOWS_ENV] : INHERITED_ENV;
  for (const key of keys) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  if (platform === "win32") {
    const systemRoot = env.SystemRoot || env.WINDIR || "C:\\Windows";
    env.PATH ||= process.env.Path || `${systemRoot}\\System32;${systemRoot}`;
  } else {
    env.PATH ||= "/usr/bin:/bin";
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  return env;
}

function terminateProcessGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform !== "win32") process.kill(-pid, "SIGTERM");
    else process.kill(pid, "SIGTERM");
  } catch { /* process already exited or does not own a group */ }
  const forceKill = setTimeout(() => {
    try {
      if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
      else process.kill(pid, "SIGKILL");
    } catch { /* process already exited */ }
  }, 1_000);
  forceKill.unref?.();
}

function ownedSessionGroups(pid: number): number[] {
  const groups = new Set<number>();
  if (process.platform === "linux") {
    for (const name of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
        if (Number(fields[3]) === pid && Number(fields[2]) > 0) groups.add(Number(fields[2]));
      } catch { /* process exited during the scan */ }
    }
  } else if (process.platform === "darwin") {
    const source = [
      "import os,sys,subprocess,json",
      "owner=int(sys.argv[1]); groups=set()",
      "rows=subprocess.run(['/bin/ps','-axo','pid=,pgid='],capture_output=True,text=True,timeout=0.5).stdout.splitlines()",
      "for row in rows:",
      "    try:",
      "        child,group=map(int,row.split())",
      "        if group>0 and os.getsid(child)==owner: groups.add(group)",
      "    except (OSError,ValueError): pass",
      "print(json.dumps(list(groups)))",
    ].join("\n");
    const result = spawnSync("python3", ["-c", source, String(pid)], { encoding: "utf8", timeout: 1000, env: terminalEnvironment() });
    if (result.status === 0) try {
      const values: unknown = JSON.parse(result.stdout);
      if (Array.isArray(values)) for (const value of values) if (Number.isSafeInteger(value) && value > 0) groups.add(value);
    } catch { /* unavailable process metadata cannot authorize a kill */ }
  }
  return [...groups];
}
function terminateOwnedSession(pid: number): void {
  const signal = (value: NodeJS.Signals) => { for (const group of ownedSessionGroups(pid)) try { process.kill(-group, value); } catch { /* group exited */ } };
  signal("SIGTERM");
  const force = setTimeout(() => signal("SIGKILL"), 1000); force.unref?.();
}

function foregroundGroup(pid: number): number | undefined {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
      const group = Number(fields[5]);
      return Number(fields[3]) === pid && Number.isSafeInteger(group) && group > 0 ? group : undefined;
    }
    if (process.platform !== "win32") {
      const result = spawnSync("/bin/ps", ["-o", "tpgid=", "-p", String(pid)], { encoding: "utf8", timeout: 500, env: terminalEnvironment() });
      const group = Number(result.stdout.trim());
      return result.status === 0 && Number.isSafeInteger(group) && group > 0 ? group : undefined;
    }
  } catch { /* the shell may already have exited */ }
  return undefined;
}

function workspaceRoot(workspaceDir: string): string {
  const root = fs.realpathSync.native(workspaceDir);
  if (!fs.statSync(root).isDirectory()) throw new Error("Terminal workspace is not a directory");
  return root;
}

// Try to load node-pty; it may fail on some platforms (e.g. macOS + Node 22)
let pty: typeof import("node-pty") | null = null;
if (!desktopNativeIdeEnabled()) {
  try {
    pty = await import("node-pty");
  } catch {
    console.warn("node-pty unavailable, will use child_process fallback for terminal");
  }
}
const loadedPty = pty;
/** Test seam for the optional native binding; no HTTP caller can replace it. */
export function setTerminalPtyForTests(value?: typeof pty): void { pty = value === undefined ? loadedPty : value; }

export function terminalShell(platform: NodeJS.Platform = process.platform): { executable: string; ptyArgs: string[]; fallbackArgs: string[] } {
  if (platform === "win32") {
    return { executable: process.env.ComSpec || "cmd.exe", ptyArgs: ["/d"], fallbackArgs: ["/d"] };
  }
  if (process.env.SHELL) return { executable: process.env.SHELL, ptyArgs: ["--login"], fallbackArgs: ["-i"] };
  for (const s of ["/bin/bash", "/bin/zsh", "/bin/sh"]) {
    if (fs.existsSync(s)) return { executable: s, ptyArgs: ["--login"], fallbackArgs: ["-i"] };
  }
  return { executable: "/bin/sh", ptyArgs: ["--login"], fallbackArgs: ["-i"] };
}

function launchPty(workspaceDir: string): TerminalProcess {
  if (!pty) throw new Error("PTY unavailable");
  const command = terminalShell();
  const shell = pty.spawn(command.executable, command.ptyArgs, { name: "xterm-256color", cols: 80, rows: 24, cwd: workspaceDir, env: terminalEnvironment() });
  let exited = false;
  return {
    pid: shell.pid,
    write: (data) => shell.write(data), resize: (cols, rows) => shell.resize(cols, rows),
    terminate: () => {
      if (process.platform === "linux" || process.platform === "darwin") { terminateOwnedSession(shell.pid); return; }
      if (!exited) {
      const foreground = foregroundGroup(shell.pid);
      if (foreground && foreground !== shell.pid) terminateProcessGroup(foreground);
      terminateProcessGroup(shell.pid); try { shell.kill(); } catch { /* exited */ }
    } },
    onData: (listener) => { shell.onData(listener); },
    onExit: (listener) => { shell.onExit((event) => { exited = true; listener(event.exitCode, event.signal); }); },
  };
}

function launchFallback(workspaceDir: string): TerminalProcess {
  const command = terminalShell();
  const windows = process.platform === "win32";
  const pyScript = [
    "import pty, os, sys, select, signal, fcntl, termios, time, subprocess, json",
    `os.chdir(${JSON.stringify(workspaceDir)})`,
    "master, slave = pty.openpty()",
    "pid = os.fork()",
    "if pid == 0:",
    "    os.setsid()",
    "    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)",
    "    os.dup2(slave, 0); os.dup2(slave, 1); os.dup2(slave, 2)",
    "    os.close(master); os.close(slave)",
    "    try: os.close(3)",
    "    except OSError: pass",
    `    os.execvp(${JSON.stringify(command.executable)}, [${JSON.stringify(command.executable)}, ${JSON.stringify(command.fallbackArgs[0])}])`,
    "else:",
    "    os.close(slave)",
    "    foreground = pid",
    "    def owned_groups():",
    "        groups = set()",
    "        if sys.platform.startswith('linux'):",
    "            for name in os.listdir('/proc'):",
    "                if not name.isdigit(): continue",
    "                try:",
    "                    with open('/proc/'+name+'/stat') as source: value = source.read()",
    "                    fields = value[value.rfind(')')+2:].split()",
    "                    if int(fields[3]) == pid: groups.add(int(fields[2]))",
    "                except (OSError, ValueError, IndexError): pass",
    "        elif sys.platform == 'darwin':",
    "            value = subprocess.run(['/bin/ps','-axo','pid=,pgid='],capture_output=True,text=True,timeout=0.5).stdout",
    "            for line in value.splitlines():",
    "                try:",
    "                    child,group = map(int,line.split())",
    "                    if os.getsid(child) == pid: groups.add(group)",
    "                except (OSError,ValueError): pass",
    "        else: groups.update([pid,foreground])",
    "        return [group for group in groups if group > 0]",
    "    def kill_jobs(sig):",
    "        for group in owned_groups():",
    "            try: os.killpg(group, sig)",
    "            except OSError: pass",
    "    def force(_sig, _frame): kill_jobs(signal.SIGKILL)",
    "    def terminate(_sig, _frame):",
    "        global foreground",
    "        try: foreground = os.tcgetpgrp(master)",
    "        except OSError: pass",
    "        kill_jobs(signal.SIGTERM)",
    "        time.sleep(1)",
    "        kill_jobs(signal.SIGKILL)",
    "        raise SystemExit",
    "    signal.signal(signal.SIGALRM, force)",
    "    signal.signal(signal.SIGTERM, terminate)",
    "    signal.signal(signal.SIGHUP, terminate)",
    "    try:",
    "        while True:",
    "            ready, _, _ = select.select([sys.stdin, master], [], [])",
    "            if sys.stdin in ready:",
    "                data = os.read(sys.stdin.fileno(), 4096)",
    "                if not data: terminate(None, None)",
    "                os.write(master, data)",
    "            if master in ready:",
    "                data = os.read(master, 4096)",
    "                if not data: break",
    "                sys.stdout.buffer.write(data); sys.stdout.buffer.flush()",
    "    except OSError: pass",
    "    finally:",
    "        try: foreground = os.tcgetpgrp(master)",
    "        except OSError: pass",
    "        kill_jobs(signal.SIGTERM)",
    "        time.sleep(1)",
    "        kill_jobs(signal.SIGKILL)",
    "        try:",
    "            _, status = os.waitpid(pid, 0)",
    "            code = os.waitstatus_to_exitcode(status)",
    "        except ChildProcessError: code = 0",
    "        try: os.write(3,(json.dumps({'exitCode':code if code >= 0 else None,'signal':-code if code < 0 else None})+'\\n').encode())",
    "        except OSError: pass",
    "        raise SystemExit(code if code >= 0 else 128-code)",
  ].join("\n");
  const proc = spawn(windows ? command.executable : "python3", windows ? command.fallbackArgs : ["-u", "-c", pyScript], {
    cwd: workspaceDir, env: terminalEnvironment(), detached: !windows, windowsHide: true, stdio: windows ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", "pipe"],
  });
  let force: ReturnType<typeof setTimeout> | undefined;
  let exitStatus: { exitCode: number | null; signal?: number } | undefined;
  let exitMetadata = "";
  proc.stdio[3]?.on("data", (data: Buffer) => {
    exitMetadata = (exitMetadata + data.toString("utf8")).slice(-1024);
    try {
      const info = JSON.parse(exitMetadata.trim());
      if ((info.exitCode === null || Number.isInteger(info.exitCode)) && (info.signal === null || Number.isInteger(info.signal))) {
        exitStatus = { exitCode: info.exitCode, ...(info.signal ? { signal: info.signal } : {}) };
      }
    } catch { /* metadata can arrive in more than one chunk */ }
  });
  const stdoutDecoder = new StringDecoder("utf8"); const stderrDecoder = new StringDecoder("utf8");
  let dataListener: ((data: string) => void) | undefined;
  proc.stdin?.on("error", () => { /* exit/input race is reported by the child exit */ });
  return {
    pid: proc.pid || 0,
    write: (data) => { proc.stdin?.write(data); }, resize: () => { /* pipe fallback has no resize protocol */ },
    terminate: () => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      try { if (windows) proc.kill("SIGTERM"); else process.kill(-proc.pid!, "SIGTERM"); } catch { /* exited */ }
      force = setTimeout(() => { try { if (windows) proc.kill("SIGKILL"); else process.kill(-proc.pid!, "SIGKILL"); } catch { /* exited */ } }, 2000); force.unref?.();
    },
    onData: (listener) => { dataListener = listener; proc.stdout?.on("data", (data: Buffer) => listener(stdoutDecoder.write(data))); proc.stderr?.on("data", (data: Buffer) => listener(stderrDecoder.write(data))); },
    onExit: (listener) => {
      proc.on("error", () => listener(null, "spawn_error"));
      proc.once("close", (code, signal) => { if (force) clearTimeout(force); dataListener?.(stdoutDecoder.end()); dataListener?.(stderrDecoder.end()); listener(exitStatus ? exitStatus.exitCode : code, exitStatus?.signal ?? signal ?? undefined); });
    },
  };
}

export function launchTerminalProcess(workspaceDir: string, forceFallback = false): TerminalProcess {
  if (desktopNativeIdeEnabled() && !forceFallback) {
    const command = process.platform === "win32"
      ? { executable: path.join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ptyArgs: ["-NoLogo", "-NoProfile"] }
      : terminalShell();
    return launchDesktopPty(workspaceRoot(workspaceDir), { executable: command.executable, args: command.ptyArgs }, terminalEnvironment());
  }
  if (!forceFallback) try { return launchPty(workspaceDir); } catch { /* optional native binding fallback */ }
  return launchFallback(workspaceDir);
}

const terminalSessions = new TerminalSessions({
  launch: (workspace) => launchTerminalProcess(workspace),
  resolveWindow: (token) => {
    const session = sessionManager.getSession(token, { touch: false });
    if (!session || !canWriteActiveWorkspace(session)) return null;
    const namespace = sessionManager.getVerifiedSessionNamespace(session);
    if (!namespace) return null;
    try {
      const workspace = workspaceRoot(session.workspaceDir);
      if (!isSamePath(workspace, path.resolve(session.workspaceDir))) return null;
      return { namespace, windowToken: token, username: session.username, workspace };
    }
    catch { return null; }
  },
});
export function stopTerminalSessionsForToken(token: string): void { terminalSessions.stopForToken(token); }
export function stopTerminalSessionsForWorkspaceChange(token: string, previousWorkspace: string): void { terminalSessions.stopForWorkspaceChange(token, previousWorkspace); }
export function recheckTerminalSessions(): void { terminalSessions.sweep(); }
export function shutdownTerminalSessions(): void { terminalSessions.shutdown(); }
export function closeTerminalClient(session: UserSession, request: TerminalAttach): void { terminalSessions.closeClient(session.token, request); }

export function handleTerminalWs(ws: WebSocket, session: UserSession, options: { framed?: boolean } = {}): void {
  const connectionId = crypto.randomUUID();
  const started = Date.now(); let lastPong = started; let lastInput = started; let lastOutput = started;
  let binding: { sessionId: string; lease: string } | undefined;
  const log = (event: string, fields: Record<string, unknown> = {}) => {
    console.info(JSON.stringify({ component: "terminal_transport", connectionId, event, elapsedMs: Date.now() - started, ...fields }));
  };
  const socket: TerminalSocket = {
    get readyState() { return ws.readyState; }, get bufferedAmount() { return ws.bufferedAmount; },
    send: (data) => { lastOutput = Date.now(); ws.send(data); }, close: (code, reason) => ws.close(code, reason),
  };
  const fail = (error: unknown) => {
    const code = error instanceof TerminalSessionError ? error.code : "terminal_unavailable";
    if (ws.readyState === WebSocket.OPEN) {
      if (options.framed) ws.send(JSON.stringify({ type: "error", code }));
      else ws.send("\r\nTerminal unavailable\r\n");
      ws.close(code === "session_in_use" ? 4009 : 1008, code);
    }
    log("rejected", { code });
  };
  ws.on("pong", () => { lastPong = Date.now(); });
  const heartbeat = setInterval(() => {
    if (Date.now() - lastPong > 60_000) { log("heartbeat_timeout", { lastPongAgeMs: Date.now() - lastPong }); ws.terminate(); return; }
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 25_000); heartbeat.unref?.();
  const attachTimeout = setTimeout(() => { if (!binding) ws.close(1008, "Attach required"); }, 15_000); attachTimeout.unref?.();
  const bind = (request: TerminalAttach) => {
    binding = terminalSessions.attach(session.token, socket, request); clearTimeout(attachTimeout);
    log("attached", { terminalSessionId: binding.sessionId });
  };
  log("opened");
  if (!options.framed) {
    try { bind({ clientKey: crypto.randomUUID(), documentId: connectionId, raw: true }); } catch (error) { fail(error); }
  }
  ws.on("message", (raw) => {
    const payload = Array.isArray(raw) ? Buffer.concat(raw) : raw instanceof ArrayBuffer ? Buffer.from(raw) : raw;
    if (payload.length > 65_536) { fail(new TerminalSessionError("invalid_request")); return; }
    try {
      const message = JSON.parse(payload.toString());
      if (message.type === "attach" && options.framed && !binding) {
        bind({ sessionId: message.sessionId, ticket: message.ticket, cursor: message.cursor, clientKey: message.clientKey, documentId: message.documentId }); return;
      }
      if (!binding) throw new TerminalSessionError("attach_required");
      if (message.type === "ready_ack") { terminalSessions.acknowledge(binding.sessionId, binding.lease, session.token, message.ticket); return; }
      if (message.type === "heartbeat") { if (options.framed) ws.send(JSON.stringify({ type: "pong", nonce: message.nonce })); return; }
      if (message.type === "input") {
        lastInput = Date.now(); terminalSessions.input(binding.sessionId, binding.lease, session.token, message.data);
        // Actual user input renews the login idle deadline; heartbeats never do.
        sessionManager.getSession(session.token);
      } else if (message.type === "resize") terminalSessions.resize(binding.sessionId, binding.lease, session.token, message.cols || 80, message.rows || 24);
      else if (message.type === "stop") terminalSessions.stopOwned(binding.sessionId, binding.lease, session.token);
    } catch (error) { fail(error); }
  });
  ws.on("error", () => { log("transport_error"); });
  ws.on("close", (code) => {
    clearInterval(heartbeat); clearTimeout(attachTimeout);
    if (binding) terminalSessions.detach(binding.sessionId, binding.lease);
    log("closed", { code, lastPongAgeMs: Date.now() - lastPong, lastInputAgeMs: Date.now() - lastInput, lastOutputAgeMs: Date.now() - lastOutput });
  });
}
