import { Router, Request, Response } from "express";
import { sessionManager, UserSession } from "../auth/sessionManager.js";
import { getLlmSettings, updateLlmSettings } from "../config.js";

export const adminRouter = Router();

function getAdminSession(req: Request, res: Response): UserSession | null {
  const session = (req as any).userSession as UserSession | undefined;
  if (!session?.isAdmin) {
    res.status(403).json({ error: "Admin access required" });
    return null;
  }
  return session;
}

function normalizeUsername(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePassword(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeWorkspace(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isValidUsername(username: string): boolean {
  return /^[^\s/\\]+$/.test(username);
}

adminRouter.get("/settings", (req, res) => {
  if (!getAdminSession(req, res)) return;

  res.json({
    users: sessionManager.listUsers(),
    allowedRoots: sessionManager.getAllowedRoots(),
    llm: getLlmSettings(),
  });
});

adminRouter.post("/users", (req, res) => {
  if (!getAdminSession(req, res)) return;

  const username = normalizeUsername(req.body.username);
  const password = normalizePassword(req.body.password);
  const defaultWorkspace = normalizeWorkspace(req.body.defaultWorkspace);
  const isAdmin = Boolean(req.body.isAdmin);

  if (!username || !password || !defaultWorkspace) {
    return res.status(400).json({ error: "username, password and defaultWorkspace are required" });
  }
  if (!isValidUsername(username)) {
    return res.status(400).json({ error: "Username cannot contain spaces or path separators" });
  }

  try {
    const user = sessionManager.createUser({
      username,
      password,
      defaultWorkspace,
      isAdmin,
    });
    res.status(201).json({ user });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

adminRouter.patch("/users/:username/password", (req, res) => {
  if (!getAdminSession(req, res)) return;

  const username = normalizeUsername(req.params.username);
  const password = normalizePassword(req.body.password);

  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }

  try {
    const user = sessionManager.updateUserPassword(username, password);
    res.json({ user });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

adminRouter.delete("/users/:username", (req, res) => {
  const session = getAdminSession(req, res);
  if (!session) return;

  const username = normalizeUsername(req.params.username);
  if (!username) {
    return res.status(400).json({ error: "username required" });
  }

  try {
    sessionManager.deleteUser(username, session.username);
    res.json({ status: "ok" });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

adminRouter.put("/llm", (req, res) => {
  if (!getAdminSession(req, res)) return;

  const vllmApiUrl =
    typeof req.body.vllmApiUrl === "string" ? req.body.vllmApiUrl.trim() : "";
  const vllmApiKey =
    typeof req.body.vllmApiKey === "string" ? req.body.vllmApiKey : "";
  const modelName =
    typeof req.body.modelName === "string" ? req.body.modelName.trim() : "";

  if (!vllmApiUrl || !modelName) {
    return res.status(400).json({ error: "vllmApiUrl and modelName are required" });
  }

  try {
    const llm = updateLlmSettings({
      vllmApiUrl,
      vllmApiKey,
      modelName,
    });
    res.json({ llm });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
