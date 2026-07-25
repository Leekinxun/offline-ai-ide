import { Router } from "express";
import type { UserSession } from "../auth/sessionManager.js";
import { getDiagnostics, runDiagnostics, startDiagnosticsSession, stopDiagnosticsSession } from "../diagnostics/service.js";
import { canWriteActiveWorkspace } from "../team/sessionBridge.js";

export const diagnosticsRouter = Router();

function workspace(req: unknown): string {
  return ((req as any).userSession as UserSession).workspaceDir;
}

diagnosticsRouter.get("/", (req, res) => res.json(getDiagnostics(workspace(req))));
diagnosticsRouter.post("/run", async (req, res) => {
  if (!canWriteActiveWorkspace((req as any).userSession as UserSession)) {
    return res.status(403).json({ error: "Workspace is read-only" });
  }
  try {
    res.json(await runDiagnostics(workspace(req)));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Diagnostics failed" });
  }
});

diagnosticsRouter.post("/watch", async (req, res) => {
  if (!canWriteActiveWorkspace((req as any).userSession as UserSession)) return res.status(403).json({ error: "Workspace is read-only" });
  try { res.json(await startDiagnosticsSession(workspace(req))); }
  catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : "Failed to start diagnostics" }); }
});

diagnosticsRouter.delete("/watch", (req, res) => {
  if (!canWriteActiveWorkspace((req as any).userSession as UserSession)) return res.status(403).json({ error: "Workspace is read-only" });
  try { res.json(stopDiagnosticsSession(workspace(req))); }
  catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : "Failed to stop diagnostics" }); }
});
