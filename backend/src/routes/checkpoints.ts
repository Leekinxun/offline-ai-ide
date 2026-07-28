import { Router } from "express";
import type { UserSession } from "../auth/sessionManager.js";
import { createCheckpoint, listCheckpoints, restoreCheckpoint } from "../chat/checkpoints.js";
import { canWriteActiveWorkspace } from "../team/sessionBridge.js";

export const checkpointsRouter = Router();

function workspace(req: unknown): string {
  return ((req as any).userSession as UserSession).workspaceDir;
}

checkpointsRouter.get("/", (req, res) => {
  res.json({ checkpoints: listCheckpoints(workspace(req)) });
});

checkpointsRouter.post("/create", (req, res) => {
  if (!canWriteActiveWorkspace((req as any).userSession as UserSession)) {
    return res.status(403).json({ error: "Workspace is read-only" });
  }
  try {
    const checkpoint = createCheckpoint(workspace(req), {
      label: typeof req.body?.label === "string" ? req.body.label : undefined,
      conversationId:
        typeof req.body?.conversationId === "string" ? req.body.conversationId : undefined,
      runId: typeof req.body?.runId === "string" ? req.body.runId : undefined,
      kind: "manual",
    });
    res.status(201).json({ checkpoint });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Checkpoint failed" });
  }
});

checkpointsRouter.post("/:id/restore", (req, res) => {
  if (!canWriteActiveWorkspace((req as any).userSession as UserSession)) {
    return res.status(403).json({ error: "Workspace is read-only" });
  }
  try {
    const checkpoint = restoreCheckpoint(workspace(req), req.params.id);
    res.json({ restored: true, checkpoint });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Restore failed";
    res.status(message === "Checkpoint not found" ? 404 : 400).json({ error: message });
  }
});
