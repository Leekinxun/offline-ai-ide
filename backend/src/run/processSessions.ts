import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { discoverRunTasks } from "./service.js";
import { prepareWorkspaceProcess, type WorkspaceFilesystemGrant, type ProcessResourceLimits } from "../agent/processSandbox.js";
import { DEFAULT_COMPATIBILITY_SHELL_LIMITS } from "../agent/shell.js";
import { safePath } from "../utils/safePath.js";
import { consumeNetworkExecutionGrant, type NetworkExecutionGrant } from "../agent/networkAccess.js";

export type ProcessSessionStatus = "running" | "exited" | "failed" | "cancelled" | "timed_out" | "interrupted";
export interface ProcessSessionSummary { id: string; taskId: string; label: string; status: ProcessSessionStatus; startedAt: number; endedAt?: number; exitCode: number | null; nextCursor: number; runId?: string; invocation?: { executable: string; args: string[] }; }
export interface ProcessOutputEvent { seq: number; stream: "stdout" | "stderr"; text: string; }
export interface ProcessSessionOwner { workspaceDir: string; owner: string; sessionToken?: string; runId?: string; }
interface StoredSession extends ProcessSessionSummary { ownerHash: string; workspaceDir: string; events: ProcessOutputEvent[]; }
interface LiveSession { record: StoredSession; child: ChildProcess; cleanup: () => void; timer: NodeJS.Timeout; force?: NodeJS.Timeout; save?: NodeJS.Timeout; signal?: AbortSignal; abort?: () => void; token?: string; requestedStatus?: ProcessSessionStatus; }
const active = new Map<string, LiveSession>();
const MAX_LOG_CHARS = 128_000;
const MAX_EVENTS = 1024;
const MAX_SESSIONS = 40;
// A trusted IPC watchdog owns the process group. It kills ordinary descendants
// if the backend disappears, including a hard crash before shutdown hooks run.
const PROCESS_WATCHDOG = `
const {spawn}=require("node:child_process");
const [executable,...args]=process.argv.slice(1);
const child=spawn(executable,args,{stdio:["pipe","pipe","pipe"],shell:false,windowsHide:true});
const kill=()=>{try{if(process.platform==="win32")child.kill("SIGKILL");else process.kill(-process.pid,"SIGKILL")}catch{process.exit(1)}};
process.on("disconnect",kill);
process.on("SIGTERM",()=>{try{child.kill("SIGTERM")}catch{};setTimeout(kill,1200).unref()});
process.on("SIGINT",()=>{try{child.kill("SIGINT")}catch{};setTimeout(kill,1200).unref()});
process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
child.stdin.on("error",()=>{});child.once("error",error=>{console.error(error.message)});
child.once("close",code=>process.exit(code===null?1:code));
`;
const ownerHash = (owner: string) => crypto.createHash("sha256").update(owner).digest("hex");
const summary = ({ ownerHash: _owner, workspaceDir: _workspace, events: _events, ...record }: StoredSession): ProcessSessionSummary => ({ ...record });
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
  if (!live.child.pid) return;
  try { if (process.platform === "win32") live.child.kill(signal); else process.kill(-live.child.pid, signal); } catch { /* exited */ }
}
function terminate(live: LiveSession, status: ProcessSessionStatus): void {
  if (live.requestedStatus) return;
  live.requestedStatus = status;
  signalGroup(live, "SIGTERM");
  live.force = setTimeout(() => signalGroup(live, "SIGKILL"), 1500); live.force.unref();
}
export function stopProcessSession(owner: ProcessSessionOwner, id: string): ProcessSessionSummary {
  const record = owned(owner, id);
  const live = active.get(id);
  if (live) terminate(live, "cancelled");
  return summary(record);
}
export async function inputProcessSession(owner: ProcessSessionOwner, id: string, text = "", eof = false): Promise<ProcessSessionSummary> {
  const record = owned(owner, id);
  const live = active.get(id);
  if (!live || record.status !== "running" || live.requestedStatus || !live.child.stdin?.writable) throw new Error("Process session is not accepting input");
  if (typeof text !== "string" || Buffer.byteLength(text) > 16_384 || typeof eof !== "boolean") throw new Error("Invalid process input");
  if (text) await new Promise<void>((resolve, reject) => live.child.stdin!.write(text, (error) => error ? reject(error) : resolve()));
  if (eof) live.child.stdin.end();
  return summary(record);
}
interface StartOptions extends ProcessSessionOwner {
  taskId: string; label: string; executable: string; args: string[]; timeoutMs?: number;
  agent?: boolean; filesystem?: WorkspaceFilesystemGrant; limits?: ProcessResourceLimits;
  runId?: string; signal?: AbortSignal; onOutput?: (event: ProcessOutputEvent) => void; onExit?: () => void;
  privateInvocation?: boolean;
  /** Trusted launch state, never accepted by HTTP or model tool arguments. */
  networkAuthorized?: boolean;
}
function startManagedSession(input: StartOptions): ProcessSessionSummary {
  const workspaceDir = fs.realpathSync(path.resolve(input.workspaceDir));
  if (!input.owner || input.owner.length > 500) throw new Error("A process owner is required");
  const timeoutMs = input.timeoutMs ?? 10 * 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 24 * 60 * 60_000) throw new Error("Invalid process timeout");
  if ([...active.values()].filter((item) => item.record.ownerHash === ownerHash(input.owner)).length >= 8) throw new Error("Too many active process sessions");
  if (input.signal?.aborted) throw new Error("Process request was cancelled");
  const prepared = prepareWorkspaceProcess({
    executable: input.executable, args: input.args, cwd: workspaceDir, signal: input.signal,
    limits: { ...(input.agent ? DEFAULT_COMPATIBILITY_SHELL_LIMITS : {}), ...input.limits, wallTimeMs: timeoutMs },
    resourceLimitMode: "posix-shell", networkMode: input.agent && !input.networkAuthorized ? "deny" : "inherit",
    ...(input.agent ? { filesystem: input.filesystem || { workspaceDir, readPaths: ["."], writePaths: ["."] } } : {}),
    env: { NO_COLOR: "1", FORCE_COLOR: "0", CI: "1", NPM_CONFIG_USERCONFIG: process.platform === "win32" ? "NUL" : "/dev/null" },
  });
  const record: StoredSession = { id: crypto.randomUUID(), taskId: input.taskId, label: input.label.slice(0, 200), status: "running", startedAt: Date.now(), exitCode: null, nextCursor: 0, workspaceDir, ownerHash: ownerHash(input.owner), events: [], ...(input.runId ? { runId: input.runId } : {}) };
  if (!input.privateInvocation) record.invocation = { executable: input.executable, args: [...input.args] };
  try { persist(record); } catch (error) { prepared.cleanup(); throw error; }
  let child: ChildProcess;
  try { child = spawn(process.execPath, ["-e", PROCESS_WATCHDOG, prepared.executable, ...prepared.args], { cwd: workspaceDir, env: prepared.env, shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true }); }
  catch (error) { prepared.cleanup(); record.status = "failed"; record.endedAt = Date.now(); persist(record); throw error; }
  const live: LiveSession = { record, child, cleanup: prepared.cleanup, timer: setTimeout(() => terminate(live, "timed_out"), timeoutMs), signal: input.signal, token: input.sessionToken };
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
  child.stdout?.on("data", (chunk: Buffer) => append("stdout", decoders.stdout.write(chunk)));
  child.stderr?.on("data", (chunk: Buffer) => append("stderr", decoders.stderr.write(chunk)));
  child.once("error", (error) => append("stderr", error.message));
  live.abort = () => terminate(live, "cancelled"); input.signal?.addEventListener("abort", live.abort, { once: true });
  child.once("close", (code) => {
    append("stdout", decoders.stdout.end()); append("stderr", decoders.stderr.end());
    clearTimeout(live.timer); if (live.save) clearTimeout(live.save);
    // Keep an already scheduled force kill alive for descendants after cancellation.
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
  return startManagedSession({ ...owner, taskId, label: task.label, executable: task.command, args: task.args, timeoutMs });
}
/** Default network deny; a separately approved, exact-command grant is single-use. */
export function startAgentProcessSession(input: ProcessSessionOwner & { executable: string; args: string[]; runId?: string; timeoutMs?: number; signal?: AbortSignal; filesystem?: WorkspaceFilesystemGrant; limits?: ProcessResourceLimits; onExit?: () => void; networkExecutionGrant?: NetworkExecutionGrant }): ProcessSessionSummary {
  let networkAuthorized = false;
  if (input.networkExecutionGrant) {
    const shellCommand = input.executable === "/bin/sh" && input.args.length === 2 && input.args[0] === "-c" ? input.args[1] : undefined;
    if (!shellCommand) throw new Error("Network approval is bound to the approved compatibility-shell command");
    consumeNetworkExecutionGrant(input.networkExecutionGrant, input.workspaceDir, shellCommand, "process_start");
    networkAuthorized = true;
  }
  return startManagedSession({ ...input, taskId: "agent:command", label: input.executable, agent: true, networkAuthorized });
}
/** Internal preview launch: no HTTP route accepts arbitrary executables or arguments. */
export function startPreviewProcessSession(input: ProcessSessionOwner & { executable: string; args: string[]; targetId: string; onOutput: (event: ProcessOutputEvent) => void; onExit: () => void }): ProcessSessionSummary {
  return startManagedSession({ ...input, taskId: input.targetId, label: "Web preview", timeoutMs: 60 * 60_000, privateInvocation: true });
}
export function stopProcessSessionsForToken(token: string): void { for (const live of active.values()) if (live.token === token) terminate(live, "cancelled"); }
export function shutdownProcessSessions(): void { for (const live of active.values()) { terminate(live, "interrupted"); live.record.status = "interrupted"; live.record.endedAt = Date.now(); try { persist(live.record); } catch { /* shutdown */ } } }
