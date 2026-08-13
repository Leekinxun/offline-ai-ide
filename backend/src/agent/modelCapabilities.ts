import { createHash } from "node:crypto";

export type ModelCapabilitySource = "model_metadata" | "context_window" | "fallback";
export type ModelFeature = "streaming" | "tool_calling" | "structured_output" | "reasoning_controls" | "cancellation" | "usage_reporting";
export type CapabilitySupport = Record<ModelFeature, boolean>;

export interface ModelCapabilities {
  modelName: string;
  contextWindow?: number;
  maxOutputTokens: number;
  source: ModelCapabilitySource;
  fetchedAt: number;
  warning?: string;
  supports: CapabilitySupport;
}

export interface ProbeSettings {
  apiUrl: string;
  apiKey?: string;
  modelName: string;
  fallbackMaxOutputTokens?: number;
  signal?: AbortSignal;
  declaredSupports?: Partial<CapabilitySupport>;
}

const CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 4_000;
const FALLBACK_MAX_OUTPUT_TOKENS = 8_192;
const cache = new Map<string, { expiresAt: number; value: ModelCapabilities }>();

export function capabilitiesFromDeclaration(modelName: string, maxOutputTokens: number, declaredSupports: Partial<CapabilitySupport> = {}): ModelCapabilities {
  return { modelName, maxOutputTokens: clampTokenLimit(maxOutputTokens), source: "fallback", fetchedAt: Date.now(), supports: discoverSupports(null, declaredSupports), warning: "Capabilities use the registered provider adapter declaration." };
}

export async function getModelCapabilities(
  settings: ProbeSettings,
  force = false
): Promise<ModelCapabilities> {
  const key = `${settings.apiUrl}|${settings.modelName}|${settings.apiKey ? createHash("sha1").update(settings.apiKey).digest("hex").slice(0, 8) : "none"}|${JSON.stringify(settings.declaredSupports || {})}`;
  const cached = cache.get(key);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;

  const fallback = Math.max(
    256,
    Math.floor(settings.fallbackMaxOutputTokens || FALLBACK_MAX_OUTPUT_TOKENS)
  );
  let metadata: Record<string, unknown> | null = null;
  let warning = "Model metadata did not expose a token limit; using the safe fallback.";

  for (const candidate of buildProbeCandidates(settings.apiUrl, settings.modelName)) {
    try {
      settings.signal?.throwIfAborted();
      const timeoutSignal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
      const response = await fetch(candidate.url, {
        method: candidate.method,
        headers: buildHeaders(settings.apiKey),
        ...(candidate.body ? { body: JSON.stringify(candidate.body) } : {}),
        signal: settings.signal
          ? AbortSignal.any([timeoutSignal, settings.signal])
          : timeoutSignal,
      });
      if (!response.ok) continue;
      const payload = (await response.json()) as unknown;
      metadata = selectModelMetadata(payload, settings.modelName);
      if (metadata && hasCapabilityMetadata(metadata)) break;
    } catch {
      settings.signal?.throwIfAborted();
      // Capability probing is best-effort and must never block a normal run.
    }
  }

  const contextWindow = metadata ? findNumber(metadata, [
    "context_length",
    "context_window",
    "max_model_len",
    "max_position_embeddings",
    "n_ctx",
    "num_ctx",
  ]) : undefined;
  const explicitMaxOutput = metadata ? findNumber(metadata, [
    "max_output_tokens",
    "max_completion_tokens",
    "max_new_tokens",
    "max_tokens",
  ]) : undefined;

  const supports = discoverSupports(metadata, settings.declaredSupports);
  let capabilities: ModelCapabilities;
  if (explicitMaxOutput) {
    capabilities = {
      modelName: settings.modelName,
      ...(contextWindow ? { contextWindow } : {}),
      maxOutputTokens: clampTokenLimit(explicitMaxOutput),
      source: "model_metadata",
      fetchedAt: Date.now(),
      supports,
    };
  } else if (contextWindow) {
    capabilities = {
      modelName: settings.modelName,
      contextWindow,
      maxOutputTokens: deriveOutputLimit(contextWindow),
      source: "context_window",
      fetchedAt: Date.now(),
      warning: "The model exposed a context window, so the output limit was derived automatically.",
      supports,
    };
  } else {
    capabilities = {
      modelName: settings.modelName,
      maxOutputTokens: fallback,
      source: "fallback",
      fetchedAt: Date.now(),
      warning,
      supports,
    };
  }

  cache.set(key, {
    value: capabilities,
    expiresAt: Date.now() + CAPABILITY_CACHE_TTL_MS,
  });
  return capabilities;
}

function discoverSupports(metadata: Record<string, unknown> | null, declared: Partial<CapabilitySupport> = {}): CapabilitySupport {
  const aliases: Record<ModelFeature, string[]> = {
    streaming: ["streaming", "supports_streaming", "stream"],
    tool_calling: ["tool_calling", "supports_tools", "function_calling", "tools"],
    structured_output: ["structured_output", "supports_structured_output", "json_schema", "response_format"],
    reasoning_controls: ["reasoning_controls", "supports_reasoning", "reasoning_effort", "thinking"],
    cancellation: ["cancellation", "supports_cancellation", "abort"],
    usage_reporting: ["usage_reporting", "supports_usage", "usage"],
  };
  const capabilityNames = new Set<string>();
  const collect = (value: unknown, depth = 0): void => {
    if (depth > 4 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) if (typeof item === "string") capabilityNames.add(normalizeKey(item)); else collect(item, depth + 1); return; }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (["capabilities", "supported_features", "features"].includes(key.toLowerCase())) collect(child, depth + 1);
    }
  };
  collect(metadata);
  const value = (feature: ModelFeature): boolean => {
    if (typeof declared[feature] === "boolean") return declared[feature]!;
    if (!metadata) return false;
    for (const alias of aliases[feature]) {
      const found = findBoolean(metadata, alias);
      if (found !== undefined) return found;
      if (capabilityNames.has(normalizeKey(alias))) return true;
    }
    return false;
  };
  return { streaming: value("streaming"), tool_calling: value("tool_calling"), structured_output: value("structured_output"), reasoning_controls: value("reasoning_controls"), cancellation: value("cancellation"), usage_reporting: value("usage_reporting") };
}

function findBoolean(value: Record<string, unknown>, target: string, depth = 0): boolean | undefined {
  if (depth > 4) return undefined; const normalized = normalizeKey(target);
  for (const [key, child] of Object.entries(value)) if (normalizeKey(key) === normalized && typeof child === "boolean") return child;
  for (const child of Object.values(value)) if (child && typeof child === "object" && !Array.isArray(child)) { const nested = findBoolean(child as Record<string, unknown>, target, depth + 1); if (nested !== undefined) return nested; }
  return undefined;
}

export function clearModelCapabilityCache(): void {
  cache.clear();
}

export async function resolveMaxOutputTokens(settings: ProbeSettings): Promise<number> {
  return (await getModelCapabilities(settings)).maxOutputTokens;
}

function buildHeaders(apiKey?: string): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

function buildProbeCandidates(apiUrl: string, modelName: string): Array<{
  url: string;
  method: "GET" | "POST";
  body?: Record<string, string>;
}> {
  const base = apiUrl.replace(/\/+$/, "");
  const root = base.replace(/\/v1$/i, "");
  return [
    { url: `${base}/models`, method: "GET" },
    { url: `${base}/models/${encodeURIComponent(modelName)}`, method: "GET" },
    { url: `${root}/api/show`, method: "POST", body: { name: modelName } },
  ];
}

function selectModelMetadata(payload: unknown, modelName: string): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  if (Array.isArray(root.data)) {
    const matching = root.data.find(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        (!modelName || (entry as Record<string, unknown>).id === modelName)
    );
    const selected = matching || root.data[0];
    if (selected && typeof selected === "object") return selected as Record<string, unknown>;
  }
  if (root.model_info && typeof root.model_info === "object") {
    return root.model_info as Record<string, unknown>;
  }
  return root;
}

function findNumber(value: Record<string, unknown>, keys: string[], depth = 0): number | undefined {
  if (depth > 4) return undefined;
  const normalizedKeys = new Set(keys.map(normalizeKey));
  for (const [key, entry] of Object.entries(value)) {
    if (normalizedKeys.has(normalizeKey(key))) {
      const parsed = typeof entry === "number" ? entry : typeof entry === "string" ? Number(entry) : Number.NaN;
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  for (const entry of Object.values(value)) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const nested = findNumber(entry as Record<string, unknown>, keys, depth + 1);
      if (nested) return nested;
    }
  }
  return undefined;
}

function hasCapabilityMetadata(value: Record<string, unknown>): boolean {
  return Boolean(
    findNumber(value, [
      "max_output_tokens",
      "max_completion_tokens",
      "max_new_tokens",
      "max_tokens",
      "context_length",
      "context_window",
      "max_model_len",
      "max_position_embeddings",
      "n_ctx",
      "num_ctx",
    ])
  );
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function clampTokenLimit(value: number): number {
  return Math.max(256, Math.min(Math.floor(value), 1_000_000));
}

function deriveOutputLimit(contextWindow: number): number {
  return clampTokenLimit(Math.min(16_384, Math.max(1_024, Math.floor(contextWindow / 4))));
}
