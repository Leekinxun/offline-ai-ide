import { estimateModelRequest } from "./modelBudget.js";
import type { OpenAIMessage, OpenAIToolDef } from "./types.js";

export interface ContextRequestBudget {
  requestLimit: number;
  historyTarget: number;
  reservedTokens: number;
  retrievalReserve: number;
}

export function contextRequestBudget(input: {
  threshold: number;
  systemPrompt: string;
  tools: OpenAIToolDef[];
  maxOutputTokens: number;
}): ContextRequestBudget {
  const requestLimit = Math.floor(input.threshold);
  if (!Number.isSafeInteger(requestLimit) || requestLimit < 1) throw new Error("Invalid context request budget");
  const base = estimateModelRequest({ ...input, messages: [] });
  const safetyReserve = Math.max(256, Math.ceil(requestLimit * 0.05));
  const retrievalReserve = Math.min(8_000, Math.floor(requestLimit * 0.1));
  const reservedTokens = base.tokens + safetyReserve;
  const historyTarget = Math.min(Math.floor(requestLimit * 0.8), requestLimit - reservedTokens - retrievalReserve);
  if (historyTarget < 256) throw new Error("Context budget cannot fit system instructions, tools, and output reserve; increase the configured budget or reduce these inputs");
  return { requestLimit, historyTarget, reservedTokens, retrievalReserve };
}

export function fitsContextRequestBudget(input: {
  systemPrompt: string;
  messages: OpenAIMessage[];
  tools: OpenAIToolDef[];
  maxOutputTokens: number;
}, limit: number): boolean {
  return estimateModelRequest(input).tokens <= limit;
}
