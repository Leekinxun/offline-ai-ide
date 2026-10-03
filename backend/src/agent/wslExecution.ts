import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PreparedWorkspaceProcess, WorkspaceProcessOptions } from "./processSandbox.js";

export type WslExecutionReasonCode =
  | "ready"
  | "wsl_missing"
  | "distro_unavailable"
  | "wsl2_required"
  | "node_missing"
  | "root_user"
  | "helper_missing"
  | "helper_not_built"
  | "isolation_unavailable"
  | "probe_failed"
  | "case_sensitive_required"
  | "unsupported_workspace"
  | "invalid_configuration";

export interface WslExecutionCapability {
  available: boolean;
  executor: "wsl";
  distro?: string;
  reason?: string;
  reasonCode?: WslExecutionReasonCode;
}

interface WslManifest {
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

interface WslExecutionHooks {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawnSync?: typeof childProcess.spawnSync;
  spawn?: typeof childProcess.spawn;
  now?: () => number;
  helperHostPath?: string;
  wslExecutablePath?: string;
  tempRoot?: string;
  setInterval?: typeof setInterval;
  setTimeout?: typeof setTimeout;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 50_000;
const PROBE_CACHE_MS = 30_000;
const PROBE_TIMEOUT_MS = 20_000;
const FIXED_LINUX_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const PROTECTED_WORKSPACE_NAMES = [".git", ".codex", ".history", ".checkpoints", ".crewforge", ".ssh", ".npmrc", ".pypirc", ".netrc"] as const;
const BLOCKED_ENV = /^(?:PATH|HOME|TMPDIR|TEMP|TMP|ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z_]+|BASH_ENV|ENV|PYTHONPATH|RUBYOPT|PERL5OPT)$/;

let hooks: WslExecutionHooks = {};
let cachedProbe: { at: number; capability: WslExecutionCapability } | undefined;
let pendingProbe: Promise<WslExecutionCapability> | undefined;

export function setWslExecutionTestHooks(next: WslExecutionHooks | undefined): void {
  hooks = next ?? {};
  cachedProbe = undefined;
  pendingProbe = undefined;
}

function platform(): NodeJS.Platform { return hooks.platform ?? process.platform; }
function environment(): NodeJS.ProcessEnv { return hooks.env ?? process.env; }
function spawnSync(...args: Parameters<typeof childProcess.spawnSync>): childProcess.SpawnSyncReturns<string | Buffer> {
  return (hooks.spawnSync ?? childProcess.spawnSync)(...args);
}
function spawnProcess(...args: Parameters<typeof childProcess.spawn>): childProcess.ChildProcess {
  return (hooks.spawn ?? childProcess.spawn)(...args);
}
function now(): number { return hooks.now ? hooks.now() : Date.now(); }
function timerSetInterval(callback: () => void, ms: number): NodeJS.Timeout {
  return (hooks.setInterval ?? setInterval)(callback, ms) as NodeJS.Timeout;
}
function timerSetTimeout(callback: () => void, ms: number): NodeJS.Timeout {
  return (hooks.setTimeout ?? setTimeout)(callback, ms) as NodeJS.Timeout;
}

function selectedDistro(): string | undefined {
  const distro = environment().CROWNFORGE_WSL_DISTRO?.trim();
  if (!distro) return undefined;
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(distro)) throw new Error("Invalid CROWNFORGE_WSL_DISTRO");
  return distro;
}

function wslArgs(prefix: string[] = []): string[] {
  const distro = selectedDistro();
  return distro ? ["--distribution", distro, ...prefix] : prefix;
}

function minimalWindowsEnvironment(): Record<string, string> {
  const source = environment();
  const result: Record<string, string> = {};
  // WSL user registration and the fixed PowerShell metadata reader need the
  // Windows profile/temp directories. env -i removes them on the Linux side.
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) {
    const value = source[key];
    if (value) result[key] = value;
  }
  const pathValue = source.SystemRoot ? `${source.SystemRoot}\\System32;${source.SystemRoot}` : source.PATH;
  if (pathValue) result.PATH = pathValue;
  return result;
}

function system32Executable(name: string): string {
  if (hooks.wslExecutablePath && name === "wsl.exe") return hooks.wslExecutablePath;
  const root = environment().SystemRoot || environment().WINDIR;
  if (!root) throw new Error("Windows SystemRoot is unavailable; cannot locate trusted system executables");
  if (!path.win32.isAbsolute(root) || root.includes("\0")) throw new Error("Windows SystemRoot must be an absolute system directory");
  return path.win32.join(root, "System32", name);
}

function fail(reasonCode: WslExecutionReasonCode, reason: string): WslExecutionCapability {
  const distro = (() => { try { return selectedDistro(); } catch { return undefined; } })();
  return { available: false, executor: "wsl", ...(distro ? { distro } : {}), reasonCode, reason };
}

function sanitizeDiagnostic(value: unknown): string {
  const text = typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : "";
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim().slice(0, 2_048);
}

function classifyWslSpawnFailure(result: childProcess.SpawnSyncReturns<string | Buffer>): WslExecutionCapability {
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const stderr = sanitizeDiagnostic(result.stderr);
  const output = stderr || sanitizeDiagnostic(result.stdout);
  if (errorCode === "ENOENT") {
    return fail("wsl_missing", "WSL is not installed or wsl.exe is unavailable. Install WSL2 with `wsl --install`, restart if prompted, then install or set a default Linux distribution.");
  }
  if (/distribution.*not.*found|no installed distributions|specified distribution/i.test(output)) {
    return fail("distro_unavailable", output || "The selected WSL distribution is unavailable. Install a distribution with `wsl --install -d Ubuntu` or set CROWNFORGE_WSL_DISTRO to an installed WSL2 distro.");
  }
  return fail("probe_failed", output || (errorCode ? `wsl.exe failed with ${errorCode}` : `wsl.exe exited with code ${result.status ?? "unknown"}`));
}

function classifyWslProcessFailure(output: string, error: NodeJS.ErrnoException | undefined, code: number | null, signal: NodeJS.Signals | null): WslExecutionCapability {
  if (error?.code === "ENOENT") {
    return fail("wsl_missing", "WSL is not installed or wsl.exe is unavailable. Install WSL2 with `wsl --install`, restart if prompted, then install or set a default Linux distribution.");
  }
  const diagnostic = sanitizeDiagnostic(output);
  if (((code === 126 || code === 127) && diagnostic.includes("/usr/bin/node")) || /Node\.js v(?:\d|1[0-7])\./.test(diagnostic)) {
    return fail("node_missing", "The WSL distribution requires Node.js 18 or later at /usr/bin/node");
  }
  if (/distribution.*not.*found|no installed distributions|specified distribution/i.test(diagnostic)) {
    return fail("distro_unavailable", diagnostic || "The selected WSL distribution is unavailable. Install a distribution with `wsl --install -d Ubuntu` or set CROWNFORGE_WSL_DISTRO to an installed WSL2 distro.");
  }
  if (error?.code === "ETIMEDOUT" || signal) return fail("probe_failed", `WSL probe timed out or was stopped${diagnostic ? `: ${diagnostic}` : ""}`);
  return fail("probe_failed", diagnostic || (error?.code ? `wsl.exe failed with ${error.code}` : `wsl.exe exited with code ${code ?? "unknown"}`));
}

function helperHostPath(): string {
  if (hooks.helperHostPath) return hooks.helperHostPath;
  const current = fileURLToPath(import.meta.url);
  if (current.endsWith(`${path.sep}dist${path.sep}agent${path.sep}wslExecution.js`)) {
    return path.join(path.dirname(current), "wslHelper.js");
  }
  const srcMarker = `${path.sep}src${path.sep}agent${path.sep}wslExecution.`;
  if (current.includes(srcMarker)) {
    return current.replace(`${path.sep}src${path.sep}agent${path.sep}wslExecution.ts`, `${path.sep}dist${path.sep}agent${path.sep}wslHelper.js`)
      .replace(`${path.sep}src${path.sep}agent${path.sep}wslExecution.js`, `${path.sep}dist${path.sep}agent${path.sep}wslHelper.js`);
  }
  return path.join(path.dirname(current), "wslHelper.js");
}

function requireBuiltHelper(): string {
  const helper = path.resolve(helperHostPath());
  if (!helper.endsWith(`${path.sep}dist${path.sep}agent${path.sep}wslHelper.js`) && !hooks.helperHostPath) {
    throw new Error("WSL helper path is invalid; expected backend/dist/agent/wslHelper.js");
  }
  if (!fs.existsSync(helper)) {
    throw new Error("WSL helper is unavailable at backend/dist/agent/wslHelper.js. Run `npm run build` for the backend before enabling Windows Agent Bash.");
  }
  return fs.realpathSync.native(helper);
}

function convertWindowsPathToWsl(windowsPath: string): string {
  const result = spawnSync(system32Executable("wsl.exe"), wslArgs(["--exec", "/usr/bin/wslpath", "-a", "-u", windowsPath]), {
    encoding: "utf8",
    env: minimalWindowsEnvironment(),
    timeout: 5_000,
    maxBuffer: 4_096,
  });
  if (result.status !== 0 || result.error) {
    const capability = classifyWslSpawnFailure(result);
    throw new Error(capability.reason ?? "Unable to convert Windows path for WSL");
  }
  const converted = String(result.stdout || "").trim();
  if (!converted.startsWith("/") || converted.includes("\0")) throw new Error("wslpath returned an invalid Linux path");
  return converted;
}

function isNativeWindowsPath(candidate: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(candidate);
}

function powershellEncoded(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function queryWindowsCaseSensitiveDirectory(directory: string): boolean | undefined {
  if (!isNativeWindowsPath(directory)) return undefined;
  const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$source = @"
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class CaseInfo {
  [DllImport("kernel32.dll", EntryPoint="CreateFileW", ExactSpelling=true, CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern SafeFileHandle CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetFileInformationByHandleEx(SafeFileHandle hFile, int FileInformationClass, out FILE_CASE_SENSITIVE_INFO lpFileInformation, uint dwBufferSize);
  [StructLayout(LayoutKind.Sequential)]
  public struct FILE_CASE_SENSITIVE_INFO { public uint Flags; }
}
"@
Add-Type -TypeDefinition $source
$dir = $env:CROWNFORGE_WSL_CASE_DIR
if ([string]::IsNullOrWhiteSpace($dir)) { exit 2 }
$handle = [CaseInfo]::CreateFileW($dir, 0x80, 7, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
if ($handle.IsInvalid) { exit 2 }
$info = New-Object CaseInfo+FILE_CASE_SENSITIVE_INFO
$ok = [CaseInfo]::GetFileInformationByHandleEx($handle, 23, [ref]$info, 4)
$handle.Dispose()
if (-not $ok) { exit 2 }
if (($info.Flags -band 1) -eq 1) { [Console]::Out.Write('1') } else { [Console]::Out.Write('0') }
`;
  const result = spawnSync(system32Executable("WindowsPowerShell\\v1.0\\powershell.exe"), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", powershellEncoded(script)], {
    encoding: "utf8",
    env: { ...minimalWindowsEnvironment(), CROWNFORGE_WSL_CASE_DIR: directory },
    timeout: 5_000,
    maxBuffer: 8_192,
  });
  if (result.status !== 0 || result.error) return false;
  return String(result.stdout || "").trim() === "1";
}

function pathContains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function pathsIntersect(left: string, right: string): boolean {
  return left === right || pathContains(left, right) || pathContains(right, left);
}

function assertOutsideGrantedTrees(label: string, candidate: string, roots: readonly string[]): void {
  for (const root of roots) {
    if (pathsIntersect(root, candidate)) {
      throw new Error(`${label} must live outside Agent filesystem grants`);
    }
  }
}

function trustedBackendRoot(helper: string): string {
  const agentDir = path.dirname(helper);
  return path.basename(agentDir) === "agent" ? path.dirname(agentDir) : agentDir;
}

function posixRelative(root: string, candidate: string): string {
  const relative = isNativeWindowsPath(root) || isNativeWindowsPath(candidate) ? path.win32.relative(root, candidate) : path.relative(root, candidate);
  return relative ? relative.replace(/\\/g, "/") : ".";
}

function validateControlAndHelperPlacement(controlDirectory: string, helper: string, workspaceDir: string, writeRoots: readonly string[]): void {
  const workspace = fs.realpathSync.native(path.resolve(workspaceDir));
  const control = fs.realpathSync.native(path.resolve(controlDirectory));
  const trustedRoot = fs.realpathSync.native(trustedBackendRoot(helper));
  assertOutsideGrantedTrees("WSL control directory", control, [workspace, ...writeRoots]);
  assertOutsideGrantedTrees("WSL trusted backend runtime", trustedRoot, [workspace, ...writeRoots]);
}

function validateEnvironment(extra: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || BLOCKED_ENV.test(key) || typeof value !== "string" || value.includes("\0")) {
      throw new Error("Process environment contains a blocked or invalid variable");
    }
    env[key] = value;
  }
  return env;
}

function validateLimits(limits: WorkspaceProcessOptions["limits"]): void {
  if (!limits) return;
  for (const [name, value] of Object.entries(limits)) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`Invalid ${name}`);
  }
}

function literalWorkspacePath(root: string, candidate: string): string {
  if (!candidate || /[*?{}[\]]/.test(candidate)) throw new Error("Filesystem grants must be literal workspace paths");
  const resolved = path.resolve(root, candidate);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("Filesystem grant escapes workspace");
  let cursor = root;
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    if (isCaseAmbiguousProtectedName(segment)) throw new Error("Filesystem grant targets a case-ambiguous protected path");
    cursor = path.join(cursor, segment);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error("Filesystem grants cannot traverse symlinks");
  }
  return resolved;
}

function isCaseAmbiguousProtectedName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === ".env" || lower.startsWith(".env.")) return name !== lower;
  return PROTECTED_WORKSPACE_NAMES.some((protectedName) => lower === protectedName && name !== protectedName);
}

function assertNoCaseAmbiguousProtectedEntries(workspaceDir: string): void {
  let entries: string[];
  try { entries = fs.readdirSync(workspaceDir); } catch { return; }
  for (const entry of entries) {
    if (isCaseAmbiguousProtectedName(entry)) {
      throw new Error("Workspace contains a case-ambiguous protected path; rename it before enabling WSL Agent Bash.");
    }
  }
}

function compileManifestFilesystem(options: WorkspaceProcessOptions): { filesystem?: NonNullable<WslManifest["options"]>["filesystem"]; writeRoots: string[] } {
  const grant = options.filesystem;
  if (!grant) return { writeRoots: [] };
  const workspace = fs.realpathSync.native(path.resolve(grant.workspaceDir || options.cwd));
  assertNoCaseAmbiguousProtectedEntries(workspace);
  const read = Array.from(new Set((grant.readPaths ?? []).map((item) => literalWorkspacePath(workspace, item))));
  const write = Array.from(new Set((grant.writePaths ?? []).map((item) => literalWorkspacePath(workspace, item))));
  const roots = Array.from(new Set([...read, ...write])).map((item) => fs.existsSync(item) ? fs.realpathSync.native(item) : item);
  const filesystem = {
    workspaceDir: workspace,
    readPaths: read.map((item) => posixRelative(workspace, item)),
    writePaths: write.map((item) => posixRelative(workspace, item)),
  };
  return { filesystem, writeRoots: roots };
}

function prepareManifest(options: WorkspaceProcessOptions, controlPath: string): { manifest: WslManifest; workspace: string; writeRoots: string[] } {
  const executable = options.executable.trim();
  if (!executable || executable.includes("\0")) throw new Error("Invalid executable");
  const args = options.args ?? [];
  if (!args.every((arg) => typeof arg === "string" && !arg.includes("\0"))) throw new Error("Invalid process arguments");
  if (options.signal?.aborted) throw new Error("Stopped before process execution");
  validateLimits(options.limits);
  const env = validateEnvironment(options.env);
  const { filesystem, writeRoots } = compileManifestFilesystem(options);
  const workspace = filesystem?.workspaceDir ?? fs.realpathSync.native(path.resolve(options.cwd));
  const hostCaseSensitiveWorkspace = queryWindowsCaseSensitiveDirectory(workspace);
  if (hostCaseSensitiveWorkspace === false && isNativeWindowsPath(workspace)) {
    throw new Error("WSL Agent Bash requires a case-sensitive Windows workspace directory. Enable it with `fsutil file setCaseSensitiveInfo <workspace> enable` from an elevated shell, or use a WSL Linux filesystem workspace.");
  }
  const cwd = fs.realpathSync.native(path.resolve(options.cwd));
  if (cwd !== workspace && !cwd.startsWith(`${workspace}${path.sep}`)) throw new Error("Process cwd escapes filesystem policy workspace");
  const manifest: WslManifest = {
    version: 1,
    op: "execute",
    controlPath,
    options: {
      executable,
      args: [...args],
      cwd,
      env,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      limits: options.limits,
      resourceLimitMode: options.resourceLimitMode,
      networkMode: options.networkMode,
      ...(hostCaseSensitiveWorkspace === undefined ? {} : { hostCaseSensitiveWorkspace }),
      ...(filesystem ? { filesystem } : {}),
    },
  };
  return { manifest, workspace, writeRoots };
}

function writeJsonAtomic(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function makeControlDirectory(): string {
  const root = hooks.tempRoot ? fs.realpathSync.native(path.resolve(hooks.tempRoot)) : os.tmpdir();
  return fs.realpathSync.native(fs.mkdtempSync(path.join(root, "crewforge-wsl-")));
}

function makeWslCommand(helperLinuxPath: string, manifestLinuxPath: string): { executable: string; args: string[] } {
  return {
    executable: system32Executable("wsl.exe"),
    args: wslArgs(["--exec", "/usr/bin/env", "-i", `PATH=${FIXED_LINUX_PATH}`, "HOME=/tmp", "LANG=C.UTF-8", "/usr/bin/node", helperLinuxPath, manifestLinuxPath]),
  };
}

function toCapabilityFromThrown(error: unknown): WslExecutionCapability {
  const message = error instanceof Error ? error.message : String(error);
  if (/helper is unavailable|npm run build|backend\/dist\/agent\/wslHelper\.js/i.test(message)) return fail("helper_not_built", message);
  if (/WSL is not installed|wsl\.exe is unavailable|wsl --install/i.test(message)) return fail("wsl_missing", message);
  if (/distribution.*not.*found|no installed distributions|selected WSL distribution/i.test(message)) return fail("distro_unavailable", message);
  if (/case-sensitive|case sensitive|case-masked/i.test(message)) return fail("case_sensitive_required", message);
  if (/outside Agent filesystem grants|escapes filesystem|case-ambiguous|symlink|workspace/i.test(message)) return fail("unsupported_workspace", message);
  if (/CROWNFORGE_WSL_DISTRO/i.test(message)) return fail("invalid_configuration", message);
  return fail("probe_failed", message);
}

function runWslProbeProcess(command: { executable: string; args: string[] }): Promise<WslExecutionCapability> {
  return new Promise((resolve) => {
    let child: childProcess.ChildProcess;
    try {
      child = spawnProcess(command.executable, command.args, {
        env: minimalWindowsEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve(classifyWslProcessFailure("", error as NodeJS.ErrnoException, null, null));
      return;
    }
    let output = "";
    let settled = false;
    const append = (chunk: Buffer) => {
      if (Buffer.byteLength(output) < 8_192) output += chunk.toString("utf8").slice(0, 8_192 - Buffer.byteLength(output));
    };
    const finish = (capability: WslExecutionCapability) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(capability);
    };
    const timeout = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish(fail("probe_failed", "WSL execution probe timed out after 20000ms"));
    }, PROBE_TIMEOUT_MS);
    timeout.unref?.();
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => finish(classifyWslProcessFailure(output, error as NodeJS.ErrnoException, null, null)));
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0 || signal) {
        const raw = sanitizeDiagnostic(output);
        try {
          const parsed = raw ? JSON.parse(raw) as Partial<WslExecutionCapability> : undefined;
          if (parsed?.reasonCode) finish({ available: false, executor: "wsl", reasonCode: parsed.reasonCode as WslExecutionReasonCode, reason: parsed.reason ?? raw });
          else finish(classifyWslProcessFailure(raw, undefined, code, signal));
        } catch {
          finish(classifyWslProcessFailure(raw, undefined, code, signal));
        }
        return;
      }
      try {
        const parsed = JSON.parse(String(output || "{}")) as Partial<WslExecutionCapability>;
        finish({
          available: parsed.available === true,
          executor: "wsl",
          ...(selectedDistro() ? { distro: selectedDistro() } : {}),
          reasonCode: parsed.reasonCode as WslExecutionReasonCode | undefined,
          reason: parsed.reason,
        });
      } catch (error) {
        finish(fail("probe_failed", `WSL probe returned invalid JSON: ${sanitizeDiagnostic((error as Error).message)}`));
      }
    });
  });
}

export async function probeWslExecution(options: { refresh?: boolean } = {}): Promise<WslExecutionCapability> {
  if (platform() !== "win32" && !hooks.platform) {
    return fail("invalid_configuration", `WSL Agent execution is only available from the Windows desktop backend; current platform is ${process.platform}`);
  }
  const cached = cachedProbe;
  if (!options.refresh && cached && now() - cached.at < PROBE_CACHE_MS) return structuredClone(cached.capability);
  if (pendingProbe) return structuredClone(await pendingProbe);
  const operation = (async () => {
  let capability: WslExecutionCapability;
  let controlDir: string | undefined;
  try {
    const helper = requireBuiltHelper();
    const helperLinux = convertWindowsPathToWsl(helper);
    controlDir = makeControlDirectory();
    const manifestPath = path.join(controlDir, "manifest.json");
    const controlPath = path.join(controlDir, "control.json");
    writeJsonAtomic(controlPath, { counter: 1, stop: false });
    writeJsonAtomic(manifestPath, { version: 1, op: "probe", controlPath } satisfies WslManifest);
    const manifestLinux = convertWindowsPathToWsl(manifestPath);
    const command = makeWslCommand(helperLinux, manifestLinux);
    capability = await runWslProbeProcess(command);
  } catch (error) {
    capability = toCapabilityFromThrown(error);
  } finally {
    if (controlDir) fs.rmSync(controlDir, { recursive: true, force: true });
  }
  cachedProbe = { at: now(), capability };
  return capability;
  })();
  pendingProbe = operation;
  try { return structuredClone(await operation); }
  finally { if (pendingProbe === operation) pendingProbe = undefined; }
}

export function prepareWslWorkspaceProcess(options: WorkspaceProcessOptions): PreparedWorkspaceProcess {
  if (platform() !== "win32" && !hooks.platform) throw new Error(`WSL Agent execution is only available from the Windows desktop backend; current platform is ${process.platform}`);
  const helper = requireBuiltHelper();
  const helperLinux = convertWindowsPathToWsl(helper);
  const controlDir = makeControlDirectory();
  const controlPath = path.join(controlDir, "control.json");
  const manifestPath = path.join(controlDir, "manifest.json");
  try {
    writeJsonAtomic(controlPath, { counter: 1, stop: false });
    const { manifest, workspace, writeRoots } = prepareManifest(options, controlPath);
    validateControlAndHelperPlacement(controlDir, helper, workspace, writeRoots);
    writeJsonAtomic(manifestPath, manifest);
    const manifestLinux = convertWindowsPathToWsl(manifestPath);
    const command = makeWslCommand(helperLinux, manifestLinux);
    let stopped = false;
    let counter = 1;
    const heartbeat = timerSetInterval(() => {
      if (stopped) return;
      try { writeJsonAtomic(controlPath, { counter: ++counter, stop: false }); }
      catch { /* helper will fail closed when heartbeat disappears */ }
    }, 500);
    heartbeat.unref?.();
    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeat);
      try { writeJsonAtomic(controlPath, { counter, stop: true }); } catch { /* best effort */ }
      const remover = timerSetTimeout(() => {
        try { fs.rmSync(controlDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
        catch { /* A locked cleanup file must not crash the desktop backend. */ }
      }, 30_000);
      remover.unref?.();
    };
    return {
      executable: command.executable,
      args: command.args,
      env: minimalWindowsEnvironment(),
      timeoutMs: options.limits?.wallTimeMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      cleanup,
    };
  } catch (error) {
    fs.rmSync(controlDir, { recursive: true, force: true });
    throw error;
  }
}

export const __wslExecutionForTests = {
  convertWindowsPathToWsl,
  minimalWindowsEnvironment,
  posixRelative,
  prepareManifest,
  classifyWslProcessFailure,
};
