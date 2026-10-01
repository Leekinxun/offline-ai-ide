import { Router } from "express";
import path from "node:path";
import type { UserSession } from "../auth/sessionManager.js";
import { canWriteActiveWorkspace } from "../team/sessionBridge.js";
import { discoverRunTasks } from "../run/service.js";
import { inputProcessSession, listProcessSessions, pollProcessSession, startProjectTaskSession, stopProcessSession, type ProcessSessionOwner } from "../run/processSessions.js";

export const processSessionsRouter = Router();
export function processOwner(req: unknown): ProcessSessionOwner {
  const session = (req as { userSession: UserSession }).userSession;
  return { workspaceDir: session.workspaceDir, owner: session.username, sessionToken: session.token };
}
export function matchesWorkspaceHeader(req: unknown): boolean {
  const request = req as { headers: Record<string, unknown>; userSession: UserSession };
  const expected = request.headers["x-workspace-dir"];
  if (expected === undefined) return true;
  if (typeof expected !== "string" || !expected) return false;
  if (path.resolve(expected) === path.resolve(request.userSession.workspaceDir)) return true;
  try { return path.resolve(decodeURIComponent(expected)) === path.resolve(request.userSession.workspaceDir); } catch { return false; }
}
processSessionsRouter.use((req, res, next) => {
  if (!(req as any).userSession?.username) return res.status(401).json({ error: "Unauthorized" });
  if (!matchesWorkspaceHeader(req)) return res.status(409).json({ error: "Workspace changed; reload before continuing" });
  if (req.method !== "GET" && !canWriteActiveWorkspace((req as any).userSession)) return res.status(403).json({ error: "Workspace is read-only" });
  next();
});
function error(res: any, cause: unknown) {
  const message = cause instanceof Error ? cause.message : "Process session request failed";
  res.status(message.includes("not found") ? 404 : message.includes("not accepting") ? 409 : 400).json({ error: (cause as NodeJS.ErrnoException)?.code ? "Process session request failed" : message });
}
processSessionsRouter.get("/", (req, res) => { try { res.json({ tasks: discoverRunTasks(processOwner(req).workspaceDir), sessions: listProcessSessions(processOwner(req)) }); } catch (cause) { error(res, cause); } });
processSessionsRouter.post("/", (req, res) => {
  if (typeof req.body?.taskId !== "string" || Object.keys(req.body || {}).some((key) => !["taskId", "timeoutMs"].includes(key))) return res.status(400).json({ error: "Select a discovered project task" });
  try { res.status(202).json({ session: startProjectTaskSession(processOwner(req), req.body.taskId, req.body.timeoutMs) }); } catch (cause) { error(res, cause); }
});
processSessionsRouter.get("/:id", (req, res) => {
  if (req.query.cursor !== undefined && (typeof req.query.cursor !== "string" || !/^\d+$/.test(req.query.cursor))) return res.status(400).json({ error: "Invalid output cursor" });
  try { res.json(pollProcessSession(processOwner(req), req.params.id, Number(req.query.cursor || 0))); } catch (cause) { error(res, cause); }
});
processSessionsRouter.post("/:id/input", async (req, res) => { try { res.json({ session: await inputProcessSession(processOwner(req), req.params.id, req.body?.text, req.body?.eof) }); } catch (cause) { error(res, cause); } });
processSessionsRouter.delete("/:id", (req, res) => { try { res.json({ session: stopProcessSession(processOwner(req), req.params.id) }); } catch (cause) { error(res, cause); } });
