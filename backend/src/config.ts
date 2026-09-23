import path from "path";
import os from "os";
import fs from "fs";
import {
  normalizeAgentProfileOverrides,
  type AgentProfileOverrides,
} from "./agent/agentProfiles.js";
import type {
  DeliveryProviderConfig,
  DeliveryRuntimeSettings,
} from "./integrations/delivery/types.js";

export interface LlmSamplingSettings {
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
}

export interface LlmInputSettings {
  supportsImageInput?: boolean;
  supportsPdfInput?: boolean;
}

export interface LlmModelSettings extends LlmSamplingSettings, LlmInputSettings {
  modelName: string;
  apiUrl: string;
  apiKey: string;
  maxTokens?: number;
}

interface LlmRuntimeSettings extends LlmSamplingSettings, LlmInputSettings {
  vllmApiUrl: string;
  vllmApiKey: string;
  modelName: string;
  models: LlmModelSettings[];
  maxTokens: number;
  maxAgentIterations: number;
  systemPrompt?: string;
  fallbacks?: ModelFallbackSettings[];
}

export interface ResolvedModelSampling extends LlmSamplingSettings { maxTokens: number; }

type SamplingField = keyof LlmSamplingSettings;
type PersistedLlmSettings = Omit<Partial<LlmRuntimeSettings>, SamplingField> & Partial<Record<SamplingField, number | null>>;

export interface ModelFallbackSettings { apiUrl: string; apiKey?: string; model: string; providerId?: string; maxOutputTokens?: number; }

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

export interface PersistedAppSettings {
  schemaVersion?: 1;
  llm?: PersistedLlmSettings;
  plugins?: PersistedPluginSettings;
  app?: Partial<AppRuntimeSettings>;
  mcp?: Partial<McpRuntimeSettings>;
  agents?: AgentProfileOverrides;
  delivery?: Partial<DeliveryRuntimeSettings>;
}

export interface AppSettingsMigrationStatus { state: "current" | "legacy_compatible" | "migrated" | "failed"; fromVersion: number; toVersion: 1; backupCreated: boolean; error?: string; }
let appSettingsMigrationStatus: AppSettingsMigrationStatus = { state: "current", fromVersion: 1, toVersion: 1, backupCreated: false };
export function getAppSettingsMigrationStatus(): AppSettingsMigrationStatus { return { ...appSettingsMigrationStatus }; }

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ADDITIONAL_LLM_MODELS = 32;
const LLM_SAMPLING_RANGES = {
  temperature: [0, 2],
  topP: [0, 1],
  frequencyPenalty: [-2, 2],
  presencePenalty: [-2, 2],
} as const;
const LLM_SAMPLING_FIELDS = Object.keys(LLM_SAMPLING_RANGES) as SamplingField[];

export class LlmSettingsValidationError extends Error {}

function validateLlmApiUrl(value: unknown): string {
  const apiUrl = typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  if (!apiUrl || apiUrl.length > 2048) {
    throw new LlmSettingsValidationError("LLM API URL is required and must be at most 2048 characters");
  }
  if (/\s/.test(apiUrl)) {
    throw new LlmSettingsValidationError("LLM API URL must not contain whitespace");
  }
  try {
    const parsed = new URL(apiUrl);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("Invalid LLM API URL");
    }
  } catch {
    throw new LlmSettingsValidationError("LLM API URL must be an http(s) URL without credentials, query, or fragment");
  }
  return apiUrl;
}

function validateLlmModelName(value: unknown): string {
  const modelName = typeof value === "string" ? value.trim() : "";
  if (!modelName || modelName.length > 200) {
    throw new LlmSettingsValidationError("LLM model name is required and must be at most 200 characters");
  }
  return modelName;
}

function validateLlmSamplingNumber(value: unknown, field: SamplingField): number {
  const [minimum, maximum] = LLM_SAMPLING_RANGES[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new LlmSettingsValidationError(`${field} must be a number between ${minimum} and ${maximum}`);
  }
  return value;
}

function validateLlmMaxTokens(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 1_000_000) {
    throw new LlmSettingsValidationError("maxTokens must be an integer between 1 and 1000000");
  }
  return value;
}

function validateLlmSamplingFields(raw: Record<string, unknown>): LlmSamplingSettings {
  const result: LlmSamplingSettings = {};
  for (const field of LLM_SAMPLING_FIELDS) {
    if (raw[field] !== undefined) result[field] = validateLlmSamplingNumber(raw[field], field);
  }
  return result;
}

function validateLlmInputSettings(raw: Record<string, unknown>): LlmInputSettings {
  const result: LlmInputSettings = {};
  for (const field of ["supportsImageInput", "supportsPdfInput"] as const) {
    if (raw[field] === undefined) continue;
    if (typeof raw[field] !== "boolean") throw new LlmSettingsValidationError(`${field} must be a boolean`);
    result[field] = raw[field];
  }
  return result;
}

function loadLlmSamplingNumber(value: unknown, field: SamplingField): number | undefined {
  try { return validateLlmSamplingNumber(value, field); }
  catch { return undefined; }
}

function validateAdditionalLlmModels(value: unknown, defaultModelName: string): LlmModelSettings[] {
  if (!Array.isArray(value) || value.length > MAX_ADDITIONAL_LLM_MODELS) {
    throw new LlmSettingsValidationError(`LLM models must be an array with at most ${MAX_ADDITIONAL_LLM_MODELS} entries`);
  }
  const names = new Set([defaultModelName]);
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new LlmSettingsValidationError(`LLM model ${index + 1} must be an object`);
    }
    const raw = candidate as Record<string, unknown>;
    const modelName = validateLlmModelName(raw.modelName);
    if (names.has(modelName)) {
      throw new LlmSettingsValidationError(`Duplicate LLM model name: ${modelName}`);
    }
    names.add(modelName);
    if (typeof raw.apiKey !== "string") {
      throw new LlmSettingsValidationError(`LLM model ${index + 1} API key must be a string`);
    }
    return {
      modelName, apiUrl: validateLlmApiUrl(raw.apiUrl), apiKey: raw.apiKey,
      ...validateLlmSamplingFields(raw),
      ...validateLlmInputSettings(raw),
      ...(raw.maxTokens !== undefined ? { maxTokens: validateLlmMaxTokens(raw.maxTokens) } : {}),
    };
  });
}

function loadAdditionalLlmModels(value: unknown, defaultModelName: string): LlmModelSettings[] {
  if (value === undefined) return [];
  try { return validateAdditionalLlmModels(value, defaultModelName); }
  catch { console.warn("Ignoring invalid persisted LLM models"); return []; }
}

export function normalizeDeliveryProviders(value: unknown): DeliveryProviderConfig[] {
  if (!Array.isArray(value)) return [];
  const providers: DeliveryProviderConfig[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const raw = candidate as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const kind = raw.kind;
    const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim().replace(/\/+$/, "") : "";
    const tokenEnv = typeof raw.tokenEnv === "string" ? raw.tokenEnv.trim() : "";
    if (!id || ids.has(id) || !["github", "gitlab", "gitea"].includes(String(kind)) || !ENV_NAME.test(tokenEnv)) continue;
    try {
      const parsed = new URL(baseUrl);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) continue;
    } catch { continue; }
    const webhookSecretEnv = typeof raw.webhookSecretEnv === "string" && ENV_NAME.test(raw.webhookSecretEnv.trim()) ? raw.webhookSecretEnv.trim() : undefined;
    const tokenKind = ["bearer", "private-token", "gitea-token"].includes(String(raw.tokenKind)) ? raw.tokenKind as DeliveryProviderConfig["tokenKind"] : undefined;
    providers.push({
      id,
      kind: kind as DeliveryProviderConfig["kind"],
      baseUrl,
      tokenEnv,
      ...(tokenKind ? { tokenKind } : {}),
      ...(webhookSecretEnv ? { webhookSecretEnv } : {}),
      ...(typeof raw.gitRemoteName === "string" && raw.gitRemoteName.trim() ? { gitRemoteName: raw.gitRemoteName.trim() } : {}),
      ...(typeof raw.apiVersion === "string" && raw.apiVersion.trim() ? { apiVersion: raw.apiVersion.trim() } : {}),
      ...(raw.disabled === true ? { disabled: true } : {}),
    });
    ids.add(id);
  }
  return providers;
}

function parseDeliveryProvidersEnv(): unknown {
  const value = process.env.DELIVERY_PROVIDERS;
  if (!value) return [];
  try { return JSON.parse(value); }
  catch { console.warn("Ignoring invalid DELIVERY_PROVIDERS JSON"); return []; }
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

function normalizeModelFallbacks(value: unknown): ModelFallbackSettings[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const raw = candidate as Record<string, unknown>;
    const apiUrl = typeof raw.apiUrl === "string" ? raw.apiUrl.trim().replace(/\/+$/, "") : "";
    const model = typeof raw.model === "string" ? raw.model.trim() : "";
    try { const parsed = new URL(apiUrl); if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return []; } catch { return []; }
    if (!model) return [];
    return [{ apiUrl, model: model.slice(0, 200), ...(typeof raw.apiKey === "string" ? { apiKey: raw.apiKey } : {}), ...(typeof raw.providerId === "string" && raw.providerId.trim() ? { providerId: raw.providerId.trim().slice(0, 100) } : {}), ...(Number.isSafeInteger(raw.maxOutputTokens) && Number(raw.maxOutputTokens) > 0 ? { maxOutputTokens: Number(raw.maxOutputTokens) } : {}) }];
  });
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

function readRegularSettingsFile(configPath: string): string {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0; let fd: number | undefined;
  try {
    fd = fs.openSync(configPath, fs.constants.O_RDONLY | noFollow);
    if (!fs.fstatSync(fd).isFile()) throw new Error("App settings path must be a regular file");
    return fs.readFileSync(fd, "utf8");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writeExclusivePrivateFile(filePath: string, bytes: string): void {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(filePath, flags, 0o600);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("Private backup target must be a regular file");
    fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, bytes, "utf8"); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function replacePrivateSettingsFile(configPath: string, bytes: string): void {
  if (fs.existsSync(configPath) && fs.lstatSync(configPath).isSymbolicLink()) throw new Error("App settings path cannot be a symlink");
  const temp = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  writeExclusivePrivateFile(temp, bytes);
  try { fs.renameSync(temp, configPath); fs.chmodSync(configPath, 0o600); }
  catch (error) { try { fs.unlinkSync(temp); } catch { /* best effort cleanup */ } throw error; }
}

export function loadPersistedAppSettings(configPath: string): PersistedAppSettings {
  try {
    if (!fs.existsSync(configPath)) {
      appSettingsMigrationStatus = { state: "current", fromVersion: 1, toVersion: 1, backupCreated: false };
      return { schemaVersion: 1 };
    }
    const raw = readRegularSettingsFile(configPath);
    const parsed = JSON.parse(raw) as PersistedAppSettings & { schemaVersion?: number };
    if (parsed.schemaVersion === undefined) {
      appSettingsMigrationStatus = { state: "legacy_compatible", fromVersion: 0, toVersion: 1, backupCreated: false };
      return parsed;
    }
    if (parsed.schemaVersion !== 1) throw new Error(`Unsupported app settings schema version: ${parsed.schemaVersion}`);
    appSettingsMigrationStatus = { state: "current", fromVersion: 1, toVersion: 1, backupCreated: false };
    return parsed;
  } catch (error) {
    console.warn(`Failed to load app settings from ${configPath}:`, error);
    appSettingsMigrationStatus = { state: "failed", fromVersion: 0, toVersion: 1, backupCreated: false, error: error instanceof Error ? error.message : String(error) };
    return { schemaVersion: 1 };
  }
}

/** Explicit operator-controlled migration; ordinary module load is read-only. */
export function migrateAppSettingsFile(configPath: string): AppSettingsMigrationStatus {
  try {
    const raw = readRegularSettingsFile(configPath);
    const parsed = JSON.parse(raw) as PersistedAppSettings & { schemaVersion?: number };
    if (parsed.schemaVersion === 1) return appSettingsMigrationStatus = { state: "current", fromVersion: 1, toVersion: 1, backupCreated: false };
    if (parsed.schemaVersion !== undefined) throw new Error(`Unsupported app settings schema version: ${parsed.schemaVersion}`);
    const backupPath = `${configPath}.migration-v0-${Date.now()}.bak`;
    writeExclusivePrivateFile(backupPath, raw);
    const migrated = { ...parsed, schemaVersion: 1 as const };
    replacePrivateSettingsFile(configPath, `${JSON.stringify(migrated, null, 2)}\n`);
    appSettingsMigrationStatus = { state: "migrated", fromVersion: 0, toVersion: 1, backupCreated: true };
    return getAppSettingsMigrationStatus();
  } catch (error) {
    appSettingsMigrationStatus = { state: "failed", fromVersion: 0, toVersion: 1, backupCreated: false, error: error instanceof Error ? error.message : String(error) };
    return getAppSettingsMigrationStatus();
  }
}

const appSettingsPath = resolveAppSettingsPath();
let persistedAppSettings = loadPersistedAppSettings(appSettingsPath);
const persistedLlmSettings = persistedAppSettings.llm || {};
const persistedRuntimeSettings = persistedAppSettings.app || {};
const persistedMcpSettings = persistedAppSettings.mcp || {};
const persistedDeliverySettings = persistedAppSettings.delivery || {};
const initialModelName = persistedLlmSettings.modelName || process.env.MODEL_NAME || process.env.AGENT_MODEL_ID || "default";
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
const initialDeliveryProviders = normalizeDeliveryProviders(
  persistedDeliverySettings.providers || parseDeliveryProvidersEnv()
);

function savePersistedAppSettings(): void {
  fs.mkdirSync(path.dirname(config.appSettingsPath), { recursive: true });
  replacePrivateSettingsFile(config.appSettingsPath, `${JSON.stringify(persistedAppSettings, null, 2)}\n`);
}

export const config = {
  port: parsePositiveInteger(process.env.PORT, 3000),
  defaultWorkspaceDir: resolveWorkspaceDir(),
  vllmApiUrl:
    persistedLlmSettings.vllmApiUrl ||
    process.env.VLLM_API_URL ||
    process.env.AGENT_BASE_URL ||
    "http://host.docker.internal:8000/v1",
  vllmApiKey:
    typeof persistedLlmSettings.vllmApiKey === "string"
      ? persistedLlmSettings.vllmApiKey
      : process.env.VLLM_API_KEY || process.env.AGENT_API_KEY || "",
  modelName: initialModelName,
  models: loadAdditionalLlmModels(persistedLlmSettings.models, initialModelName),
  supportsImageInput: persistedLlmSettings.supportsImageInput === true,
  supportsPdfInput: persistedLlmSettings.supportsPdfInput === true,
  temperature:
    persistedLlmSettings.temperature === null
      ? undefined
      : loadLlmSamplingNumber(persistedLlmSettings.temperature, "temperature") ??
        (process.env.AGENT_TEMPERATURE === undefined
          ? undefined
          : loadLlmSamplingNumber(Number(process.env.AGENT_TEMPERATURE), "temperature")),
  topP: loadLlmSamplingNumber(persistedLlmSettings.topP, "topP"),
  frequencyPenalty: loadLlmSamplingNumber(persistedLlmSettings.frequencyPenalty, "frequencyPenalty"),
  presencePenalty: loadLlmSamplingNumber(persistedLlmSettings.presencePenalty, "presencePenalty"),
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
  modelFallbacks: normalizeModelFallbacks(persistedLlmSettings.fallbacks),
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
  deliveryProviders: initialDeliveryProviders,
  deliveryPollIntervalSeconds: parsePositiveInteger(
    persistedDeliverySettings.pollIntervalSeconds,
    parsePositiveInteger(process.env.DELIVERY_POLL_INTERVAL_SECONDS, 60)
  ),
  deliveryRequestTimeoutSeconds: parsePositiveInteger(
    persistedDeliverySettings.requestTimeoutSeconds,
    parsePositiveInteger(process.env.DELIVERY_REQUEST_TIMEOUT_SECONDS, 20)
  ),
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

export function getDeliverySettings(): DeliveryRuntimeSettings {
  return {
    providers: normalizeDeliveryProviders(config.deliveryProviders),
    pollIntervalSeconds: config.deliveryPollIntervalSeconds,
    requestTimeoutSeconds: config.deliveryRequestTimeoutSeconds,
  };
}

export function updateDeliverySettings(next: DeliveryRuntimeSettings): DeliveryRuntimeSettings {
  config.deliveryProviders = normalizeDeliveryProviders(next.providers);
  config.deliveryPollIntervalSeconds = parsePositiveInteger(next.pollIntervalSeconds, 60);
  config.deliveryRequestTimeoutSeconds = parsePositiveInteger(next.requestTimeoutSeconds, 20);
  persistedAppSettings = { ...persistedAppSettings, delivery: getDeliverySettings() };
  savePersistedAppSettings();
  return getDeliverySettings();
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
    models: config.models.map((model) => ({ ...model })),
    supportsImageInput: config.supportsImageInput,
    supportsPdfInput: config.supportsPdfInput,
    maxTokens: config.agentMaxTokens,
    maxAgentIterations: config.maxAgentIterations,
    systemPrompt: config.systemPrompt,
    ...(typeof config.temperature === "number" ? { temperature: config.temperature } : {}),
    ...(typeof config.topP === "number" ? { topP: config.topP } : {}),
    ...(typeof config.frequencyPenalty === "number" ? { frequencyPenalty: config.frequencyPenalty } : {}),
    ...(typeof config.presencePenalty === "number" ? { presencePenalty: config.presencePenalty } : {}),
  };
}

export function resolveModelEndpoint(modelName: string): LlmModelSettings {
  const configured = config.models.find((model) => model.modelName === modelName);
  return configured ? { ...configured } : {
    modelName,
    apiUrl: config.vllmApiUrl,
    apiKey: config.vllmApiKey,
  };
}

export function resolveModelSampling(modelName: string): ResolvedModelSampling {
  const model = config.models.find((candidate) => candidate.modelName === modelName);
  const resolved: ResolvedModelSampling = { maxTokens: model?.maxTokens ?? config.agentMaxTokens };
  for (const field of LLM_SAMPLING_FIELDS) {
    const value = model?.[field] ?? config[field];
    if (typeof value === "number") resolved[field] = value;
  }
  return resolved;
}

export function resolveModelInputCapabilities(modelName: string): { image_input: boolean; pdf_input: boolean } {
  const model = config.models.find((candidate) => candidate.modelName === modelName);
  if (model) return { image_input: model.supportsImageInput === true, pdf_input: model.supportsPdfInput === true };
  if (modelName === config.modelName) {
    return { image_input: config.supportsImageInput, pdf_input: config.supportsPdfInput };
  }
  return { image_input: false, pdf_input: false };
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

export function updateLlmSettings(next: Omit<LlmRuntimeSettings, "models" | SamplingField> & {
  models?: unknown;
} & Partial<Record<SamplingField, number | null>>): LlmRuntimeSettings {
  const modelName = validateLlmModelName(next.modelName);
  const vllmApiUrl = validateLlmApiUrl(next.vllmApiUrl);
  const models = validateAdditionalLlmModels(next.models === undefined ? config.models : next.models, modelName);
  const maxTokens = validateLlmMaxTokens(next.maxTokens);
  const inputSettings = validateLlmInputSettings(next as unknown as Record<string, unknown>);
  const sampling: LlmSamplingSettings = {};
  for (const field of LLM_SAMPLING_FIELDS) {
    const incoming = next[field];
    const value = incoming === undefined ? config[field] : incoming === null ? undefined : validateLlmSamplingNumber(incoming, field);
    if (value !== undefined) sampling[field] = value;
  }
  config.vllmApiUrl = vllmApiUrl;
  config.vllmApiKey = next.vllmApiKey;
  config.modelName = modelName;
  config.models = models;
  config.supportsImageInput = inputSettings.supportsImageInput ?? config.supportsImageInput;
  config.supportsPdfInput = inputSettings.supportsPdfInput ?? config.supportsPdfInput;
  config.agentMaxTokens = maxTokens;
  config.maxAgentIterations = next.maxAgentIterations;
  config.systemPrompt = next.systemPrompt || "";
  config.temperature = sampling.temperature;
  config.topP = sampling.topP;
  config.frequencyPenalty = sampling.frequencyPenalty;
  config.presencePenalty = sampling.presencePenalty;

  const persistedLlm: PersistedLlmSettings = { ...persistedAppSettings.llm, ...getLlmSettings() };
  for (const field of LLM_SAMPLING_FIELDS) {
    if (next[field] === null) persistedLlm[field] = null;
  }
  persistedAppSettings = {
    ...persistedAppSettings,
    llm: persistedLlm,
  };
  savePersistedAppSettings();

  return getLlmSettings();
}
