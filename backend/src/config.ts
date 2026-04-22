import path from "path";
import os from "os";
import fs from "fs";

interface LlmRuntimeSettings {
  vllmApiUrl: string;
  vllmApiKey: string;
  modelName: string;
}

interface PersistedAppSettings {
  llm?: Partial<LlmRuntimeSettings>;
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
const persistedAppSettings = loadPersistedAppSettings(appSettingsPath);
const persistedLlmSettings = persistedAppSettings.llm || {};

export const config = {
  port: parseInt(process.env.PORT || "3000"),
  defaultWorkspaceDir: resolveWorkspaceDir(),
  vllmApiUrl:
    persistedLlmSettings.vllmApiUrl ||
    process.env.VLLM_API_URL ||
    "http://host.docker.internal:8000/v1",
  vllmApiKey: persistedLlmSettings.vllmApiKey || process.env.VLLM_API_KEY || "",
  modelName: persistedLlmSettings.modelName || process.env.MODEL_NAME || "default",
  staticDir: process.env.STATIC_DIR || "static",
  maxAgentIterations: parseInt(process.env.MAX_AGENT_ITERATIONS || "30"),
  agentMaxTokens: parseInt(process.env.AGENT_MAX_TOKENS || "8192"),
  usersConfigPath: process.env.USERS_CONFIG || "users.json",
  appSettingsPath,
};

export function getLlmSettings(): LlmRuntimeSettings {
  return {
    vllmApiUrl: config.vllmApiUrl,
    vllmApiKey: config.vllmApiKey,
    modelName: config.modelName,
  };
}

export function updateLlmSettings(next: LlmRuntimeSettings): LlmRuntimeSettings {
  config.vllmApiUrl = next.vllmApiUrl;
  config.vllmApiKey = next.vllmApiKey;
  config.modelName = next.modelName;

  const payload: PersistedAppSettings = {
    llm: getLlmSettings(),
  };

  fs.mkdirSync(path.dirname(config.appSettingsPath), { recursive: true });
  fs.writeFileSync(
    config.appSettingsPath,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf-8"
  );

  return getLlmSettings();
}
