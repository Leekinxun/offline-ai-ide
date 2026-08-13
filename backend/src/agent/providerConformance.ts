import crypto from "node:crypto";
import type { ModelCapabilities, ModelFeature } from "./modelCapabilities.js";
import { ProviderRequestError } from "./providerErrors.js";
import type { OpenAIResponse, OpenAIToolDef } from "./types.js";

export type ModelRole = "ask" | "plan" | "code" | "review" | "explore" | "verifier";
export interface ProviderExecutionContract {
  id: string;
  permissions: string[];
  isolation: string;
  tools: string[];
  requiredCapabilities?: ModelFeature[];
}

const ROLE_REQUIREMENTS: Record<ModelRole, ModelFeature[]> = {
  ask: ["streaming", "cancellation"],
  plan: ["streaming", "tool_calling", "cancellation"],
  code: ["streaming", "tool_calling", "cancellation", "usage_reporting"],
  review: ["streaming", "tool_calling", "cancellation"],
  explore: ["streaming", "tool_calling", "cancellation"],
  verifier: ["streaming", "tool_calling", "cancellation"],
};

export function requiredCapabilitiesFor(role: ModelRole, tools: OpenAIToolDef[] = [], explicit: ModelFeature[] = []): ModelFeature[] {
  return [...new Set([...ROLE_REQUIREMENTS[role], ...(tools.length ? ["tool_calling" as const] : []), ...explicit])];
}

export function assertModelSuitable(input: { role: ModelRole; capabilities: ModelCapabilities; tools?: OpenAIToolDef[]; required?: ModelFeature[]; structuredOutput?: boolean }): void {
  const required = requiredCapabilitiesFor(input.role, input.tools, [...(input.required || []), ...(input.structuredOutput ? ["structured_output" as const] : [])]);
  const missing = required.filter((feature) => !input.capabilities.supports[feature]);
  if (missing.length) throw new ProviderRequestError({ code: "capability_mismatch", message: `Model ${input.capabilities.modelName} is unsuitable for ${input.role}; missing required capabilities: ${missing.join(", ")}`, retryable: false, recoverable: true });
}

export function modelSuitability(role: ModelRole, capabilities: ModelCapabilities, required: ModelFeature[] = []): { suitable: boolean; required: ModelFeature[]; missing: ModelFeature[] } {
  const all = requiredCapabilitiesFor(role, [], required); const missing = all.filter((feature) => !capabilities.supports[feature]); return { suitable: missing.length === 0, required: all, missing };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function executionContractDigest(contract: ProviderExecutionContract): string { return crypto.createHash("sha256").update(stable({ ...contract, permissions: [...contract.permissions].sort(), tools: [...contract.tools].sort(), requiredCapabilities: [...(contract.requiredCapabilities || [])].sort() })).digest("hex"); }
export function assertFallbackContract(primary: ProviderExecutionContract | undefined, fallback: ProviderExecutionContract | undefined): void {
  if (!primary || !fallback || executionContractDigest(primary) !== executionContractDigest(fallback)) throw new ProviderRequestError({ code: "fallback_contract_mismatch", message: "Fallback model would change the execution, tool, permission, isolation, or capability contract", retryable: false, recoverable: true });
}

export function validateProviderResponse(value: OpenAIResponse, structuredOutput = false): OpenAIResponse {
  if (!value || !Array.isArray(value.choices) || value.choices.length !== 1) throw malformed("Provider response must contain exactly one choice");
  const choice = value.choices[0]; const message = choice?.message;
  if (!message || message.role !== "assistant" || (message.content !== null && typeof message.content !== "string")) throw malformed("Provider response has an invalid assistant message");
  if (!choice.finish_reason || !["stop", "tool_calls", "length"].includes(choice.finish_reason)) throw malformed("Provider response is missing a terminal finish reason");
  const calls = message.tool_calls;
  if (choice.finish_reason === "tool_calls" && (!Array.isArray(calls) || calls.length === 0)) throw malformed("tool_calls finish reason requires tool calls");
  if (calls) for (const call of calls) if (!call?.id || call.type !== "function" || !call.function?.name || typeof call.function.arguments !== "string") throw malformed("Provider response contains a malformed tool call");
  if (structuredOutput && message.content !== null) { try { JSON.parse(message.content); } catch { throw malformed("Provider structured output is not valid JSON"); } }
  if (value.usage) for (const [key, amount] of Object.entries(value.usage)) if (amount !== undefined && (!Number.isSafeInteger(amount) || amount < 0)) throw malformed(`Provider usage ${key} is invalid`);
  return value;
}
function malformed(message: string): ProviderRequestError { return new ProviderRequestError({ code: "response_parse", message, retryable: false, recoverable: true }); }
