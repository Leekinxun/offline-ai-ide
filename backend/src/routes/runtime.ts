import { Router } from "express";
import type { UserSession } from "../auth/sessionManager.js";
import { getSandboxDiagnostics, type SandboxDiagnostics } from "../run/sandboxDiagnostics.js";

export function createRuntimeRouter(readDiagnostics: () => SandboxDiagnostics = getSandboxDiagnostics): Router {
  const router = Router();
  router.get("/sandbox", (req, res) => {
    const session = (req as typeof req & { userSession?: UserSession }).userSession;
    if (!session?.username) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (!session.isAdmin) { res.status(403).json({ error: "Admin access required" }); return; }
    res.setHeader("Cache-Control", "no-store");
    if (Object.keys(req.query).length) { res.status(400).json({ error: "Sandbox diagnostics do not accept command or path parameters" }); return; }
    res.json(readDiagnostics());
  });
  return router;
}

export const runtimeRouter = createRuntimeRouter();
