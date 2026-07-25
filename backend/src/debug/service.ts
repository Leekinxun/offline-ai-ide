import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn, type ChildProcess } from "child_process";
import { WebSocket } from "ws";

export type DebugStatus = "starting" | "running" | "paused" | "stopped" | "failed";

export interface DebugBreakpoint { path: string; line: number; verified: boolean; }
export interface DebugFrame { id: string; functionName: string; path: string; line: number; column: number; }
export interface DebugSessionState {
  id: string;
  path: string;
  status: DebugStatus;
  startedAt: number;
  updatedAt: number;
  breakpoints: DebugBreakpoint[];
  frames: DebugFrame[];
  stdout: string;
  stderr: string;
  error?: string;
}

interface ActiveDebugSession {
  workspaceDir: string;
  child: ChildProcess;
  inspector?: WebSocket;
  state: DebugSessionState;
  nextMessageId: number;
  pending: Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>;
  initialBreakHandled: boolean;
  connectTimer: NodeJS.Timeout;
  breakpointSetup: Promise<void>;
  resolveBreakpointSetup?: () => void;
  scriptPaths: Map<string, string>;
}

const sessions = new Map<string, ActiveDebugSession>();
const MAX_OUTPUT = 200_000;

function appendOutput(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length <= MAX_OUTPUT ? next : next.slice(-MAX_OUTPUT);
}

function validateTarget(workspaceDir: string, targetPath: string): string {
  if (!targetPath || path.isAbsolute(targetPath)) throw new Error("Debug target must be a workspace-relative file");
  const workspaceRoot = fs.realpathSync.native(workspaceDir);
  const requested = path.resolve(workspaceDir, targetPath);
  if (!fs.existsSync(requested) || !fs.statSync(requested).isFile()) throw new Error("Debug target does not exist");
  const absolute = fs.realpathSync.native(requested);
  const relative = path.relative(workspaceRoot, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Debug target escapes the workspace");
  if (![".js", ".mjs", ".cjs"].includes(path.extname(absolute).toLowerCase())) throw new Error("Phase 2 debugging supports Node.js JavaScript files only");
  return absolute;
}

function publicState(active?: ActiveDebugSession): DebugSessionState | null {
  if (!active) return null;
  return { ...active.state, breakpoints: active.state.breakpoints.map((item) => ({ ...item })), frames: active.state.frames.map((item) => ({ ...item })) };
}

export function getDebugSession(workspaceDir: string): DebugSessionState | null {
  return publicState(sessions.get(workspaceDir));
}

function sendInspector(active: ActiveDebugSession, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const socket = active.inspector;
  if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Debugger is not connected"));
  const id = active.nextMessageId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      active.pending.delete(id);
      reject(new Error(`Debugger command timed out: ${method}`));
    }, 10_000);
    timer.unref?.();
    active.pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

function framePath(workspaceDir: string, url: string): string {
  try {
    if (!url.startsWith("file:") && !path.isAbsolute(url)) return url;
    const workspaceRoot = fs.realpathSync.native(workspaceDir);
    const rawAbsolute = url.startsWith("file:") ? fileURLToPath(url) : url;
    const absolute = fs.existsSync(rawAbsolute) ? fs.realpathSync.native(rawAbsolute) : rawAbsolute;
    const relative = path.relative(workspaceRoot, absolute).split(path.sep).join("/");
    return !relative.startsWith("../") && !path.isAbsolute(relative) ? relative : url;
  } catch { return url; }
}

function stopChild(active: ActiveDebugSession): void {
  if (active.child.exitCode !== null || active.child.pid === undefined) return;
  try {
    if (process.platform !== "win32") process.kill(-active.child.pid, "SIGTERM");
    else active.child.kill("SIGTERM");
  } catch { try { active.child.kill("SIGTERM"); } catch { /* already stopped */ } }
}

async function connectInspector(active: ActiveDebugSession, inspectorUrl: string, absoluteTarget: string): Promise<void> {
  if (active.inspector) return;
  const socket = new WebSocket(inspectorUrl);
  active.inspector = socket;
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (typeof message.id === "number") {
      const pending = active.pending.get(message.id);
      if (!pending) return;
      active.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || "Debugger command failed"));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "Debugger.resumed") {
      active.state.status = "running";
      active.state.frames = [];
      active.state.updatedAt = Date.now();
    }
    if (message.method === "Debugger.breakpointResolved") {
      const line = Number(message.params?.location?.lineNumber || -1) + 1;
      const breakpoint = active.state.breakpoints.find((item) => item.line === line);
      if (breakpoint) breakpoint.verified = true;
      active.state.updatedAt = Date.now();
    }
    if (message.method === "Debugger.scriptParsed") {
      const scriptUrl = String(message.params?.url || "");
      const scriptId = String(message.params?.scriptId || "");
      const relativeScriptPath = framePath(active.workspaceDir, scriptUrl);
      if (relativeScriptPath && relativeScriptPath !== scriptUrl) active.scriptPaths.set(scriptId, relativeScriptPath);
      if (framePath(active.workspaceDir, scriptUrl) === active.state.path) {
        void (async () => {
          for (const breakpoint of active.state.breakpoints) {
            const result = await sendInspector(active, "Debugger.setBreakpoint", {
              location: { scriptId, lineNumber: Math.max(0, breakpoint.line - 1), columnNumber: 0 },
            });
            breakpoint.verified = Boolean(result?.actualLocation);
          }
          active.state.updatedAt = Date.now();
        })().catch((error) => {
          active.state.error = error instanceof Error ? error.message : String(error);
        }).finally(() => active.resolveBreakpointSetup?.());
      }
    }
    if (message.method === "Debugger.paused") {
      const reason = String(message.params?.reason || "");
      const pausedLine = Number(message.params?.callFrames?.[0]?.location?.lineNumber || -1) + 1;
      const isConfiguredBreakpoint = active.state.breakpoints.some((item) => item.line === pausedLine);
      if (!active.initialBreakHandled && (/break on start/i.test(reason) || !isConfiguredBreakpoint)) {
        active.initialBreakHandled = true;
        void active.breakpointSetup
          .then(() => sendInspector(active, "Debugger.resume"))
          .catch(() => undefined);
        return;
      }
      active.initialBreakHandled = true;
      active.state.status = "paused";
      active.state.updatedAt = Date.now();
      active.state.frames = (message.params?.callFrames || []).slice(0, 30).map((frame: any) => ({
        id: String(frame.callFrameId || crypto.randomUUID()),
        functionName: String(frame.functionName || "(anonymous)"),
        path: frame.url
          ? framePath(active.workspaceDir, String(frame.url))
          : active.scriptPaths.get(String(frame.location?.scriptId || "")) || "",
        line: Number(frame.location?.lineNumber || 0) + 1,
        column: Number(frame.location?.columnNumber || 0) + 1,
      }));
    }
  });
  socket.once("open", async () => {
    try {
      clearTimeout(active.connectTimer);
      await sendInspector(active, "Runtime.enable");
      await sendInspector(active, "Debugger.enable");
      active.state.status = "running";
      active.state.updatedAt = Date.now();
      await sendInspector(active, "Runtime.runIfWaitingForDebugger");
    } catch (error) {
      active.state.status = "failed";
      active.state.error = error instanceof Error ? error.message : String(error);
      active.state.updatedAt = Date.now();
      stopChild(active);
    }
  });
  socket.once("error", (error) => {
    active.state.status = "failed";
    active.state.error = error.message;
    active.state.updatedAt = Date.now();
    stopChild(active);
  });
}

export function startDebugSession(workspaceDir: string, targetPath: string, lines: number[]): DebugSessionState {
  const previous = sessions.get(workspaceDir);
  if (previous && ["starting", "running", "paused"].includes(previous.state.status)) throw new Error("A debug session is already active");
  const absoluteTarget = validateTarget(workspaceDir, targetPath);
  const normalizedPath = path.relative(fs.realpathSync.native(workspaceDir), absoluteTarget).split(path.sep).join("/");
  const breakpoints = Array.from(new Set(lines.filter((line) => Number.isInteger(line) && line > 0))).sort((a, b) => a - b).slice(0, 100);
  const child = spawn(process.execPath, ["--inspect-brk=127.0.0.1:0", absoluteTarget], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    detached: process.platform !== "win32",
  });
  const state: DebugSessionState = {
    id: `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
    path: normalizedPath,
    status: "starting",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    breakpoints: breakpoints.map((line) => ({ path: normalizedPath, line, verified: false })),
    frames: [],
    stdout: "",
    stderr: "",
  };
  let resolveBreakpointSetup: (() => void) | undefined;
  const breakpointSetup = breakpoints.length === 0
    ? Promise.resolve()
    : new Promise<void>((resolve) => { resolveBreakpointSetup = resolve; });
  const active: ActiveDebugSession = {
    workspaceDir,
    child,
    state,
    nextMessageId: 1,
    pending: new Map(),
    initialBreakHandled: false,
    connectTimer: setTimeout(() => undefined, 10_000),
    breakpointSetup,
    resolveBreakpointSetup,
    scriptPaths: new Map(),
  };
  clearTimeout(active.connectTimer);
  active.connectTimer = setTimeout(() => {
    if (state.status !== "starting") return;
    state.status = "failed";
    state.error = "Node Inspector did not become ready";
    state.updatedAt = Date.now();
    stopChild(active);
  }, 10_000);
  active.connectTimer.unref?.();
  sessions.set(workspaceDir, active);
  child.stdout?.on("data", (chunk) => { state.stdout = appendOutput(state.stdout, chunk); state.updatedAt = Date.now(); });
  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    state.stderr = appendOutput(state.stderr, text);
    state.updatedAt = Date.now();
    const match = state.stderr.match(/Debugger listening on (ws:\/\/[^\s]+)/);
    if (match) void connectInspector(active, match[1], absoluteTarget);
    if (text.includes("Waiting for the debugger to disconnect")) {
      active.inspector?.close();
      state.status = "stopped";
      state.frames = [];
      state.updatedAt = Date.now();
    }
  });
  child.once("error", (error) => { state.status = "failed"; state.error = error.message; state.updatedAt = Date.now(); });
  child.once("close", () => {
    clearTimeout(active.connectTimer);
    for (const pending of active.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Debug process exited")); }
    active.pending.clear();
    active.inspector?.close();
    if (state.status !== "failed") state.status = "stopped";
    state.updatedAt = Date.now();
  });
  return publicState(active)!;
}

export async function debugCommand(workspaceDir: string, action: "continue" | "step_over" | "step_into" | "step_out"): Promise<DebugSessionState> {
  const active = sessions.get(workspaceDir);
  if (!active || active.state.status !== "paused") throw new Error("Debugger is not paused");
  const methods = { continue: "Debugger.resume", step_over: "Debugger.stepOver", step_into: "Debugger.stepInto", step_out: "Debugger.stepOut" } as const;
  await sendInspector(active, methods[action]);
  active.state.status = "running";
  active.state.frames = [];
  active.state.updatedAt = Date.now();
  return publicState(active)!;
}

export function stopDebugSession(workspaceDir: string): DebugSessionState {
  const active = sessions.get(workspaceDir);
  if (!active) throw new Error("No debug session exists");
  active.inspector?.close();
  stopChild(active);
  active.state.status = "stopped";
  active.state.frames = [];
  active.state.updatedAt = Date.now();
  return publicState(active)!;
}
