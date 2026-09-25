import { Request, Response, NextFunction } from "express";
import { IncomingMessage } from "http";
import { sessionManager, UserSession } from "./sessionManager.js";
import {
  getMobileSessionFromRequest,
  getMobileSessionFromUpgrade,
  isSameMobileOrigin,
  validateMobileCsrf,
  type MobileSession,
} from "../mobile/pairing.js";

export { getMobileSessionFromRequest, getMobileSessionFromUpgrade };

export function mobileAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const session = getMobileSessionFromRequest(req);
  if (!session) {
    res.status(401).json({ error: "Mobile session expired" });
    return;
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    if (!isSameMobileOrigin(req) || !validateMobileCsrf(session, req.headers["x-crewforge-mobile-csrf"])) {
      res.status(403).json({ error: "Mobile request failed origin or CSRF validation" });
      return;
    }
  }
  (req as Request & { mobileSession: MobileSession }).mobileSession = session;
  next();
}

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
