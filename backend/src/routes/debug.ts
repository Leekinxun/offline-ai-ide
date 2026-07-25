import { Router } from "express";
import type { UserSession } from "../auth/sessionManager.js";
import { canWriteActiveWorkspace } from "../team/sessionBridge.js";
import { debugCommand, getDebugSession, startDebugSession, stopDebugSession } from "../debug/service.js";

export const debugRouter = Router();
const session = (req: unknown) => (req as any).userSession as UserSession;

debugRouter.get("/", (req, res) => res.json({ session: getDebugSession(session(req).workspaceDir) }));

debugRouter.post("/start", (req, res) => {
  if (!canWriteActiveWorkspace(session(req))) return res.status(403).json({ error: "Workspace is read-only" });
  try {
    const targetPath = typeof req.body?.path === "string" ? req.body.path : "";
    const lines = Array.isArray(req.body?.breakpoints) ? req.body.breakpoints.map(Number) : [];
    res.status(202).json({ session: startDebugSession(session(req).workspaceDir, targetPath, lines) });
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Failed to start debugger" }); }
});

debugRouter.post("/command", async (req, res) => {
  if (!canWriteActiveWorkspace(session(req))) return res.status(403).json({ error: "Workspace is read-only" });
  const action = req.body?.action;
  if (!["continue", "step_over", "step_into", "step_out"].includes(action)) return res.status(400).json({ error: "Unknown debug command" });
  try { res.json({ session: await debugCommand(session(req).workspaceDir, action) }); }
  catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : "Debug command failed" }); }
});

debugRouter.delete("/", (req, res) => {
  if (!canWriteActiveWorkspace(session(req))) return res.status(403).json({ error: "Workspace is read-only" });
  try { res.json({ session: stopDebugSession(session(req).workspaceDir) }); }
  catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : "Failed to stop debugger" }); }
});
