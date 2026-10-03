import { Router, type Request, type Response } from "express";
import type { UserSession } from "../auth/sessionManager.js";
import { getSandboxDiagnostics, type SandboxDiagnostics } from "../run/sandboxDiagnostics.js";
import { probeWslExecution } from "../agent/wslExecution.js";
import { probeWindowsNativeSandbox, setupWindowsNativeSandbox } from "../agent/windowsNativeSandbox.js";
import { hasRunningAgentProcessSessions } from "../run/processSessions.js";
import { getWindowsAgentSettings, updateWindowsAgentSettings, validateWindowsAgentSettings, type WindowsAgentSettings } from "../run/windowsAgentSettings.js";

interface ExecutionCapability {
  available: boolean;
  distro?: string;
  reason?: string;
  reasonCode?: string;
  status?: string;
  runtimeVersion?: string;
  weakerNetworkIsolation?: boolean;
}

interface RuntimeExecutionReaders {
  platform?: NodeJS.Platform;
  desktop?: boolean;
  readWslCapability?: () => ExecutionCapability | Promise<ExecutionCapability>;
  readNativeCapability?: () => ExecutionCapability | Promise<ExecutionCapability>;
  readSettings?: () => WindowsAgentSettings;
  writeSettings?: (value: unknown, workspaceDir: string) => WindowsAgentSettings;
  setupNativeSandbox?: (workspaceDir: string, mode: WindowsAgentSettings["sandboxMode"]) => Promise<void>;
  hasRunningAgentProcesses?: () => boolean;
}

const WSL_FAILURE_REASONS: Record<string, string> = {
  wsl_missing: "WSL2 is not installed or is unavailable",
  distro_unavailable: "The selected WSL Linux distribution is unavailable",
  wsl2_required: "The Linux distribution must use WSL2",
  node_missing: "The Linux distribution requires Node.js 18 or later",
  root_user: "WSL Agent execution requires a non-root Linux user",
  helper_missing: "The Linux distribution requires Bash and bubblewrap",
  helper_not_built: "The App execution helper is missing from this installation",
  isolation_unavailable: "Required Linux filesystem or network isolation is unavailable",
  unsupported_workspace: "The workspace cannot be safely mapped into the WSL execution environment",
  case_sensitive_required: "WSL Agent execution requires a case-sensitive NTFS workspace",
  invalid_configuration: "The WSL execution configuration is invalid",
  probe_failed: "Execution capability could not be checked",
};

const NATIVE_FAILURE_REASONS: Record<string, string> = {
  setup_required: "Set up the Windows sandbox before running Agent commands",
  setup_pending: "Windows sandbox setup is in progress",
  setup_failed: "Windows sandbox setup could not be completed",
  setup_cancelled: "Windows sandbox setup was cancelled",
  helper_missing: "The Windows sandbox helper is missing from this installation",
  helper_not_built: "The Windows sandbox helper is missing from this installation",
  powershell_missing: "PowerShell is unavailable on this computer",
  unsupported_platform: "The Windows native sandbox is unavailable on this system",
  unsupported_windows: "The Windows native sandbox requires Windows 10 or later",
  unsupported_permissions: "Compatibility mode cannot enforce the required protection for sensitive files. Use the recommended native sandbox or WSL2",
  isolation_unavailable: "Required Windows sandbox isolation is unavailable",
  invalid_configuration: "The Windows execution configuration is invalid",
  probe_failed: "The Windows execution environment could not be verified",
};

function diagnosticText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength) || undefined;
}
function sessionFor(req: Request): UserSession | undefined {
  return (req as Request & { userSession?: UserSession }).userSession;
}
function isLoopback(address: string | undefined): boolean {
  return Boolean(address && (address === "::1" || /^127(?:\.\d{1,3}){3}$/.test(address) || /^::ffff:127(?:\.\d{1,3}){3}$/i.test(address)));
}
function sameOrigin(req: Request): boolean {
  try {
    const host = req.headers.host;
    if (!host || typeof req.headers.origin !== "string") return false;
    const protocol = "encrypted" in req.socket && req.socket.encrypted ? "https:" : "http:";
    const expected = new URL(`${protocol}//${host}`);
    const origin = new URL(req.headers.origin);
    return !origin.username && !origin.password && origin.origin === expected.origin &&
      ["localhost", "127.0.0.1", "[::1]"].includes(expected.hostname) &&
      Number(expected.port || (protocol === "https:" ? 443 : 80)) === req.socket.localPort;
  } catch { return false; }
}

export function createRuntimeRouter(
  readDiagnostics: () => SandboxDiagnostics = getSandboxDiagnostics,
  executionReaders: RuntimeExecutionReaders = {},
): Router {
  const router = Router();
  let setupPending = false;
  const platform = () => executionReaders.platform ?? process.platform;
  const desktop = () => executionReaders.desktop ?? process.env.CREWFORGE_DESKTOP === "1";
  const settings = () => executionReaders.readSettings ? executionReaders.readSettings() : getWindowsAgentSettings();
  const busy = () => setupPending || (executionReaders.hasRunningAgentProcesses ? executionReaders.hasRunningAgentProcesses() : hasRunningAgentProcessSessions());
  function authorizeMutation(req: Request, res: Response): UserSession | undefined {
    res.setHeader("Cache-Control", "no-store");
    const session = sessionFor(req);
    if (!session?.username) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (!session.isAdmin) { res.status(403).json({ error: "Admin access required" }); return; }
    if (platform() !== "win32" || !desktop()) {
      res.status(403).json({ error: "Windows desktop access required" }); return;
    }
    if (!isLoopback(req.socket.remoteAddress) || !sameOrigin(req)) {
      res.status(403).json({ error: "Local same-origin access required" }); return;
    }
    if (!req.is("application/json") || Object.keys(req.query).length) {
      res.status(400).json({ error: "Only a JSON body without query parameters is accepted" }); return;
    }
    return session;
  }
  router.get("/sandbox", (req, res) => {
    const session = sessionFor(req);
    if (!session?.username) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (!session.isAdmin) { res.status(403).json({ error: "Admin access required" }); return; }
    res.setHeader("Cache-Control", "no-store");
    if (Object.keys(req.query).length) { res.status(400).json({ error: "Sandbox diagnostics do not accept command or path parameters" }); return; }
    res.json(readDiagnostics());
  });
  router.get("/execution", async (req, res) => {
    const session = sessionFor(req);
    if (!session?.username) { res.status(401).json({ error: "Unauthorized" }); return; }
    res.setHeader("Cache-Control", "no-store");
    if (Object.keys(req.query).length) { res.status(400).json({ error: "Execution diagnostics do not accept parameters" }); return; }
    const hostPlatform = platform();
    const windowsWeb = hostPlatform === "win32" && !desktop();
    let executor: "wsl" | "native" | "windows-native" = hostPlatform === "win32" ? windowsWeb ? "wsl" : "windows-native" : "native";
    let currentSettings: WindowsAgentSettings | undefined;
    try {
      if (windowsWeb) {
        const capability = await (executionReaders.readWslCapability ? executionReaders.readWslCapability() : probeWslExecution({ refresh: true }));
        const distro = diagnosticText(capability.distro, 128);
        const reasonCode = typeof capability.reasonCode === "string" && Object.hasOwn(WSL_FAILURE_REASONS, capability.reasonCode) ? capability.reasonCode : "probe_failed";
        return res.json({
          hostPlatform, executor, available: capability.available === true,
          ...(distro && /^[A-Za-z0-9._ -]+$/.test(distro) ? { distro } : {}),
          ...(capability.available !== true ? { reasonCode, reason: WSL_FAILURE_REASONS[reasonCode] } : {}),
        });
      }
      if (hostPlatform === "win32") {
        const current = validateWindowsAgentSettings(settings());
        currentSettings = current;
        executor = current.environment === "wsl" ? "wsl" : "windows-native";
        const capability: ExecutionCapability = setupPending && executor === "windows-native" ? { available: false, reasonCode: "setup_pending" } :
          executor === "wsl" ? await (executionReaders.readWslCapability ? executionReaders.readWslCapability() : probeWslExecution({ refresh: true })) :
          await (executionReaders.readNativeCapability ? executionReaders.readNativeCapability() : probeWindowsNativeSandbox());
        const reasons = executor === "wsl" ? WSL_FAILURE_REASONS : NATIVE_FAILURE_REASONS;
        const reasonCode = typeof capability.reasonCode === "string" && Object.hasOwn(reasons, capability.reasonCode) ? capability.reasonCode : "probe_failed";
        const distro = diagnosticText(capability.distro, 128);
        const runtimeVersion = diagnosticText(capability.runtimeVersion, 80);
        res.json({
          hostPlatform, executor, shell: executor === "wsl" ? "bash" : "powershell", settings: current,
          available: capability.available === true,
          status: capability.available === true ? "ready" : reasonCode === "setup_pending" ? "setup_pending" : reasonCode === "setup_required" ? "setup_required" : "unavailable",
          setupRequired: executor === "windows-native" && capability.available !== true && reasonCode === "setup_required",
          ...(executor === "windows-native" ? { weakerNetworkIsolation: current.sandboxMode === "unelevated" } : {}),
          ...(executor === "wsl" && distro && /^[A-Za-z0-9._ -]+$/.test(distro) ? { distro } : {}),
          ...(runtimeVersion && /^\d+(?:\.\d+){0,3}$/.test(runtimeVersion) ? { runtimeVersion } : {}),
          ...(capability.available !== true ? { reasonCode, reason: reasons[reasonCode] } : {}),
        });
      } else {
        const diagnostics = readDiagnostics();
        const unavailable = !diagnostics.filesystem.available ? diagnostics.filesystem : diagnostics.network;
        res.json({
          hostPlatform, executor, available: diagnostics.executionReady === true,
          ...(!diagnostics.executionReady ? {
            reason: !diagnostics.filesystem.available ? "Required filesystem isolation is unavailable" : "Required network isolation is unavailable",
            ...(unavailable.reasonCode && /^[a-z][a-z0-9_]{0,79}$/.test(unavailable.reasonCode) ? { reasonCode: unavailable.reasonCode } : {}),
          } : {}),
        });
      }
    } catch {
      if (!desktop()) return res.json({ hostPlatform, executor, available: false, reasonCode: "probe_failed", reason: "Execution capability could not be checked" });
      res.json({ hostPlatform, executor, available: false, status: "unavailable", ...(currentSettings ? { settings: currentSettings, shell: executor === "wsl" ? "bash" : "powershell" } : {}), reasonCode: "probe_failed", reason: "Execution capability could not be checked" });
    }
  });
  router.post("/execution/settings", (req, res) => {
    const session = authorizeMutation(req, res); if (!session) return;
    if (busy()) { res.status(409).json({ error: "Stop active Agent commands or wait for sandbox setup before changing the execution environment", reasonCode: "execution_busy" }); return; }
    try {
      const value = validateWindowsAgentSettings(req.body);
      const current = executionReaders.writeSettings ? executionReaders.writeSettings(value, session.workspaceDir) : updateWindowsAgentSettings(value, session.workspaceDir);
      res.json({ settings: current });
    } catch { res.status(400).json({ error: "Execution settings could not be saved", reasonCode: "invalid_configuration" }); }
  });
  router.post("/sandbox/setup", async (req, res) => {
    const session = authorizeMutation(req, res); if (!session) return;
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length) {
      res.status(400).json({ error: "Sandbox setup accepts only an empty JSON object" }); return;
    }
    if (busy()) { res.status(409).json({ error: "Stop active Agent commands or wait for sandbox setup before setting up the sandbox", reasonCode: "execution_busy" }); return; }
    try {
      const current = settings();
      if (current.environment !== "native") { res.status(409).json({ error: "Select Windows native execution before setting up its sandbox" }); return; }
      if (!session.workspaceDir) { res.status(400).json({ error: "Select a workspace before setting up the sandbox" }); return; }
      setupPending = true;
      await (executionReaders.setupNativeSandbox ? executionReaders.setupNativeSandbox(session.workspaceDir, current.sandboxMode) : setupWindowsNativeSandbox(session.workspaceDir, current.sandboxMode));
      res.json({ success: true });
    } catch { res.status(500).json({ error: "Windows sandbox setup could not be completed", reasonCode: "setup_failed" }); }
    finally { setupPending = false; }
  });
  return router;
}

export const runtimeRouter = createRuntimeRouter();
