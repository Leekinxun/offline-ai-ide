import { Router } from "express";
import type { UserSession } from "../auth/sessionManager.js";
import { discoverRunTasks, listRunRecords, startRunTask, stopRunTask } from "../run/service.js";
import { canWriteActiveWorkspace } from "../team/sessionBridge.js";

export const runRouter = Router();

function workspace(req: unknown): string {
  return ((req as any).userSession as UserSession).workspaceDir;
}

runRouter.get("/", (req, res) => res.json({ tasks: discoverRunTasks(workspace(req)), runs: listRunRecords(workspace(req)) }));
runRouter.post("/:taskId", (req, res) => {
  if (!canWriteActiveWorkspace((req as any).userSession as UserSession)) {
    return res.status(403).json({ error: "Workspace is read-only" });
  }
  try {
    res.status(202).json({ run: startRunTask(workspace(req), req.params.taskId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Task execution failed";
    res.status(message === "Unknown or unavailable task" ? 404 : 500).json({ error: message });
  }
});

runRouter.delete("/:runId", (req, res) => {
  if (!canWriteActiveWorkspace((req as any).userSession as UserSession)) {
    return res.status(403).json({ error: "Workspace is read-only" });
  }
  try {
    res.json({ run: stopRunTask(workspace(req), req.params.runId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to stop task";
    res.status(message === "Run is not active" ? 409 : 500).json({ error: message });
  }
});
