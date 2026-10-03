import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface WindowsAgentSettings {
  environment: "native" | "wsl";
  sandboxMode: "elevated" | "unelevated";
}

const DEFAULT_SETTINGS: Readonly<WindowsAgentSettings> = Object.freeze({ environment: "native", sandboxMode: "elevated" });
const MAX_SETTINGS_BYTES = 4_096;

export function validateWindowsAgentSettings(value: unknown): WindowsAgentSettings {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== 2 || Object.keys(value).some((key) => !["environment", "sandboxMode"].includes(key))) {
    throw new Error("Execution settings require only environment and sandboxMode");
  }
  const input = value as Record<string, unknown>;
  if (input.environment !== "native" && input.environment !== "wsl") throw new Error("Invalid Windows execution environment");
  if (input.sandboxMode !== "elevated" && input.sandboxMode !== "unelevated") throw new Error("Invalid Windows sandbox mode");
  return { environment: input.environment, sandboxMode: input.sandboxMode };
}

/** Server-owned settings stay separate from credentials and other App configuration. */
export function windowsAgentSettingsPath(): string {
  // Match config's path resolution without importing it or reading its private
  // contents when the execution adapter is imported by standalone tools.
  const configured = process.env.APP_SETTINGS_CONFIG;
  if (configured) return path.join(path.dirname(path.resolve(configured)), "agent-execution.json");
  const candidates = [path.resolve("app-settings.json"), path.resolve("../app-settings.json")];
  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  const fallback = process.cwd().endsWith(`${path.sep}backend`) ? candidates[1] : candidates[0];
  return path.join(path.dirname(existing ?? fallback), "agent-execution.json");
}

function readPersistedSettings(): WindowsAgentSettings {
  const file = windowsAgentSettingsPath();
  let descriptor: number | undefined;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Execution settings cannot be a symbolic link");
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) throw new Error("Invalid execution settings file");
    return validateWindowsAgentSettings(JSON.parse(fs.readFileSync(descriptor, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_SETTINGS };
    throw new Error("Windows Agent execution settings could not be read");
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

/** Read lazily so imports never create files, change policy, or initialize the sandbox. */
export function getWindowsAgentSettings(): WindowsAgentSettings {
  // Web deployments retain their existing WSL execution path. Desktop-private
  // settings and native overrides are not read outside an App-owned backend.
  if (process.env.CREWFORGE_DESKTOP !== "1") return { environment: "wsl", sandboxMode: "elevated" };
  const settings = readPersistedSettings();
  const environment = process.env.CROWNFORGE_WINDOWS_AGENT_ENVIRONMENT;
  const sandboxMode = process.env.CROWNFORGE_WINDOWS_SANDBOX_MODE;
  return validateWindowsAgentSettings({
    environment: environment === undefined ? settings.environment : environment,
    sandboxMode: sandboxMode === undefined ? settings.sandboxMode : sandboxMode,
  });
}

function canonicalPath(value: string): string {
  let cursor = path.resolve(value);
  const suffix: string[] = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error("Execution settings directory is unavailable");
    suffix.unshift(path.basename(cursor)); cursor = parent;
  }
  return path.join(fs.realpathSync.native(cursor), ...suffix);
}

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function updateWindowsAgentSettings(value: unknown, workspaceDir?: string): WindowsAgentSettings {
  const settings = validateWindowsAgentSettings(value);
  const directory = canonicalPath(path.dirname(windowsAgentSettingsPath()));
  const file = path.join(directory, "agent-execution.json");
  for (const workspace of [process.env.WORKSPACE_DIR, workspaceDir].filter((item): item is string => Boolean(item))) {
    if (inside(directory, canonicalPath(workspace))) throw new Error("Execution settings must be outside the Agent workspace");
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile())) throw new Error("Invalid execution settings file");
  const temporary = path.join(directory, `.agent-execution-${crypto.randomBytes(12).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  return getWindowsAgentSettings();
}
