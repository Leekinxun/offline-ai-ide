import { Router } from "express";
import type { UserSession } from "../auth/sessionManager.js";
import { canWriteActiveWorkspace } from "../team/sessionBridge.js";
import {
  debugCommand,
  evaluateDebugExpression,
  getDebugScopes,
  getDebugSession,
  getDebugVariables,
  startDebugSession,
  stopDebugSession,
} from "../debug/service.js";

export const debugRouter = Router();
const session = (req: unknown) => (req as any).userSession as UserSession;

debugRouter.get("/", (req, res) => res.json({ session: getDebugSession(session(req).workspaceDir) }));

debugRouter.get("/scopes", async (req, res) => {
  const frameId = typeof req.query.frameId === "string" ? req.query.frameId : "";
  try { res.json({ scopes: await getDebugScopes(session(req).workspaceDir, frameId) }); }
  catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : "Failed to load debug scopes" }); }
});

debugRouter.get("/variables", async (req, res) => {
  const reference = Number(req.query.reference);
  try { res.json({ variables: await getDebugVariables(session(req).workspaceDir, reference) }); }
  catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : "Failed to load debug variables" }); }
});

debugRouter.post("/evaluate", async (req, res) => {
  if (!canWriteActiveWorkspace(session(req))) return res.status(403).json({ error: "Workspace is read-only" });
  const frameId = typeof req.body?.frameId === "string" ? req.body.frameId : "";
  const expression = typeof req.body?.expression === "string" ? req.body.expression : "";
  try { res.json({ result: await evaluateDebugExpression(session(req).workspaceDir, frameId, expression) }); }
  catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : "Failed to evaluate expression" }); }
});

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

debugRouter.delete("/", async (req, res) => {
  if (!canWriteActiveWorkspace(session(req))) return res.status(403).json({ error: "Workspace is read-only" });
  try { res.json({ session: await stopDebugSession(session(req).workspaceDir) }); }
  catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : "Failed to stop debugger" }); }
});
