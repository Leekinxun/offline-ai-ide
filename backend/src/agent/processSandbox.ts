import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ProcessResourceLimits {
  /** A wall-clock limit, enforced by this supervisor. */
  wallTimeMs?: number;
  /** These require OS-level rlimits, which Node does not expose. */
  cpuTimeMs?: number;
  memoryBytes?: number;
  maxOpenFiles?: number;
}

export interface WorkspaceProcessOptions {
  executable: string;
  args?: readonly string[];
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Readonly<Record<string, string>>;
  limits?: ProcessResourceLimits;
  /**
   * `posix-shell` applies hard+soft rlimits in a small trusted wrapper before
   * exec. The executable and args are passed as positional arguments.
   */
  resourceLimitMode?: "none" | "posix-shell";
  /** Explicit egress behavior. Agent shells use `deny`; other callers default to `inherit`. */
  networkMode?: "inherit" | "deny";
  /** Literal workspace-relative filesystem grants enforced by the OS helper. */
  filesystem?: WorkspaceFilesystemGrant;
}

export interface WorkspaceFilesystemGrant {
  workspaceDir?: string;
  readPaths?: readonly string[];
  writePaths?: readonly string[];
}

export interface CompiledFilesystemPolicy {
  workspaceDir: string;
  readPaths: string[];
  writePaths: string[];
  protectedPaths: Array<{ path: string; denyRead: boolean; denyWrite: boolean }>;
}

export interface NetworkIsolationCapability {
  available: boolean;
  helper?: "sandbox-exec" | "bubblewrap";
  executable?: string;
  reason?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 50_000;
const INHERITED_ENV = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TEMP", "TMP"] as const;
const BLOCKED_ENV = /^(?:NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z_]+|BASH_ENV|ENV|PYTHONPATH|RUBYOPT|PERL5OPT)$/;
const MACOS_SANDBOX_PROFILE = "(version 1)(deny network*)(allow default)";
const LINUX_BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/bin/bwrap"] as const;
const PROTECTED_WORKSPACE_NAMES = [".git", ".codex", ".history", ".checkpoints", ".crewforge", ".ssh", ".npmrc", ".pypirc", ".netrc"] as const;
const SYSTEM_READ_PATHS = ["/System", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/Library", "/private/var/db", "/dev", "/etc/ld.so.cache", "/etc/ld.so.preload", "/etc/alternatives", "/etc/localtime"] as const;

function literalWorkspacePath(root: string, candidate: string): string {
  if (!candidate || /[*?{}[\]]/.test(candidate)) throw new Error("Filesystem grants must be literal workspace paths");
  const resolved = path.resolve(root, candidate);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("Filesystem grant escapes workspace");
  let cursor = root;
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error("Filesystem grants cannot traverse symlinks");
  }
  return resolved;
}

/** Resolves policy grants once, before any untrusted process is spawned. */
export function compileFilesystemPolicy(workspaceDir: string, grant: WorkspaceFilesystemGrant): CompiledFilesystemPolicy {
  const workspaceDirResolved = fs.realpathSync.native(path.resolve(workspaceDir));
  const explicitRead = Array.from(new Set((grant.readPaths || []).map((item) => literalWorkspacePath(workspaceDirResolved, item))));
  const explicitWrite = Array.from(new Set((grant.writePaths || []).map((item) => literalWorkspacePath(workspaceDirResolved, item))));
  const writePaths = [...explicitWrite].sort();
  const readPaths = Array.from(new Set([...explicitRead, ...writePaths])).sort();
  const rootEntries = (() => { try { return fs.readdirSync(workspaceDirResolved); } catch { return []; } })();
  const protectedNames = Array.from(new Set([...PROTECTED_WORKSPACE_NAMES, ...rootEntries.filter((name) => name === ".env" || name.startsWith(".env."))]));
  const protectedPaths = protectedNames.map((name) => {
    const protectedPath = path.join(workspaceDirResolved, name);
    return {
      path: protectedPath,
      denyRead: !explicitRead.includes(protectedPath) && !explicitWrite.includes(protectedPath),
      denyWrite: !explicitWrite.includes(protectedPath),
    };
  });
  return { workspaceDir: workspaceDirResolved, readPaths, writePaths, protectedPaths };
}

/** Probes the actual hard egress helper, including kernel/user-namespace support. */
export function probeNetworkIsolation(platform: NodeJS.Platform = process.platform): NetworkIsolationCapability {
  if ((platform === "darwin" || platform === "linux") && typeof process.getuid === "function" && process.getuid() === 0) {
    return { available: false, reason: "sandboxed commands cannot run as root" };
  }
  if (platform === "darwin") {
    const executable = "/usr/bin/sandbox-exec";
    if (!fs.existsSync(executable)) {
      return { available: false, reason: `${executable} is not installed` };
    }
    const probe = spawnSync(executable, ["-p", MACOS_SANDBOX_PROFILE, "/usr/bin/true"], {
      stdio: "ignore",
      timeout: 5_000,
    });
    if (probe.status !== 0) {
      return { available: false, reason: `sandbox-exec capability probe failed with code ${probe.status ?? "unknown"}` };
    }
    return { available: true, helper: "sandbox-exec", executable };
  }
  if (platform === "linux") {
    const executable = LINUX_BWRAP_CANDIDATES.find((candidate) => fs.existsSync(candidate));
    if (!executable) {
      return { available: false, reason: `bubblewrap is not installed at ${LINUX_BWRAP_CANDIDATES.join(" or ")}` };
    }
    const probe = spawnSync(executable, ["--die-with-parent", "--unshare-net", "--", "/bin/true"], {
      stdio: "ignore",
      timeout: 5_000,
    });
    if (probe.status !== 0) {
      return { available: false, reason: `bubblewrap network namespace probe failed with code ${probe.status ?? "unknown"}` };
    }
    return { available: true, helper: "bubblewrap", executable };
  }
  return { available: false, reason: `hard network deny is unsupported on platform ${platform}` };
}

/** Filesystem and network isolation use the same mandatory OS helper. */
export function probeFilesystemIsolation(platform: NodeJS.Platform = process.platform): NetworkIsolationCapability {
  const capability = probeNetworkIsolation(platform);
  if (!capability.available) return { ...capability, reason: capability.reason?.replace(/^hard network deny/, "hard filesystem isolation") };
  if (platform === "linux" && capability.executable) {
    const probe = spawnSync(capability.executable, ["--die-with-parent", "--unshare-user-try", "--unshare-pid", "--ro-bind", "/", "/", "--", "/bin/true"], {
      stdio: "ignore",
      timeout: 5_000,
    });
    if (probe.status !== 0) return { available: false, reason: `bubblewrap filesystem capability probe failed with code ${probe.status ?? "unknown"}` };
  }
  return capability;
}

function processGroupKill(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    // A detached POSIX child leads its own process group. Killing -pid reaches
    // ordinary descendants too; a descendant which creates a new session is
    // outside Node's ability to reliably supervise without OS-specific support.
    if (process.platform !== "win32") process.kill(-pid, signal);
    else process.kill(pid, signal);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function minimalEnvironment(extra: Readonly<Record<string, string>> = {}): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || BLOCKED_ENV.test(key) || typeof value !== "string") return undefined;
    env[key] = value;
  }
  return env;
}

function validateLimits(limits: ProcessResourceLimits | undefined): string | undefined {
  if (!limits) return undefined;
  for (const [name, value] of Object.entries(limits)) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) return `Invalid ${name}`;
  }
  return undefined;
}

const POSIX_RESOURCE_WRAPPER = String.raw`
fail_limit() {
  printf '%s\n' "[crewforge-sandbox] unable to enforce $1 limit: $2" >&2
  exit 125
}
apply_limit() {
  limit_name=$1
  limit_flag=$2
  requested=$3
  current_hard=$(ulimit -H "$limit_flag" 2>/dev/null) || fail_limit "$limit_name" "shell does not support ulimit $limit_flag"
  effective=$requested
  case "$current_hard" in
    unlimited) ;;
    *[!0-9]*|'') fail_limit "$limit_name" "unexpected current hard limit: $current_hard" ;;
    *) if [ "$current_hard" -lt "$effective" ]; then effective=$current_hard; fi ;;
  esac
  ulimit -S "$limit_flag" "$effective" 2>/dev/null || fail_limit "$limit_name" "could not set soft limit to $effective"
  ulimit -H "$limit_flag" "$effective" 2>/dev/null || fail_limit "$limit_name" "could not set hard limit to $effective"
}
cpu_seconds=$1
memory_kib=$2
open_files=$3
shift 3
[ "$cpu_seconds" = 0 ] || apply_limit cpu -t "$cpu_seconds"
[ "$memory_kib" = 0 ] || apply_limit address-space -v "$memory_kib"
[ "$open_files" = 0 ] || apply_limit open-files -n "$open_files"
exec "$@"
`;

function resourceWrappedCommand(
  executable: string,
  args: readonly string[],
  limits: ProcessResourceLimits | undefined,
  mode: WorkspaceProcessOptions["resourceLimitMode"]
): { executable: string; args: string[] } | string {
  const hasHardLimits = Boolean(limits?.cpuTimeMs || limits?.memoryBytes || limits?.maxOpenFiles);
  if (!hasHardLimits) return { executable, args: [...args] };
  if (mode !== "posix-shell") {
    return 'CPU, memory, and file-descriptor limits require resourceLimitMode "posix-shell"';
  }
  if (process.platform === "win32") return "POSIX hard resource limits are unavailable on win32";
  if (limits?.memoryBytes && process.platform !== "linux") {
    return `Address-space hard limits are unavailable through /bin/sh on ${process.platform}`;
  }
  const cpuSeconds = limits?.cpuTimeMs ? Math.max(1, Math.ceil(limits.cpuTimeMs / 1_000)) : 0;
  const memoryKiB = limits?.memoryBytes ? Math.max(1, Math.ceil(limits.memoryBytes / 1_024)) : 0;
  const maxOpenFiles = limits?.maxOpenFiles ?? 0;
  return {
    executable: "/bin/sh",
    args: ["-c", POSIX_RESOURCE_WRAPPER, "crewforge-resource-wrapper", String(cpuSeconds), String(memoryKiB), String(maxOpenFiles), executable, ...args],
  };
}

function networkWrappedCommand(
  executable: string,
  args: readonly string[],
  mode: WorkspaceProcessOptions["networkMode"]
): { executable: string; args: string[] } | string {
  if (mode !== "deny") return { executable, args: [...args] };
  const capability = probeNetworkIsolation();
  if (!capability.available || !capability.executable || !capability.helper) {
    return `Network isolation unavailable: ${capability.reason ?? "no supported hard network helper"}`;
  }
  if (capability.helper === "sandbox-exec") {
    return {
      executable: capability.executable,
      args: ["-p", MACOS_SANDBOX_PROFILE, executable, ...args],
    };
  }
  return {
    executable: capability.executable,
    args: ["--die-with-parent", "--unshare-net", "--", executable, ...args],
  };
}

function sbplLiteral(value: string): string { return JSON.stringify(value); }

function macosSandboxProfile(policy: CompiledFilesystemPolicy, networkMode: WorkspaceProcessOptions["networkMode"], executable: string, scratchDir: string): string {
  const systemReads = SYSTEM_READ_PATHS.filter((item) => fs.existsSync(item));
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow signal)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read-metadata)",
    "(allow file-read* (literal \"/\"))",
    `(allow file-read* (literal ${sbplLiteral(policy.workspaceDir)}))`,
    `(allow file-read* (literal ${sbplLiteral(executable)}))`,
    ...systemReads.map((item) => `(allow file-read* (subpath ${sbplLiteral(item)}) (literal ${sbplLiteral(item)}))`),
    `(allow file-read* (subpath ${sbplLiteral(scratchDir)}) (literal ${sbplLiteral(scratchDir)}))`,
    ...policy.readPaths.map((item) => `(allow file-read* (subpath ${sbplLiteral(item)}) (literal ${sbplLiteral(item)}))`),
    `(allow file-write* (subpath ${sbplLiteral(scratchDir)}) (literal ${sbplLiteral(scratchDir)}))`,
    "(allow file-write* (literal \"/dev/null\"))",
    "(allow file-write* (literal \"/dev/stdout\"))",
    "(allow file-write* (literal \"/dev/stderr\"))",
    ...policy.writePaths.map((item) => `(allow file-write* (subpath ${sbplLiteral(item)}) (literal ${sbplLiteral(item)}))`),
    ...policy.protectedPaths.filter((item) => item.denyRead).map((item) => `(deny file-read* (subpath ${sbplLiteral(item.path)}) (literal ${sbplLiteral(item.path)}))`),
    ...policy.protectedPaths.filter((item) => item.denyWrite).map((item) => `(deny file-write* (subpath ${sbplLiteral(item.path)}) (literal ${sbplLiteral(item.path)}))`),
    networkMode === "deny" ? "(deny network*)" : "(allow network*)",
  ];
  return lines.join("\n");
}

function pathPrefixes(target: string): string[] {
  const parts = path.resolve(target).split(path.sep).filter(Boolean);
  const result: string[] = [];
  let cursor: string = path.sep;
  for (const part of parts.slice(0, -1)) { cursor = path.join(cursor, part); result.push(cursor); }
  return result;
}

export function buildLinuxFilesystemSandboxArgs(
  policy: CompiledFilesystemPolicy,
  networkMode: WorkspaceProcessOptions["networkMode"],
  executable: string,
  args: readonly string[],
  cwd: string
): string[] | string {
  for (const granted of policy.readPaths) if (!fs.existsSync(granted)) return `Filesystem read grant does not exist: ${granted}`;
  for (const granted of policy.writePaths) if (!fs.existsSync(granted)) return `Filesystem write grant does not exist: ${granted}`;
  const systemReads = SYSTEM_READ_PATHS.filter((item) => fs.existsSync(item));
  const mounts = Array.from(new Set([...systemReads, ...policy.readPaths, ...(fs.existsSync(executable) ? [executable] : [])]));
  const directories = Array.from(new Set([...mounts, cwd].flatMap(pathPrefixes))).sort((left, right) => left.length - right.length);
  const result = ["--die-with-parent", "--new-session", "--unshare-user-try", "--unshare-pid", "--unshare-ipc", "--unshare-uts"];
  if (networkMode === "deny") result.push("--unshare-net");
  result.push("--tmpfs", "/", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  for (const directory of directories) result.push("--dir", directory);
  for (const item of systemReads) result.push("--ro-bind", item, item);
  if (fs.existsSync(executable) && !systemReads.some((item) => executable === item || executable.startsWith(`${item}${path.sep}`))) result.push("--ro-bind", executable, executable);
  for (const item of policy.readPaths) {
    if (policy.writePaths.includes(item)) result.push("--bind", item, item);
    else result.push("--ro-bind", item, item);
  }
  for (const entry of policy.protectedPaths) {
    const protectedPath = entry.path;
    if (!fs.existsSync(protectedPath)) continue;
    if (protectedPath.includes("/proc/") || protectedPath.includes("/dev/")) return "Protected path cannot target a virtual filesystem";
    const stat = fs.lstatSync(protectedPath);
    if (entry.denyRead) {
      if (stat.isDirectory()) result.push("--tmpfs", protectedPath);
      else result.push("--ro-bind", "/dev/null", protectedPath);
    } else if (entry.denyWrite) {
      result.push("--ro-bind", protectedPath, protectedPath);
    }
  }
  result.push("--chdir", cwd, "--", executable, ...args);
  return result;
}

function sandboxWrappedCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
  networkMode: WorkspaceProcessOptions["networkMode"],
  filesystem: WorkspaceProcessOptions["filesystem"],
  scratchDir?: string
): { executable: string; args: string[] } | string {
  if (!filesystem) return networkWrappedCommand(executable, args, networkMode);
  let policy: CompiledFilesystemPolicy;
  try { policy = compileFilesystemPolicy(filesystem.workspaceDir || cwd, filesystem); }
  catch (error) { return error instanceof Error ? error.message : String(error); }
  let canonicalCwd: string;
  try { canonicalCwd = fs.realpathSync.native(path.resolve(cwd)); }
  catch (error) { return `Process cwd is unavailable: ${error instanceof Error ? error.message : String(error)}`; }
  if (canonicalCwd !== policy.workspaceDir && !canonicalCwd.startsWith(`${policy.workspaceDir}${path.sep}`)) return "Process cwd escapes filesystem policy workspace";
  const capability = probeFilesystemIsolation();
  if (!capability.available || !capability.executable || !capability.helper) {
    return `Filesystem isolation unavailable: ${capability.reason ?? "no supported hard filesystem helper"}`;
  }
  if (capability.helper === "sandbox-exec") {
    if (!scratchDir) return "Filesystem isolation scratch directory is unavailable";
    return { executable: capability.executable, args: ["-p", macosSandboxProfile(policy, networkMode, executable, scratchDir), executable, ...args] };
  }
  const bwrapArgs = buildLinuxFilesystemSandboxArgs(policy, networkMode, executable, args, canonicalCwd);
  return typeof bwrapArgs === "string" ? bwrapArgs : { executable: capability.executable, args: bwrapArgs };
}

/**
 * Executes a program without a shell. Arguments are passed verbatim to spawn.
 * On POSIX it creates a separate process group so cancellation reaches normal
 * descendant processes. This is supervision, not a complete OS sandbox.
 */
export async function runWorkspaceProcess(options: WorkspaceProcessOptions): Promise<string> {
  const executable = options.executable.trim();
  if (!executable || executable.includes("\0")) return "Error: Invalid executable";
  const args = options.args ?? [];
  if (!args.every((arg) => typeof arg === "string" && !arg.includes("\0"))) return "Error: Invalid process arguments";
  if (options.signal?.aborted) return "Error: Stopped before process execution";

  const limitError = validateLimits(options.limits);
  if (limitError) return `Error: ${limitError}`;
  const env = minimalEnvironment(options.env);
  if (!env) return "Error: Process environment contains a blocked or invalid variable";

  const timeoutMs = options.limits?.wallTimeMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    return "Error: Invalid process limits";
  }
  const wrapped = resourceWrappedCommand(executable, args, options.limits, options.resourceLimitMode ?? "none");
  if (typeof wrapped === "string") return `Error: ${wrapped}`;
  let sandboxTempDir: string | undefined;
  if (options.filesystem && process.platform === "darwin") {
    try { sandboxTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-sandbox-")); env.TMPDIR = sandboxTempDir; env.TMP = sandboxTempDir; env.TEMP = sandboxTempDir; }
    catch (error) { return `Error: Filesystem isolation scratch directory failed: ${error instanceof Error ? error.message : String(error)}`; }
  } else if (options.filesystem && process.platform === "linux") {
    env.TMPDIR = "/tmp"; env.TMP = "/tmp"; env.TEMP = "/tmp";
  }
  const cleanupSandboxTemp = () => { if (sandboxTempDir) fs.rmSync(sandboxTempDir, { recursive: true, force: true }); };
  const networkWrapped = sandboxWrappedCommand(wrapped.executable, wrapped.args, options.cwd, options.networkMode ?? "inherit", options.filesystem, sandboxTempDir);
  if (typeof networkWrapped === "string") { cleanupSandboxTemp(); return `Error: ${networkWrapped}`; }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(networkWrapped.executable, networkWrapped.args, {
        cwd: options.cwd,
        env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error: unknown) {
      cleanupSandboxTemp();
      resolve(`Error: ${(error as Error).message}`);
      return;
    }

    let output = "";
    let outputBytes = 0;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    const append = (chunk: Buffer) => {
      const remaining = maxOutputBytes - outputBytes;
      if (remaining <= 0) return;
      const kept = chunk.subarray(0, remaining);
      output += kept.toString("utf8");
      outputBytes += kept.length;
    };
    const finish = (result: string, preserveForceKill = false) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKill && !preserveForceKill) clearTimeout(forceKill);
      options.signal?.removeEventListener("abort", abort);
      cleanupSandboxTemp();
      resolve(result.slice(0, maxOutputBytes));
    };
    const terminate = () => {
      try { processGroupKill(child.pid, "SIGTERM"); } catch { /* already unavailable */ }
      forceKill = setTimeout(() => {
        try { processGroupKill(child.pid, "SIGKILL"); } catch { /* already unavailable */ }
      }, 1_000);
      forceKill.unref?.();
    };
    const abort = () => { terminate(); finish("Error: Stopped during process execution", true); };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    options.signal?.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(() => { terminate(); finish(`Error: Timeout (${timeoutMs}ms)`, true); }, timeoutMs);
    timeout.unref?.();
    child.on("error", (error) => finish(`Error: ${error.message}`));
    child.on("close", (code) => {
      const trimmed = output.trim();
      if (code === 0) finish(trimmed || "(no output)");
      else finish(`Error: Process exited with code ${code ?? "unknown"}${trimmed ? `\n${trimmed}` : ""}`);
    });
  });
}
