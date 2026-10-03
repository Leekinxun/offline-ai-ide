import { Router } from "express";
import type { UserSession } from "../auth/sessionManager.js";
import { getSandboxDiagnostics, type SandboxDiagnostics } from "../run/sandboxDiagnostics.js";
import { probeWslExecution } from "../agent/wslExecution.js";

interface ExecutionCapability {
  available: boolean;
  distro?: string;
  reason?: string;
  reasonCode?: string;
}

interface RuntimeExecutionReaders {
  platform?: NodeJS.Platform;
  readWslCapability?: () => ExecutionCapability | Promise<ExecutionCapability>;
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

function diagnosticText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength) || undefined;
}

export function createRuntimeRouter(
  readDiagnostics: () => SandboxDiagnostics = getSandboxDiagnostics,
  executionReaders: RuntimeExecutionReaders = {},
): Router {
  const router = Router();
  router.get("/sandbox", (req, res) => {
    const session = (req as typeof req & { userSession?: UserSession }).userSession;
    if (!session?.username) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (!session.isAdmin) { res.status(403).json({ error: "Admin access required" }); return; }
    res.setHeader("Cache-Control", "no-store");
    if (Object.keys(req.query).length) { res.status(400).json({ error: "Sandbox diagnostics do not accept command or path parameters" }); return; }
    res.json(readDiagnostics());
  });
  router.get("/execution", async (req, res) => {
    const session = (req as typeof req & { userSession?: UserSession }).userSession;
    if (!session?.username) { res.status(401).json({ error: "Unauthorized" }); return; }
    res.setHeader("Cache-Control", "no-store");
    if (Object.keys(req.query).length) { res.status(400).json({ error: "Execution diagnostics do not accept parameters" }); return; }
    const hostPlatform = executionReaders.platform ?? process.platform;
    const executor = hostPlatform === "win32" ? "wsl" : "native";
    try {
      if (executor === "wsl") {
        const capability = await (executionReaders.readWslCapability ? executionReaders.readWslCapability() : probeWslExecution({ refresh: true }));
        const distro = diagnosticText(capability.distro, 128);
        const reasonCode = typeof capability.reasonCode === "string" && Object.hasOwn(WSL_FAILURE_REASONS, capability.reasonCode) ? capability.reasonCode : "probe_failed";
        res.json({
          hostPlatform, executor, available: capability.available === true,
          ...(distro && /^[A-Za-z0-9._ -]+$/.test(distro) ? { distro } : {}),
          ...(capability.available !== true ? { reasonCode, reason: WSL_FAILURE_REASONS[reasonCode] } : {}),
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
      res.json({ hostPlatform, executor, available: false, reasonCode: "probe_failed", reason: "Execution capability could not be checked" });
    }
  });
  return router;
}

export const runtimeRouter = createRuntimeRouter();
