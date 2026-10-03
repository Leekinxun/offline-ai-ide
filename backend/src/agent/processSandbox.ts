import childProcess, { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactSecrets } from "./secretRedaction.js";
import { INTERNAL_NODE_RUNTIME, macosNodeRuntimeFrameworks, nodeRuntimeEnvironment } from "../utils/nodeRuntime.js";
import { prepareWslWorkspaceProcess } from "./wslExecution.js";
import { prepareWindowsNativeProcess, probeWindowsNativeSandbox } from "./windowsNativeSandbox.js";
import { getWindowsAgentSettings } from "../run/windowsAgentSettings.js";

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
  /** Server-owned fixed Node runtime authority; identity cannot be supplied over HTTP or model JSON. */
  internalNodeRuntime?: typeof INTERNAL_NODE_RUNTIME;
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
  reasonCode?: "root_user" | "helper_missing" | "unsupported_platform" | "namespace_permission_denied" | "namespace_unavailable" | "namespace_limit" | "mount_permission_denied" | "runtime_unavailable" | "probe_timeout" | "probe_failed" | "invalid_configuration";
  procMode?: LinuxProcMode;
  exitCode?: number | null;
  stderr?: string;
}

export type LinuxProcMode = "private" | "none";

/** Server/operator configuration only; never taken from a command's environment. */
export function resolveLinuxProcMode(value = process.env.CROWNFORGE_SANDBOX_PROC_MODE): LinuxProcMode {
  if (value === undefined || value === "private") return "private";
  if (value === "none") return "none";
  throw new Error("Invalid CROWNFORGE_SANDBOX_PROC_MODE; expected private or none");
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 50_000;
const INHERITED_ENV = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TEMP", "TMP"] as const;
const BLOCKED_ENV = /^(?:ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z_]+|BASH_ENV|ENV|PYTHONPATH|RUBYOPT|PERL5OPT)$/;
const MACOS_SANDBOX_PROFILE = "(version 1)(deny network*)(allow default)";
const LINUX_BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/bin/bwrap"] as const;
const PROTECTED_WORKSPACE_NAMES = [".git", ".codex", ".history", ".checkpoints", ".crewforge", ".ssh", ".npmrc", ".pypirc", ".netrc"] as const;
const SYSTEM_READ_PATHS = ["/System", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/Library", "/private/var/db", "/dev", "/etc/ld.so.cache", "/etc/ld.so.preload", "/etc/alternatives", "/etc/localtime"] as const;
const LINUX_SYSTEM_READ_PATHS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc/ld.so.cache", "/etc/alternatives", "/etc/localtime"] as const;
const LINUX_RUNTIME_ROOTS = ["/opt/conda"] as const;
export const ISOLATION_PROBE_TIMEOUT_MS = 5_000;
export const ISOLATION_PROBE_STDERR_LIMIT = 2_048;

/** Only shipped, root-owned runtimes are added; PATH never grants host directories. */
export function linuxTrustedRuntimeReadPaths(): string[] {
  return LINUX_RUNTIME_ROOTS.filter((runtime) => {
    try {
      for (const candidate of [...pathPrefixes(runtime), runtime]) {
        const stat = fs.lstatSync(candidate);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) return false;
      }
      return true;
    } catch { return false; }
  });
}

export function sanitizeIsolationDiagnostic(value: unknown): string {
  const text = typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : "";
  return redactSecrets(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim().slice(0, ISOLATION_PROBE_STDERR_LIMIT);
}

function probeFailure(label: string, probe: ReturnType<typeof childProcess.spawnSync>): NetworkIsolationCapability {
  const stderr = sanitizeIsolationDiagnostic(probe.stderr);
  const errorCode = (probe.error as NodeJS.ErrnoException | undefined)?.code;
  const reasonCode: NetworkIsolationCapability["reasonCode"] = errorCode === "ETIMEDOUT" ? "probe_timeout"
    : /(?:no permissions|operation not permitted|permission denied).*namespace|namespace.*(?:not permitted|permission denied)/i.test(stderr) ? "namespace_permission_denied"
      : /namespace.*(?:ENOSPC|nesting depth|exceeded)/i.test(stderr) ? "namespace_limit"
        : /kernel.*(?:does not support|not allow).*namespace|namespace.*not supported/i.test(stderr) ? "namespace_unavailable"
          : /mount|pivot_root/i.test(stderr) && /not permitted|permission denied/i.test(stderr) ? "mount_permission_denied"
            : /exec(?:vp|v|ve)?.*(?:no such file|not found)|no such file.*(?:true|loader)/i.test(stderr) ? "runtime_unavailable" : "probe_failed";
  const detail = stderr || (errorCode ? `spawn error ${errorCode}` : probe.signal ? `signal ${probe.signal}` : "no helper diagnostic");
  return { available: false, reasonCode, exitCode: probe.status, ...(stderr ? { stderr } : {}), reason: `${label} failed with code ${probe.status ?? "unknown"}: ${detail}` };
}

/** A fixed true command with the same runtime mounts used by real Agent commands. */
export function buildLinuxIsolationProbeArgs(networkMode: "inherit" | "deny" = "deny", procMode = resolveLinuxProcMode()): string[] {
  const args = buildLinuxFilesystemSandboxArgs({ workspaceDir: "/tmp", readPaths: [], writePaths: [], protectedPaths: [] }, networkMode, "/bin/true", [], "/tmp", procMode);
  if (typeof args === "string") throw new Error(args);
  return args;
}

function probeIsolation(kind: "network" | "filesystem", platform: NodeJS.Platform, selectedProcMode?: LinuxProcMode): NetworkIsolationCapability {
  let procMode: LinuxProcMode | undefined;
  if (platform === "linux") {
    try { procMode = selectedProcMode ?? resolveLinuxProcMode(); }
    catch (error) { return { available: false, helper: "bubblewrap", reasonCode: "invalid_configuration", reason: (error as Error).message }; }
  }
  const modeMetadata = procMode ? { procMode } : {};
  if ((platform === "darwin" || platform === "linux") && typeof process.getuid === "function" && process.getuid() === 0) {
    return { ...modeMetadata, available: false, reasonCode: "root_user", reason: "sandboxed commands cannot run as root" };
  }
  const helper = platform === "darwin" ? "sandbox-exec" : platform === "linux" ? "bubblewrap" : undefined;
  if (!helper) return { available: false, reasonCode: "unsupported_platform", reason: `hard ${kind === "network" ? "network deny" : "filesystem isolation"} is unsupported on platform ${platform}` };
  const executable = helper === "sandbox-exec" ? "/usr/bin/sandbox-exec" : LINUX_BWRAP_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!executable || !fs.existsSync(executable)) return { ...modeMetadata, available: false, helper, reasonCode: "helper_missing", reason: `${helper} is not installed at ${helper === "sandbox-exec" ? "/usr/bin/sandbox-exec" : LINUX_BWRAP_CANDIDATES.join(" or ")}` };
  let args: string[];
  try {
    args = helper === "sandbox-exec" ? ["-p", MACOS_SANDBOX_PROFILE, "/usr/bin/true"]
      : buildLinuxIsolationProbeArgs(kind === "network" ? "deny" : "inherit", procMode);
  } catch (error) { return { ...modeMetadata, available: false, helper, executable, reasonCode: "invalid_configuration", reason: sanitizeIsolationDiagnostic((error as Error).message) }; }
  const probe = childProcess.spawnSync(executable, args, {
    encoding: "utf8", stdio: ["ignore", "ignore", "pipe"], timeout: ISOLATION_PROBE_TIMEOUT_MS,
    maxBuffer: 8_192, env: { PATH: "/usr/bin:/bin", LANG: "C" },
  });
  if (probe.status !== 0 || probe.error) return { ...modeMetadata, helper, executable, ...probeFailure(`${helper} ${kind} capability probe`, probe) };
  return { ...modeMetadata, available: true, helper, executable };
}

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
  return probeIsolation("network", platform);
}

/** Filesystem and network isolation use the same mandatory OS helper. */
export function probeFilesystemIsolation(platform: NodeJS.Platform = process.platform): NetworkIsolationCapability {
  return probeIsolation("filesystem", platform);
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
  mode: WorkspaceProcessOptions["networkMode"],
  cwd: string,
  procMode?: LinuxProcMode
): { executable: string; args: string[] } | string {
  if (mode !== "deny") return { executable, args: [...args] };
  const capability = probeIsolation("network", process.platform, procMode);
  if (!capability.available || !capability.executable || !capability.helper) {
    return `Network isolation unavailable: ${capability.reason ?? "no supported hard network helper"}`;
  }
  if (capability.helper === "sandbox-exec") {
    return {
      executable: capability.executable,
      args: ["-p", MACOS_SANDBOX_PROFILE, executable, ...args],
    };
  }
  // Callers without an explicit filesystem grant receive only workspace reads.
  // Building a complete mount tree is mandatory even for a network-only request.
  const policy = compileFilesystemPolicy(cwd, { readPaths: ["."], writePaths: [] });
  const linuxArgs = buildLinuxFilesystemSandboxArgs(policy, "deny", executable, args, policy.workspaceDir, capability.procMode);
  return typeof linuxArgs === "string" ? linuxArgs : { executable: capability.executable, args: linuxArgs };
}

function sbplLiteral(value: string): string { return JSON.stringify(value); }

function macosSandboxProfile(policy: CompiledFilesystemPolicy, networkMode: WorkspaceProcessOptions["networkMode"], executable: string, scratchDir: string, runtimeReadPaths: readonly string[]): string {
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
    ...runtimeReadPaths.map((item) => `(allow file-read* (subpath ${sbplLiteral(item)}) (literal ${sbplLiteral(item)}))`),
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

function pathContains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

/** Parent mount metadata is read only by the supervisor, never mounted into the payload. */
function parentProcMounts(): string[] {
  if (process.platform !== "linux") return [];
  const descriptor = fs.openSync("/proc/self/mountinfo", fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(1_048_577);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length === bytes.length) throw new Error("Parent mount metadata exceeds the sandbox inspection limit");
    if (!length) throw new Error("Parent mount metadata is unavailable");
    return bytes.subarray(0, length).toString("utf8").split("\n").filter(Boolean).flatMap((line) => {
      const separator = line.indexOf(" - ");
      if (separator < 0) throw new Error("Parent mount metadata is invalid");
      if (line.slice(separator + 3).split(" ")[0] !== "proc") return [];
      const mountpoint = line.slice(0, separator).split(" ")[4];
      if (!mountpoint?.startsWith("/")) throw new Error("Parent mount metadata is invalid");
      return [mountpoint.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)))];
    });
  } finally { fs.closeSync(descriptor); }
}

function procExposureReason(paths: readonly string[], procMounts: readonly string[]): string | undefined {
  for (const candidate of paths) {
    const lexical = path.resolve(candidate);
    const canonical = fs.existsSync(lexical) ? fs.realpathSync.native(lexical) : lexical;
    for (const target of [lexical, canonical]) {
      if (pathContains(target, "/proc") || pathContains("/proc", target) ||
        procMounts.some((mount) => pathContains(target, mount) || pathContains(mount, target))) {
        return "No-proc sandbox mode rejects paths that expose a parent proc filesystem";
      }
    }
  }
  return undefined;
}

export function buildLinuxFilesystemSandboxArgs(
  policy: CompiledFilesystemPolicy,
  networkMode: WorkspaceProcessOptions["networkMode"],
  executable: string,
  args: readonly string[],
  cwd: string,
  procMode: LinuxProcMode = resolveLinuxProcMode()
): string[] | string {
  if (procMode !== "private" && procMode !== "none") return "Invalid Linux sandbox proc mode";
  const systemReads = [...LINUX_SYSTEM_READ_PATHS.filter((item) => fs.existsSync(item)), ...linuxTrustedRuntimeReadPaths()];
  if (procMode === "none") {
    try {
      const rejected = procExposureReason([policy.workspaceDir, ...policy.readPaths, ...policy.writePaths, ...systemReads, executable, cwd], parentProcMounts());
      if (rejected) return rejected;
    } catch { return "No-proc sandbox mode could not verify parent filesystem mounts"; }
  }
  for (const granted of policy.readPaths) if (!fs.existsSync(granted)) return `Filesystem read grant does not exist: ${granted}`;
  for (const granted of policy.writePaths) if (!fs.existsSync(granted)) return `Filesystem write grant does not exist: ${granted}`;
  const mounts = Array.from(new Set([...systemReads, ...policy.readPaths, ...(fs.existsSync(executable) ? [executable] : [])]));
  const directories = Array.from(new Set([...mounts, cwd].flatMap(pathPrefixes))).sort((left, right) => left.length - right.length);
  const result = ["--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts"];
  if (networkMode === "deny") result.push("--unshare-net");
  result.push("--tmpfs", "/");
  if (procMode === "private") result.push("--proc", "/proc");
  result.push("--dev", "/dev", "--tmpfs", "/tmp");
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
      if (stat.isDirectory()) result.push("--tmpfs", protectedPath, "--remount-ro", protectedPath);
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
  scratchDir?: string,
  procMode?: LinuxProcMode,
  runtimeReadPaths: readonly string[] = []
): { executable: string; args: string[] } | string {
  if (!filesystem) return networkWrappedCommand(executable, args, networkMode, cwd, procMode);
  let policy: CompiledFilesystemPolicy;
  try { policy = compileFilesystemPolicy(filesystem.workspaceDir || cwd, filesystem); }
  catch (error) { return error instanceof Error ? error.message : String(error); }
  let canonicalCwd: string;
  try { canonicalCwd = fs.realpathSync.native(path.resolve(cwd)); }
  catch (error) { return `Process cwd is unavailable: ${error instanceof Error ? error.message : String(error)}`; }
  if (canonicalCwd !== policy.workspaceDir && !canonicalCwd.startsWith(`${policy.workspaceDir}${path.sep}`)) return "Process cwd escapes filesystem policy workspace";
  const capability = probeIsolation("filesystem", process.platform, procMode);
  if (!capability.available || !capability.executable || !capability.helper) {
    return `Filesystem isolation unavailable: ${capability.reason ?? "no supported hard filesystem helper"}`;
  }
  if (capability.helper === "sandbox-exec") {
    if (!scratchDir) return "Filesystem isolation scratch directory is unavailable";
    return { executable: capability.executable, args: ["-p", macosSandboxProfile(policy, networkMode, executable, scratchDir, runtimeReadPaths), executable, ...args] };
  }
  const bwrapArgs = buildLinuxFilesystemSandboxArgs(policy, networkMode, executable, args, canonicalCwd, capability.procMode);
  return typeof bwrapArgs === "string" ? bwrapArgs : { executable: capability.executable, args: bwrapArgs };
}

/**
 * Executes a program without a shell. Arguments are passed verbatim to spawn.
 * On POSIX it creates a separate process group so cancellation reaches normal
 * descendant processes. This is supervision, not a complete OS sandbox.
 */
export interface PreparedWorkspaceProcess {
  executable: string; args: string[]; env: Record<string, string>; timeoutMs: number; maxOutputBytes: number; cleanup: () => void;
  /** Revoke an active transport without releasing its final lifecycle lease. */
  cancel?: () => void;
  /** Bind a pending native lease to the actual owned supervisor. */
  onSpawn?: (pid: number) => void;
}

export function prepareWorkspaceProcess(options: WorkspaceProcessOptions): PreparedWorkspaceProcess {
  const executable = options.executable.trim();
  if (!executable || executable.includes("\0")) throw new Error("Invalid executable");
  const internalNode = options.internalNodeRuntime === INTERNAL_NODE_RUNTIME && executable === process.execPath;
  if (options.internalNodeRuntime && !internalNode) throw new Error("Internal Node runtime authority requires the fixed backend executable");
  const args = options.args ?? [];
  if (!args.every((arg) => typeof arg === "string" && !arg.includes("\0"))) throw new Error("Invalid process arguments");
  if (options.signal?.aborted) throw new Error("Stopped before process execution");
  const procMode = process.platform === "linux" && (options.filesystem || options.networkMode === "deny") ? resolveLinuxProcMode() : undefined;
  if (procMode === "none") {
    const rejected = procExposureReason([options.cwd, ...(path.isAbsolute(executable) ? [executable] : [])], parentProcMounts());
    if (rejected) throw new Error(rejected);
  }

  const limitError = validateLimits(options.limits);
  if (limitError) throw new Error(limitError);
  let env = minimalEnvironment(options.env);
  if (!env) throw new Error("Process environment contains a blocked or invalid variable");
  const timeoutMs = options.limits?.wallTimeMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error("Invalid process limits");
  }
  // Agent grants require real Linux isolation inside WSL, rather than a Windows
  // shell launch that drops the mandatory filesystem/network/resource policy.
  if (process.platform === "win32" && options.filesystem && !internalNode) {
    compileFilesystemPolicy(options.filesystem.workspaceDir || options.cwd, options.filesystem);
    return getWindowsAgentSettings().environment === "wsl" ? prepareWslWorkspaceProcess(options) : prepareWindowsNativeProcess(options);
  }
  if (internalNode) env = nodeRuntimeEnvironment(env);
  const frameworks = internalNode ? macosNodeRuntimeFrameworks() : undefined;
  const runtimeReadPaths = frameworks ? [fs.realpathSync.native(executable), frameworks] : [];

  const wrapped = resourceWrappedCommand(executable, args, options.limits, options.resourceLimitMode ?? "none");
  if (typeof wrapped === "string") throw new Error(wrapped);
  let sandboxTempDir: string | undefined;
  if (options.filesystem && process.platform === "darwin") {
    try { sandboxTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-sandbox-")); env.TMPDIR = sandboxTempDir; env.TMP = sandboxTempDir; env.TEMP = sandboxTempDir; env.HOME = sandboxTempDir; }
    catch (error) { throw new Error(`Filesystem isolation scratch directory failed: ${error instanceof Error ? error.message : String(error)}`); }
  } else if (options.filesystem && process.platform === "linux") {
    env.TMPDIR = "/tmp"; env.TMP = "/tmp"; env.TEMP = "/tmp";
    // No host passwd database or user home is mounted. Tools such as npm need
    // a home for config/cache resolution; keep it in the private scratch mount.
    env.HOME = "/tmp";
  }
  const cleanupSandboxTemp = () => { if (sandboxTempDir) fs.rmSync(sandboxTempDir, { recursive: true, force: true }); };
  const networkWrapped = sandboxWrappedCommand(wrapped.executable, wrapped.args, options.cwd, options.networkMode ?? "inherit", options.filesystem, sandboxTempDir, procMode, runtimeReadPaths);
  if (typeof networkWrapped === "string") { cleanupSandboxTemp(); throw new Error(networkWrapped); }

  return { ...networkWrapped, env, timeoutMs, maxOutputBytes, cleanup: cleanupSandboxTemp };
}

export async function runWorkspaceProcess(options: WorkspaceProcessOptions): Promise<string> {
  if (process.platform === "win32" && options.filesystem && !options.internalNodeRuntime && getWindowsAgentSettings().environment === "native") {
    const capability = await probeWindowsNativeSandbox();
    if (!capability.available) return `Error: ${capability.reason || "Set up the Windows sandbox in desktop settings before running Agent commands"}`;
  }
  let prepared: PreparedWorkspaceProcess;
  try { prepared = prepareWorkspaceProcess(options); }
  catch (error) { return `Error: ${error instanceof Error ? error.message : String(error)}`; }
  const { env, timeoutMs, maxOutputBytes, cleanup: cleanupSandboxTemp } = prepared;
  const networkWrapped = prepared;
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
      if (child.pid) prepared.onSpawn?.(child.pid);
    } catch (error: unknown) {
      if (child?.pid) {
        try { prepared.cancel?.(); } catch { /* A lease write failure must not prevent killing the owned process. */ }
        child.once("close", cleanupSandboxTemp);
        try { processGroupKill(child.pid, "SIGKILL"); } catch { /* Already closed. */ }
      } else cleanupSandboxTemp();
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
    const finish = (result: string, preserveForceKill = false, deferCleanup = false) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKill && !preserveForceKill) clearTimeout(forceKill);
      options.signal?.removeEventListener("abort", abort);
      if (!deferCleanup) cleanupSandboxTemp();
      resolve(result.slice(0, maxOutputBytes));
    };
    const terminate = () => {
      try { if (prepared.cancel) prepared.cancel(); else cleanupSandboxTemp(); }
      catch { /* Cancellation markers are best effort; still terminate the process. */ }
      try { processGroupKill(child.pid, "SIGTERM"); } catch { /* already unavailable */ }
      forceKill = setTimeout(() => {
        try { processGroupKill(child.pid, "SIGKILL"); } catch { /* already unavailable */ }
      }, 1_000);
      forceKill.unref?.();
    };
    const abort = () => { terminate(); finish("Error: Stopped during process execution", true, Boolean(prepared.cancel)); };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    options.signal?.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(() => { terminate(); const trimmed = output.trim(); finish(`Error: Timeout (${timeoutMs}ms)${trimmed ? `\n${trimmed}` : ""}`, true, Boolean(prepared.cancel)); }, timeoutMs);
    timeout.unref?.();
    child.on("error", (error) => finish(`Error: ${error.message}`));
    child.on("close", (code) => {
      cleanupSandboxTemp();
      const trimmed = output.trim();
      if (code === 0) finish(trimmed || "(no output)");
      else finish(`Error: Process exited with code ${code ?? "unknown"}${trimmed ? `\n${trimmed}` : ""}`);
    });
  });
}
