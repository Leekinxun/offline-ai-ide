import { Router } from "express";
import {
  listConversationSummaries,
  readConversationMessages,
} from "../chat/history.js";
import type { UserSession } from "../auth/sessionManager.js";

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
