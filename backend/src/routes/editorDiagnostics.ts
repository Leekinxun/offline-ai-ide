import { Router } from "express";
import type { UserSession } from "../auth/sessionManager.js";
import { clearEditorDiagnostics, EditorDiagnosticsError, getEditorDiagnosticFeedback, publishEditorDiagnostics } from "../chat/editorDiagnostics.js";

export const editorDiagnosticsRouter = Router();
editorDiagnosticsRouter.use((req, res, next) => {
  const session = (req as typeof req & { userSession?: UserSession }).userSession;
  if (!session?.username || !session.workspaceDir) { res.status(401).json({ error: "Unauthorized" }); return; }
  res.setHeader("Cache-Control", "no-store"); next();
});
editorDiagnosticsRouter.get("/", (req, res) => {
  const session = (req as typeof req & { userSession: UserSession }).userSession;
  if (req.query.path !== undefined && typeof req.query.path !== "string") { res.status(400).json({ error: "Invalid diagnostic path" }); return; }
  res.json({ snapshots: getEditorDiagnosticFeedback({ workspaceDir: session.workspaceDir, owner: session.username, path: req.query.path as string | undefined }) });
});
editorDiagnosticsRouter.post("/", (req, res) => {
  const session = (req as typeof req & { userSession: UserSession }).userSession;
  try { res.json({ snapshot: publishEditorDiagnostics({ workspaceDir: session.workspaceDir, owner: session.username }, req.body) }); }
  catch (error) { res.status(error instanceof EditorDiagnosticsError ? error.status : 400).json({ error: error instanceof EditorDiagnosticsError ? error.message : "Editor diagnostics could not be accepted" }); }
});
editorDiagnosticsRouter.delete("/", (req, res) => {
  const session = (req as typeof req & { userSession: UserSession }).userSession;
  try { clearEditorDiagnostics({ workspaceDir: session.workspaceDir, owner: session.username }, req.body); res.json({ cleared: true }); }
  catch (error) { res.status(error instanceof EditorDiagnosticsError ? error.status : 400).json({ error: error instanceof EditorDiagnosticsError ? error.message : "Editor diagnostics could not be cleared" }); }
});
