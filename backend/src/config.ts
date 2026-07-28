import path from "path";
import os from "os";
import fs from "fs";
import {
  normalizeAgentProfileOverrides,
  type AgentProfileOverrides,
} from "./agent/agentProfiles.js";

interface LlmRuntimeSettings {
  vllmApiUrl: string;
  vllmApiKey: string;
  modelName: string;
  maxTokens: number;
  maxAgentIterations: number;
  systemPrompt?: string;
}

interface PluginOverrideSettings {
  enabled: boolean;
}

interface AppRuntimeSettings {
  uploadMaxFileSizeMb: number;
}

export interface McpRuntimeSettings {
  baseUrls: string[];
  lazyUrls: string[];
  disabledUrls: string[];
  servers?: McpServerConfig[];
  timeout: number;
  connectTimeout: number;
}

export interface McpRemoteServerConfig {
  id: string;
  transport: "remote";
  url: string;
  headers?: Record<string, string>;
  oauthTokenEnv?: string;
  lazy?: boolean;
  disabled?: boolean;
}

export interface McpStdioServerConfig {
  id: string;
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  lazy?: boolean;
  disabled?: boolean;
}

export type McpServerConfig = McpRemoteServerConfig | McpStdioServerConfig;

interface PersistedPluginSettings {
  overrides?: Record<string, Partial<PluginOverrideSettings>>;
}

interface PersistedAppSettings {
  llm?: Partial<LlmRuntimeSettings>;
  plugins?: PersistedPluginSettings;
  app?: Partial<AppRuntimeSettings>;
  mcp?: Partial<McpRuntimeSettings>;
  agents?: AgentProfileOverrides;
}

function parsePositiveInteger(
  value: unknown,
  fallback: number
): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? parseInt(value, 10)
        : Number.NaN;

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseUrlList(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,]/)
      : [];

  return Array.from(
    new Set(
      values
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value)
    .filter((entry): entry is [string, string] =>
      entry[0].trim().length > 0 && typeof entry[1] === "string"
    )
    .map(([key, entryValue]) => [key.trim(), entryValue] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function normalizeMcpServers(value: unknown): McpServerConfig[] {
  if (!Array.isArray(value)) return [];
  const servers: McpServerConfig[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const raw = candidate as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id || ids.has(id)) continue;
    if (raw.transport === "remote") {
      const url = typeof raw.url === "string" ? raw.url.trim().replace(/\/+$/, "") : "";
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      } catch {
        continue;
      }
      servers.push({
        id,
        transport: "remote",
        url,
        headers: normalizeStringRecord(raw.headers),
        oauthTokenEnv:
          typeof raw.oauthTokenEnv === "string" && raw.oauthTokenEnv.trim()
            ? raw.oauthTokenEnv.trim()
            : undefined,
        lazy: raw.lazy === true,
        disabled: raw.disabled === true,
      });
    } else if (raw.transport === "stdio") {
      const command = typeof raw.command === "string" ? raw.command.trim() : "";
      if (!command) continue;
      servers.push({
        id,
        transport: "stdio",
        command,
        args: Array.isArray(raw.args)
          ? raw.args.filter((item): item is string => typeof item === "string")
          : undefined,
        env: normalizeStringRecord(raw.env),
        lazy: raw.lazy === true,
        disabled: raw.disabled === true,
      });
    } else {
      continue;
    }
    ids.add(id);
  }
  return servers;
}

function resolveWorkspaceDir(): string {
  const envDir = process.env.WORKSPACE_DIR;
  if (envDir) return path.resolve(envDir);

  // Try /workspace (works inside Docker)
  try {
    fs.mkdirSync("/workspace", { recursive: true });
    return "/workspace";
  } catch {
    // Fallback for macOS/local dev
    const fallback = path.join(os.homedir(), "ai-ide-workspace");
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

function resolveAppSettingsPath(): string {
  if (process.env.APP_SETTINGS_CONFIG) {
    return path.resolve(process.env.APP_SETTINGS_CONFIG);
  }

  const candidates = [
    path.resolve(process.cwd(), "app-settings.json"),
    path.resolve(process.cwd(), "../app-settings.json"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  if (process.cwd().endsWith(`${path.sep}backend`)) {
    return path.resolve(process.cwd(), "../app-settings.json");
  }

  return path.resolve(process.cwd(), "app-settings.json");
}

function resolvePluginsDir(): string {
  if (process.env.PLUGINS_DIR) {
    return path.resolve(process.env.PLUGINS_DIR);
  }

  const candidates = [
    path.resolve(process.cwd(), "plugins"),
    path.resolve(process.cwd(), "../plugins"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  if (process.cwd().endsWith(`${path.sep}backend`)) {
    return path.resolve(process.cwd(), "../plugins");
  }

  return path.resolve(process.cwd(), "plugins");
}

function loadPersistedAppSettings(configPath: string): PersistedAppSettings {
  try {
    if (!fs.existsSync(configPath)) {
      return {};
    }
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as PersistedAppSettings;
  } catch (error) {
    console.warn(`Failed to load app settings from ${configPath}:`, error);
    return {};
  }
}

const appSettingsPath = resolveAppSettingsPath();
let persistedAppSettings = loadPersistedAppSettings(appSettingsPath);
const persistedLlmSettings = persistedAppSettings.llm || {};
const persistedRuntimeSettings = persistedAppSettings.app || {};
const persistedMcpSettings = persistedAppSettings.mcp || {};
const initialAgentSettings = normalizeAgentProfileOverrides(persistedAppSettings.agents);
const initialMcpUrls = parseUrlList(
  persistedMcpSettings.baseUrls ||
    process.env.MCP_BASE_URLS ||
    process.env.MCP_BASE_URL
);
const initialMcpLazyUrls = parseUrlList(
  persistedMcpSettings.lazyUrls || process.env.MCP_LAZY_URLS
);
const initialMcpDisabledUrls = parseUrlList(
  persistedMcpSettings.disabledUrls || process.env.MCP_DISABLED_URLS
);
const initialMcpServers = normalizeMcpServers(persistedMcpSettings.servers);

function savePersistedAppSettings(): void {
  fs.mkdirSync(path.dirname(config.appSettingsPath), { recursive: true });
  fs.writeFileSync(
    config.appSettingsPath,
    `${JSON.stringify(persistedAppSettings, null, 2)}\n`,
    "utf-8"
  );
}

export const config = {
  port: parsePositiveInteger(process.env.PORT, 3000),
  defaultWorkspaceDir: resolveWorkspaceDir(),
  vllmApiUrl:
    persistedLlmSettings.vllmApiUrl ||
    process.env.VLLM_API_URL ||
    "http://host.docker.internal:8000/v1",
  vllmApiKey: persistedLlmSettings.vllmApiKey || process.env.VLLM_API_KEY || "",
  modelName: persistedLlmSettings.modelName || process.env.MODEL_NAME || "default",
  systemPrompt: persistedLlmSettings.systemPrompt || process.env.SYSTEM_PROMPT || "",
  staticDir: process.env.STATIC_DIR || "static",
  pythonExecutable:
    process.env.PYTHON_EXECUTABLE || (process.platform === "win32" ? "python" : "python3"),
  debugpyPythonExecutable:
    process.env.DEBUGPY_PYTHON_EXECUTABLE ||
    process.env.PYTHON_EXECUTABLE ||
    (process.platform === "win32" ? "python" : "python3"),
  maxAgentIterations: parsePositiveInteger(process.env.MAX_AGENT_ITERATIONS, 30),
  contextCompactThreshold: parsePositiveInteger(
    process.env.AGENT_CONTEXT_COMPACT_THRESHOLD,
    60000
  ),
  agentMaxTokens: parsePositiveInteger(
    persistedLlmSettings.maxTokens,
    parsePositiveInteger(process.env.AGENT_MAX_TOKENS, 8192)
  ),
  mcpBaseUrls: initialMcpUrls,
  mcpLazyUrls: initialMcpLazyUrls,
  mcpDisabledUrls: initialMcpDisabledUrls,
  mcpServers: initialMcpServers,
  mcpTimeout: parsePositiveInteger(
    persistedMcpSettings.timeout,
    parsePositiveInteger(process.env.MCP_TIMEOUT, 60)
  ),
  mcpConnectTimeout: parsePositiveInteger(
    persistedMcpSettings.connectTimeout,
    parsePositiveInteger(process.env.MCP_CONNECT_TIMEOUT, 10)
  ),
  agentProfiles: initialAgentSettings,
  usersConfigPath: process.env.USERS_CONFIG || "users.json",
  pluginsDir: resolvePluginsDir(),
  uploadMaxFileSizeMb: parsePositiveInteger(
    persistedRuntimeSettings.uploadMaxFileSizeMb,
    parsePositiveInteger(process.env.UPLOAD_MAX_FILE_SIZE_MB, 250)
  ),
  appSettingsPath,
};

export function getAgentSettings(): AgentProfileOverrides {
  return JSON.parse(JSON.stringify(config.agentProfiles)) as AgentProfileOverrides;
}

export function updateAgentSettings(next: AgentProfileOverrides): AgentProfileOverrides {
  config.agentProfiles = normalizeAgentProfileOverrides(next);
  persistedAppSettings = {
    ...persistedAppSettings,
    agents: getAgentSettings(),
  };
  savePersistedAppSettings();
  return getAgentSettings();
}

export function getAppSettings(): AppRuntimeSettings {
  return {
    uploadMaxFileSizeMb: config.uploadMaxFileSizeMb,
  };
}

export function getMcpSettings(): McpRuntimeSettings {
  return {
    baseUrls: [...config.mcpBaseUrls],
    lazyUrls: [...config.mcpLazyUrls],
    disabledUrls: [...config.mcpDisabledUrls],
    servers: normalizeMcpServers(config.mcpServers),
    timeout: config.mcpTimeout,
    connectTimeout: config.mcpConnectTimeout,
  };
}

export function updateMcpSettings(next: McpRuntimeSettings): McpRuntimeSettings {
  config.mcpBaseUrls = parseUrlList(next.baseUrls);
  config.mcpLazyUrls = parseUrlList(next.lazyUrls);
  config.mcpDisabledUrls = parseUrlList(next.disabledUrls);
  config.mcpServers = normalizeMcpServers(next.servers);
  config.mcpTimeout = next.timeout;
  config.mcpConnectTimeout = next.connectTimeout;

  persistedAppSettings = {
    ...persistedAppSettings,
    mcp: getMcpSettings(),
  };
  savePersistedAppSettings();

  return getMcpSettings();
}

export function updateAppSettings(
  next: AppRuntimeSettings
): AppRuntimeSettings {
  config.uploadMaxFileSizeMb = next.uploadMaxFileSizeMb;

  persistedAppSettings = {
    ...persistedAppSettings,
    app: getAppSettings(),
  };
  savePersistedAppSettings();

  return getAppSettings();
}

export function getLlmSettings(): LlmRuntimeSettings {
  return {
    vllmApiUrl: config.vllmApiUrl,
    vllmApiKey: config.vllmApiKey,
    modelName: config.modelName,
    maxTokens: config.agentMaxTokens,
    maxAgentIterations: config.maxAgentIterations,
    systemPrompt: config.systemPrompt,
  };
}

export function getPluginOverrides(): Record<string, PluginOverrideSettings> {
  const overrides = persistedAppSettings.plugins?.overrides || {};
  const normalized: Record<string, PluginOverrideSettings> = {};

  for (const [pluginId, value] of Object.entries(overrides)) {
    if (!pluginId.trim() || typeof value?.enabled !== "boolean") {
      continue;
    }
    normalized[pluginId] = {
      enabled: value.enabled,
    };
  }

  return normalized;
}

export function setPluginEnabled(
  pluginId: string,
  enabled: boolean
): Record<string, PluginOverrideSettings> {
  const normalizedPluginId = pluginId.trim();
  if (!normalizedPluginId) {
    throw new Error("pluginId is required");
  }

  const nextOverrides = {
    ...getPluginOverrides(),
    [normalizedPluginId]: { enabled },
  };

  persistedAppSettings = {
    ...persistedAppSettings,
    plugins: {
      overrides: nextOverrides,
    },
  };
  savePersistedAppSettings();

  return nextOverrides;
}

export function clearPluginOverride(
  pluginId: string
): Record<string, PluginOverrideSettings> {
  const normalizedPluginId = pluginId.trim();
  if (!normalizedPluginId) {
    throw new Error("pluginId is required");
  }

  const nextOverrides = { ...getPluginOverrides() };
  delete nextOverrides[normalizedPluginId];

  const nextPlugins =
    Object.keys(nextOverrides).length > 0
      ? {
          overrides: nextOverrides,
        }
      : undefined;

  persistedAppSettings = {
    ...persistedAppSettings,
    ...(nextPlugins ? { plugins: nextPlugins } : {}),
  };

  if (!nextPlugins) {
    delete persistedAppSettings.plugins;
  }

  savePersistedAppSettings();

  return nextOverrides;
}

export function updateLlmSettings(next: LlmRuntimeSettings): LlmRuntimeSettings {
  config.vllmApiUrl = next.vllmApiUrl;
  config.vllmApiKey = next.vllmApiKey;
  config.modelName = next.modelName;
  config.agentMaxTokens = next.maxTokens;
  config.maxAgentIterations = next.maxAgentIterations;
  config.systemPrompt = next.systemPrompt || "";

  persistedAppSettings = {
    ...persistedAppSettings,
    llm: getLlmSettings(),
  };
  savePersistedAppSettings();

  return getLlmSettings();
}
