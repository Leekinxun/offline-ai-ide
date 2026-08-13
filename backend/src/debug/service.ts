import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn, type ChildProcess } from "child_process";
import { WebSocket } from "ws";
import { config } from "../config.js";
import { DapClient, type DapEvent } from "./dapClient.js";

export type DebugStatus = "starting" | "running" | "paused" | "stopped" | "failed";
export type DebugRuntime = "node" | "python";

export interface DebugBreakpoint { path: string; line: number; verified: boolean; }
export interface DebugFrame { id: string; functionName: string; path: string; line: number; column: number; }
export interface DebugScope {
  name: string;
  variablesReference: number;
  expensive: boolean;
  namedVariables?: number;
  indexedVariables?: number;
}
export interface DebugVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  evaluateName?: string;
  namedVariables?: number;
  indexedVariables?: number;
}
export interface DebugEvaluation {
  result: string;
  type?: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
}
export interface DebugSessionState {
  id: string;
  path: string;
  runtime: DebugRuntime;
  status: DebugStatus;
  startedAt: number;
  updatedAt: number;
  pauseVersion: number;
  breakpoints: DebugBreakpoint[];
  frames: DebugFrame[];
  stdout: string;
  stderr: string;
  error?: string;
}

interface ActiveDebugSessionBase {
  runtime: DebugRuntime;
  workspaceDir: string;
  child: ChildProcess;
  state: DebugSessionState;
  connectTimer: NodeJS.Timeout;
  pauseVersion: number;
}

interface ActiveNodeDebugSession extends ActiveDebugSessionBase {
  runtime: "node";
  inspector?: WebSocket;
  nextMessageId: number;
  pending: Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>;
  initialBreakHandled: boolean;
  breakpointSetup: Promise<void>;
  resolveBreakpointSetup?: () => void;
  scriptPaths: Map<string, string>;
  callFrames: Map<string, any>;
  variableReferences: Map<number, string>;
  nextVariableReference: number;
}

interface ActivePythonDebugSession extends ActiveDebugSessionBase {
  runtime: "python";
  absoluteTarget: string;
  dap: DapClient;
  targetPython: string;
  threadId?: number;
  initializedEvent: Promise<void>;
  resolveInitialized: () => void;
  capabilities: Record<string, unknown>;
  stopping: boolean;
}

type ActiveDebugSession = ActiveNodeDebugSession | ActivePythonDebugSession;

const sessions = new Map<string, ActiveDebugSession>();
const MAX_OUTPUT = 200_000;
const INHERITED_ENV = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TMP", "TEMP"] as const;
const BLOCKED_ENV = /^(?:NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z_]+|BASH_ENV|ENV|PYTHONPATH|RUBYOPT|PERL5OPT)$/;

/** Debuggees are supervised processes, not an OS-level sandbox. */
export function debugEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  env.PATH ||= "/usr/bin:/bin";
  for (const [key, value] of Object.entries(extra)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || BLOCKED_ENV.test(key) || typeof value !== "string") {
      throw new Error(`Blocked debugger environment variable: ${key}`);
    }
  }
  return { ...env, ...extra };
}

function canonicalWorkspaceRoot(workspaceDir: string): string {
  const root = fs.realpathSync.native(workspaceDir);
  if (!fs.statSync(root).isDirectory()) throw new Error("Debug workspace is not a directory");
  return root;
}

function appendOutput(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length <= MAX_OUTPUT ? next : next.slice(-MAX_OUTPUT);
}

function validateTarget(
  workspaceDir: string,
  targetPath: string
): { absoluteTarget: string; runtime: DebugRuntime } {
  if (!targetPath || path.isAbsolute(targetPath)) throw new Error("Debug target must be a workspace-relative file");
  const workspaceRoot = canonicalWorkspaceRoot(workspaceDir);
  const requested = path.resolve(workspaceRoot, targetPath);
  if (!fs.existsSync(requested) || !fs.statSync(requested).isFile()) throw new Error("Debug target does not exist");
  const absolute = fs.realpathSync.native(requested);
  const relative = path.relative(workspaceRoot, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Debug target escapes the workspace");
  const extension = path.extname(absolute).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(extension)) {
    return { absoluteTarget: absolute, runtime: "node" };
  }
  if ([".py", ".pyw"].includes(extension)) {
    return { absoluteTarget: absolute, runtime: "python" };
  }
  throw new Error("Debugging supports JavaScript and Python files only");
}

function publicState(active?: ActiveDebugSession): DebugSessionState | null {
  if (!active) return null;
  return { ...active.state, pauseVersion: active.pauseVersion, breakpoints: active.state.breakpoints.map((item) => ({ ...item })), frames: active.state.frames.map((item) => ({ ...item })) };
}

export function getDebugSession(workspaceDir: string): DebugSessionState | null {
  try { return publicState(sessions.get(canonicalWorkspaceRoot(workspaceDir))); } catch { return null; }
}

function requirePausedSession(workspaceDir: string): ActiveDebugSession {
  const active = sessions.get(canonicalWorkspaceRoot(workspaceDir));
  if (!active || active.state.status !== "paused") throw new Error("Debugger is not paused");
  return active;
}

function clearPausedData(active: ActiveDebugSession): void {
  active.state.frames = [];
  if (active.runtime === "node") {
    active.callFrames.clear();
    active.variableReferences.clear();
  } else {
    active.threadId = undefined;
  }
}

function waitForNextPause(active: ActiveDebugSession, pauseVersion: number, timeoutMs = 8_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (active.pauseVersion > pauseVersion || active.state.status === "stopped") {
        clearInterval(timer);
        resolve();
        return;
      }
      if (active.state.status === "failed") {
        clearInterval(timer);
        reject(new Error(active.state.error || "Debug session failed"));
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(new Error("Debugger did not pause after the step command"));
      }
    }, 20);
    timer.unref?.();
  });
}

function nodeVariableReference(active: ActiveNodeDebugSession, objectId?: string): number {
  if (!objectId) return 0;
  for (const [reference, currentObjectId] of active.variableReferences) {
    if (currentObjectId === objectId) return reference;
  }
  const reference = active.nextVariableReference++;
  active.variableReferences.set(reference, objectId);
  return reference;
}

function nodeRemoteValue(remote: any): string {
  if (!remote) return "undefined";
  if (remote.type === "undefined") return "undefined";
  if (remote.subtype === "null") return "null";
  if (remote.unserializableValue !== undefined) return String(remote.unserializableValue);
  if (remote.type === "string") return JSON.stringify(String(remote.value ?? ""));
  if (remote.value !== undefined) return String(remote.value);
  return String(remote.description || remote.className || remote.type || "object");
}

function nodeRemoteType(remote: any): string | undefined {
  if (!remote) return undefined;
  if (remote.subtype && remote.subtype !== "null") return String(remote.subtype);
  if (remote.className) return String(remote.className);
  return remote.type ? String(remote.type) : undefined;
}

function nodeRemoteVariable(
  active: ActiveNodeDebugSession,
  remote: any,
  name: string,
  evaluateName?: string
): DebugVariable {
  return {
    name,
    value: nodeRemoteValue(remote),
    type: nodeRemoteType(remote),
    variablesReference: nodeVariableReference(active, remote?.objectId),
    evaluateName,
    namedVariables: Number.isInteger(remote?.preview?.properties?.length)
      ? remote.preview.properties.length
      : undefined,
  };
}

function sendInspector(active: ActiveNodeDebugSession, method: string, params: Record<string, unknown> = {}): Promise<any> {
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

function stopChild(active: ActiveDebugSessionBase): void {
  if (active.child.exitCode !== null || active.child.pid === undefined) return;
  try {
    if (process.platform !== "win32") process.kill(-active.child.pid, "SIGTERM");
    else active.child.kill("SIGTERM");
  } catch { try { active.child.kill("SIGTERM"); } catch { /* already stopped */ } }
}

async function connectInspector(active: ActiveNodeDebugSession, inspectorUrl: string): Promise<void> {
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
      clearPausedData(active);
      active.state.updatedAt = Date.now();
      void sendInspector(active, "Runtime.releaseObjectGroup", { objectGroup: "crownforge-debug" })
        .catch(() => undefined);
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
      clearPausedData(active);
      active.state.status = "paused";
      active.state.updatedAt = Date.now();
      active.state.frames = (message.params?.callFrames || []).slice(0, 30).map((frame: any) => {
        const id = String(frame.callFrameId || crypto.randomUUID());
        active.callFrames.set(id, frame);
        return {
          id,
          functionName: String(frame.functionName || "(anonymous)"),
          path: frame.url
            ? framePath(active.workspaceDir, String(frame.url))
            : active.scriptPaths.get(String(frame.location?.scriptId || "")) || "",
          line: Number(frame.location?.lineNumber || 0) + 1,
          column: Number(frame.location?.columnNumber || 0) + 1,
        };
      });
      active.pauseVersion += 1;
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

function createDebugState(
  workspaceDir: string,
  absoluteTarget: string,
  runtime: DebugRuntime,
  lines: number[]
): DebugSessionState {
  const normalizedPath = path.relative(fs.realpathSync.native(workspaceDir), absoluteTarget).split(path.sep).join("/");
  const breakpoints = Array.from(new Set(lines.filter((line) => Number.isInteger(line) && line > 0))).sort((a, b) => a - b).slice(0, 100);
  return {
    id: `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
    path: normalizedPath,
    runtime,
    status: "starting",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    pauseVersion: 0,
    breakpoints: breakpoints.map((line) => ({ path: normalizedPath, line, verified: false })),
    frames: [],
    stdout: "",
    stderr: "",
  };
}

function startNodeDebugSession(
  workspaceDir: string,
  absoluteTarget: string,
  lines: number[]
): DebugSessionState {
  const state = createDebugState(workspaceDir, absoluteTarget, "node", lines);
  const child = spawn(process.execPath, ["--inspect-brk=127.0.0.1:0", absoluteTarget], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: debugEnvironment({ NO_COLOR: "1", FORCE_COLOR: "0" }),
    detached: process.platform !== "win32",
  });
  let resolveBreakpointSetup: (() => void) | undefined;
  const breakpointSetup = state.breakpoints.length === 0
    ? Promise.resolve()
    : new Promise<void>((resolve) => { resolveBreakpointSetup = resolve; });
  const active: ActiveNodeDebugSession = {
    runtime: "node",
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
    callFrames: new Map(),
    variableReferences: new Map(),
    nextVariableReference: 1,
    pauseVersion: 0,
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
    if (match) void connectInspector(active, match[1]);
    if (text.includes("Waiting for the debugger to disconnect")) {
      active.inspector?.close();
      state.status = "stopped";
      clearPausedData(active);
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
    clearPausedData(active);
    state.updatedAt = Date.now();
  });
  return publicState(active)!;
}

function workspacePythonExecutable(workspaceDir: string): string {
  const candidates = process.platform === "win32"
    ? [".venv/Scripts/python.exe", "venv/Scripts/python.exe"]
    : [".venv/bin/python", "venv/bin/python"];
  for (const candidate of candidates) {
    const absolute = path.join(workspaceDir, candidate);
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
      const resolved = fs.realpathSync.native(absolute);
      const relative = path.relative(canonicalWorkspaceRoot(workspaceDir), resolved);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return resolved;
    }
  }
  return config.pythonExecutable;
}

function failPythonSession(active: ActivePythonDebugSession, error: unknown): void {
  if (active.stopping || active.state.status === "stopped") return;
  const message = error instanceof Error ? error.message : String(error);
  active.state.status = "failed";
  active.state.error = /No module named ['\"]?debugpy/i.test(active.state.stderr)
    ? `debugpy is not installed for ${config.debugpyPythonExecutable}. Install debugpy==1.8.21 or set DEBUGPY_PYTHON_EXECUTABLE.`
    : message;
  clearPausedData(active);
  active.state.updatedAt = Date.now();
  stopChild(active);
}

async function capturePythonFrames(active: ActivePythonDebugSession, requestedThreadId?: number): Promise<void> {
  try {
    let threadId = requestedThreadId;
    if (!threadId) {
      const result = await active.dap.request("threads");
      threadId = Number(result?.threads?.[0]?.id || 0);
    }
    if (!threadId) throw new Error("debugpy did not provide a paused thread");
    active.threadId = threadId;
    const result = await active.dap.request("stackTrace", {
      threadId,
      startFrame: 0,
      levels: 30,
    });
    active.state.frames = (result?.stackFrames || []).map((frame: any) => ({
      id: String(frame.id || crypto.randomUUID()),
      functionName: String(frame.name || "<module>"),
      path: frame.source?.path
        ? framePath(active.workspaceDir, String(frame.source.path))
        : String(frame.source?.name || ""),
      line: Number(frame.line || 1),
      column: Number(frame.column || 1),
    }));
    active.state.status = "paused";
    active.state.updatedAt = Date.now();
    active.pauseVersion += 1;
  } catch (error) {
    failPythonSession(active, error);
  }
}

function handlePythonDapEvent(active: ActivePythonDebugSession, event: DapEvent): void {
  const body = event.body || {};
  if (event.event === "initialized") {
    active.resolveInitialized();
    return;
  }
  if (event.event === "output") {
    const output = String(body.output || "");
    if (body.category === "stdout") active.state.stdout = appendOutput(active.state.stdout, output);
    if (body.category === "stderr" || body.category === "important") {
      active.state.stderr = appendOutput(active.state.stderr, output);
    }
    active.state.updatedAt = Date.now();
    return;
  }
  if (event.event === "stopped") {
    clearPausedData(active);
    active.state.updatedAt = Date.now();
    void capturePythonFrames(active, Number(body.threadId || 0));
    return;
  }
  if (event.event === "continued") {
    active.state.status = "running";
    clearPausedData(active);
    active.state.updatedAt = Date.now();
    return;
  }
  if (event.event === "breakpoint") {
    const resolved = body.breakpoint;
    const resolvedPath = resolved?.source?.path
      ? framePath(active.workspaceDir, String(resolved.source.path))
      : active.state.path;
    const breakpoint = active.state.breakpoints.find(
      (item) => item.path === resolvedPath && item.line === Number(resolved?.line || 0)
    );
    if (breakpoint) breakpoint.verified = Boolean(resolved?.verified);
    active.state.updatedAt = Date.now();
    return;
  }
  if (event.event === "exited") {
    active.state.status = "stopped";
    clearPausedData(active);
    active.state.updatedAt = Date.now();
    return;
  }
  if (event.event === "terminated") {
    active.stopping = true;
    active.state.status = "stopped";
    clearPausedData(active);
    active.state.updatedAt = Date.now();
    void active.dap.request("disconnect", { restart: false, terminateDebuggee: false }, 1_500)
      .catch(() => undefined)
      .finally(() => {
        active.dap.dispose();
        stopChild(active);
      });
  }
}

function waitForPythonInitialized(active: ActivePythonDebugSession): Promise<void> {
  return Promise.race([
    active.initializedEvent,
    new Promise<void>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("debugpy did not enter configuration mode")), 15_000);
      timer.unref?.();
    }),
  ]);
}

async function initializePythonSession(active: ActivePythonDebugSession): Promise<void> {
  try {
    active.capabilities = await active.dap.request("initialize", {
      clientID: "crownforge",
      clientName: "CrownForge",
      adapterID: "debugpy",
      pathFormat: "path",
      linesStartAt1: true,
      columnsStartAt1: true,
      locale: "en-US",
      supportsRunInTerminalRequest: false,
      supportsVariableType: true,
      supportsVariablePaging: true,
    });
    const launch = active.dap.request("launch", {
      name: "CrownForge Python",
      type: "debugpy",
      request: "launch",
      program: active.absoluteTarget,
      cwd: active.workspaceDir,
      python: [active.targetPython],
      console: "internalConsole",
      redirectOutput: true,
      justMyCode: true,
      subProcess: false,
      stopOnEntry: false,
      env: { NO_COLOR: "1", FORCE_COLOR: "0", PYTHONUNBUFFERED: "1" },
    }, 30_000);
    await waitForPythonInitialized(active);
    const breakpointResult = await active.dap.request("setBreakpoints", {
      source: { name: path.basename(active.absoluteTarget), path: active.absoluteTarget },
      breakpoints: active.state.breakpoints.map((breakpoint) => ({ line: breakpoint.line })),
      sourceModified: false,
    });
    active.state.breakpoints = (breakpointResult?.breakpoints || []).map((breakpoint: any, index: number) => ({
      path: active.state.path,
      line: Number(breakpoint.line || active.state.breakpoints[index]?.line || 1),
      verified: Boolean(breakpoint.verified),
    }));
    await active.dap.request("setExceptionBreakpoints", { filters: [] });
    await active.dap.request("configurationDone");
    await launch;
    clearTimeout(active.connectTimer);
    if (active.state.status === "starting") {
      active.state.status = "running";
      active.state.updatedAt = Date.now();
    }
  } catch (error) {
    failPythonSession(active, error);
  }
}

function startPythonDebugSession(
  workspaceDir: string,
  absoluteTarget: string,
  lines: number[]
): DebugSessionState {
  const state = createDebugState(workspaceDir, absoluteTarget, "python", lines);
  const targetPython = workspacePythonExecutable(workspaceDir);
  const child = spawn(
    config.debugpyPythonExecutable,
    ["-u", "-m", "debugpy.adapter"],
    {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: debugEnvironment({ PYTHONUNBUFFERED: "1" }),
      detached: process.platform !== "win32",
    }
  );
  if (!child.stdin || !child.stdout) throw new Error("Failed to open debugpy adapter streams");
  const dap = new DapClient(child.stdout, child.stdin);
  let resolveInitialized: () => void = () => {};
  const initializedEvent = new Promise<void>((resolve) => { resolveInitialized = resolve; });
  const active: ActivePythonDebugSession = {
    runtime: "python",
    workspaceDir,
    absoluteTarget,
    child,
    state,
    dap,
    targetPython,
    initializedEvent,
    resolveInitialized,
    capabilities: {},
    stopping: false,
    pauseVersion: 0,
    connectTimer: setTimeout(() => undefined, 15_000),
  };
  clearTimeout(active.connectTimer);
  active.connectTimer = setTimeout(() => {
    if (state.status !== "starting") return;
    state.status = "failed";
    state.error = "debugpy did not become ready";
    state.updatedAt = Date.now();
    stopChild(active);
  }, 15_000);
  active.connectTimer.unref?.();
  sessions.set(workspaceDir, active);
  dap.on("event", (event: DapEvent) => handlePythonDapEvent(active, event));
  dap.on("close", (error: Error) => {
    if (!["failed", "stopped"].includes(state.status)) failPythonSession(active, error);
  });
  child.stderr?.on("data", (chunk) => {
    state.stderr = appendOutput(state.stderr, chunk);
    state.updatedAt = Date.now();
    if (/No module named ['\"]?debugpy/i.test(state.stderr)) {
      failPythonSession(active, new Error("debugpy is not installed"));
    }
  });
  child.once("error", (error) => {
    clearTimeout(active.connectTimer);
    failPythonSession(active, error);
  });
  child.once("close", () => {
    clearTimeout(active.connectTimer);
    dap.dispose(new Error("debugpy adapter exited"));
    if (!["failed", "stopped"].includes(state.status)) {
      failPythonSession(active, new Error("debugpy adapter exited before the session completed"));
    }
    clearPausedData(active);
    state.updatedAt = Date.now();
  });
  void initializePythonSession(active);
  return publicState(active)!;
}

export function startDebugSession(workspaceDir: string, targetPath: string, lines: number[]): DebugSessionState {
  const root = canonicalWorkspaceRoot(workspaceDir);
  const previous = sessions.get(root);
  if (previous && ["starting", "running", "paused"].includes(previous.state.status)) throw new Error("A debug session is already active");
  const { absoluteTarget, runtime } = validateTarget(root, targetPath);
  return runtime === "python"
    ? startPythonDebugSession(root, absoluteTarget, lines)
    : startNodeDebugSession(root, absoluteTarget, lines);
}

export async function getDebugScopes(workspaceDir: string, frameId: string): Promise<DebugScope[]> {
  const active = requirePausedSession(workspaceDir);
  if (!frameId || !active.state.frames.some((frame) => frame.id === frameId)) {
    throw new Error("Debug frame is not available");
  }
  if (active.runtime === "python") {
    const result = await active.dap.request("scopes", { frameId: Number(frameId) });
    return (result?.scopes || []).map((scope: any) => ({
      name: String(scope.name || "Scope"),
      variablesReference: Number(scope.variablesReference || 0),
      expensive: Boolean(scope.expensive),
      namedVariables: Number.isInteger(scope.namedVariables) ? scope.namedVariables : undefined,
      indexedVariables: Number.isInteger(scope.indexedVariables) ? scope.indexedVariables : undefined,
    }));
  }

  const frame = active.callFrames.get(frameId);
  if (!frame) throw new Error("Debug frame is no longer available");
  const labels: Record<string, string> = {
    local: "Local",
    closure: "Closure",
    global: "Global",
    catch: "Catch",
    block: "Block",
    script: "Script",
    with: "With",
    eval: "Eval",
    module: "Module",
    wasmExpressionStack: "WebAssembly",
  };
  return (frame.scopeChain || []).map((scope: any) => ({
    name: String(labels[String(scope.type || "")] || scope.name || scope.type || "Scope"),
    variablesReference: nodeVariableReference(active, scope.object?.objectId),
    expensive: scope.type === "global",
    namedVariables: Number.isInteger(scope.object?.preview?.properties?.length)
      ? scope.object.preview.properties.length
      : undefined,
  }));
}

export async function getDebugVariables(workspaceDir: string, reference: number): Promise<DebugVariable[]> {
  const active = requirePausedSession(workspaceDir);
  if (!Number.isInteger(reference) || reference <= 0) throw new Error("Invalid variable reference");
  if (active.runtime === "python") {
    const result = await active.dap.request("variables", { variablesReference: reference });
    return (result?.variables || []).map((variable: any) => ({
      name: String(variable.name || ""),
      value: String(variable.value ?? ""),
      type: variable.type ? String(variable.type) : undefined,
      variablesReference: Number(variable.variablesReference || 0),
      evaluateName: variable.evaluateName ? String(variable.evaluateName) : undefined,
      namedVariables: Number.isInteger(variable.namedVariables) ? variable.namedVariables : undefined,
      indexedVariables: Number.isInteger(variable.indexedVariables) ? variable.indexedVariables : undefined,
    }));
  }

  const objectId = active.variableReferences.get(reference);
  if (!objectId) throw new Error("Variable reference is no longer available");
  const result = await sendInspector(active, "Runtime.getProperties", {
    objectId,
    ownProperties: true,
    accessorPropertiesOnly: false,
    generatePreview: true,
  });
  const variables: DebugVariable[] = [];
  for (const property of result?.result || []) {
    if (property.symbol) continue;
    const name = String(property.name || "");
    if (property.value) {
      variables.push(nodeRemoteVariable(active, property.value, name, name));
    } else if (property.get || property.set) {
      variables.push({
        name,
        value: property.get ? "<getter>" : "<setter>",
        type: "accessor",
        variablesReference: 0,
        evaluateName: name,
      });
    }
  }
  for (const property of result?.internalProperties || []) {
    if (property.value) variables.push(nodeRemoteVariable(active, property.value, String(property.name || "")));
  }
  return variables;
}

export async function evaluateDebugExpression(
  workspaceDir: string,
  frameId: string,
  expression: string
): Promise<DebugEvaluation> {
  const active = requirePausedSession(workspaceDir);
  const normalizedExpression = expression.trim();
  if (!normalizedExpression) throw new Error("Expression is required");
  if (normalizedExpression.length > 10_000) throw new Error("Expression is too long");
  if (!frameId || !active.state.frames.some((frame) => frame.id === frameId)) {
    throw new Error("Debug frame is not available");
  }

  if (active.runtime === "python") {
    const result = await active.dap.request("evaluate", {
      frameId: Number(frameId),
      expression: normalizedExpression,
      context: "watch",
    });
    return {
      result: String(result?.result ?? ""),
      type: result?.type ? String(result.type) : undefined,
      variablesReference: Number(result?.variablesReference || 0),
      namedVariables: Number.isInteger(result?.namedVariables) ? result.namedVariables : undefined,
      indexedVariables: Number.isInteger(result?.indexedVariables) ? result.indexedVariables : undefined,
    };
  }

  if (!active.callFrames.has(frameId)) throw new Error("Debug frame is no longer available");
  const response = await sendInspector(active, "Debugger.evaluateOnCallFrame", {
    callFrameId: frameId,
    expression: normalizedExpression,
    objectGroup: "crownforge-debug",
    includeCommandLineAPI: true,
    silent: false,
    returnByValue: false,
    generatePreview: true,
  });
  if (response?.exceptionDetails) {
    const detail = response.exceptionDetails.exception?.description
      || response.exceptionDetails.text
      || "Expression evaluation failed";
    throw new Error(String(detail));
  }
  const remote = response?.result;
  return {
    result: nodeRemoteValue(remote),
    type: nodeRemoteType(remote),
    variablesReference: nodeVariableReference(active, remote?.objectId),
    namedVariables: Number.isInteger(remote?.preview?.properties?.length)
      ? remote.preview.properties.length
      : undefined,
  };
}

export async function debugCommand(workspaceDir: string, action: "continue" | "step_over" | "step_into" | "step_out"): Promise<DebugSessionState> {
  const active = requirePausedSession(workspaceDir);
  const pauseVersion = active.pauseVersion;
  if (active.runtime === "python") {
    const commands = {
      continue: "continue",
      step_over: "next",
      step_into: "stepIn",
      step_out: "stepOut",
    } as const;
    const threadId = active.threadId;
    if (!threadId) throw new Error("debugpy did not provide a paused thread");
    active.state.status = "running";
    clearPausedData(active);
    active.state.updatedAt = Date.now();
    try {
      await active.dap.request(commands[action], {
        threadId,
        ...(action === "continue" ? {} : { singleThread: false }),
      });
      if (action !== "continue") await waitForNextPause(active, pauseVersion);
      return publicState(active)!;
    } catch (error) {
      active.state.error = error instanceof Error ? error.message : String(error);
      active.state.updatedAt = Date.now();
      throw error;
    }
  }
  const methods = { continue: "Debugger.resume", step_over: "Debugger.stepOver", step_into: "Debugger.stepInto", step_out: "Debugger.stepOut" } as const;
  active.state.status = "running";
  clearPausedData(active);
  active.state.updatedAt = Date.now();
  await sendInspector(active, methods[action]);
  if (action !== "continue") await waitForNextPause(active, pauseVersion);
  return publicState(active)!;
}

export async function stopDebugSession(workspaceDir: string): Promise<DebugSessionState> {
  const active = sessions.get(canonicalWorkspaceRoot(workspaceDir));
  if (!active) throw new Error("No debug session exists");
  if (active.runtime === "node") {
    active.inspector?.close();
  } else {
    active.stopping = true;
    const command = active.capabilities.supportsTerminateRequest ? "terminate" : "disconnect";
    try {
      await active.dap.request(
        command,
        command === "disconnect" ? { restart: false, terminateDebuggee: true } : {},
        3_000
      );
    } catch {
      // The process group termination below is the final fallback.
    }
    active.dap.dispose();
  }
  stopChild(active);
  active.state.status = "stopped";
  clearPausedData(active);
  active.state.updatedAt = Date.now();
  return publicState(active)!;
}
