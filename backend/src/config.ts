import path from "path";
import os from "os";
import fs from "fs";

interface LlmRuntimeSettings {
  vllmApiUrl: string;
  vllmApiKey: string;
  modelName: string;
  maxTokens: number;
  systemPrompt?: string;
}

interface PluginOverrideSettings {
  enabled: boolean;
}

interface PersistedPluginSettings {
  overrides?: Record<string, Partial<PluginOverrideSettings>>;
}

interface PersistedAppSettings {
  llm?: Partial<LlmRuntimeSettings>;
  plugins?: PersistedPluginSettings;
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
  maxAgentIterations: parsePositiveInteger(process.env.MAX_AGENT_ITERATIONS, 30),
  agentMaxTokens: parsePositiveInteger(
    persistedLlmSettings.maxTokens,
    parsePositiveInteger(process.env.AGENT_MAX_TOKENS, 8192)
  ),
  usersConfigPath: process.env.USERS_CONFIG || "users.json",
  pluginsDir: resolvePluginsDir(),
  appSettingsPath,
};

export function getLlmSettings(): LlmRuntimeSettings {
  return {
    vllmApiUrl: config.vllmApiUrl,
    vllmApiKey: config.vllmApiKey,
    modelName: config.modelName,
    maxTokens: config.agentMaxTokens,
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
  config.systemPrompt = next.systemPrompt || "";

  persistedAppSettings = {
    ...persistedAppSettings,
    llm: getLlmSettings(),
  };
  savePersistedAppSettings();

  return getLlmSettings();
}
