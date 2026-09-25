import { Router } from "express";
import path from "node:path";
import { isSamePath, sessionManager } from "../auth/sessionManager.js";
import { authMiddleware } from "../auth/middleware.js";
import { loginLimiter } from "../auth/loginLimiter.js";
import {
  DesktopFolderPickerTimeoutError,
  DesktopFolderPickerUnavailableError,
  pickDesktopFolder,
} from "../auth/desktopFolderPicker.js";
import { getDebugSession, stopDebugSession } from "../debug/service.js";
import { stopDiagnosticsSession } from "../diagnostics/service.js";

export const authRouter = Router();

// POST /api/auth/register
authRouter.post("/register", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const username = typeof req.body?.username === "string" ? req.body.username : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (username.length > 128 || password.length > 1024) {
    return res.status(400).json({ error: "Username or password is too long" });
  }
  const attempt = loginLimiter.start(req.ip || req.socket.remoteAddress || "unknown", `register:${username}`);
  if (!attempt.allowed) {
    res.setHeader("Retry-After", String(attempt.retryAfterSeconds));
    return res.status(429).json({ error: "Too many registration attempts" });
  }
  try {
    const registration = await sessionManager.requestRegistrationAsync(username, password);
    // Registrations are intentionally counted toward the per-IP KDF budget.
    attempt.finish(false);
    return res.status(201).json({ status: "pending", registration });
  } catch (error: any) {
    attempt.finish(false);
    const message = error?.message || "Registration failed";
    const status = message.includes("already registered") ? 409 : 400;
    return res.status(status).json({ error: message });
  }
});

// POST /api/auth/login
authRouter.post("/login", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const username = req.body?.username;
  const password = req.body?.password;
  if (typeof username !== "string" || !username || username.length > 128 ||
      typeof password !== "string" || !password || password.length > 1024) {
    return res.status(400).json({ error: "Username and password required" });
  }
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const attempt = loginLimiter.start(ip, username);
  if (!attempt.allowed) {
    res.setHeader("Retry-After", String(attempt.retryAfterSeconds));
    return res.status(429).json({ error: "Too many login attempts" });
  }
  try {
    const result = await sessionManager.loginAsync(username, password);
    attempt.finish(Boolean(result));
    if (!result) return res.status(401).json({ error: "Invalid credentials" });
    return res.json({ ...result, desktop: process.env.CREWFORGE_DESKTOP === "1" });
  } catch {
    attempt.finish(null);
    return res.status(503).json({ error: "Login temporarily unavailable" });
  }
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
  const isAtRoot = isSamePath(result.path, result.rootPath);
  res.json({
    ...result,
    selectable: true,
    canNavigateUp: !isAtRoot,
    parentPath: !isAtRoot ? path.dirname(result.path) : null,
  });
});
