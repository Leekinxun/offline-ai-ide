import { Router } from "express";
import type { UserSession } from "../auth/sessionManager.js";
import {
  DocumentDiagnosticsError,
  DocumentFormatError,
  checkPythonDocument,
  formatPythonDocument,
  getDiagnostics,
  runDiagnostics,
  startDiagnosticsSession,
  stopDiagnosticsSession,
} from "../diagnostics/service.js";
import { canWriteActiveWorkspace } from "../team/sessionBridge.js";

export const diagnosticsRouter = Router();

function workspace(req: unknown): string {
  return ((req as any).userSession as UserSession).workspaceDir;
}

diagnosticsRouter.get("/", (req, res) => res.json(getDiagnostics(workspace(req))));
diagnosticsRouter.post("/document", async (req, res) => {
  const { path, content } = req.body || {};
  if (typeof path !== "string" || typeof content !== "string") {
    return res.status(400).json({ error: "path and content are required" });
  }
  try {
    res.json(await checkPythonDocument(workspace(req), path, content));
  } catch (error) {
    if (error instanceof DocumentDiagnosticsError) {
      const status = error.code === "RUFF_MISSING" ? 503 : error.code === "CHECK_TIMEOUT" ? 504 : error.code === "CHECK_FAILED" ? 422 : 400;
      return res.status(status).json({ error: error.message, code: error.code });
    }
    res.status(500).json({ error: error instanceof Error ? error.message : "Document diagnostics failed" });
  }
});
diagnosticsRouter.post("/format", async (req, res) => {
  if (!canWriteActiveWorkspace((req as any).userSession as UserSession)) {
    return res.status(403).json({ error: "Workspace is read-only" });
  }
  const { path, content } = req.body || {};
  if (typeof path !== "string" || typeof content !== "string") {
    return res.status(400).json({ error: "path and content are required" });
  }
  try {
    res.json(await formatPythonDocument(workspace(req), path, content));
  } catch (error) {
    if (error instanceof DocumentFormatError) {
      const status = error.code === "RUFF_MISSING" ? 503 : error.code === "FORMAT_TIMEOUT" ? 504 : error.code === "FORMAT_FAILED" ? 422 : 400;
      return res.status(status).json({ error: error.message, code: error.code });
    }
    res.status(500).json({ error: error instanceof Error ? error.message : "Formatting failed" });
  }
});
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
