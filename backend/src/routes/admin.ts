import { Router, Request, Response } from "express";
import { sessionManager, UserSession } from "../auth/sessionManager.js";
import {
  clearPluginOverride,
  getAppSettings,
  getLlmSettings,
  getMcpSettings,
  getPluginOverrides,
  setPluginEnabled,
  updateAppSettings,
  updateLlmSettings,
  updateMcpSettings,
} from "../config.js";
import { getMcpClient } from "../agent/mcp.js";

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

function normalizeMcpEndpointList(value: unknown): { urls: string[]; error?: string } {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,]/)
      : [];
  const urls: string[] = [];
  for (const rawUrl of values) {
    if (typeof rawUrl !== "string") return { urls, error: "MCP endpoints must be strings" };
    const normalized = rawUrl.trim().replace(/\/+$/, "");
    if (!normalized) continue;
    try {
      const parsed = new URL(normalized);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
    } catch {
      return { urls, error: `Invalid MCP endpoint: ${normalized}` };
    }
    if (!urls.includes(normalized)) urls.push(normalized);
  }
  return { urls };
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
    mcp: getMcpSettings(),
    app: getAppSettings(),
    plugins: {
      overrides: getPluginOverrides(),
    },
  });
});

adminRouter.get("/mcp/inspect", async (req, res) => {
  if (!getAdminSession(req, res)) return;

  try {
    const servers = await getMcpClient().inspectServers();
    res.json({ servers });
  } catch (error: any) {
    res.status(502).json({ error: error.message });
  }
});

adminRouter.put("/mcp", (req, res) => {
  if (!getAdminSession(req, res)) return;

  const baseResult = normalizeMcpEndpointList(req.body.baseUrls);
  const lazyResult = normalizeMcpEndpointList(req.body.lazyUrls);
  const disabledResult = normalizeMcpEndpointList(req.body.disabledUrls);
  if (baseResult.error || lazyResult.error || disabledResult.error) {
    return res.status(400).json({ error: baseResult.error || lazyResult.error || disabledResult.error });
  }

  const timeout = normalizePositiveInteger(req.body.timeout);
  const connectTimeout = normalizePositiveInteger(req.body.connectTimeout);
  if (timeout === null || connectTimeout === null) {
    return res.status(400).json({
      error: "MCP timeout and connectTimeout must be positive integers",
    });
  }

  try {
    const mcp = updateMcpSettings({
      baseUrls: baseResult.urls,
      lazyUrls: lazyResult.urls,
      disabledUrls: disabledResult.urls,
      timeout,
      connectTimeout,
    });
    res.json({ mcp });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.put("/app", (req, res) => {
  if (!getAdminSession(req, res)) return;

  const uploadMaxFileSizeMb = normalizePositiveInteger(
    req.body.uploadMaxFileSizeMb
  );

  if (uploadMaxFileSizeMb === null) {
    return res.status(400).json({
      error: "uploadMaxFileSizeMb must be a positive integer",
    });
  }

  try {
    const app = updateAppSettings({ uploadMaxFileSizeMb });
    res.json({ app });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
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
  const maxAgentIterations = normalizePositiveInteger(req.body.maxAgentIterations);
  const systemPrompt =
    typeof req.body.systemPrompt === "string" ? req.body.systemPrompt : "";

  if (!vllmApiUrl || !modelName || maxTokens === null || maxAgentIterations === null) {
    return res.status(400).json({
      error:
        "vllmApiUrl, modelName, positive integer maxTokens and positive integer maxAgentIterations are required",
    });
  }

  try {
    const llm = updateLlmSettings({
      vllmApiUrl,
      vllmApiKey,
      modelName,
      maxTokens,
      maxAgentIterations,
      systemPrompt,
    });
    res.json({ llm });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
