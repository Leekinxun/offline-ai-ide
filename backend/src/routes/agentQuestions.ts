import { Router } from "express";
import type { UserSession } from "../auth/sessionManager.js";
import { answerAgentQuestion, listAgentQuestions } from "../chat/agentQuestions.js";

export const agentQuestionsRouter = Router();
agentQuestionsRouter.get("/", (req, res) => {
  const session = (req as typeof req & { userSession: UserSession }).userSession;
  const conversationId = typeof req.query.conversationId === "string" ? req.query.conversationId : undefined;
  res.setHeader("Cache-Control", "no-store");
  res.json({ questions: listAgentQuestions(session.workspaceDir, session.username, conversationId) });
});
agentQuestionsRouter.post("/:id/answer", (req, res) => {
  const session = (req as typeof req & { userSession: UserSession }).userSession;
  try {
    answerAgentQuestion(session.workspaceDir, session.username, req.params.id, req.body);
    res.json({ accepted: true });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Answer rejected" });
  }
});
