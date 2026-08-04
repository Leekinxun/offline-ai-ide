import type { AgentMode } from "./types.js";

export type AgentProfileId = AgentMode | "explore" | "subagent" | "teammate";

export interface AgentBudget {
  maxSteps: number;
  maxToolCalls: number;
  maxDurationMs: number;
  maxOutputTokens: number;
  maxCostUsd: number;
}

export interface AgentPermissionProfile {
  allow: string[];
  deny: string[];
}

export interface AgentProfile {
  id: AgentProfileId;
  modelName?: string;
  providerId: string;
  budget: AgentBudget;
  permissions: AgentPermissionProfile;
  pricing: {
    inputPerMillionUsd: number;
    outputPerMillionUsd: number;
  };
  stepSnapshots: boolean;
}

export type AgentProfileOverrides = Partial<Record<AgentProfileId, Partial<{
  modelName: string;
  providerId: string;
  budget: Partial<AgentBudget>;
  permissions: Partial<AgentPermissionProfile>;
  pricing: Partial<AgentProfile["pricing"]>;
  stepSnapshots: boolean;
}>>>;

const ALL_TOOLS = ["*"];
const DEFAULTS: Record<AgentProfileId, AgentProfile> = {
  ask: profile("ask", 8, 8, 5 * 60_000, false, ["compress", "memory_read", "skill_load", "read_file", "TodoWrite", "mcp_*", "search_lazy_mcp_tools", "activate_lazy_mcp_tools"]),
  review: profile("review", 20, 30, 15 * 60_000, false, ["compress", "memory_read", "skill_load", "read_file", "bash", "TodoWrite"]),
  plan: profile("plan", 16, 20, 10 * 60_000, false, ["compress", "memory_read", "skill_load", "read_file", "bash", "TodoWrite", "submit_plan"]),
  code: profile("code", 30, 80, 30 * 60_000, true, ALL_TOOLS),
  explore: profile("explore", 20, 40, 15 * 60_000, false, ["bash", "read_file"]),
  subagent: profile("subagent", 30, 60, 25 * 60_000, true, ["bash", "read_file", "write_file", "edit_file"]),
  teammate: profile("teammate", 50, 100, 60 * 60_000, true, ["bash", "read_file", "write_file", "edit_file", "send_message", "idle", "claim_task"]),
};

function profile(
  id: AgentProfileId,
  maxSteps: number,
  maxToolCalls: number,
  maxDurationMs: number,
  stepSnapshots: boolean,
  allow: string[]
): AgentProfile {
  return {
    id,
    providerId: "openai-compatible",
    budget: {
      maxSteps,
      maxToolCalls,
      maxDurationMs,
      maxOutputTokens: 8192,
      maxCostUsd: 0,
    },
    permissions: { allow, deny: [] },
    pricing: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
    stepSnapshots,
  };
}

export function normalizeAgentProfileOverrides(raw: unknown): AgentProfileOverrides {
  if (!raw || typeof raw !== "object") return {};
  const result: AgentProfileOverrides = {};
  for (const id of Object.keys(DEFAULTS) as AgentProfileId[]) {
    const value = (raw as Record<string, unknown>)[id];
    if (!value || typeof value !== "object") continue;
    const candidate = value as Record<string, unknown>;
    const budget = normalizeNumericObject(candidate.budget, [
      "maxSteps", "maxToolCalls", "maxDurationMs", "maxOutputTokens", "maxCostUsd",
    ]);
    const pricing = normalizeNumericObject(candidate.pricing, [
      "inputPerMillionUsd", "outputPerMillionUsd",
    ]);
    const permissions = candidate.permissions && typeof candidate.permissions === "object"
      ? candidate.permissions as Record<string, unknown>
      : {};
    result[id] = {
      ...(typeof candidate.modelName === "string" && candidate.modelName.trim()
        ? { modelName: candidate.modelName.trim().slice(0, 200) }
        : {}),
      ...(typeof candidate.providerId === "string" && candidate.providerId.trim()
        ? { providerId: candidate.providerId.trim().slice(0, 100) }
        : {}),
      ...(Object.keys(budget).length > 0 ? { budget } : {}),
      ...(Object.keys(pricing).length > 0 ? { pricing } : {}),
      ...(Array.isArray(permissions.allow) || Array.isArray(permissions.deny)
        ? {
            permissions: {
              ...(Array.isArray(permissions.allow) ? { allow: normalizePatterns(permissions.allow) } : {}),
              ...(Array.isArray(permissions.deny) ? { deny: normalizePatterns(permissions.deny) } : {}),
            },
          }
        : {}),
      ...(typeof candidate.stepSnapshots === "boolean"
        ? { stepSnapshots: candidate.stepSnapshots }
        : {}),
    };
  }
  return result;
}

export function resolveAgentProfile(
  id: AgentProfileId,
  overrides: AgentProfileOverrides = {},
  globalDefaults?: { modelName?: string; maxOutputTokens?: number; maxSteps?: number }
): AgentProfile {
  const base = DEFAULTS[id];
  const override = overrides[id] || {};
  return {
    ...base,
    ...override,
    id,
    modelName: override.modelName || globalDefaults?.modelName,
    budget: {
      ...base.budget,
      ...(globalDefaults?.maxOutputTokens ? { maxOutputTokens: globalDefaults.maxOutputTokens } : {}),
      ...(globalDefaults?.maxSteps && ["ask", "review", "plan", "code"].includes(id)
        ? { maxSteps: globalDefaults.maxSteps }
        : {}),
      ...(override.budget || {}),
    },
    permissions: {
      ...base.permissions,
      ...(override.permissions || {}),
    },
    pricing: {
      ...base.pricing,
      ...(override.pricing || {}),
    },
  };
}

export function listSelectableModelNames(
  overrides: AgentProfileOverrides = {},
  defaultModelName = "default"
): string[] {
  const names = new Set<string>();
  const normalizedDefault = defaultModelName.trim();
  if (normalizedDefault) names.add(normalizedDefault);
  for (const profile of Object.values(overrides)) {
    const modelName = profile?.modelName?.trim();
    if (modelName) names.add(modelName);
  }
  return Array.from(names);
}

export function resolveSelectableModelName(
  id: AgentProfileId,
  requestedModelName: unknown,
  overrides: AgentProfileOverrides = {},
  defaultModelName = "default"
): string {
  const profileModel = resolveAgentProfile(id, overrides, {
    modelName: defaultModelName,
  }).modelName || defaultModelName;
  if (typeof requestedModelName !== "string" || !requestedModelName.trim()) {
    return profileModel;
  }

  const requested = requestedModelName.trim();
  if (!listSelectableModelNames(overrides, defaultModelName).includes(requested)) {
    throw new Error("Requested model is not configured for this workspace");
  }
  return requested;
}

export function agentProfileAllowsTool(profile: AgentProfile, toolName: string): boolean {
  if (profile.permissions.deny.some((pattern) => matchPattern(pattern, toolName))) return false;
  return profile.permissions.allow.some((pattern) => matchPattern(pattern, toolName));
}

export function estimateUsageCostUsd(
  profile: AgentProfile,
  promptTokens: number,
  completionTokens: number
): number {
  return roundCost(
    promptTokens / 1_000_000 * profile.pricing.inputPerMillionUsd +
    completionTokens / 1_000_000 * profile.pricing.outputPerMillionUsd
  );
}

function matchPattern(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === value;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function normalizePatterns(value: unknown[]): string[] {
  return Array.from(new Set(value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 200)));
}

function normalizeNumericObject(
  value: unknown,
  keys: string[]
): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const output: Record<string, number> = {};
  for (const key of keys) {
    const entry = (value as Record<string, unknown>)[key];
    if (typeof entry === "number" && Number.isFinite(entry) && entry >= 0) {
      output[key] = key === "maxCostUsd" || key.endsWith("Usd") ? entry : Math.floor(entry);
    }
  }
  return output;
}

function roundCost(value: number): number {
  return Math.round(Math.max(0, value) * 1_000_000) / 1_000_000;
}
