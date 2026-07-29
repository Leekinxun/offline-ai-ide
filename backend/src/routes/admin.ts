import { Router, Request, Response } from "express";
import { sessionManager, UserSession } from "../auth/sessionManager.js";
import {
  clearPluginOverride,
  getAgentSettings,
  getAppSettings,
  getLlmSettings,
  getMcpSettings,
  getPluginOverrides,
  normalizeMcpServers,
  setPluginEnabled,
  updateAppSettings,
  updateAgentSettings,
  updateLlmSettings,
  updateMcpSettings,
} from "../config.js";
import { getMcpClient } from "../agent/mcp.js";
import { getModelCapabilities } from "../agent/modelCapabilities.js";
import {
  deleteMemory,
  listMemoryEntries,
  mergeMemory,
  writeMemory,
} from "../agent/memory.js";
import {
  getManagedWorkspaceSkill,
  listManagedWorkspaceSkills,
  listSkillUsage,
  setWorkspaceSkillEnabled,
} from "../agent/skills.js";

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
    pendingRegistrations: sessionManager.listPendingRegistrations(),
    allowedRoots: sessionManager.getAllowedRoots(),
    llm: getLlmSettings(),
    agents: getAgentSettings(),
    mcp: getMcpSettings(),
    app: getAppSettings(),
    plugins: {
      overrides: getPluginOverrides(),
    },
  });
});

adminRouter.put("/agents", (req, res) => {
  if (!getAdminSession(req, res)) return;
  try {
    res.json({ agents: updateAgentSettings(req.body || {}) });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
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

adminRouter.get("/llm/capabilities", async (req, res) => {
  if (!getAdminSession(req, res)) return;

  try {
    const llm = getLlmSettings();
    const capabilities = await getModelCapabilities(
      {
        apiUrl: llm.vllmApiUrl,
        apiKey: llm.vllmApiKey,
        modelName: llm.modelName,
        fallbackMaxOutputTokens: llm.maxTokens,
      },
      req.query.refresh === "1"
    );
    res.json({ capabilities });
  } catch (error: any) {
    res.status(502).json({ error: error.message });
  }
});

adminRouter.get("/memory", (req, res) => {
  const session = getAdminSession(req, res);
  if (!session) return;
  try {
    res.json({ memory: listMemoryEntries(session.workspaceDir) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.put("/memory/:scope", (req, res) => {
  const session = getAdminSession(req, res);
  if (!session) return;
  if (req.body?.content !== undefined && typeof req.body.content !== "string") {
    return res.status(400).json({ error: "Memory content must be a string" });
  }
  try {
    writeMemory(session.workspaceDir, req.params.scope, req.body?.content);
    res.json({ memory: listMemoryEntries(session.workspaceDir) });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

adminRouter.delete("/memory/:scope", (req, res) => {
  const session = getAdminSession(req, res);
  if (!session) return;
  try {
    deleteMemory(session.workspaceDir, req.params.scope);
    res.json({ memory: listMemoryEntries(session.workspaceDir) });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

adminRouter.post("/memory/merge", (req, res) => {
  const session = getAdminSession(req, res);
  if (!session) return;
  try {
    mergeMemory(session.workspaceDir, req.body?.sourceScope, req.body?.targetScope);
    res.json({ memory: listMemoryEntries(session.workspaceDir) });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

adminRouter.get("/skills", (req, res) => {
  const session = getAdminSession(req, res);
  if (!session) return;
  try {
    const query = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
    const skills = listManagedWorkspaceSkills(session.workspaceDir).filter((skill) => {
      if (!query) return true;
      return `${skill.name} ${skill.description} ${skill.trigger} ${skill.tags} ${Object.values(skill.metadata).join(" ")}`
        .toLowerCase()
        .includes(query);
    });
    res.json({ skills });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.get("/skills/:name/usage", (req, res) => {
  const session = getAdminSession(req, res);
  if (!session) return;
  try {
    res.json({ usage: listSkillUsage(session.workspaceDir, req.params.name) });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

adminRouter.get("/skills/:name", (req, res) => {
  const session = getAdminSession(req, res);
  if (!session) return;
  try {
    res.json({ skill: getManagedWorkspaceSkill(session.workspaceDir, req.params.name) });
  } catch (error: any) {
    res.status(404).json({ error: error.message });
  }
});

adminRouter.put("/skills/:name/enabled", (req, res) => {
  const session = getAdminSession(req, res);
  if (!session) return;
  try {
    res.json({ skill: setWorkspaceSkillEnabled(session.workspaceDir, req.params.name, req.body?.enabled) });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
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
    const existing = getMcpSettings();
    const servers = req.body.servers === undefined
      ? (existing.servers || [])
      : normalizeMcpServers(req.body.servers);
    if (
      req.body.servers !== undefined &&
      (!Array.isArray(req.body.servers) || servers.length !== req.body.servers.length)
    ) {
      return res.status(400).json({ error: "Invalid MCP server configuration" });
    }
    const mcp = updateMcpSettings({
      baseUrls: baseResult.urls,
      lazyUrls: lazyResult.urls,
      disabledUrls: disabledResult.urls,
      servers,
      timeout,
      connectTimeout,
    });
    const client = getMcpClient();
    client.resetDiscovery();
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

adminRouter.post("/registrations/:username/approve", (req, res) => {
  if (!getAdminSession(req, res)) return;

  const username = normalizeUsername(req.params.username);
  const defaultWorkspace = normalizeWorkspace(req.body?.defaultWorkspace);
  if (!username) {
    return res.status(400).json({ error: "username required" });
  }

  try {
    const user = sessionManager.approveRegistration(
      username,
      defaultWorkspace || undefined
    );
    res.json({ user });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

adminRouter.delete("/registrations/:username", (req, res) => {
  if (!getAdminSession(req, res)) return;

  const username = normalizeUsername(req.params.username);
  if (!username) {
    return res.status(400).json({ error: "username required" });
  }

  try {
    sessionManager.rejectRegistration(username);
    res.json({ status: "ok" });
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
  const requestedMaxTokens =
    req.body.maxTokens === undefined ? getLlmSettings().maxTokens : normalizePositiveInteger(req.body.maxTokens);
  const maxTokens = requestedMaxTokens || getLlmSettings().maxTokens;
  const maxAgentIterations = normalizePositiveInteger(req.body.maxAgentIterations);
  const systemPrompt =
    typeof req.body.systemPrompt === "string" ? req.body.systemPrompt : "";

  if (!vllmApiUrl || !modelName || maxAgentIterations === null) {
    return res.status(400).json({
      error:
        "vllmApiUrl, modelName and positive integer maxAgentIterations are required",
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
