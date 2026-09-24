import { Router } from "express";
import path from "node:path";
import { sessionManager } from "../auth/sessionManager.js";
import { authMiddleware } from "../auth/middleware.js";
import {
  DesktopFolderPickerTimeoutError,
  DesktopFolderPickerUnavailableError,
  pickDesktopFolder,
} from "../auth/desktopFolderPicker.js";
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
  res.json({ ...result, desktop: process.env.CREWFORGE_DESKTOP === "1" });
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
    workspaceRoot: session.workspaceRoot,
    isAdmin: session.isAdmin,
    isolated: session.isolated,
    desktop: process.env.CREWFORGE_DESKTOP === "1",
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
  if (session.isolated) {
    return res.status(403).json({ error: "Isolated Vibe windows are locked to their worktree" });
  }
  const result = sessionManager.changeWorkspaceWithinUserRoot(session.token, newPath);
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

// POST /api/auth/workspace/pick
authRouter.post("/workspace/pick", authMiddleware, async (req, res) => {
  const session = (req as any).userSession;
  if (process.env.CREWFORGE_DESKTOP !== "1") {
    return res.status(404).json({ error: "Desktop folder picker is unavailable" });
  }
  if (session.isolated) {
    return res.status(403).json({ error: "Isolated Vibe windows are locked to their worktree" });
  }

  const previousWorkspace = session.workspaceDir;
  try {
    const picked = await pickDesktopFolder(session.workspaceDir);
    if (!picked.path) {
      return res.json({ cancelled: true });
    }
    const result = sessionManager.changeWorkspaceFromTrustedDesktopPicker(session.token, picked.path);
    if (!result) {
      return res.status(400).json({ error: "Selected folder is not an accessible directory" });
    }
    if (result.workspaceDir !== previousWorkspace) {
      try { stopDiagnosticsSession(previousWorkspace); } catch { /* no active watcher */ }
      if (getDebugSession(previousWorkspace)) {
        try { await stopDebugSession(previousWorkspace); } catch { /* already stopped */ }
      }
    }
    return res.json(result);
  } catch (error: any) {
    if (error instanceof DesktopFolderPickerUnavailableError) {
      return res.status(503).json({ error: error.message });
    }
    if (error instanceof DesktopFolderPickerTimeoutError) {
      return res.status(504).json({ error: error.message });
    }
    return res.status(500).json({ error: error?.message || "Desktop folder picker failed" });
  }
});

// GET /api/auth/workspace/list?path=xxx
authRouter.get("/workspace/list", authMiddleware, (req, res) => {
  const session = (req as any).userSession;
  const dir = typeof req.query.path === "string" ? req.query.path : undefined;
  const result = sessionManager.listUserWorkspaceDirectories(session.token, dir);
  if (!result) {
    return res.status(403).json({ error: "Path is outside the user's workspace root" });
  }
  res.json({
    ...result,
    selectable: true,
    canNavigateUp: result.path !== result.rootPath,
    parentPath: result.path !== result.rootPath ? path.dirname(result.path) : null,
  });
});
