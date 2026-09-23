import type { ModelFeature } from "./modelCapabilities.js";
import type { ModelFallbackCandidate } from "./modelProcessor.js";
import type { ProviderExecutionContract } from "./providerConformance.js";
import { config, resolveModelInputCapabilities, resolveModelSampling, type ModelFallbackSettings } from "../config.js";

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
  return candidates.slice(0, 3).map((candidate) => {
    const matchesConfiguredModel = config.models.some((model) =>
      model.modelName === candidate.model && model.apiUrl === candidate.apiUrl
      && model.apiKey === (candidate.apiKey || "")
    ) || (candidate.model === config.modelName && candidate.apiUrl === config.vllmApiUrl
      && config.vllmApiKey === (candidate.apiKey || ""));
    const sampling = matchesConfiguredModel ? resolveModelSampling(candidate.model) : undefined;
    const limit = Math.min(
      candidate.maxOutputTokens || Number.POSITIVE_INFINITY,
      maxOutputTokens || Number.POSITIVE_INFINITY,
      sampling?.maxTokens || Number.POSITIVE_INFINITY
    );
    return {
      ...candidate,
      ...(Number.isFinite(limit) ? { maxOutputTokens: limit } : {}),
      sampling: sampling ? {
        temperature: sampling.temperature,
        topP: sampling.topP,
        frequencyPenalty: sampling.frequencyPenalty,
        presencePenalty: sampling.presencePenalty,
      } : {},
      inputCapabilities: matchesConfiguredModel
        ? resolveModelInputCapabilities(candidate.model)
        : { image_input: false, pdf_input: false },
      executionContract,
    };
  });
}
