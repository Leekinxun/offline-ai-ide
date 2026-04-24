import { Router, Request, Response } from "express";
import { sessionManager, UserSession } from "../auth/sessionManager.js";
import {
  clearPluginOverride,
  getLlmSettings,
  getPluginOverrides,
  setPluginEnabled,
  updateLlmSettings,
} from "../config.js";

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

function normalizePositiveInteger(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? parseInt(value, 10)
        : Number.NaN;

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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
    plugins: {
      overrides: getPluginOverrides(),
    },
  });
});

adminRouter.put("/plugins/:pluginId", (req, res) => {
  if (!getAdminSession(req, res)) return;

  const pluginId =
    typeof req.params.pluginId === "string" ? req.params.pluginId.trim() : "";
  const enabled = req.body.enabled;

  if (!pluginId || typeof enabled !== "boolean") {
    return res.status(400).json({
      error: "pluginId and a boolean enabled flag are required",
    });
  }

  try {
    const overrides = setPluginEnabled(pluginId, enabled);
    res.json({
      status: "ok",
      pluginId,
      enabled,
      overrides,
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

adminRouter.delete("/plugins/:pluginId", (req, res) => {
  if (!getAdminSession(req, res)) return;

  const pluginId =
    typeof req.params.pluginId === "string" ? req.params.pluginId.trim() : "";

  if (!pluginId) {
    return res.status(400).json({
      error: "pluginId is required",
    });
  }

  try {
    const overrides = clearPluginOverride(pluginId);
    res.json({
      status: "ok",
      pluginId,
      overrides,
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
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
  const maxTokens = normalizePositiveInteger(req.body.maxTokens);

  if (!vllmApiUrl || !modelName || maxTokens === null) {
    return res.status(400).json({
      error: "vllmApiUrl, modelName and a positive integer maxTokens are required",
    });
  }

  try {
    const llm = updateLlmSettings({
      vllmApiUrl,
      vllmApiKey,
      modelName,
      maxTokens,
    });
    res.json({ llm });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
