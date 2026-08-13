import type { ModelFeature } from "./modelCapabilities.js";
import type { ModelFallbackCandidate } from "./modelProcessor.js";
import type { ProviderExecutionContract } from "./providerConformance.js";
import type { ModelFallbackSettings } from "../config.js";

export function buildProviderExecutionContract(input: {
  id: string;
  permissions: readonly string[];
  isolation: string;
  tools: readonly string[];
  requiredCapabilities?: readonly ModelFeature[];
}): ProviderExecutionContract {
  return {
    id: input.id,
    permissions: [...new Set(input.permissions)].sort(),
    isolation: input.isolation,
    tools: [...new Set(input.tools)].sort(),
    ...(input.requiredCapabilities ? { requiredCapabilities: [...new Set(input.requiredCapabilities)].sort() } : {}),
  };
}

/** Every configured fallback receives the exact effective request contract. */
export function bindConfiguredFallbacks(
  candidates: readonly ModelFallbackSettings[],
  executionContract: ProviderExecutionContract,
  maxOutputTokens?: number
): ModelFallbackCandidate[] {
  return candidates.slice(0, 3).map((candidate) => ({
    ...candidate,
    ...(maxOutputTokens ? { maxOutputTokens: Math.min(candidate.maxOutputTokens || maxOutputTokens, maxOutputTokens) } : {}),
    executionContract,
  }));
}
