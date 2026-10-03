import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexSandboxClient, type CodexSandboxRpcClient } from "./codexSandboxClient.js";
import type { PreparedWorkspaceProcess, WorkspaceProcessOptions } from "./processSandbox.js";

export const WINDOWS_NATIVE_RUNTIME_VERSION = "0.160.0" as const;
const MANIFEST_NAME = "crownforge-codex-runtime.json";
const REQUIRED_FILES = ["bin/codex.exe", "bin/codex-code-mode-host.exe", "codex-resources/codex-command-runner.exe", "codex-resources/codex-windows-sandbox-setup.exe", "codex-path/rg.exe", "codex-package.json"];
const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONTROL_NAMES = new Set([".git", ".codex", ".history", ".checkpoints", ".crewforge"]);
const SECRET_NAMES = new Set([".ssh", ".aws", ".azure", ".kube", ".docker", ".npmrc", ".pypirc", ".netrc", ".git-credentials"]);
const DENY_REGISTRY_NAME = "protected-read-paths.json";
const EXECUTION_LEASE_NAME = "execution-lease.json";
const SAFE_ENV = new Set(["SYSTEMROOT", "WINDIR", "COMSPEC", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "USERNAME", "USERDOMAIN", "COMPUTERNAME", "PATHEXT", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "TEMP", "TMP", "PATH", "CI", "NO_COLOR", "FORCE_COLOR"]);
type SandboxMode = "elevated" | "unelevated";

export interface WindowsNativeSandboxCapability {
  available: boolean;
  executor: "windows-native";
  shell: "powershell";
  status: "ready" | "notConfigured" | "updateRequired" | "unsupported" | "missingRuntime" | "error";
  reasonCode?: string;
  reason?: string;
  sandboxMode: SandboxMode;
  runtimeVersion: typeof WINDOWS_NATIVE_RUNTIME_VERSION;
  weakerNetworkIsolation: boolean;
}

interface NativeLocations { backendRoot: string; runtimeRoot: string; home: string; scriptsRoot: string; privateFiles: string[] }
interface VerifiedRuntime { root: string; executable: string; fingerprint: string }
interface NativeHooks {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  backendRoot?: string;
  runtimeRoot?: string;
  stateHome?: string;
  privateFiles?: string[];
  powershellExecutable?: string;
  sandboxMode?: SandboxMode;
  spawn?: typeof childProcess.spawn;
  clientFactory?: (options: ConstructorParameters<typeof CodexSandboxClient>[0]) => CodexSandboxRpcClient;
  processAlive?: (pid: number) => boolean;
}
let hooks: NativeHooks = {};
let locations: NativeLocations | undefined;
let verifiedRuntime: VerifiedRuntime | undefined;
let readiness: { fingerprint: string; mode: SandboxMode; available: boolean } | undefined;
let pendingProbe: Promise<WindowsNativeSandboxCapability> | undefined;
let setupPending = false;
interface NativeLeaseRecord { version: 1; backendPid: number; supervisorPid?: number; nonce: string; cancelled?: boolean }
interface NativeLease { cancel: () => void; onSpawn: (pid: number) => void; release: () => void }

export function setWindowsNativeSandboxTestHooks(value: NativeHooks | undefined): void {
  hooks = value ?? {}; locations = undefined; verifiedRuntime = undefined; readiness = undefined; pendingProbe = undefined; setupPending = false;
}
function platform(): NodeJS.Platform { return hooks.platform ?? process.platform; }
function environment(): NodeJS.ProcessEnv { return hooks.env ?? process.env; }
function sourceValue(key: string): string | undefined {
  const source = environment(); return source[Object.keys(source).find((candidate) => candidate.toUpperCase() === key.toUpperCase()) ?? key];
}
function sandboxMode(): SandboxMode {
  if (hooks.sandboxMode) return hooks.sandboxMode;
  const override = sourceValue("CROWNFORGE_WINDOWS_SANDBOX_MODE");
  if (override !== undefined) {
    if (override !== "elevated" && override !== "unelevated") throw new Error("Invalid Windows sandbox mode");
    return override;
  }
  if (!locations) return "elevated";
  const settingsFile = path.join(path.dirname(locations.home), "agent-execution.json");
  if (!fs.existsSync(settingsFile)) return "elevated";
  const stat = fs.lstatSync(settingsFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("Invalid Windows execution settings");
  const value: unknown = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  const mode = value && typeof value === "object" ? (value as Record<string, unknown>).sandboxMode : undefined;
  if (mode !== "elevated" && mode !== "unelevated") throw new Error("Invalid Windows sandbox mode");
  return mode;
}
function capability(status: WindowsNativeSandboxCapability["status"], reasonCode?: string, reason?: string): WindowsNativeSandboxCapability {
  let mode: SandboxMode = "elevated";
  try { mode = sandboxMode(); } catch { /* invalid configuration is reported by the caller */ }
  return { available: status === "ready", executor: "windows-native", shell: "powershell", status, sandboxMode: mode,
    runtimeVersion: WINDOWS_NATIVE_RUNTIME_VERSION, weakerNetworkIsolation: mode === "unelevated", ...(reasonCode ? { reasonCode } : {}), ...(reason ? { reason } : {}) };
}
function comparePath(value: string): string { return path.resolve(value).replaceAll("\\", "/").replace(/\/$/, "").toLowerCase(); }
function inside(candidate: string, root: string): boolean { const c = comparePath(candidate); const r = comparePath(root); return c === r || c.startsWith(`${r}/`); }
function overlaps(a: string, b: string): boolean { return inside(a, b) || inside(b, a); }
function rejectSymlinkComponents(value: string): void {
  const absolute = path.resolve(value); let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("Windows sandbox control paths cannot traverse symlinks or junctions"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
function makePrivateDirectory(value: string): string {
  rejectSymlinkComponents(value); fs.mkdirSync(value, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(value).isDirectory()) throw new Error("Invalid Windows sandbox control directory");
  return fs.realpathSync.native(value);
}
function pidAlive(pid: number): boolean {
  if (hooks.processAlive) return hooks.processAlive(pid);
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; return true; }
}
function readNativeLease(file: string): NativeLeaseRecord {
  rejectSymlinkComponents(file); const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("Invalid Windows sandbox execution lease");
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Windows sandbox execution lease");
  const record = value as NativeLeaseRecord;
  if (record.version !== 1 || !Number.isSafeInteger(record.backendPid) || record.backendPid <= 0 || !/^[a-f0-9]{32}$/.test(record.nonce) ||
    record.supervisorPid !== undefined && (!Number.isSafeInteger(record.supervisorPid) || record.supervisorPid <= 0)) throw new Error("Invalid Windows sandbox execution lease");
  return record;
}
function acquireNativeLease(local: NativeLocations): NativeLease {
  const file = path.join(local.home, EXECUTION_LEASE_NAME); rejectSymlinkComponents(file);
  const record: NativeLeaseRecord = { version: 1, backendPid: process.pid, nonce: crypto.randomBytes(16).toString("hex") };
  let acquired = false;
  for (let attempt = 0; attempt < 3 && !acquired; attempt++) {
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`); acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const previous = readNativeLease(file);
      // A missing supervisor cannot prove that a backend did not crash in the
      // small spawn/registration window. Never recover that uncertain lease.
      if (pidAlive(previous.backendPid) || previous.supervisorPid === undefined || pidAlive(previous.supervisorPid)) {
        throw new Error("Windows native Agent execution is busy; wait for its current command and process cleanup");
      }
      // Serialize reclaimers by the old nonce. Re-read inside that critical
      // section so a competing restart cannot unlink a newly acquired lease.
      const reclaim = path.join(local.home, `.execution-reclaim-${previous.nonce}`);
      let reclaimDescriptor: number;
      try { reclaimDescriptor = fs.openSync(reclaim, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
      catch { throw new Error("Windows native execution lease recovery is busy; retry after process cleanup"); }
      try {
        fs.writeFileSync(reclaimDescriptor, String(process.pid));
        const current = readNativeLease(file);
        if (current.nonce === previous.nonce && !pidAlive(current.backendPid) && current.supervisorPid !== undefined && !pidAlive(current.supervisorPid)) fs.rmSync(file);
      } finally { fs.closeSync(reclaimDescriptor); fs.rmSync(reclaim, { force: true }); }
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }
  if (!acquired) throw new Error("Windows native Agent execution is busy");
  let released = false;
  const update = () => {
    if (released) throw new Error("Windows native execution lease is closed");
    const current = readNativeLease(file);
    if (current.nonce !== record.nonce || current.backendPid !== record.backendPid) throw new Error("Windows native execution lease ownership changed");
    const temporary = path.join(local.home, `.execution-lease-${record.nonce}.tmp`);
    try { fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, file); }
    finally { fs.rmSync(temporary, { force: true }); }
  };
  return {
    cancel: () => { if (released || record.cancelled) return; record.cancelled = true; update(); },
    onSpawn: (pid) => { if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid native supervisor PID"); record.supervisorPid = pid; update(); },
    release: () => {
      if (released) return;
      const current = readNativeLease(file);
      if (current.nonce !== record.nonce || current.backendPid !== record.backendPid) throw new Error("Windows native execution lease ownership changed");
      fs.rmSync(file); released = true;
    },
  };
}
async function resolveLocations(): Promise<NativeLocations> {
  if (locations) return locations;
  let home: string; let privateFiles: string[];
  if (hooks.stateHome) { home = hooks.stateHome; privateFiles = hooks.privateFiles ?? []; }
  else {
    // Config is loaded only after an explicit capability read/setup, never at module import.
    const { config } = await import("../config.js");
    home = path.join(path.dirname(config.appSettingsPath), "codex-native-sandbox");
    privateFiles = [config.appSettingsPath, path.resolve(config.usersConfigPath), path.join(path.dirname(config.appSettingsPath), "agent-execution.json")];
  }
  const backendRoot = fs.realpathSync.native(hooks.backendRoot ?? BACKEND_ROOT);
  const arch = hooks.arch ?? process.arch;
  if (arch !== "x64" && arch !== "arm64") throw new Error("The Windows sandbox runtime does not support this architecture");
  const runtimeRoot = path.resolve(hooks.runtimeRoot ?? path.join(backendRoot, "vendor", "codex", `win-${arch}`));
  rejectSymlinkComponents(home); rejectSymlinkComponents(runtimeRoot);
  const absoluteHome = path.resolve(home);
  // Missing App-owned config files are guarded through their existing parent.
  // Scripts therefore live beside the settings directory, not beneath it.
  const scriptNamespace = crypto.createHash("sha256").update(comparePath(absoluteHome)).digest("hex").slice(0, 16);
  locations = { backendRoot, runtimeRoot, home: absoluteHome, scriptsRoot: path.join(path.dirname(path.dirname(absoluteHome)), `codex-native-scripts-${scriptNamespace}`), privateFiles: privateFiles.map((file) => path.resolve(file)) };
  return locations;
}
function runtimeFingerprint(root: string, files: string[]): string {
  return files.map((relative) => {
    const file = path.join(root, ...relative.split("/")); rejectSymlinkComponents(file);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("The Windows sandbox package contains an invalid file");
    return `${relative}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  }).join("|");
}
function requireRuntime(local: NativeLocations): VerifiedRuntime {
  const root = local.runtimeRoot;
  const file = path.join(root, MANIFEST_NAME); rejectSymlinkComponents(file);
  if (!fs.existsSync(file)) throw new Error("The bundled Windows sandbox runtime is missing; reinstall the App or prepare its pinned Codex runtime");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) throw new Error("Invalid Windows sandbox runtime manifest");
  const manifest: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Invalid Windows sandbox runtime manifest");
  const data = manifest as Record<string, unknown>;
  const arch = hooks.arch ?? process.arch;
  if (data.schemaVersion !== 1 || data.runtimeVersion !== WINDOWS_NATIVE_RUNTIME_VERSION || data.platform !== "win32" || data.arch !== arch || !data.files || typeof data.files !== "object" || Array.isArray(data.files)) {
    throw new Error("The Windows sandbox runtime must be the pinned Codex 0.160.0 package for this architecture");
  }
  const files = data.files as Record<string, unknown>;
  if (REQUIRED_FILES.some((required) => typeof files[required] !== "string")) throw new Error("The Windows sandbox runtime package is incomplete");
  const names = Object.keys(files).sort();
  if (names.length > 10_000 || names.some((relative) => !relative || relative.startsWith("/") || relative.includes("\\") || relative.includes(":") || relative.includes("\0") || relative.split("/").some((part) => !part || part === "." || part === "..") || !/^[a-f0-9]{64}$/.test(String(files[relative])))) {
    throw new Error("Invalid Windows sandbox runtime file inventory");
  }
  const fingerprint = crypto.createHash("sha256").update(fs.readFileSync(file)).update(runtimeFingerprint(root, [MANIFEST_NAME, ...names])).digest("hex");
  if (verifiedRuntime?.fingerprint === fingerprint && verifiedRuntime.root === root) return verifiedRuntime;
  for (const relative of names) {
    const hash = crypto.createHash("sha256"); const descriptor = fs.openSync(path.join(root, ...relative.split("/")), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { const buffer = Buffer.alloc(1_048_576); let size: number; while ((size = fs.readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, size)); }
    finally { fs.closeSync(descriptor); }
    if (hash.digest("hex") !== files[relative]) throw new Error("The Windows sandbox runtime failed its integrity check; reinstall the App");
  }
  verifiedRuntime = { root, executable: path.join(root, "bin", "codex.exe"), fingerprint }; return verifiedRuntime;
}
export function windowsNativePowerShellExecutable(): string {
  if (hooks.powershellExecutable) return fs.realpathSync.native(hooks.powershellExecutable);
  const root = sourceValue("SystemRoot") ?? sourceValue("WINDIR");
  if (!root || !path.win32.isAbsolute(root) || root.includes("\0")) throw new Error("Windows SystemRoot is unavailable; cannot locate trusted PowerShell");
  const file = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  rejectSymlinkComponents(file);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error("The system PowerShell executable is unavailable");
  return fs.realpathSync.native(file);
}
function safeEnvironment(local: NativeLocations, workspace?: string, overrides?: WorkspaceProcessOptions["env"]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment())) {
    if (value && SAFE_ENV.has(key.toUpperCase()) && key.toUpperCase() !== "PATH" && !value.includes("\0")) result[key.toUpperCase()] = value;
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (key.toUpperCase() === "NPM_CONFIG_USERCONFIG" && value === "NUL") continue;
    if (key.toUpperCase() === "GIT_OPTIONAL_LOCKS" && value === "0") continue;
    if (key.toUpperCase() === "GIT_PAGER" && value === "") continue;
    if (!SAFE_ENV.has(key.toUpperCase()) || ["SYSTEMROOT", "WINDIR", "COMSPEC", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "PATH", "TEMP", "TMP", "PATHEXT"].includes(key.toUpperCase()) || value.includes("\0")) {
      throw new Error("Native Agent environment overrides must use the safe Windows tool variables");
    }
    result[key.toUpperCase()] = value;
  }
  const candidates = [path.join(local.runtimeRoot, "codex-path"), ...String(sourceValue("PATH") ?? "").split(platform() === "win32" ? ";" : path.delimiter)];
  const paths: string[] = [];
  for (const entry of candidates) {
    if (!entry || !path.isAbsolute(entry) || entry.includes("\0")) continue;
    try {
      rejectSymlinkComponents(entry); const canonical = fs.realpathSync.native(entry);
      if (!fs.statSync(canonical).isDirectory() || workspace && overlaps(canonical, workspace) || inside(canonical, local.home) || inside(canonical, local.scriptsRoot)) continue;
      if (!paths.some((value) => comparePath(value) === comparePath(canonical))) paths.push(canonical);
    } catch { /* Missing or shadowable PATH directories grant no launch authority. */ }
  }
  const systemRoot = sourceValue("SystemRoot") ?? sourceValue("WINDIR");
  if (systemRoot) for (const entry of [path.join(systemRoot, "System32"), systemRoot]) if (!workspace || !overlaps(entry, workspace)) paths.push(entry);
  result.PATH = [...new Set(paths)].join(";");
  result.CODEX_HOME = local.home;
  result.NPM_CONFIG_USERCONFIG = "NUL";
  result.GIT_OPTIONAL_LOCKS = "0";
  result.GIT_PAGER = "";
  // The sidecar must never discover ChatGPT/OpenAI auth or inherited tool injection.
  result.RUST_LOG = "error";
  return result;
}
function tomlString(value: string): string { return JSON.stringify(value); }
function untrustedProjectTables(cwd: string): string[] {
  const lines: string[] = []; let current = path.resolve(cwd);
  while (true) {
    lines.push(`[projects.${tomlString(current)}]`, 'trust_level = "untrusted"');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  return lines;
}
function baseConfig(mode: SandboxMode): string {
  return ["check_for_update_on_startup = false", 'model_provider = "crownforge-offline"', 'approval_policy = "never"', 'web_search = "disabled"',
    "allow_login_shell = false", "[windows]", `sandbox = ${tomlString(mode)}`, "[analytics]", "enabled = false", "[feedback]", "enabled = false",
    '[model_providers.crownforge-offline]', 'name = "CrownForge execution only"', 'base_url = "http://127.0.0.1:9"', 'wire_api = "responses"', "requires_openai_auth = false",
    "[shell_environment_policy]", 'inherit = "all"', "ignore_default_excludes = false", "experimental_use_profile = false", "[features]", "prefer_mxc = false"].join("\n") + "\n";
}
function ensureBaseConfig(local: NativeLocations, mode: SandboxMode): void {
  makePrivateDirectory(local.home);
  const file = path.join(local.home, "config.toml"); rejectSymlinkComponents(file);
  // An App-private home has no user-auth configuration to merge or migrate.
  fs.writeFileSync(file, baseConfig(mode), { mode: 0o600 });
}
/** Configuration creation belongs to explicit setup, never a capability read. */
function hasBaseConfig(local: NativeLocations, mode: SandboxMode): boolean {
  for (const directory of [local.home, path.dirname(local.home)]) rejectSymlinkComponents(directory);
  const file = path.join(local.home, "config.toml"); rejectSymlinkComponents(file);
  let descriptor: number | undefined;
  try {
    const homeStat = fs.lstatSync(local.home);
    if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) throw new Error("Invalid Windows sandbox control directory");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new Error("Invalid Windows sandbox configuration");
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (fs.readFileSync(descriptor, "utf8") !== baseConfig(mode)) throw new Error("Windows sandbox configuration changed; run explicit setup again before Agent commands");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
function fixedRpcArguments(mode: SandboxMode): string[] {
  return ["-c", `windows.sandbox=${tomlString(mode)}`, "-c", "features.prefer_mxc=false", "-c", "check_for_update_on_startup=false", "app-server", "--stdio"];
}
function createClient(local: NativeLocations, runtime: VerifiedRuntime, mode: SandboxMode): CodexSandboxRpcClient {
  const options = { executable: runtime.executable, args: fixedRpcArguments(mode), cwd: local.home, env: safeEnvironment(local), ...(hooks.spawn ? { spawn: hooks.spawn } : {}) };
  return hooks.clientFactory ? hooks.clientFactory(options) : new CodexSandboxClient(options);
}
function decodeReadiness(value: unknown): "ready" | "notConfigured" | "updateRequired" {
  const status = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).status : undefined;
  if (status !== "ready" && status !== "notConfigured" && status !== "updateRequired") throw new Error("Unknown Windows sandbox readiness protocol");
  return status;
}

/** Probe never provisions users, permissions or firewall rules, and never requests UAC. */
export async function probeWindowsNativeSandbox(): Promise<WindowsNativeSandboxCapability> {
  if (platform() !== "win32") return capability("unsupported", "unsupported_platform", "The native Windows sandbox is available only on Windows");
  if (setupPending) return capability("notConfigured", "setup_pending", "Windows sandbox setup is in progress");
  if (pendingProbe) return structuredClone(await pendingProbe);
  const operation = (async () => {
    let client: CodexSandboxRpcClient | undefined;
    try {
      const local = await resolveLocations(); const runtime = requireRuntime(local); const mode = sandboxMode();
      if (mode === "unelevated") {
        readiness = undefined;
        return capability("error", "unsupported_permissions", "The unelevated Windows sandbox cannot enforce the App's private-file read restrictions; select the recommended elevated sandbox or WSL");
      }
      windowsNativePowerShellExecutable();
      if (!hasBaseConfig(local, mode)) {
        readiness = undefined;
        return capability("notConfigured", "setup_required", "Set up the Windows sandbox in desktop settings before running Agent commands");
      }
      client = createClient(local, runtime, mode); await client.initialize();
      const status = decodeReadiness(await client.call("windowsSandbox/readiness"));
      readiness = { fingerprint: runtime.fingerprint, mode, available: status === "ready" };
      return status === "ready" ? capability(status) : capability(status, "setup_required", "Set up the Windows sandbox in desktop settings before running Agent commands");
    } catch (error) {
      readiness = undefined;
      const message = error instanceof Error ? error.message : "Windows sandbox verification failed";
      return capability(/runtime|manifest|integrity|package/i.test(message) ? "missingRuntime" : "error", /PowerShell/i.test(message) ? "powershell_missing" : /runtime|manifest|integrity|package/i.test(message) ? "helper_missing" : "probe_failed", message);
    } finally { client?.close(); }
  })();
  pendingProbe = operation;
  try { return structuredClone(await operation); } finally { if (pendingProbe === operation) pendingProbe = undefined; }
}

function literalGrant(workspace: string, candidate: string): string {
  if (!candidate || candidate.includes("\0") || /[*?{}[\]]/.test(candidate) || path.isAbsolute(candidate) || path.win32.isAbsolute(candidate) || candidate.includes(":")) throw new Error("Native filesystem grants must be literal workspace-relative paths");
  const result = path.resolve(workspace, candidate.replaceAll("\\", path.sep));
  if (!inside(result, workspace)) throw new Error("Native filesystem grant escapes the workspace");
  rejectSymlinkComponents(result); return result;
}
function protectedName(name: string): "read" | "deny" | undefined {
  const lower = name.toLowerCase();
  if (CONTROL_NAMES.has(lower)) return "read";
  if (SECRET_NAMES.has(lower) || lower === ".env" || lower.startsWith(".env.")) return "deny";
  return undefined;
}
function validateWorkspace(local: NativeLocations, value: string): string {
  if (!path.isAbsolute(value) || value.includes("\0")) throw new Error("The Windows workspace must be an absolute local path");
  rejectSymlinkComponents(value); const workspace = fs.realpathSync.native(value);
  if (!fs.statSync(workspace).isDirectory() || /^\\\\/.test(workspace)) throw new Error("The native Windows sandbox requires a local filesystem workspace");
  const controls = [local.backendRoot, local.runtimeRoot, local.home, local.scriptsRoot, ...local.privateFiles];
  if (controls.some((control) => overlaps(workspace, control))) throw new Error("The Agent workspace must be separate from the App installation, private settings and sandbox control directories");
  const powershell = windowsNativePowerShellExecutable();
  if (inside(powershell, workspace)) throw new Error("The workspace cannot contain the system PowerShell executable");
  return workspace;
}
function filesystemEntries(local: NativeLocations, workspace: string, writes: string[], script?: string): Map<string, "read" | "write" | "deny"> {
  const entries = new Map<string, "read" | "write" | "deny">([[":root", "read"]]);
  for (const value of writes) entries.set(value, "write");
  for (const control of [local.backendRoot, local.runtimeRoot, local.scriptsRoot]) entries.set(control, "read");
  entries.set(local.home, "deny");
  for (const secret of local.privateFiles) {
    const guard = fs.existsSync(secret) ? secret : path.dirname(secret);
    rejectSymlinkComponents(guard);
    if (!fs.existsSync(guard) || !fs.statSync(guard).isDirectory() && guard !== secret) throw new Error("The private App configuration directory must exist before sandbox setup");
    if (overlaps(guard, workspace) || inside(local.scriptsRoot, guard)) throw new Error("Private App configuration guards must be separate from the workspace and command scripts");
    entries.set(guard, "deny");
  }
  const userHome = sourceValue("USERPROFILE");
  if (userHome) for (const name of [...SECRET_NAMES, ".codex"]) {
    const secret = path.join(userHome, name);
    if (fs.existsSync(secret)) entries.set(secret, "deny");
  }
  const stack = [{ dir: workspace, depth: 0 }]; let count = 0;
  while (stack.length) {
    const { dir, depth } = stack.pop()!;
    if (depth > 32 || count > 100_000) throw new Error("Workspace protected-path inventory exceeds the native sandbox limit; use a smaller workspace or WSL");
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++count > 100_000) throw new Error("Workspace protected-path inventory exceeds the native sandbox limit; use a smaller workspace or WSL");
      const target = path.join(dir, entry.name); const access = protectedName(entry.name);
      if (access) { entries.set(target, access); continue; }
      if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push({ dir: target, depth: depth + 1 });
    }
  }
  if (script) entries.set(script, "read");
  return entries;
}
/** Codex's elevated deny-read ACLs are shared by its sandbox-user group. Never
 * let a second workspace's profile revoke an earlier workspace's protection. */
function monotonicDenyEntries(local: NativeLocations, entries: Map<string, "read" | "write" | "deny">): Map<string, "read" | "write" | "deny"> {
  const registry = path.join(local.home, DENY_REGISTRY_NAME); rejectSymlinkComponents(registry);
  let previous: string[] = [];
  try {
    const stat = fs.lstatSync(registry);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_194_304) throw new Error("Invalid native sandbox protected-path registry");
    const value: unknown = JSON.parse(fs.readFileSync(registry, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value) || (value as { version?: unknown }).version !== 1 || !Array.isArray((value as { paths?: unknown }).paths)) throw new Error("Invalid native sandbox protected-path registry");
    const paths: unknown[] = (value as { paths: unknown[] }).paths;
    if (paths.length > 100_000 || paths.some((item) => typeof item !== "string" || !path.isAbsolute(item) || item.includes("\0") || path.dirname(item) === item)) throw new Error("Invalid native sandbox protected-path registry");
    previous = paths as string[];
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const paths = new Map(previous.map((item) => [comparePath(item), item]));
  for (const [item, access] of entries) if (access === "deny") paths.set(comparePath(item), item);
  const allPaths = [...paths.values()].sort();
  const content = `${JSON.stringify({ version: 1, paths: allPaths })}\n`;
  if (Buffer.byteLength(content) > 4_194_304 || allPaths.length > 100_000) throw new Error("Native sandbox protected-path registry exceeds its limit");
  const temporary = path.join(local.home, `.protected-read-paths-${crypto.randomBytes(12).toString("hex")}.tmp`);
  try { fs.writeFileSync(temporary, content, { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, registry); }
  finally { fs.rmSync(temporary, { force: true }); }
  const result = new Map(entries);
  for (const item of allPaths) {
    // Upstream materializes missing exact denies as directories. Keep the
    // registration, but do not recreate a secret that the user has removed.
    if (fs.existsSync(item)) result.set(item, "deny");
  }
  return result;
}
function profileFile(local: NativeLocations, workspace: string, entries: Map<string, "read" | "write" | "deny">, network: boolean): { name: string; file: string } {
  const name = `crownforge-${crypto.randomBytes(16).toString("hex")}`;
  const file = path.join(local.home, `${name}.config.toml`);
  const lines = [`default_permissions = ${tomlString(name)}`, `[permissions.${name}.filesystem]`, ...[...entries].map(([key, access]) => `${tomlString(key)} = ${tomlString(access)}`),
    `[permissions.${name}.network]`, `enabled = ${network}`, ...untrustedProjectTables(workspace)];
  fs.writeFileSync(file, `${lines.join("\n")}\n`, { flag: "wx", mode: 0o600 }); return { name, file };
}

/** The only provisioning entry point; callers must obtain explicit user intent in desktop settings. */
export async function setupWindowsNativeSandbox(workspaceDir: string, mode: SandboxMode): Promise<void> {
  if (platform() !== "win32") throw new Error("Windows sandbox setup is available only on Windows");
  if (mode !== "elevated" && mode !== "unelevated") throw new Error("Invalid Windows sandbox setup mode");
  if (mode === "unelevated") throw new Error("The unelevated Windows sandbox cannot enforce private-file read restrictions; select the elevated sandbox or WSL");
  if (setupPending) throw new Error("Windows sandbox setup is already in progress");
  setupPending = true; readiness = undefined;
  let client: CodexSandboxRpcClient | undefined; let profile: { name: string; file: string } | undefined; let local: NativeLocations | undefined; let lease: NativeLease | undefined;
  try {
    if (pendingProbe) await pendingProbe;
    readiness = undefined;
    local = await resolveLocations(); const runtime = requireRuntime(local);
    const workspace = validateWorkspace(local, workspaceDir);
    makePrivateDirectory(local.home); lease = acquireNativeLease(local); ensureBaseConfig(local, mode);
    profile = profileFile(local, workspace, monotonicDenyEntries(local, filesystemEntries(local, workspace, [workspace])), false);
    // app-server does not accept the CLI's -p named profile option. Setup is
    // serialized against execution and temporarily uses this App-owned config.
    const profileLines = fs.readFileSync(profile.file, "utf8").split("\n");
    fs.writeFileSync(path.join(local.home, "config.toml"), `${profileLines[0]}\n${baseConfig(mode)}${profileLines.slice(1).join("\n")}`, { mode: 0o600 });
    client = createClient(local, runtime, mode); await client.initialize();
    // Register before the RPC acknowledgment: setup may finish immediately.
    const completed = client.waitForNotification("windowsSandbox/setupCompleted");
    void completed.catch(() => {});
    const started = await client.call("windowsSandbox/setupStart", { mode, cwd: workspace });
    if (!started || typeof started !== "object" || (started as { started?: unknown }).started !== true) throw new Error("Windows sandbox setup did not start");
    const result = await completed;
    if (!result || typeof result !== "object" || Array.isArray(result) || (result as { mode?: unknown }).mode !== mode || (result as { success?: unknown }).success !== true) {
      throw new Error("Windows sandbox setup failed or was cancelled; no Agent command was enabled");
    }
    client.close(); client = createClient(local, runtime, mode); await client.initialize();
    const status = decodeReadiness(await client.call("windowsSandbox/readiness"));
    if (status !== "ready") throw new Error("Windows sandbox setup completed but readiness verification failed");
    readiness = { fingerprint: runtime.fingerprint, mode, available: true };
  } catch (error) { readiness = undefined; throw error; }
  finally {
    client?.close();
    try { if (profile) fs.rmSync(profile.file, { force: true }); if (local && lease) ensureBaseConfig(local, mode); }
    catch { readiness = undefined; throw new Error("Windows sandbox configuration cleanup failed; recheck before running Agent commands"); }
    finally { try { lease?.release(); } finally { setupPending = false; } }
  }
}

function powershellCommand(options: WorkspaceProcessOptions, trustedPowerShell: string): string | undefined {
  if (comparePath(options.executable) !== comparePath(trustedPowerShell)) return undefined;
  const args = options.args ?? []; const index = args.findIndex((arg) => arg.toLowerCase() === "-command");
  if (index < 0 || index !== args.length - 2) throw new Error("Native Agent PowerShell requires one non-interactive -Command source");
  const prefix = args.slice(0, index).map((value) => value.toLowerCase());
  for (let i = 0; i < prefix.length; i++) {
    if (["-nologo", "-noprofile", "-noninteractive"].includes(prefix[i])) continue;
    if (prefix[i] === "-executionpolicy" && prefix[i + 1] === "bypass") { i++; continue; }
    throw new Error("Unsupported native Agent PowerShell launch option");
  }
  return args[index + 1];
}
function scriptSource(command: string): string {
  return `\uFEFF$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n$global:LASTEXITCODE = $null\ntry {\n& {\n${command}\n}\n$crownforgeCommandSucceeded = $?\n$crownforgeNativeExitCode = $global:LASTEXITCODE\nif ($null -ne $crownforgeNativeExitCode -and [int]$crownforgeNativeExitCode -ne 0) { exit ([int]$crownforgeNativeExitCode) }\nif (-not $crownforgeCommandSucceeded) { exit 1 }\nexit 0\n} catch {\n[Console]::Error.WriteLine($_.ToString())\nexit 1\n}\n`;
}

export function prepareWindowsNativeProcess(options: WorkspaceProcessOptions): PreparedWorkspaceProcess {
  if (platform() !== "win32") throw new Error("Native Agent execution is available only on Windows");
  if (!locations || !readiness?.available || setupPending) throw new Error("Set up or recheck the Windows sandbox in desktop settings before running Agent commands");
  const local = locations; const runtime = requireRuntime(local); const mode = sandboxMode();
  if (readiness.fingerprint !== runtime.fingerprint || readiness.mode !== mode) throw new Error("The Windows sandbox runtime or mode changed; recheck its readiness before running Agent commands");
  if (!hasBaseConfig(local, mode)) { readiness = undefined; throw new Error("Set up or recheck the Windows sandbox in desktop settings before running Agent commands"); }
  if (options.internalNodeRuntime) throw new Error("Internal runtime authority is not accepted by the Agent Windows sandbox");
  if (options.signal?.aborted) throw new Error("Stopped before process execution");
  if (options.limits?.cpuTimeMs !== undefined || options.limits?.memoryBytes !== undefined || options.limits?.maxOpenFiles !== undefined) throw new Error("Codex Windows sandbox does not expose POSIX CPU, memory or file-descriptor limits; use WSL for an explicitly required hard limit");
  const timeoutMs = options.limits?.wallTimeMs ?? options.timeoutMs ?? 120_000; const maxOutputBytes = options.maxOutputBytes ?? 50_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new Error("Invalid native process limits");
  if (!options.filesystem) throw new Error("Native Agent commands require a filesystem grant");
  const workspace = validateWorkspace(local, options.filesystem.workspaceDir ?? options.cwd);
  const cwd = fs.realpathSync.native(options.cwd); rejectSymlinkComponents(options.cwd);
  if (!inside(cwd, workspace)) throw new Error("Native command cwd must be inside the granted workspace");
  const reads = options.filesystem.readPaths ?? ["."];
  if (!reads.length || reads.some((value) => comparePath(literalGrant(workspace, value)) !== comparePath(workspace))) throw new Error("Codex native Windows sandbox requires root-read permission; use WSL for narrow filesystem read grants");
  const writes = [...new Set((options.filesystem.writePaths ?? []).map((value) => literalGrant(workspace, value)))];
  for (const write of writes) if (path.relative(workspace, write).split(path.sep).some((part) => protectedName(part))) throw new Error("Agent write grants cannot include private or App control paths");
  if (!options.executable || !path.isAbsolute(options.executable) || options.executable.includes("\0")) throw new Error("Native command executable must be an absolute trusted tool path");
  rejectSymlinkComponents(options.executable); const executable = fs.realpathSync.native(options.executable);
  if (inside(executable, workspace) || !fs.statSync(executable).isFile()) throw new Error("Native command executable cannot be supplied by the workspace");
  if (!(options.args ?? []).every((value) => typeof value === "string" && !value.includes("\0"))) throw new Error("Invalid native process arguments");
  const env = safeEnvironment(local, workspace, options.env);
  let scriptDir: string | undefined; let profile: { name: string; file: string } | undefined;
  const lease = acquireNativeLease(local);
  try {
    // Managed sessions persist their records under .history after preparation.
    // Reserve that App-owned control directory before snapshotting ACL rules.
    makePrivateDirectory(path.join(workspace, ".history"));
    const powershell = windowsNativePowerShellExecutable(); const command = powershellCommand(options, powershell);
    let argv = [...(options.args ?? [])]; let target = executable; let script: string | undefined;
    if (command !== undefined) {
      if (Buffer.byteLength(command) > 2_097_152) throw new Error("Native Agent command source exceeds the script size limit");
      makePrivateDirectory(local.scriptsRoot); scriptDir = fs.mkdtempSync(path.join(local.scriptsRoot, "command-"));
      script = path.join(scriptDir, "command.ps1"); fs.writeFileSync(script, scriptSource(command), { flag: "wx", mode: 0o600 });
      target = powershell; argv = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script];
    }
    profile = profileFile(local, workspace, monotonicDenyEntries(local, filesystemEntries(local, workspace, writes, script)), options.networkMode === "inherit");
    const args = ["-p", profile.name, "-c", `windows.sandbox=${tomlString(mode)}`, "-c", "features.prefer_mxc=false", "sandbox", "-P", profile.name, "-C", cwd, "--", target, ...argv];
    if (args.reduce((size, argument) => size + argument.length + 3, runtime.executable.length) > 30_000) throw new Error("Native command arguments exceed the Windows launch limit; use a script or WSL");
    let cleaned = false;
    return { executable: runtime.executable, args, env, timeoutMs, maxOutputBytes, cancel: lease.cancel, onSpawn: lease.onSpawn, cleanup: () => {
      if (cleaned) return; cleaned = true;
      try { if (profile) fs.rmSync(profile.file, { force: true }); if (scriptDir) fs.rmSync(scriptDir, { recursive: true, force: true }); }
      catch { /* A locked script must not crash backend process cleanup. */ }
      finally { try { lease.release(); } catch { /* Preserve an uncertain lease; never crash the backend on process close. */ } }
    } };
  } catch (error) { if (profile) fs.rmSync(profile.file, { force: true }); if (scriptDir) fs.rmSync(scriptDir, { recursive: true, force: true }); lease.release(); throw error; }
}

export const __windowsNativeSandboxForTests = { REQUIRED_FILES, MANIFEST_NAME, DENY_REGISTRY_NAME, EXECUTION_LEASE_NAME, scriptSource, baseConfig };
