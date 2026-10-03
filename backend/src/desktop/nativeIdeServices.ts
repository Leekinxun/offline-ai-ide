import path from "node:path";
import crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { TerminalProcess } from "../run/terminalSessions.js";
import { parseGitStatusOutput, scopeGitStatusEntries, type GitStatusSnapshot } from "../files/gitStatus.js";
import { getDesktopNativeIde, NativeIdeError, type NativeIdeEvent } from "./nativeIdeClient.js";

interface NativeEntry { name: string; isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean; }
interface FileNode { name: string; path: string; type: "file" | "directory"; children?: FileNode[]; }

export async function readDesktopFileTree(workspaceDir: string): Promise<FileNode[]> {
  const client = getDesktopNativeIde();
  let visited = 0;
  async function visit(relative: string, depth: number): Promise<FileNode[]> {
    if (depth > 64) throw new NativeIdeError("Workspace tree depth limit exceeded", "LIMIT_EXCEEDED");
    const entries = await client.request<NativeEntry[]>("fs.entries", { workspaceDir, path: relative });
    const visible = entries.filter((item) => !item.name.startsWith(".") && !item.isSymbolicLink);
    visible.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    const result: FileNode[] = [];
    for (const item of visible) {
      if (++visited > 250_000) throw new NativeIdeError("Workspace tree entry limit exceeded", "LIMIT_EXCEEDED");
      const entryPath = relative ? `${relative}/${item.name}` : item.name;
      if (item.isDirectory) result.push({ name: item.name, path: entryPath, type: "directory", children: await visit(entryPath, depth + 1) });
      else if (item.isFile) result.push({ name: item.name, path: entryPath, type: "file" });
    }
    return result;
  }
  return visit("", 0);
}

export function readDesktopFile(workspaceDir: string, relativePath: string): Promise<{ content: string; mtimeMs: number }> {
  return getDesktopNativeIde().request("fs.read", { workspaceDir, path: relativePath });
}

export async function readDesktopGitStatus(workspaceDir: string): Promise<GitStatusSnapshot> {
  const client = getDesktopNativeIde();
  const execute = async (args: string[]) => {
    const result = await client.request<{ stdout: string; stderr: string; exitCode: number }>("git.exec", { workspaceDir, args });
    if (result.exitCode !== 0) throw new NativeIdeError("Git status is unavailable", result.stderr.includes("not a git repository") ? "NOT_REPO" : "GIT_FAILED");
    return result.stdout;
  };
  const prefix = (await execute(["rev-parse", "--show-prefix"])).trim().replace(/\/$/, "");
  const source = await execute(["-c", "core.quotepath=false", "status", "--porcelain=v2", "--branch", "-z", "-uall", "--", "."]);
  const parsed = parseGitStatusOutput(source);
  return { isRepo: true, ...parsed, entries: scopeGitStatusEntries(parsed.entries, prefix), updatedAt: Date.now() };
}

/** The existing session manager still owns leases, reconnects, replay and authorization. */
export function launchDesktopPty(workspaceDir: string, command: { executable: string; args: string[] }, env: Record<string, string>): TerminalProcess {
  const client = getDesktopNativeIde();
  const decoder = new StringDecoder("utf8");
  const nativeId = crypto.randomUUID();
  let pid = 0;
  let terminated = false;
  let exited = false;
  let outputBytes = 0;
  const output: string[] = [];
  let dataListener: ((data: string) => void) | undefined;
  let exitListener: ((code: number | null, signal?: number | string) => void) | undefined;
  let exitCode: number | null = null;
  let signal: string | undefined;
  const deliver = (data: string) => {
    if (!data) return;
    if (dataListener) dataListener(data);
    else {
      outputBytes += Buffer.byteLength(data);
      if (outputBytes > 131_072) { finish(null, "output_overflow"); void stop(); return; }
      output.push(data);
    }
  };
  const finish = (code: number | null, reason?: string) => {
    if (exited) return;
    exited = true; exitCode = code; signal = reason;
    deliver(decoder.end()); unsubscribe(); disconnect();
    exitListener?.(exitCode, signal);
  };
  const consume = (event: NativeIdeEvent) => {
    if (exited || event.params.sessionId !== nativeId) return;
    if (event.event === "pty.output" && typeof event.params.data === "string") deliver(decoder.write(Buffer.from(event.params.data, "base64")));
    else if (event.event === "pty.exit") finish(typeof event.params.exitCode === "number" ? event.params.exitCode : null);
  };
  const unsubscribe = client.onEvent((event) => {
    if (!event.event.startsWith("pty.")) return;
    consume(event);
  });
  const disconnect = client.onDisconnect(() => finish(null, "runtime_disconnected"));
  const started = client.request<{ sessionId: string; pid: number }>("pty.spawn", { sessionId: nativeId, workspaceDir, executable: command.executable, args: command.args, env, cols: 80, rows: 24 }).then(async (value) => {
    if (value.sessionId !== nativeId) throw new NativeIdeError("Native PTY identity mismatch", "PROTOCOL_ERROR");
    pid = value.pid;
    if (terminated) { await stop(); return; }
  });
  const stop = async () => { if (nativeId) await client.request("pty.kill", { sessionId: nativeId }).catch(() => {}); };
  void started.catch(() => finish(null, "spawn_error"));
  let writes = Promise.resolve();
  return {
    get pid() { return pid; },
    write(data) {
      if (terminated || exited) return;
      writes = writes.then(() => started).then(async () => {
        if (!terminated && !exited) await client.request("pty.write", { sessionId: nativeId, data: Buffer.from(data).toString("base64") });
      }).catch(() => finish(null, "input_error"));
    },
    resize(cols, rows) {
      if (terminated || exited) return;
      void started.then(() => client.request("pty.resize", { sessionId: nativeId, cols, rows })).catch(() => finish(null, "resize_error"));
    },
    terminate() { terminated = true; void started.then(stop).catch(() => {}); },
    onData(listener) { dataListener = listener; for (const data of output.splice(0)) listener(data); outputBytes = 0; },
    onExit(listener) { exitListener = listener; if (exited) listener(exitCode, signal); },
  };
}

export async function watchDesktopWorkspace(workspaceDir: string, changed: () => void, failed?: (error: Error) => void): Promise<() => void> {
  const client = getDesktopNativeIde();
  const watchId = crypto.randomUUID();
  const ignored = new Set([".git", ".history", ".checkpoints", ".team", ".tasks", ".codex", ".omx", ".crewforge", ".transcripts", "node_modules", "dist", "build", "target", ".venv", "__pycache__"]);
  const unsubscribe = client.onEvent((event) => {
    if (event.event !== "fs.changed") return;
    if (event.params.watchId !== watchId) return;
    const paths = Array.isArray(event.params.paths) ? event.params.paths : [];
    if (event.params.overflow || paths.some((value) => typeof value === "string" && !value.split(/[\\/]/).some((part) => ignored.has(part)) && (!path.extname(value) || [".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".json", ".toml"].includes(path.extname(value).toLowerCase())))) changed();
  });
  const disconnect = client.onDisconnect((error) => { unsubscribe(); failed?.(error); });
  try {
    const result = await client.request<{ watchId: string }>("watch.start", { workspaceDir, watchId });
    if (result.watchId !== watchId) throw new NativeIdeError("Native watcher identity mismatch", "PROTOCOL_ERROR");
    return () => { unsubscribe(); disconnect(); void client.request("watch.stop", { watchId }).catch(() => {}); };
  } catch (error) { unsubscribe(); disconnect(); throw error; }
}
