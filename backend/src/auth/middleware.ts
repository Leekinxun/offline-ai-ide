import { Request, Response, NextFunction } from "express";
import { IncomingMessage } from "http";
import { sessionManager, UserSession } from "./sessionManager.js";

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers["authorization"];
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const session = sessionManager.getSession(token);
  if (!session) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  (req as any).userSession = session;
  next();
}

export function getWsSession(req: IncomingMessage): UserSession | null {
  const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
  const token = url.searchParams.get("token");
  return sessionManager.getSession(token);
}
