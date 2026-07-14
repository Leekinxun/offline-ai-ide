import { Router } from "express";
import {
  listConversationSummaries,
  readConversationMessages,
} from "../chat/history.js";
import type { UserSession } from "../auth/sessionManager.js";
import { listRunSummaries, readRunRecord } from "../chat/runHistory.js";

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

chatRouter.get("/runs/:runId", (req, res) => {
  try {
    res.json(readRunRecord(getSessionWorkspace(req), req.params.runId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load agent run";
    res.status(message === "Run not found" ? 404 : 400).json({ error: message });
  }
});
