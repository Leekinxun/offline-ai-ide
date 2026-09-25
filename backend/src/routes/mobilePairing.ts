import path from "node:path";
import { Router, type Request, type Response, type NextFunction } from "express";
import { authMiddleware, mobileAuthMiddleware } from "../auth/middleware.js";
import { sessionManager, type UserSession } from "../auth/sessionManager.js";
import { getTeamManager } from "../team/sessionBridge.js";
import {
  getMobileSessionFromRequest,
  isSameMobileOrigin,
  mobileCookieHeader,
  mobilePairingManager,
  PairingError,
  publicMobileSession,
  type MobileSession,
} from "../mobile/pairing.js";

export const mobilePairingRouter = Router();

function desktop(req: Request): UserSession {
  return (req as Request & { userSession: UserSession }).userSession;
}

function mobile(req: Request): MobileSession {
  return (req as Request & { mobileSession: MobileSession }).mobileSession;
}

function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "no-store");
  next();
}

function sameOriginJson(req: Request, res: Response, next: NextFunction): void {
  if (!isSameMobileOrigin(req) || !req.is("application/json")) {
    res.status(403).json({ error: "Same-origin JSON request required" });
    return;
  }
  next();
}

function handleError(res: Response, error: unknown): void {
  const status = error instanceof PairingError ? error.statusCode : 500;
  const message = error instanceof Error ? error.message : "Mobile pairing failed";
  res.status(status).json({ error: status === 500 ? "Mobile pairing failed" : message });
}

mobilePairingRouter.use(noStore);

// Phone endpoints. Tickets and claim tokens are only accepted in JSON bodies,
// never as URL query parameters or paths that a proxy may log.
mobilePairingRouter.post("/claim", sameOriginJson, (req, res) => {
  const ticket = typeof req.body?.ticket === "string" ? req.body.ticket : "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return res.status(400).json({ error: "Invalid pairing ticket" });
  try {
    res.json(mobilePairingManager.claim(ticket, req.body?.deviceName));
  } catch (error) {
    handleError(res, error);
  }
});

mobilePairingRouter.post("/claim/status", sameOriginJson, (req, res) => {
  const claimToken = typeof req.body?.claimToken === "string" ? req.body.claimToken : "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(claimToken)) return res.status(400).json({ error: "Invalid claim token" });
  try {
    res.json(mobilePairingManager.claimStatus(claimToken));
  } catch (error) {
    handleError(res, error);
  }
});

mobilePairingRouter.post("/exchange", sameOriginJson, (req, res) => {
  const claimToken = typeof req.body?.claimToken === "string" ? req.body.claimToken : "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(claimToken)) return res.status(400).json({ error: "Invalid claim token" });
  try {
    const existing = getMobileSessionFromRequest(req);
    const { cookieSecret, session } = mobilePairingManager.exchange(claimToken);
    if (existing) mobilePairingManager.revoke(existing.id);
    res.setHeader("Set-Cookie", mobileCookieHeader(cookieSecret, (session.expiresAt - Date.now()) / 1000));
    res.json({ session: publicMobileSession(session) });
  } catch (error) {
    handleError(res, error);
  }
});

mobilePairingRouter.get("/me", mobileAuthMiddleware, (req, res) => {
  res.json({ session: publicMobileSession(mobile(req)) });
});

mobilePairingRouter.post("/logout", mobileAuthMiddleware, (req, res) => {
  mobilePairingManager.revoke(mobile(req).id);
  res.setHeader("Set-Cookie", mobileCookieHeader("", 0));
  res.json({ status: "ok" });
});

mobilePairingRouter.get("/scopes", mobileAuthMiddleware, (req, res) => {
  const session = mobile(req);
  const parent = sessionManager.getSession(session.parentSessionToken);
  if (!parent) return res.status(401).json({ error: "Desktop session expired" });
  const scopes: Array<{ key: string; name: string; teamId: string | null; role: string | null }> = [];
  for (const scope of mobilePairingManager.availableScopes(session)) {
    if (!scope.teamId) {
      scopes.push({ key: scope.key, name: path.basename(scope.workspaceDir), teamId: null, role: "owner" });
      continue;
    }
    try {
      const team = getTeamManager(parent).getTeamDetails(scope.teamId, session.username);
      scopes.push({ key: scope.key, name: team.name, teamId: team.id, role: team.role });
    } catch {
      // Membership can be removed between the initial filter and this read.
    }
  }
  res.json({ scopes, activeScopeKey: session.scopeKey });
});

mobilePairingRouter.post("/scope", mobileAuthMiddleware, (req, res) => {
  const key = typeof req.body?.key === "string" ? req.body.key : "";
  if (!key || key.length > 128) return res.status(400).json({ error: "Scope key required" });
  try {
    const session = mobilePairingManager.setScope(mobile(req), key);
    res.json({ session: publicMobileSession(session) });
  } catch (error) {
    handleError(res, error);
  }
});

// Desktop endpoints use the existing Bearer login. The mobile cookie is never
// accepted by authMiddleware and cannot be used for desktop APIs.
mobilePairingRouter.post("/", authMiddleware, (req, res) => {
  try {
    res.status(201).json(mobilePairingManager.create(desktop(req)));
  } catch (error) {
    handleError(res, error);
  }
});

mobilePairingRouter.get("/devices", authMiddleware, (req, res) => {
  res.json({ devices: mobilePairingManager.listDevices(desktop(req)) });
});

mobilePairingRouter.delete("/devices/:id", authMiddleware, (req, res) => {
  if (!mobilePairingManager.revokeForUser(req.params.id, desktop(req).username)) {
    return res.status(404).json({ error: "Device not found" });
  }
  res.json({ status: "ok" });
});

mobilePairingRouter.get("/:id", authMiddleware, (req, res) => {
  try {
    res.json(mobilePairingManager.status(req.params.id, desktop(req).token));
  } catch (error) {
    handleError(res, error);
  }
});

mobilePairingRouter.post("/:id/approve", authMiddleware, (req, res) => {
  try {
    res.json(mobilePairingManager.approve(req.params.id, desktop(req).token));
  } catch (error) {
    handleError(res, error);
  }
});

mobilePairingRouter.post("/:id/reject", authMiddleware, (req, res) => {
  try {
    res.json(mobilePairingManager.reject(req.params.id, desktop(req).token));
  } catch (error) {
    handleError(res, error);
  }
});
