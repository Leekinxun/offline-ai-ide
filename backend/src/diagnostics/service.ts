import fs from "fs";
import path from "path";
import { spawn } from "child_process";

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface WorkspaceDiagnostic {
  path: string;
  line: number;
  column: number;
  severity: DiagnosticSeverity;
  message: string;
  source: string;
  code?: string;
}

export interface DiagnosticsResult {
  diagnostics: WorkspaceDiagnostic[];
  tools: string[];
  startedAt: number;
  durationMs: number;
  session: DiagnosticsSessionState;
}

export interface DiagnosticsSessionState {
  status: "stopped" | "watching" | "running" | "error";
  generation: number;
  startedAt?: number;
  lastRunAt?: number;
  error?: string;
}

const resultCache = new Map<string, DiagnosticsResult>();
interface DiagnosticsSession {
  state: DiagnosticsSessionState;
  signature: string;
  timer: NodeJS.Timeout;
}
const sessions = new Map<string, DiagnosticsSession>();
const inFlight = new Map<string, Promise<DiagnosticsResult>>();

function relativePath(workspaceDir: string, candidate: string): string | null {
  const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(workspaceDir, candidate);
  const relative = path.relative(workspaceDir, absolute).split(path.sep).join("/");
  if (!relative || relative === "." || relative.startsWith("../") || path.isAbsolute(relative)) return null;
  return relative;
}

interface CommandResult { stdout: string; stderr: string; missing: boolean; }

function run(command: string, args: string[], workspaceDir: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (missing = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ stdout: stdout.slice(-8 * 1024 * 1024), stderr: stderr.slice(-8 * 1024 * 1024), missing });
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(false);
    }, 60_000);
    timeout.unref?.();
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ENOENT"));
    child.once("close", () => finish(false));
  });
}

function parseTypeScript(workspaceDir: string, output: string): WorkspaceDiagnostic[] {
  const diagnostics: WorkspaceDiagnostic[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/);
    if (!match) continue;
    const file = relativePath(workspaceDir, match[1]);
    if (!file) continue;
    diagnostics.push({
      path: file,
      line: Number(match[2]),
      column: Number(match[3]),
      severity: match[4] as "error" | "warning",
      code: match[5],
      message: match[6],
      source: "typescript",
    });
  }
  return diagnostics;
}

function parseRuff(workspaceDir: string, output: string): WorkspaceDiagnostic[] {
  try {
    const entries = JSON.parse(output);
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((entry): WorkspaceDiagnostic[] => {
      const file = relativePath(workspaceDir, String(entry.filename || ""));
      if (!file) return [];
      return [{
        path: file,
        line: Number(entry.location?.row || 1),
        column: Number(entry.location?.column || 1),
        severity: "warning",
        code: typeof entry.code === "string" ? entry.code : undefined,
        message: String(entry.message || "Python diagnostic"),
        source: "ruff",
      }];
    });
  } catch {
    return [];
  }
}

function parseCargo(workspaceDir: string, output: string): WorkspaceDiagnostic[] {
  const diagnostics: WorkspaceDiagnostic[] = [];
  for (const line of output.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (event.reason !== "compiler-message" || !event.message) continue;
      const level = event.message.level;
      if (level !== "error" && level !== "warning") continue;
      const primary = Array.isArray(event.message.spans)
        ? event.message.spans.find((span: any) => span.is_primary) || event.message.spans[0]
        : null;
      if (!primary) continue;
      const file = relativePath(workspaceDir, String(primary.file_name || ""));
      if (!file) continue;
      diagnostics.push({
        path: file,
        line: Number(primary.line_start || 1),
        column: Number(primary.column_start || 1),
        severity: level,
        code: event.message.code?.code,
        message: String(event.message.message || "Rust diagnostic"),
        source: "rustc",
      });
    } catch {
      // Cargo can mix non-JSON messages into stderr; ignore those lines.
    }
  }
  return diagnostics;
}

function hasPythonFiles(directory: string, depth = 0): boolean {
  if (depth > 4) return false;
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if ([".git", ".checkpoints", "node_modules", "dist", "build", "target"].includes(entry.name)) continue;
      if (entry.isFile() && entry.name.endsWith(".py")) return true;
      if (entry.isDirectory() && hasPythonFiles(path.join(directory, entry.name), depth + 1)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function stoppedState(): DiagnosticsSessionState {
  return { status: "stopped", generation: 0 };
}

export function getDiagnostics(workspaceDir: string): DiagnosticsResult {
  const cached = resultCache.get(workspaceDir);
  const session = sessions.get(workspaceDir)?.state || stoppedState();
  return cached ? { ...cached, session: { ...session } } : { diagnostics: [], tools: [], startedAt: 0, durationMs: 0, session: { ...session } };
}

async function executeDiagnostics(workspaceDir: string): Promise<DiagnosticsResult> {
  const startedAt = Date.now();
  const diagnostics: WorkspaceDiagnostic[] = [];
  const tools: string[] = [];
  const session = sessions.get(workspaceDir);
  if (session) session.state = { ...session.state, status: "running", error: undefined };
  const localTsc = path.join(workspaceDir, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

  if (fs.existsSync(path.join(workspaceDir, "tsconfig.json")) && fs.existsSync(localTsc)) {
    const result = await run(localTsc, ["--noEmit", "--pretty", "false"], workspaceDir);
    diagnostics.push(...parseTypeScript(workspaceDir, `${result.stdout}\n${result.stderr}`));
    tools.push("typescript");
  }
  if (hasPythonFiles(workspaceDir)) {
    const result = await run("ruff", ["check", "--output-format=json", "."], workspaceDir);
    if (!result.missing) {
      diagnostics.push(...parseRuff(workspaceDir, result.stdout));
      tools.push("ruff");
    }
  }
  if (fs.existsSync(path.join(workspaceDir, "Cargo.toml"))) {
    const result = await run("cargo", ["check", "--message-format=json"], workspaceDir);
    if (!result.missing) {
      diagnostics.push(...parseCargo(workspaceDir, result.stdout));
      tools.push("cargo");
    }
  }

  if (session) {
    session.state = {
      ...session.state,
      status: "watching",
      generation: session.state.generation + 1,
      lastRunAt: Date.now(),
      error: undefined,
    };
  }
  const next = { diagnostics: diagnostics.slice(0, 2_000), tools, startedAt, durationMs: Date.now() - startedAt, session: { ...(session?.state || stoppedState()) } };
  resultCache.set(workspaceDir, next);
  return next;
}

export function runDiagnostics(workspaceDir: string): Promise<DiagnosticsResult> {
  const active = inFlight.get(workspaceDir);
  if (active) return active;
  const execution = executeDiagnostics(workspaceDir)
    .catch((error) => {
      const session = sessions.get(workspaceDir);
      if (session) session.state = { ...session.state, status: "error", error: error instanceof Error ? error.message : String(error) };
      throw error;
    })
    .finally(() => inFlight.delete(workspaceDir));
  inFlight.set(workspaceDir, execution);
  return execution;
}

const WATCH_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".json", ".toml"]);
const WATCH_IGNORED = new Set([".git", ".checkpoints", "node_modules", "dist", "build", "target", ".venv"]);

function workspaceSignature(workspaceDir: string): string {
  let count = 0;
  let fingerprint = 2166136261;
  const visit = (directory: string, depth: number) => {
    if (depth > 10 || count >= 5_000) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (count >= 5_000 || WATCH_IGNORED.has(entry.name)) break;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { visit(full, depth + 1); continue; }
      if (!entry.isFile() || !WATCH_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      try {
        const stat = fs.statSync(full);
        const value = `${path.relative(workspaceDir, full)}:${stat.mtimeMs}:${stat.size}`;
        for (let index = 0; index < value.length; index += 1) {
          fingerprint ^= value.charCodeAt(index);
          fingerprint = Math.imul(fingerprint, 16777619);
        }
        count += 1;
      } catch { /* file changed while scanning */ }
    }
  };
  visit(workspaceDir, 0);
  return `${count}:${fingerprint >>> 0}`;
}

export async function startDiagnosticsSession(workspaceDir: string): Promise<DiagnosticsResult> {
  const existing = sessions.get(workspaceDir);
  if (existing) return getDiagnostics(workspaceDir);
  const state: DiagnosticsSessionState = { status: "watching", generation: 0, startedAt: Date.now() };
  const session: DiagnosticsSession = {
    state,
    signature: workspaceSignature(workspaceDir),
    timer: setInterval(() => undefined, 1_200),
  };
  clearInterval(session.timer);
  session.timer = setInterval(() => {
    if (session.state.status === "running") return;
    const signature = workspaceSignature(workspaceDir);
    if (signature === session.signature) return;
    session.signature = signature;
    void runDiagnostics(workspaceDir);
  }, 1_200);
  session.timer.unref?.();
  sessions.set(workspaceDir, session);
  return runDiagnostics(workspaceDir);
}

export function stopDiagnosticsSession(workspaceDir: string): DiagnosticsResult {
  const session = sessions.get(workspaceDir);
  if (session) clearInterval(session.timer);
  sessions.delete(workspaceDir);
  const cached = resultCache.get(workspaceDir);
  const next = cached ? { ...cached, session: stoppedState() } : getDiagnostics(workspaceDir);
  resultCache.set(workspaceDir, next);
  return next;
}
