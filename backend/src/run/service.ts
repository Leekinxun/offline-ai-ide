import crypto from "crypto";
import fs from "fs";
import path from "path";
import { spawn, type ChildProcess } from "child_process";

export interface RunTask {
  id: string;
  label: string;
  kind: "run" | "test" | "build" | "check";
  source: string;
  command: string;
  args: string[];
}

export interface RunFailure {
  path: string;
  line: number;
  column: number;
  message: string;
}

export interface RunRecord {
  id: string;
  taskId: string;
  label: string;
  status: "running" | "passed" | "failed" | "timed_out" | "cancelled";
  startedAt: number;
  durationMs: number;
  endedAt?: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  failures: RunFailure[];
}

const runCache = new Map<string, RunRecord[]>();
interface ActiveRun {
  child: ChildProcess;
  record: RunRecord;
  workspaceDir: string;
  timeout: NodeJS.Timeout;
  forceTimer?: NodeJS.Timeout;
  requestedStatus?: "timed_out" | "cancelled";
  completion: Promise<RunRecord>;
  resolveCompletion: (record: RunRecord) => void;
}
const activeRuns = new Map<string, ActiveRun>();
const MAX_OUTPUT = 200_000;

function safeJson(filePath: string): any {
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); } catch { return null; }
}

export function discoverRunTasks(workspaceDir: string): RunTask[] {
  const tasks: RunTask[] = [];
  const packageJson = safeJson(path.join(workspaceDir, "package.json"));
  if (packageJson?.scripts && typeof packageJson.scripts === "object") {
    for (const script of Object.keys(packageJson.scripts).sort()) {
      const kind: RunTask["kind"] = /test/i.test(script) ? "test" : /build/i.test(script) ? "build" : /lint|check|type/i.test(script) ? "check" : "run";
      tasks.push({ id: `npm:${script}`, label: `npm: ${script}`, kind, source: "package.json", command: process.platform === "win32" ? "npm.cmd" : "npm", args: ["run", script] });
    }
  }
  if (fs.existsSync(path.join(workspaceDir, "Cargo.toml"))) {
    tasks.push(
      { id: "cargo:check", label: "cargo check", kind: "check", source: "Cargo.toml", command: "cargo", args: ["check"] },
      { id: "cargo:test", label: "cargo test", kind: "test", source: "Cargo.toml", command: "cargo", args: ["test"] },
      { id: "cargo:run", label: "cargo run", kind: "run", source: "Cargo.toml", command: "cargo", args: ["run"] }
    );
  }
  const pythonConfig = ["pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini"].some((name) => fs.existsSync(path.join(workspaceDir, name)));
  if (pythonConfig) {
    const python = process.platform === "win32" ? "python" : "python3";
    tasks.push({ id: "python:pytest", label: "pytest", kind: "test", source: "Python", command: python, args: ["-m", "pytest"] });
    tasks.push({ id: "python:compile", label: "Python compile check", kind: "check", source: "Python", command: python, args: ["-m", "compileall", "-q", "."] });
  }
  return tasks.slice(0, 100);
}

function relativeFailurePath(workspaceDir: string, value: string): string | null {
  const candidate = value.replace(/^['"]|['"]$/g, "");
  const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(workspaceDir, candidate);
  const relative = path.relative(workspaceDir, absolute).split(path.sep).join("/");
  return !relative || relative.startsWith("../") || path.isAbsolute(relative) ? null : relative;
}

function parseFailures(workspaceDir: string, output: string): RunFailure[] {
  const failures: RunFailure[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    // npm prints the script command with a leading "> "; it can contain source-like
    // text and must never be treated as a failure location.
    if (line.trimStart().startsWith("> ")) continue;
    let pathValue: string | undefined;
    let lineValue = 1;
    let columnValue = 1;
    let message = line.trim();
    const standard = line.match(/^(.+?):(\d+):(\d+):\s*(.+)$/);
    const python = line.match(/^\s*File\s+"([^"]+)",\s+line\s+(\d+)/);
    const pytest = line.match(/^(.+?\.py):(\d+):\s*(.+)$/);
    if (standard) {
      [, pathValue] = standard;
      lineValue = Number(standard[2]); columnValue = Number(standard[3]); message = standard[4];
    } else if (python) {
      pathValue = python[1]; lineValue = Number(python[2]);
    } else if (pytest) {
      pathValue = pytest[1]; lineValue = Number(pytest[2]); message = pytest[3];
    }
    if (!pathValue) continue;
    const relative = relativeFailurePath(workspaceDir, pathValue);
    if (!relative) continue;
    const key = `${relative}:${lineValue}:${columnValue}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    failures.push({ path: relative, line: lineValue, column: columnValue, message: message.slice(0, 500) });
    if (failures.length >= 200) break;
  }
  return failures;
}

export function listRunRecords(workspaceDir: string): RunRecord[] {
  const records = runCache.get(workspaceDir) || [];
  const now = Date.now();
  for (const record of records) {
    if (record.status === "running") record.durationMs = now - record.startedAt;
  }
  return records;
}

function appendOutput(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length <= MAX_OUTPUT ? next : next.slice(next.length - MAX_OUTPUT);
}

function signalRun(active: ActiveRun, signal: NodeJS.Signals): void {
  if (active.child.exitCode !== null || active.child.pid === undefined) return;
  try {
    if (process.platform !== "win32") process.kill(-active.child.pid, signal);
    else active.child.kill(signal);
  } catch {
    try { active.child.kill(signal); } catch { /* process already exited */ }
  }
}

function finishRun(active: ActiveRun, exitCode: number | null): RunRecord {
  clearTimeout(active.timeout);
  if (active.forceTimer) clearTimeout(active.forceTimer);
  const endedAt = Date.now();
  active.record.status = active.requestedStatus || (exitCode === 0 ? "passed" : "failed");
  active.record.exitCode = exitCode;
  active.record.endedAt = endedAt;
  active.record.durationMs = endedAt - active.record.startedAt;
  active.record.failures = parseFailures(
    active.workspaceDir,
    `${active.record.stdout}\n${active.record.stderr}`
  );
  activeRuns.delete(active.record.id);
  active.resolveCompletion(active.record);
  return active.record;
}

export function startRunTask(workspaceDir: string, taskId: string): RunRecord {
  const task = discoverRunTasks(workspaceDir).find((item) => item.id === taskId);
  if (!task) throw new Error("Unknown or unavailable task");
  const startedAt = Date.now();
  const id = `${startedAt}-${crypto.randomBytes(3).toString("hex")}`;
  const record: RunRecord = {
    id,
    taskId: task.id,
    label: task.label,
    status: "running",
    startedAt,
    durationMs: 0,
    exitCode: null,
    stdout: "",
    stderr: "",
    failures: [],
  };
  runCache.set(workspaceDir, [record, ...(runCache.get(workspaceDir) || [])].slice(0, 20));

  const child = spawn(task.command, task.args, {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" },
    detached: process.platform !== "win32",
  });

  let resolveCompletion!: (record: RunRecord) => void;
  const completion = new Promise<RunRecord>((resolve) => { resolveCompletion = resolve; });
  const active: ActiveRun = {
    child,
    record,
    workspaceDir,
    completion,
    resolveCompletion,
    timeout: setTimeout(() => undefined, 120_000),
  };
  clearTimeout(active.timeout);
  active.timeout = setTimeout(() => {
    active.requestedStatus = "timed_out";
    signalRun(active, "SIGTERM");
    active.forceTimer = setTimeout(() => signalRun(active, "SIGKILL"), 2_000);
    active.forceTimer.unref?.();
  }, 120_000);
  active.timeout.unref?.();
  activeRuns.set(id, active);

  child.stdout?.on("data", (chunk) => { record.stdout = appendOutput(record.stdout, chunk); });
  child.stderr?.on("data", (chunk) => { record.stderr = appendOutput(record.stderr, chunk); });
  child.once("error", (error) => {
    record.stderr = appendOutput(record.stderr, `\n${error.message}`);
  });
  child.once("close", (code) => finishRun(active, code));
  return record;
}

export async function executeRunTask(workspaceDir: string, taskId: string): Promise<RunRecord> {
  const record = startRunTask(workspaceDir, taskId);
  return waitForRun(workspaceDir, record.id);
}

export function stopRunTask(workspaceDir: string, runId: string): RunRecord {
  const active = activeRuns.get(runId);
  if (!active || active.workspaceDir !== workspaceDir) throw new Error("Run is not active");
  active.requestedStatus = "cancelled";
  signalRun(active, "SIGTERM");
  active.forceTimer = setTimeout(() => signalRun(active, "SIGKILL"), 2_000);
  active.forceTimer.unref?.();
  return active.record;
}

export async function waitForRun(workspaceDir: string, runId: string): Promise<RunRecord> {
  const active = activeRuns.get(runId);
  if (active && active.workspaceDir === workspaceDir) return active.completion;
  const record = listRunRecords(workspaceDir).find((item) => item.id === runId);
  if (!record) throw new Error("Run not found");
  return record;
}
