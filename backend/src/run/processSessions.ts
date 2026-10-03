import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { discoverRunTasks, resolveRunTaskExecution } from "./service.js";
import { prepareWorkspaceProcess, type WorkspaceFilesystemGrant, type ProcessResourceLimits } from "../agent/processSandbox.js";
import { defaultAgentShellLimits } from "../agent/shell.js";
import { usesNativeWindowsAgent } from "../agent/windowsShell.js";
import { safePath } from "../utils/safePath.js";
import { consumeNetworkExecutionGrant, type NetworkExecutionGrant } from "../agent/networkAccess.js";
import { nodeRuntimeEnvironment } from "../utils/nodeRuntime.js";

export type ProcessSessionStatus = "running" | "exited" | "failed" | "cancelled" | "timed_out" | "interrupted";
export interface ProcessSessionSummary { id: string; taskId: string; label: string; status: ProcessSessionStatus; startedAt: number; endedAt?: number; timeoutMs?: number; deadlineAt?: number; exitCode: number | null; nextCursor: number; runId?: string; invocation?: { executable: string; args: string[] }; }
export interface ProcessOutputEvent { seq: number; stream: "stdout" | "stderr"; text: string; }
export interface ProcessSessionOwner { workspaceDir: string; owner: string; sessionToken?: string; runId?: string; }
interface StoredSession extends ProcessSessionSummary { ownerHash: string; workspaceDir: string; events: ProcessOutputEvent[]; }
interface LiveSession { record: StoredSession; child: ChildProcess; cleanup: () => void; cancel?: () => void; timer: NodeJS.Timeout; force?: NodeJS.Timeout; save?: NodeJS.Timeout; signal?: AbortSignal; abort?: () => void; token?: string; requestedStatus?: ProcessSessionStatus; stdinError?: Error; }
const active = new Map<string, LiveSession>();
/** Execution-environment changes apply only after managed Agent jobs finish. */
export function hasRunningAgentProcessSessions(): boolean {
  return [...active.values()].some((session) => session.record.taskId === "agent:command");
}
const MAX_LOG_CHARS = 128_000;
const MAX_EVENTS = 1024;
const MAX_SESSIONS = 40;
// A trusted IPC watchdog owns the process group. It kills ordinary descendants
// if the backend disappears, including a hard crash before shutdown hooks run.
const PROCESS_WATCHDOG = `
const fs=require("node:fs");
const path=require("node:path");
const {spawn,spawnSync}=require("node:child_process");
const [nodeRuntime,parentPidValue,executable,...args]=process.argv.slice(1);
const parentPid=Number(parentPidValue)||process.ppid;
const diagnosticsEnabled=process.env.CROWNFORGE_WATCHDOG_DIAGNOSTICS==="1";
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
if(nodeRuntime==="node")env.ELECTRON_RUN_AS_NODE="1";
if(process.connected===false)process.exit(1);
const child=spawn(executable,args,{env,stdio:["pipe","pipe","pipe"],shell:false,windowsHide:true});
const diagnosticDir=()=>path.join(process.cwd(),".history","process-sessions");
const writeDiagnostic=(name,value)=>{if(!diagnosticsEnabled)return;try{const dir=diagnosticDir();fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,name),JSON.stringify(value),{mode:0o600})}catch{}};
const marker=(event,value={})=>writeDiagnostic(\`watchdog-\${event}-\${process.pid}.json\`,{event,watchdogPid:process.pid,parentPid,childPid:child.pid,platform:process.platform,cwd:process.cwd(),...value});
marker("started",{executable,args:args.slice(0,8)});
const diagnostic=(pid,result)=>writeDiagnostic(\`watchdog-taskkill-\${process.pid}-\${pid}.json\`,{watchdogPid:process.pid,parentPid,targetPid:pid,status:result.status,signal:result.signal,error:result.error?{code:result.error.code,message:result.error.message}:undefined,stdout:String(result.stdout||"").slice(-4096),stderr:String(result.stderr||"").slice(-4096)});
const taskkill=(pid)=>{try{const systemRoot=process.env.SystemRoot||process.env.WINDIR||"C:\\\\Windows";if(!/^[A-Za-z]:[\\\\/]/.test(systemRoot)||systemRoot.includes("\\0"))throw new Error("Invalid Windows system directory");const command=path.win32.join(systemRoot,"System32","taskkill.exe");const result=spawnSync(command,["/pid",String(pid),"/T","/F"],{stdio:["ignore","pipe","pipe"],encoding:"utf8",windowsHide:true,timeout:15000});diagnostic(pid,result)}catch{}finally{process.exit(1)}};
let cleaning=false;
const kill=(reason)=>{if(cleaning)return;cleaning=true;try{if(process.platform==="win32"){writeDiagnostic(\`watchdog-parent-\${process.pid}.json\`,{watchdogPid:process.pid,parentPid,childPid:child.pid,reason});if(child.pid)taskkill(child.pid);else process.exit(1)}else process.kill(-process.pid,"SIGKILL")}catch{process.exit(1)}};
process.on("exit",code=>marker("exit",{code}));
process.on("disconnect",kill);
process.on("message",message=>{if(message&&message.type==="stop")kill("stop-request")});
process.on("SIGTERM",()=>{if(process.platform==="win32")kill();else{try{child.kill("SIGTERM")}catch{};setTimeout(kill,1200).unref()}});
process.on("SIGINT",()=>{if(process.platform==="win32")kill();else{try{child.kill("SIGINT")}catch{};setTimeout(kill,1200).unref()}});
if(process.platform==="win32"){let firstPoll=true;const timer=setInterval(()=>{try{process.kill(parentPid,0);if(firstPoll){firstPoll=false;marker("parent-poll",{result:"alive"})}}catch(error){marker("parent-poll-error",{code:error&&error.code,message:error&&error.message});if(error&&error.code==="ESRCH")kill("parent-esrch")}},250);timer.unref()}
process.stdin.on("error",()=>{});process.stdout.on("error",()=>{});process.stderr.on("error",()=>{});
process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
child.stdin.on("error",()=>{});child.stdout.on("error",()=>{});child.stderr.on("error",()=>{});child.once("error",error=>{marker("child-error",{message:error.message,code:error.code});try{console.error(error.message)}catch{}});
child.once("exit",(code,signal)=>marker("child-exit",{code,signal}));
child.once("close",code=>{marker("child-close",{code});process.exit(code===null?1:code)});
`;
const ownerHash = (owner: string) => crypto.createHash("sha256").update(owner).digest("hex");
const summary = ({ ownerHash: _owner, workspaceDir: _workspace, events: _events, ...record }: StoredSession): ProcessSessionSummary => ({ ...record });
export function windowsProcessTreeKillInvocation(pid: number): { executable: string; args: string[] } {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid process tree pid");
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  if (!/^[A-Za-z]:[\\/]/.test(systemRoot) || systemRoot.includes("\0")) throw new Error("Invalid Windows system directory");
  return { executable: path.win32.join(systemRoot, "System32", "taskkill.exe"), args: ["/pid", String(pid), "/T", "/F"] };
}
function killWindowsProcessTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    const invocation = windowsProcessTreeKillInvocation(pid);
    const killer = spawn(invocation.executable, invocation.args, { stdio: "ignore", windowsHide: true });
    killer.once("error", () => { /* taskkill may be unavailable or the process may have exited. */ });
  } catch { /* exited or invalid */ }
}
function requestWindowsSupervisorStop(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (child.connected) child.send({ type: "stop" }, (error) => {
      if (error && child.exitCode === null && child.signalCode === null) killWindowsProcessTree(child.pid);
    });
    else killWindowsProcessTree(child.pid);
  } catch { killWindowsProcessTree(child.pid); }
}
function watchdogEnvironment(environment: Readonly<Record<string, string>>): Record<string, string> {
  const result = nodeRuntimeEnvironment(environment);
  if (process.env.CROWNFORGE_WATCHDOG_DIAGNOSTICS === "1") result.CROWNFORGE_WATCHDOG_DIAGNOSTICS = "1";
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "WINDIR", "PATHEXT"] as const) {
      const value = process.env[key];
      if (value) result[key] = value;
    }
  }
  return result;
}
function storage(workspace: string, id?: string): string {
  if (id !== undefined && !/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid process session id");
  const relative = `.history/process-sessions${id ? `/${id}.json` : ""}`;
  const target = safePath(relative, workspace);
  let cursor = path.resolve(workspace);
  for (const part of relative.split("/")) {
    cursor = path.join(cursor, part);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("Unsafe process session storage"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; break; }
  }
  return target;
}
function persist(record: StoredSession): void {
  const target = storage(record.workspaceDir, record.id);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, target);
}
function owned(owner: ProcessSessionOwner, id: string): StoredSession {
  const live = active.get(id);
  let record: StoredSession;
  if (live) record = live.record;
  else {
    const target = storage(owner.workspaceDir, id);
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile() || stat.size > 1_000_000) throw new Error("Invalid session metadata");
      record = JSON.parse(fs.readFileSync(target, "utf8"));
    } catch { throw new Error("Process session not found"); }
  }
  if (record.id !== id || record.workspaceDir !== fs.realpathSync(path.resolve(owner.workspaceDir)) || record.ownerHash !== ownerHash(owner.owner) || (owner.runId && record.runId !== owner.runId)) throw new Error("Process session not found");
  if (!live && record.status === "running") { record.status = "interrupted"; record.endedAt = Date.now(); persist(record); }
  return record;
}
export function listProcessSessions(owner: ProcessSessionOwner): ProcessSessionSummary[] {
  const directory = storage(owner.workspaceDir);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)).flatMap((name) => {
    try { return [summary(owned(owner, name.slice(0, -5)))]; } catch { return []; }
  }).sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_SESSIONS);
}
export function pollProcessSession(owner: ProcessSessionOwner, id: string, cursor = 0): { session: ProcessSessionSummary; events: ProcessOutputEvent[]; nextCursor: number; truncated: boolean } {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid output cursor");
  const record = owned(owner, id);
  return { session: summary(record), events: record.events.filter((event) => event.seq > cursor), nextCursor: record.nextCursor, truncated: cursor < (record.events[0]?.seq ?? 1) - 1 };
}
function signalGroup(live: LiveSession, signal: NodeJS.Signals): void {
  if (!live.child.pid || process.platform === "win32" && (live.child.exitCode !== null || live.child.signalCode !== null)) return;
  try {
    if (process.platform === "win32" && signal === "SIGTERM" && live.child.connected) {
      // A queued IPC request is handled after watchdog startup has registered
      // its actual payload PID. Killing the watchdog directly can race /T's
      // process snapshot against that payload's creation.
      requestWindowsSupervisorStop(live.child);
    } else if (process.platform === "win32") killWindowsProcessTree(live.child.pid);
    else process.kill(-live.child.pid, signal);
  } catch { if (process.platform === "win32") killWindowsProcessTree(live.child.pid); }
}
function terminate(live: LiveSession, status: ProcessSessionStatus): void {
  if (live.requestedStatus) return;
  live.requestedStatus = status;
  // Also revoke the Linux lease; killing wsl.exe alone cannot prove that its
  // Linux process tree has stopped.
  try { if (live.cancel) live.cancel(); else live.cleanup(); }
  catch { /* A failed lease marker must not prevent process-tree termination. */ }
  signalGroup(live, "SIGTERM");
  // The Windows watchdog owns a bounded synchronous taskkill (15 seconds).
  // Do not kill that supervisor while it is still reaping its payload tree.
  live.force = setTimeout(() => signalGroup(live, "SIGKILL"), process.platform === "win32" ? 17_000 : 1500); live.force.unref();
}
export function stopProcessSession(owner: ProcessSessionOwner, id: string): ProcessSessionSummary {
  const record = owned(owner, id);
  const live = active.get(id);
  if (live) terminate(live, "cancelled");
  return summary(record);
}
function closedInputError(error: unknown): boolean {
  return ["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END", "ERR_STREAM_PREMATURE_CLOSE"].includes((error as NodeJS.ErrnoException | undefined)?.code || "");
}
function inputFailure(error: unknown): unknown {
  return closedInputError(error) ? new Error("Process session is not accepting input", { cause: error }) : error;
}
export async function inputProcessSession(owner: ProcessSessionOwner, id: string, text = "", eof = false): Promise<ProcessSessionSummary> {
  const record = owned(owner, id);
  const live = active.get(id);
  if (live?.stdinError) throw inputFailure(live.stdinError);
  const stdin = live?.child.stdin;
  if (!live || record.status !== "running" || live.requestedStatus || !stdin?.writable || stdin.destroyed || stdin.writableEnded || live.child.exitCode !== null || live.child.signalCode !== null) throw new Error("Process session is not accepting input");
  if (typeof text !== "string" || Buffer.byteLength(text) > 16_384 || typeof eof !== "boolean") throw new Error("Invalid process input");
  try {
    if (text) await new Promise<void>((resolve, reject) => stdin.write(text, (error) => error ? reject(error) : resolve()));
    if (eof) await new Promise<void>((resolve, reject) => stdin.end((error?: Error | null) => error ? reject(error) : resolve()));
  } catch (error) { throw inputFailure(error); }
  return summary(record);
}
interface StartOptions extends ProcessSessionOwner {
  taskId: string; label: string; executable: string; args: string[]; timeoutMs?: number;
  launchExecutable?: string; launchArgs?: string[];
  agent?: boolean; filesystem?: WorkspaceFilesystemGrant; limits?: ProcessResourceLimits;
  runId?: string; signal?: AbortSignal; onOutput?: (event: ProcessOutputEvent) => void; onExit?: () => void;
  privateInvocation?: boolean;
  /** Trusted launch state, never accepted by HTTP or model tool arguments. */
  networkAuthorized?: boolean;
  /** Internal fixed Node payload only; never supplied by project tasks or Agent tools. */
  nodeRuntime?: boolean;
}
function startManagedSession(input: StartOptions): ProcessSessionSummary {
  const workspaceDir = fs.realpathSync(path.resolve(input.workspaceDir));
  if (!input.owner || input.owner.length > 500) throw new Error("A process owner is required");
  const timeoutMs = input.timeoutMs ?? 10 * 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 24 * 60 * 60_000) throw new Error("Invalid process timeout");
  if ([...active.values()].filter((item) => item.record.ownerHash === ownerHash(input.owner)).length >= 8) throw new Error("Too many active process sessions");
  if (input.signal?.aborted) throw new Error("Process request was cancelled");
  if (input.nodeRuntime && input.executable !== process.execPath) throw new Error("Internal Node sessions must use the backend executable");
  const prepared = prepareWorkspaceProcess({
    executable: input.launchExecutable || input.executable, args: input.launchArgs || input.args, cwd: workspaceDir, signal: input.signal,
    limits: { ...(input.agent ? defaultAgentShellLimits() : {}), ...input.limits, wallTimeMs: timeoutMs },
    resourceLimitMode: "posix-shell", networkMode: input.agent && !input.networkAuthorized ? "deny" : "inherit",
    ...(input.agent ? { filesystem: input.filesystem || { workspaceDir, readPaths: ["."], writePaths: ["."] } } : {}),
    env: { NO_COLOR: "1", FORCE_COLOR: "0", CI: "1", NPM_CONFIG_USERCONFIG: process.platform === "win32" && (!input.agent || usesNativeWindowsAgent()) ? "NUL" : "/dev/null" },
  });
  const startedAt = Date.now();
  const record: StoredSession = { id: crypto.randomUUID(), taskId: input.taskId, label: input.label.slice(0, 200), status: "running", startedAt, timeoutMs, deadlineAt: startedAt + timeoutMs, exitCode: null, nextCursor: 0, workspaceDir, ownerHash: ownerHash(input.owner), events: [], ...(input.runId ? { runId: input.runId } : {}) };
  if (!input.privateInvocation) record.invocation = { executable: input.executable, args: [...input.args] };
  try { persist(record); } catch (error) { prepared.cleanup(); throw error; }
  let child: ChildProcess | undefined;
  // On Windows libuv kills non-detached direct children with the parent's Job
  // Object. The watchdog must outlive that parent to clean its whole subtree.
  try {
    child = spawn(process.execPath, ["-e", PROCESS_WATCHDOG, input.nodeRuntime && process.versions.electron ? "node" : "task", String(process.pid), prepared.executable, ...prepared.args], { cwd: workspaceDir, env: watchdogEnvironment(prepared.env), shell: false, detached: true, stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true });
    if (child.pid) prepared.onSpawn?.(child.pid);
  } catch (error) {
    if (child?.pid) {
      try { prepared.cancel?.(); } catch { /* Preserve cleanup and termination when a lease write fails. */ }
      const startedChild = child;
      let force: NodeJS.Timeout | undefined;
      child.once("close", () => { if (force) clearTimeout(force); prepared.cleanup(); });
      try {
        if (process.platform === "win32") {
          requestWindowsSupervisorStop(startedChild);
          force = setTimeout(() => {
            if (startedChild.exitCode === null && startedChild.signalCode === null) killWindowsProcessTree(startedChild.pid);
          }, 17_000); force.unref();
        } else process.kill(-child.pid, "SIGKILL");
      } catch { /* Already closed. */ }
    } else prepared.cleanup();
    record.status = "failed"; record.endedAt = Date.now(); persist(record); throw error;
  }
  const live: LiveSession = { record, child, cleanup: prepared.cleanup, cancel: prepared.cancel, timer: setTimeout(() => terminate(live, "timed_out"), Math.max(0, record.deadlineAt! - Date.now())), signal: input.signal, token: input.sessionToken };
  live.timer.unref(); active.set(record.id, live);
  const append = (stream: ProcessOutputEvent["stream"], text: string) => {
    if (!text) return;
    const event = { seq: ++record.nextCursor, stream, text: text.slice(-MAX_LOG_CHARS) };
    record.events.push(event);
    let length = record.events.reduce((count, item) => count + item.text.length, 0);
    while (record.events.length > MAX_EVENTS || (length > MAX_LOG_CHARS && record.events.length > 1)) length -= record.events.shift()!.text.length;
    try { input.onOutput?.(event); } catch { terminate(live, "failed"); }
    if (!live.save) { live.save = setTimeout(() => { live.save = undefined; try { persist(record); } catch { terminate(live, "failed"); } }, 250); live.save.unref(); }
  };
  const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  // A failed write also emits an error event. Keep a listener for the complete
  // stream lifetime so an exit race cannot become an uncaught backend error.
  child.stdin?.on("error", (error) => {
    live.stdinError = error;
    if (!closedInputError(error)) { append("stderr", error.message); terminate(live, "failed"); }
  });
  child.stdout?.on("data", (chunk: Buffer) => append("stdout", decoders.stdout.write(chunk)));
  child.stderr?.on("data", (chunk: Buffer) => append("stderr", decoders.stderr.write(chunk)));
  child.once("error", (error) => append("stderr", error.message));
  live.abort = () => terminate(live, "cancelled"); input.signal?.addEventListener("abort", live.abort, { once: true });
  child.once("close", (code) => {
    append("stdout", decoders.stdout.end()); append("stderr", decoders.stderr.end());
    clearTimeout(live.timer); if (live.save) clearTimeout(live.save);
    // The Windows watchdog has reaped its target tree before close. Never send
    // a delayed taskkill to a released PID that another process can reuse.
    if (process.platform === "win32" && live.force) clearTimeout(live.force);
    record.status = live.requestedStatus || (code === 0 ? "exited" : "failed");
    record.exitCode = code; record.endedAt = Date.now();
    input.signal?.removeEventListener("abort", live.abort!);
    active.delete(record.id); prepared.cleanup();
    try { persist(record); } catch { /* workspace may have been removed during shutdown */ }
    try { input.onExit?.(); } catch { /* Audit callbacks cannot crash process supervision. */ }
  });
  return summary(record);
}
export function startProjectTaskSession(owner: ProcessSessionOwner, taskId: string, timeoutMs?: number): ProcessSessionSummary {
  const task = discoverRunTasks(owner.workspaceDir).find((item) => item.id === taskId);
  if (!task) throw new Error("Unknown or unavailable task");
  const execution = resolveRunTaskExecution(task);
  return startManagedSession({ ...owner, taskId, label: task.label, executable: task.command, args: task.args, launchExecutable: execution.executable, launchArgs: execution.args, timeoutMs, nodeRuntime: false });
}
/** Default network deny; a separately approved, exact-command grant is single-use. */
export function startAgentProcessSession(input: ProcessSessionOwner & { executable: string; args: string[]; runId?: string; timeoutMs?: number; signal?: AbortSignal; filesystem?: WorkspaceFilesystemGrant; limits?: ProcessResourceLimits; onExit?: () => void; networkExecutionGrant?: NetworkExecutionGrant }): ProcessSessionSummary {
  let networkAuthorized = false;
  if (input.networkExecutionGrant) {
    const commandIndex = input.args.findIndex((arg) => arg.toLowerCase() === "-command");
    const shellCommand = ["/bin/sh", "/bin/bash"].includes(input.executable) && input.args.length === 2 && input.args[0] === "-c" ? input.args[1]
      : usesNativeWindowsAgent() && commandIndex === input.args.length - 2 ? input.args[commandIndex + 1] : undefined;
    if (!shellCommand) throw new Error("Network approval is bound to the approved compatibility-shell command");
    consumeNetworkExecutionGrant(input.networkExecutionGrant, input.workspaceDir, shellCommand, "process_start");
    networkAuthorized = true;
  }
  return startManagedSession({ ...input, taskId: "agent:command", label: input.executable, agent: true, networkAuthorized, nodeRuntime: false });
}
/** Internal preview launch: no HTTP route accepts arbitrary executables or arguments. */
export function startPreviewProcessSession(input: ProcessSessionOwner & { executable: string; args: string[]; targetId: string; onOutput: (event: ProcessOutputEvent) => void; onExit: () => void }): ProcessSessionSummary {
  return startManagedSession({ ...input, taskId: input.targetId, label: "Web preview", timeoutMs: 60 * 60_000, privateInvocation: true, nodeRuntime: true });
}
export function stopProcessSessionsForToken(token: string): void { for (const live of active.values()) if (live.token === token) terminate(live, "cancelled"); }
export function shutdownProcessSessions(): void { for (const live of active.values()) { terminate(live, "interrupted"); live.record.status = "interrupted"; live.record.endedAt = Date.now(); try { persist(live.record); } catch { /* shutdown */ } } }
