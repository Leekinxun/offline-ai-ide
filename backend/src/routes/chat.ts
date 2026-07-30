import { Router } from "express";
import {
  forkConversation,
  listConversationSummaries,
  readConversationMessages,
} from "../chat/history.js";
import type { UserSession } from "../auth/sessionManager.js";
import { sessionManager } from "../auth/sessionManager.js";
import { listChildRuns, listRunSummaries, readRunRecord } from "../chat/runHistory.js";
import { findCheckpointForRun, restoreCheckpoint } from "../chat/checkpoints.js";
import { canWriteActiveWorkspace } from "../team/sessionBridge.js";
import {
  createManagedWorktree,
  listManagedWorktrees,
  removeManagedWorktree,
} from "../chat/worktrees.js";

export const chatRouter = Router();

function getSessionWorkspace(req: unknown): string {
  return ((req as any).userSession as UserSession).workspaceDir;
}

chatRouter.get("/conversations", (req, res) => {
  try {
    res.json({
      conversations: listConversationSummaries(getSessionWorkspace(req)),
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to list conversations",
    });
  }
});

chatRouter.get("/conversations/:id", (req, res) => {
  try {
    const summary = listConversationSummaries(getSessionWorkspace(req)).find(
      (conversation) => conversation.id === req.params.id
    );
    res.json({
      id: req.params.id,
      messages: readConversationMessages(getSessionWorkspace(req), req.params.id),
      ...(summary
        ? { mode: summary.mode, status: summary.status, summary: summary.summary }
        : {}),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load conversation";
    res.status(message === "Conversation not found" ? 404 : 400).json({
      error: message,
    });
  }
});

chatRouter.post("/conversations/:id/fork", (req, res) => {
  try {
    const upToTimestamp = req.body?.upToTimestamp;
    if (
      upToTimestamp !== undefined &&
      (typeof upToTimestamp !== "number" || !Number.isFinite(upToTimestamp))
    ) {
      return res.status(400).json({ error: "upToTimestamp must be a finite number" });
    }
    const conversation = forkConversation(getSessionWorkspace(req), req.params.id, {
      ...(typeof upToTimestamp === "number" ? { upToTimestamp } : {}),
      ...(typeof req.body?.title === "string" ? { title: req.body.title } : {}),
    });
    res.status(201).json({ conversation });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fork conversation";
    res.status(message === "Conversation not found" ? 404 : 400).json({ error: message });
  }
});

chatRouter.get("/runs", (req, res) => {
  try {
    const conversationId =
      typeof req.query.conversationId === "string" ? req.query.conversationId.trim() : undefined;
    res.json({ runs: listRunSummaries(getSessionWorkspace(req), conversationId) });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to list agent runs",
    });
  }
});

chatRouter.get("/runs/:runId/children", (req, res) => {
  try {
    res.json({ runs: listChildRuns(getSessionWorkspace(req), req.params.runId) });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to list child runs",
    });
  }
});

chatRouter.get("/runs/:runId", (req, res) => {
  try {
    res.json(readRunRecord(getSessionWorkspace(req), req.params.runId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load agent run";
    res.status(message === "Run not found" ? 404 : 400).json({ error: message });
  }
});

chatRouter.post("/runs/:runId/revert", (req, res) => {
  const session = (req as any).userSession as UserSession;
  if (!canWriteActiveWorkspace(session)) {
    return res.status(403).json({ error: "Workspace is read-only" });
  }
  try {
    const run = readRunRecord(session.workspaceDir, req.params.runId);
    if (run.status === "running" || run.status === "queued") {
      return res.status(409).json({ error: "Stop the agent run before reverting its workspace" });
    }
    const checkpoint = findCheckpointForRun(session.workspaceDir, req.params.runId);
    if (!checkpoint) return res.status(404).json({ error: "Run checkpoint not found" });
    res.json({ restored: true, checkpoint: restoreCheckpoint(session.workspaceDir, checkpoint.id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to revert run";
    res.status(message === "Run not found" || message === "Checkpoint not found" ? 404 : 400).json({ error: message });
  }
});

chatRouter.get("/worktrees", (req, res) => {
  try {
    res.json({ worktrees: listManagedWorktrees(getSessionWorkspace(req)) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Failed to list worktrees" });
  }
});

chatRouter.post("/worktrees", (req, res) => {
  if (!canWriteActiveWorkspace((req as any).userSession as UserSession)) {
    return res.status(403).json({ error: "Workspace is read-only" });
  }
  try {
    const worktree = createManagedWorktree(getSessionWorkspace(req), {
      ...(typeof req.body?.name === "string" ? { name: req.body.name } : {}),
      ...(typeof req.body?.revision === "string" ? { revision: req.body.revision } : {}),
    });
    res.status(201).json({ worktree });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Failed to create worktree" });
  }
});

chatRouter.post("/vibe-window", (req, res) => {
  const session = (req as any).userSession as UserSession;
  if (!canWriteActiveWorkspace(session)) {
    return res.status(403).json({ error: "Workspace is read-only" });
  }
  if (session.isolated) {
    return res.status(409).json({ error: "This window is already isolated" });
  }
  let worktree: ReturnType<typeof createManagedWorktree> | null = null;
  try {
    worktree = createManagedWorktree(session.workspaceDir, {
      name: typeof req.body?.name === "string" ? req.body.name : "vibe",
      ...(typeof req.body?.revision === "string" ? { revision: req.body.revision } : {}),
    });
    const isolatedSession = sessionManager.createIsolatedSession(session.token, worktree.path);
    res.status(201).json({ worktree, session: isolatedSession });
  } catch (error) {
    if (worktree) {
      try { removeManagedWorktree(session.workspaceDir, worktree.id); } catch { /* preserve the original failure */ }
    }
    res.status(400).json({ error: error instanceof Error ? error.message : "Failed to create isolated Vibe window" });
  }
});

chatRouter.delete("/worktrees/:id", (req, res) => {
  if (!canWriteActiveWorkspace((req as any).userSession as UserSession)) {
    return res.status(403).json({ error: "Workspace is read-only" });
  }
  try {
    res.json({ removed: true, worktree: removeManagedWorktree(getSessionWorkspace(req), req.params.id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to remove worktree";
    res.status(message === "Managed worktree not found" ? 404 : 400).json({ error: message });
  }
});
