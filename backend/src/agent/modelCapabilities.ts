import { createHash } from "node:crypto";

export type ModelCapabilitySource = "model_metadata" | "context_window" | "fallback";

export interface ModelCapabilities {
  modelName: string;
  contextWindow?: number;
  maxOutputTokens: number;
  source: ModelCapabilitySource;
  fetchedAt: number;
  warning?: string;
}

export interface ProbeSettings {
  apiUrl: string;
  apiKey?: string;
  modelName: string;
  fallbackMaxOutputTokens?: number;
}

const CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 4_000;
const FALLBACK_MAX_OUTPUT_TOKENS = 8_192;
const cache = new Map<string, { expiresAt: number; value: ModelCapabilities }>();

export async function getModelCapabilities(
  settings: ProbeSettings,
  force = false
): Promise<ModelCapabilities> {
  const key = `${settings.apiUrl}|${settings.modelName}|${settings.apiKey ? createHash("sha1").update(settings.apiKey).digest("hex").slice(0, 8) : "none"}`;
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
      const response = await fetch(candidate.url, {
        method: candidate.method,
        headers: buildHeaders(settings.apiKey),
        ...(candidate.body ? { body: JSON.stringify(candidate.body) } : {}),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!response.ok) continue;
      const payload = (await response.json()) as unknown;
      metadata = selectModelMetadata(payload, settings.modelName);
      if (metadata && hasCapabilityMetadata(metadata)) break;
    } catch {
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

  let capabilities: ModelCapabilities;
  if (explicitMaxOutput) {
    capabilities = {
      modelName: settings.modelName,
      ...(contextWindow ? { contextWindow } : {}),
      maxOutputTokens: clampTokenLimit(explicitMaxOutput),
      source: "model_metadata",
      fetchedAt: Date.now(),
    };
  } else if (contextWindow) {
    capabilities = {
      modelName: settings.modelName,
      contextWindow,
      maxOutputTokens: deriveOutputLimit(contextWindow),
      source: "context_window",
      fetchedAt: Date.now(),
      warning: "The model exposed a context window, so the output limit was derived automatically.",
    };
  } else {
    capabilities = {
      modelName: settings.modelName,
      maxOutputTokens: fallback,
      source: "fallback",
      fetchedAt: Date.now(),
      warning,
    };
  }

  cache.set(key, {
    value: capabilities,
    expiresAt: Date.now() + CAPABILITY_CACHE_TTL_MS,
  });
  return capabilities;
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
