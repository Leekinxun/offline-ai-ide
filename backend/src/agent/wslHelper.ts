import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareWorkspaceProcess, type WorkspaceProcessOptions } from "./processSandbox.js";

type ReasonCode =
  | "ready"
  | "wsl2_required"
  | "node_missing"
  | "root_user"
  | "helper_missing"
  | "isolation_unavailable"
  | "probe_failed"
  | "case_sensitive_required"
  | "unsupported_workspace"
  | "invalid_configuration";

interface Manifest {
  version: 1;
  op: "execute" | "probe";
  controlPath: string;
  options?: {
    executable: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    timeoutMs?: number;
    maxOutputBytes?: number;
    limits?: WorkspaceProcessOptions["limits"];
    resourceLimitMode?: WorkspaceProcessOptions["resourceLimitMode"];
    networkMode?: WorkspaceProcessOptions["networkMode"];
    hostCaseSensitiveWorkspace?: boolean;
    filesystem?: {
      workspaceDir: string;
      readPaths: string[];
      writePaths: string[];
    };
  };
}

const HEARTBEAT_TIMEOUT_NS = BigInt(15_000_000_000);
const FIXED_LINUX_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const SYSTEM_EXECUTABLE_ROOTS = ["/bin", "/usr/bin", "/sbin", "/usr/sbin", "/usr/local/bin", "/usr/local/sbin"] as const;
const PROTECTED_WORKSPACE_NAMES = [".git", ".codex", ".history", ".checkpoints", ".crewforge", ".ssh", ".npmrc", ".pypirc", ".netrc"] as const;
const BLOCKED_ENV = /^(?:PATH|HOME|TMPDIR|TEMP|TMP|ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z_]+|BASH_ENV|ENV|PYTHONPATH|RUBYOPT|PERL5OPT)$/;
let activeOperation: Manifest["op"] | undefined;

function cleanReason(value: unknown): string {
  return String(value instanceof Error ? value.message : value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").slice(0, 2_048);
}

function fail(reasonCode: ReasonCode, reason: string, exitCode = 125): never {
  if (activeOperation === "probe") {
    process.stdout.write(JSON.stringify({ available: false, executor: "wsl", reasonCode, reason }));
  } else {
    process.stderr.write(`WSL helper failed: ${reason}\n`);
  }
  process.exit(exitCode);
}

function pathContains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function pathsIntersect(left: string, right: string): boolean {
  return left === right || pathContains(left, right) || pathContains(right, left);
}

function realpathExisting(candidate: string): string {
  return fs.realpathSync.native(path.resolve(candidate));
}

function windowsPathToLinux(windowsPath: string): string {
  if (typeof windowsPath !== "string" || !windowsPath || windowsPath.includes("\0")) throw new Error("Invalid Windows path");
  const result = childProcess.spawnSync("/usr/bin/wslpath", ["-a", "-u", windowsPath], {
    encoding: "utf8",
    env: { PATH: FIXED_LINUX_PATH, LANG: "C" },
    timeout: 5_000,
    maxBuffer: 4_096,
  });
  if (result.status !== 0 || result.error) throw new Error(cleanReason(result.stderr || result.error || "wslpath failed"));
  const converted = String(result.stdout || "").trim();
  if (!converted.startsWith("/") || converted.includes("\0")) throw new Error("wslpath returned an invalid Linux path");
  return converted;
}

function readManifest(file: string): Manifest {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;
  if (parsed.version !== 1 || !["execute", "probe"].includes(parsed.op) || typeof parsed.controlPath !== "string") {
    throw new Error("Invalid WSL manifest");
  }
  return parsed;
}

function detectWsl2(): boolean {
  const release = (() => { try { return fs.readFileSync("/proc/sys/kernel/osrelease", "utf8"); } catch { return ""; } })();
  const version = (() => { try { return fs.readFileSync("/proc/version", "utf8"); } catch { return ""; } })();
  const text = `${release}\n${version}`;
  return /microsoft-standard-WSL2|WSL2/i.test(text);
}

function assertNonRoot(): void {
  if (typeof process.getuid === "function" && process.getuid() === 0) throw new Error("WSL Agent Bash must run as a non-root Linux user");
}

function assertRootOwnedSystemExecutable(executable: string): void {
  const resolved = realpathExisting(resolveSystemExecutable(executable));
  if (!SYSTEM_EXECUTABLE_ROOTS.some((root) => resolved === root || resolved.startsWith(`${root}/`))) {
    throw new Error("Executable must be a root-owned system program inside WSL");
  }
  for (const candidate of pathPrefixes(resolved)) {
    const stat = fs.lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
      throw new Error("Executable path is not a trusted root-owned system path");
    }
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    throw new Error("Executable is not a trusted root-owned system file");
  }
}

function resolveSystemExecutable(executable: string): string {
  if (executable.includes("\0") || executable.includes("\\")) throw new Error("Executable must be a Linux system command");
  if (executable.includes("/")) {
    if (!path.isAbsolute(executable)) throw new Error("Executable must be an absolute Linux path or bare system command");
    return executable;
  }
  if (!/^[A-Za-z0-9._+-]+$/.test(executable)) throw new Error("Executable must be a bare system command");
  for (const directory of FIXED_LINUX_PATH.split(":")) {
    const candidate = path.join(directory, executable);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("Executable is unavailable in the fixed Linux system PATH");
}

function pathPrefixes(target: string): string[] {
  const parts = path.resolve(target).split(path.sep).filter(Boolean);
  const result: string[] = [path.sep];
  let cursor: string = path.sep;
  for (const part of parts.slice(0, -1)) {
    cursor = path.join(cursor, part);
    result.push(cursor);
  }
  return result;
}

function isCaseAmbiguousProtectedName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === ".env" || lower.startsWith(".env.")) return name !== lower;
  return PROTECTED_WORKSPACE_NAMES.some((protectedName) => lower === protectedName && name !== protectedName);
}

function assertNoCaseAmbiguousProtectedEntries(workspaceDir: string): void {
  for (const entry of fs.readdirSync(workspaceDir)) {
    if (isCaseAmbiguousProtectedName(entry)) {
      throw new Error("Workspace contains a case-ambiguous protected path");
    }
  }
}

function literalWorkspacePath(root: string, candidate: string): string {
  if (!candidate || candidate.includes("\\") || /[*?{}[\]]/.test(candidate)) throw new Error("Filesystem grants must be literal Linux workspace paths");
  const resolved = path.resolve(root, candidate);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) throw new Error("Filesystem grant escapes workspace");
  let cursor = root;
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    if (isCaseAmbiguousProtectedName(segment)) throw new Error("Filesystem grant targets a case-ambiguous protected path");
    cursor = path.join(cursor, segment);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error("Filesystem grants cannot traverse symlinks");
  }
  return resolved;
}

function assertOutsideGrantedTrees(label: string, candidate: string, roots: readonly string[]): void {
  for (const root of roots) {
    if (pathsIntersect(root, candidate)) throw new Error(`${label} must live outside Agent filesystem grants`);
  }
}

function trustedBackendRoot(helperPath: string): string {
  const agentDir = path.dirname(helperPath);
  return path.basename(agentDir) === "agent" ? path.dirname(agentDir) : agentDir;
}

function alternateCaseName(name: string): string | undefined {
  for (let index = 0; index < name.length; index += 1) {
    const char = name[index];
    const lower = char.toLowerCase();
    const upper = char.toUpperCase();
    if (lower !== upper) return `${name.slice(0, index)}${char === lower ? upper : lower}${name.slice(index + 1)}`;
  }
  return undefined;
}

function assertCaseSensitiveWorkspace(workspace: string, hostCaseSensitive: boolean | undefined): void {
  if (hostCaseSensitive === true) return;
  const entries = fs.readdirSync(workspace).filter((entry) => !entry.includes("\0"));
  const probe = entries.find((entry) => alternateCaseName(entry) && !isCaseAmbiguousProtectedName(entry));
  if (!probe) throw new Error("Workspace case sensitivity could not be verified from existing entries; use a WSL Linux filesystem workspace or enable NTFS directory case sensitivity before running Agent Bash.");
  const alternate = alternateCaseName(probe);
  if (!alternate) throw new Error("Workspace case sensitivity could not be verified");
  const originalPath = path.join(workspace, probe);
  const alternatePath = path.join(workspace, alternate);
  if (fs.existsSync(alternatePath)) {
    const original = fs.lstatSync(originalPath);
    const alias = fs.lstatSync(alternatePath);
    if (original.dev === alias.dev && original.ino === alias.ino) {
      throw new Error("Workspace filesystem is case-insensitive; enable NTFS directory case sensitivity or use a WSL Linux filesystem workspace.");
    }
  }
  if (/^\/mnt\/[A-Za-z]\//.test(workspace)) {
    throw new Error("WSL Agent Bash requires a case-sensitive DrvFS workspace directory to protect case-masked files.");
  }
}

function compileLinuxOptions(manifest: Manifest, manifestPath: string): WorkspaceProcessOptions {
  if (!manifest.options) throw new Error("Execution manifest has no options");
  const request = manifest.options;
  if (!request.filesystem) throw new Error("WSL Agent execution requires a filesystem isolation grant");
  if (request.networkMode !== "deny" && request.networkMode !== "inherit") throw new Error("Invalid WSL network isolation mode");
  const workspace = request.filesystem ? realpathExisting(windowsPathToLinux(request.filesystem.workspaceDir)) : realpathExisting(windowsPathToLinux(request.cwd));
  assertCaseSensitiveWorkspace(workspace, request.hostCaseSensitiveWorkspace);
  assertNoCaseAmbiguousProtectedEntries(workspace);
  const cwd = realpathExisting(windowsPathToLinux(request.cwd));
  if (cwd !== workspace && !cwd.startsWith(`${workspace}/`)) throw new Error("Process cwd escapes filesystem policy workspace");
  const controlPath = realpathExisting(windowsPathToLinux(manifest.controlPath));
  const helperPath = realpathExisting(fileURLToPath(import.meta.url));
  const backendRoot = trustedBackendRoot(helperPath);
  const manifestReal = realpathExisting(manifestPath);
  const filesystem = request.filesystem ? {
    workspaceDir: workspace,
    readPaths: request.filesystem.readPaths.map((item) => path.relative(workspace, literalWorkspacePath(workspace, item)) || "."),
    writePaths: request.filesystem.writePaths.map((item) => path.relative(workspace, literalWorkspacePath(workspace, item)) || "."),
  } : undefined;
  const grantRoots = filesystem ? [...filesystem.readPaths, ...filesystem.writePaths].map((item) => literalWorkspacePath(workspace, item)) : [workspace];
  assertOutsideGrantedTrees("WSL trusted backend runtime", backendRoot, grantRoots);
  assertOutsideGrantedTrees("WSL manifest", manifestReal, grantRoots);
  assertOutsideGrantedTrees("WSL control file", controlPath, grantRoots);

  const executable = request.executable === "bash" ? "/bin/bash" : resolveSystemExecutable(request.executable);
  assertRootOwnedSystemExecutable(executable);
  if (!Array.isArray(request.args) || !request.args.every((arg) => typeof arg === "string" && !arg.includes("\0"))) throw new Error("Invalid process arguments");
  for (const [key, value] of Object.entries(request.env ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || BLOCKED_ENV.test(key) || typeof value !== "string" || value.includes("\0")) {
      throw new Error("Process environment contains a blocked or invalid variable");
    }
  }
  return {
    executable,
    args: request.args,
    cwd,
    env: request.env,
    timeoutMs: request.timeoutMs,
    maxOutputBytes: request.maxOutputBytes,
    limits: request.limits,
    resourceLimitMode: request.resourceLimitMode,
    networkMode: request.networkMode,
    ...(filesystem ? { filesystem } : {}),
  };
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try { process.kill(-pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

function runProbe(): void {
  try {
    assertNonRoot();
    if (!detectWsl2()) fail("wsl2_required", "Agent Bash requires WSL2. Run `wsl --set-default-version 2`, convert or install a WSL2 distro, then restart the app.");
    if (Number(process.versions.node.split(".")[0]) < 18) fail("node_missing", "WSL Agent execution requires Node.js 18 or later");
    if (!fs.existsSync("/usr/bin/node")) fail("node_missing", "WSL distro must provide /usr/bin/node. Install Node.js inside the selected WSL2 distribution.");
    assertRootOwnedSystemExecutable("/bin/bash");
    const prepared = prepareWorkspaceProcess({
      executable: "/bin/true",
      cwd: "/tmp",
      networkMode: "deny",
      filesystem: { workspaceDir: "/tmp", readPaths: [], writePaths: [] },
      limits: { maxOpenFiles: 64, wallTimeMs: 5_000 },
      resourceLimitMode: "posix-shell",
    });
    prepared.cleanup();
    process.stdout.write(JSON.stringify({ available: true, executor: "wsl", reasonCode: "ready" }));
  } catch (error) {
    const reason = cleanReason(error);
    const reasonCode: ReasonCode = /must run as a non-root|cannot run as root/i.test(reason) ? "root_user"
      : /\/bin\/bash/.test(reason) || /(?:bubblewrap|bwrap).*not installed/.test(reason) ? "helper_missing"
      : /bubblewrap|filesystem isolation|network isolation|namespace|bwrap/i.test(reason) ? "isolation_unavailable"
        : /node/i.test(reason) ? "node_missing" : "probe_failed";
    fail(reasonCode, reason, 0);
  }
}

function runExecution(manifest: Manifest, manifestPath: string): void {
  assertNonRoot();
  if (!detectWsl2()) throw new Error("Agent Bash requires WSL2");
  const controlPath = windowsPathToLinux(manifest.controlPath);
  const options = compileLinuxOptions(manifest, manifestPath);
  const prepared = prepareWorkspaceProcess(options);
  let child: childProcess.ChildProcess;
  try {
    child = childProcess.spawn(prepared.executable, prepared.args, {
      cwd: options.cwd,
      env: prepared.env,
      shell: false,
      detached: true,
      stdio: ["pipe", "inherit", "inherit"],
    });
  } catch (error) {
    prepared.cleanup();
    throw error;
  }

  let lastCounter: unknown;
  let lastBeat = process.hrtime.bigint();
  let terminating = false;
  let finished = false;
  const terminate = () => {
    if (terminating) return;
    terminating = true;
    try { killProcessGroup(child.pid, "SIGTERM"); } catch { /* already gone */ }
    setTimeout(() => { try { killProcessGroup(child.pid, "SIGKILL"); } catch { /* already gone */ } }, 1_000).unref();
  };
  const cleanupAndExit = (exitCode: number) => {
    if (finished) return;
    finished = true;
    clearInterval(monitor);
    clearTimeout(wallTimeout);
    try { killProcessGroup(child.pid, "SIGTERM"); } catch { /* already gone */ }
    prepared.cleanup();
    process.exit(exitCode);
  };
  const monitor = setInterval(() => {
    try {
      const state = JSON.parse(fs.readFileSync(controlPath, "utf8")) as { counter?: unknown; stop?: boolean };
      if (state.stop) { terminate(); return; }
      if (state.counter !== lastCounter) {
        lastCounter = state.counter;
        lastBeat = process.hrtime.bigint();
      } else if (process.hrtime.bigint() - lastBeat > HEARTBEAT_TIMEOUT_NS) {
        terminate();
      }
    } catch {
      terminate();
    }
  }, 500);
  monitor.unref();
  const wallTimeout = setTimeout(() => {
    process.stderr.write(`WSL payload timed out after ${prepared.timeoutMs}ms\n`);
    terminate();
  }, prepared.timeoutMs);
  wallTimeout.unref();

  process.stdin.on("data", (chunk) => {
    if (!child.stdin?.write(chunk)) process.stdin.pause();
  });
  child.stdin?.on("drain", () => process.stdin.resume());
  child.stdin?.on("error", () => terminate());
  process.stdin.on("end", () => child.stdin?.end());
  process.stdin.on("error", () => child.stdin?.end());
  process.stdout.on("error", terminate);
  process.stderr.on("error", terminate);
  process.once("SIGTERM", () => {
    terminate();
    setTimeout(() => cleanupAndExit(128 + 15), 1_100).unref();
  });
  process.once("SIGINT", () => {
    terminate();
    setTimeout(() => cleanupAndExit(128 + 2), 1_100).unref();
  });

  child.on("error", (error) => {
    if (finished) return;
    finished = true;
    clearInterval(monitor);
    clearTimeout(wallTimeout);
    prepared.cleanup();
    process.stderr.write(`WSL payload failed: ${cleanReason(error)}\n`);
    process.exit(125);
  });
  child.on("close", (code, signal) => {
    if (finished) return;
    finished = true;
    clearInterval(monitor);
    clearTimeout(wallTimeout);
    try { killProcessGroup(child.pid, "SIGTERM"); } catch { /* already gone */ }
    prepared.cleanup();
    if (signal) process.exit(128);
    process.exit(code ?? 125);
  });
}

function main(): void {
  try {
    const manifestPath = process.argv[2];
    if (!manifestPath) throw new Error("Missing WSL manifest path");
    const manifest = readManifest(manifestPath);
    activeOperation = manifest.op;
    if (manifest.op === "probe") runProbe();
    else runExecution(manifest, manifestPath);
  } catch (error) {
    process.stderr.write(`WSL helper failed: ${cleanReason(error)}\n`);
    process.exit(125);
  }
}

const invokedPath = process.argv[1] ? (() => { try { return realpathExisting(process.argv[1]); } catch { return path.resolve(process.argv[1]); } })() : undefined;
if (invokedPath === realpathExisting(fileURLToPath(import.meta.url))) main();

export const __wslHelperForTests = {
  compileLinuxOptions,
  detectWsl2,
  windowsPathToLinux,
};
