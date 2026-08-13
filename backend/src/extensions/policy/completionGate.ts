import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertRepositoryQuality, getAgentHooksGeneration, hasAgentHooks } from "../../agent/agentHooks.js";
import { redactSecrets } from "../../agent/secretRedaction.js";
import { TraceStore } from "../../chat/traceStore.js";

export interface CompletionGateEvidence {
  schemaVersion: 1;
  status: "passed" | "passed_with_warnings" | "blocked";
  runId: string;
  scopeId: string;
  hookGeneration: number;
  attemptToken: string;
  /** @deprecated Use attemptToken. Kept while older clients migrate. */
  token: string;
  warnings: Array<{ name: string; error: string }>;
  error?: string;
  timestamp: string;
}

interface AttemptBinding {
  workspace: string;
  runId: string;
  scopeId: string;
  generation: number;
}

const cache = new Map<string, CompletionGateEvidence>();
const attempts = new Map<string, AttemptBinding>();
const activeAttempts = new Map<string, string>();

function scopeKey(workspace: string, runId: string, scopeId: string): string {
  return `${path.resolve(workspace)}\0${runId}\0${scopeId}`;
}

function assertAttempt(input: { workspaceDir: string; runId: string; scopeId: string; attemptToken: string }): AttemptBinding {
  const binding = attempts.get(input.attemptToken);
  const expectedKey = scopeKey(input.workspaceDir, input.runId, input.scopeId);
  if (
    !binding ||
    binding.workspace !== path.resolve(input.workspaceDir) ||
    binding.runId !== input.runId ||
    binding.scopeId !== input.scopeId ||
    binding.generation !== getAgentHooksGeneration() ||
    activeAttempts.get(expectedKey) !== input.attemptToken
  ) {
    throw new Error("Completion attempt token is missing, stale, or bound to a different completion attempt");
  }
  return binding;
}

export function beginCompletionAttempt(input: { workspaceDir: string; runId: string; scopeId?: string }): string {
  const scopeId = input.scopeId || `run:${input.runId}`;
  const key = scopeKey(input.workspaceDir, input.runId, scopeId);
  const previous = activeAttempts.get(key);
  if (previous) cache.delete(previous);
  const attemptToken = crypto.randomUUID();
  attempts.set(attemptToken, {
    workspace: path.resolve(input.workspaceDir),
    runId: input.runId,
    scopeId,
    generation: getAgentHooksGeneration(),
  });
  activeAttempts.set(key, attemptToken);
  return attemptToken;
}

function persist(workspaceDir: string, evidence: CompletionGateEvidence): void {
  const safe = redactSecrets(evidence);
  const filePath = path.join(workspaceDir, ".codex", "audit", "completion-gates.jsonl");
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) throw new Error("Completion gate audit path cannot be a symlink");
  fs.appendFileSync(filePath, `${JSON.stringify(safe)}\n`, { mode: 0o600 });
  new TraceStore(workspaceDir).append({
    kind: "validation", action: "Repository completion quality gate", correlationId: evidence.runId,
    runId: evidence.runId, decision: evidence.status, evidence: evidence.error,
    metadata: { scopeId: evidence.scopeId, attemptToken: evidence.attemptToken, warningCount: evidence.warnings.length, hookGeneration: evidence.hookGeneration },
  });
}

export class CompletionQualityGateError extends Error {
  constructor(readonly evidence: CompletionGateEvidence) { super(evidence.error || "Repository quality hook blocked completion"); this.name = "CompletionQualityGateError"; }
}

export async function runRepositoryCompletionGate(input: {
  workspaceDir: string;
  runId: string;
  scopeId?: string;
  attemptToken: string;
  agentId: string;
  conversationId?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}): Promise<CompletionGateEvidence> {
  const scopeId = input.scopeId || `run:${input.runId}`;
  const binding = assertAttempt({ workspaceDir: input.workspaceDir, runId: input.runId, scopeId, attemptToken: input.attemptToken });
  const cached = cache.get(input.attemptToken);
  if (cached) { if (cached.status === "blocked") throw new CompletionQualityGateError(cached); return cached; }
  const base = { schemaVersion: 1 as const, runId: input.runId, scopeId, hookGeneration: binding.generation, attemptToken: input.attemptToken, token: input.attemptToken, timestamp: new Date().toISOString() };
  if (!hasAgentHooks("repositoryQuality")) {
    const evidence: CompletionGateEvidence = { ...base, status: "passed", warnings: [] };
    persist(input.workspaceDir, evidence); cache.set(input.attemptToken, evidence); return evidence;
  }
  try {
    const warnings = await assertRepositoryQuality({ agentId: input.agentId, workspaceDir: input.workspaceDir, runId: input.runId, conversationId: input.conversationId, requestId: input.requestId, metadata: { ...input.metadata, completionScopeId: scopeId, completionAttemptToken: input.attemptToken } });
    const evidence: CompletionGateEvidence = { ...base, status: warnings.length ? "passed_with_warnings" : "passed", warnings };
    persist(input.workspaceDir, evidence); cache.set(input.attemptToken, evidence); return evidence;
  } catch (error) {
    const evidence: CompletionGateEvidence = { ...base, status: "blocked", warnings: [], error: error instanceof Error ? error.message : String(error) };
    persist(input.workspaceDir, evidence); cache.set(input.attemptToken, evidence); throw new CompletionQualityGateError(evidence);
  }
}

export function assertCompletionGateToken(workspaceDir: string, scopeId: string, attemptToken: string | undefined): void {
  if (!hasAgentHooks("repositoryQuality")) return;
  const binding = attemptToken ? attempts.get(attemptToken) : undefined;
  const evidence = attemptToken ? cache.get(attemptToken) : undefined;
  if (
    !binding || !evidence || evidence.status === "blocked" ||
    binding.workspace !== path.resolve(workspaceDir) || binding.scopeId !== scopeId ||
    binding.generation !== getAgentHooksGeneration() ||
    activeAttempts.get(scopeKey(workspaceDir, binding.runId, scopeId)) !== attemptToken
  ) throw new Error("Repository quality gate is required before terminal completion");
}

export function clearCompletionGateCacheForTests(): void { cache.clear(); attempts.clear(); activeAttempts.clear(); }
