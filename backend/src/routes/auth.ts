import { Router } from "express";
import { sessionManager } from "../auth/sessionManager.js";
import { authMiddleware } from "../auth/middleware.js";
import { getDebugSession, stopDebugSession } from "../debug/service.js";
import { stopDiagnosticsSession } from "../diagnostics/service.js";

export const authRouter = Router();

// POST /api/auth/register
authRouter.post("/register", (req, res) => {
  const username = typeof req.body?.username === "string" ? req.body.username : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  try {
    const registration = sessionManager.requestRegistration(username, password);
    res.status(201).json({ status: "pending", registration });
  } catch (error: any) {
    const message = error?.message || "Registration failed";
    const status = message.includes("already registered") ? 409 : 400;
    res.status(status).json({ error: message });
  }
});

// POST /api/auth/login
authRouter.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }
  const result = sessionManager.login(username, password);
  if (!result) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  res.json(result);
});

// POST /api/auth/logout
authRouter.post("/logout", (req, res) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (token) sessionManager.logout(token);
  res.json({ status: "ok" });
});

// GET /api/auth/me
authRouter.get("/me", (req, res) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const session = sessionManager.getSession(token);
  if (!session) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.json({
    username: session.username,
    workspaceDir: session.workspaceDir,
    isAdmin: session.isAdmin,
  });
});

// --- Workspace routes (protected) ---

// POST /api/auth/workspace/change
authRouter.post("/workspace/change", authMiddleware, async (req, res) => {
  const session = (req as any).userSession;
  const { path: newPath } = req.body;
  if (!newPath) {
    return res.status(400).json({ error: "path required" });
  }
  const previousWorkspace = session.workspaceDir;
  const result = sessionManager.changeWorkspace(session.token, newPath);
  if (!result) {
    return res.status(403).json({ error: "Path not allowed" });
  }
  if (result.workspaceDir !== previousWorkspace) {
    try { stopDiagnosticsSession(previousWorkspace); } catch { /* no active watcher */ }
    if (getDebugSession(previousWorkspace)) {
      try { await stopDebugSession(previousWorkspace); } catch { /* already stopped */ }
    }
  }
  res.json(result);
});

// GET /api/auth/workspace/list?path=xxx
authRouter.get("/workspace/list", authMiddleware, (req, res) => {
  const dir = (req.query.path as string) || "/";
  const entries = sessionManager.listDirectories(dir);
  res.json({
    path: dir,
    entries,
    selectable: sessionManager.isSelectableWorkspace(dir),
    allowedRoots: sessionManager.getAllowedRoots(),
  });
});
