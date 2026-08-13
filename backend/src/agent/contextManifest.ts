import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OpenAIMessage, OpenAIToolDef } from "./types.js";
import { redactSecrets } from "./secretRedaction.js";
import { evaluateContextPath } from "./contextPolicy.js";

export const CONTEXT_MANIFEST_SCHEMA_VERSION = 1 as const;

export type ContextManifestPurpose =
  | "agent_turn"
  | "compaction"
  | "subagent"
  | "teammate"
  | "change_set_review"
  | "title";
export type ContextManifestStatus = "prepared" | "sent" | "completed" | "failed" | "aborted";
export type ContextFreshness = "fresh" | "possibly_stale" | "stale" | "unknown";
export type ContextTrust =
  | "platform"
  | "authenticated_user"
  | "approved_user_artifact"
  | "workspace_instruction"
  | "local_tool_output"
  | "external_tool_output"
  | "model_generated"
  | "generated_file";
export type ContextIntegrity = "verified_digest" | "observed" | "unknown";
export type ContextDecision = "included" | "excluded" | "redacted" | "truncated";

export interface ContextSourceHint {
  kind: string;
  sourceType: string;
  reason: string;
  path?: string;
  messageId?: string;
  toolCallId?: string;
  skillName?: string;
  planId?: string;
  revision?: string;
  indexDocumentId?: string;
  observedAt?: number;
  sourceUpdatedAt?: number;
  freshness?: ContextFreshness;
  trust?: ContextTrust;
  integrity?: ContextIntegrity;
  decision?: ContextDecision;
  ruleIds?: string[];
  pinned?: boolean;
  /** Caller-supplied source text is used only for digest/token accounting and is never persisted. */
  content?: string;
}

export interface ContextManifestItem {
  itemId: string;
  kind: string;
  source: {
    type: string;
    path?: string;
    messageId?: string;
    toolCallId?: string;
    skillName?: string;
    planId?: string;
    revision?: string;
    indexDocumentId?: string;
  };
  reason: string;
  estimatedTokens: number;
  chars: number;
  contentDigest: string;
  observedAt: number;
  sourceUpdatedAt?: number;
  freshness: ContextFreshness;
  trust: ContextTrust;
  integrity: ContextIntegrity;
  decision: ContextDecision;
  ruleIds: string[];
  pinned: boolean;
}

export interface ContextManifestAttempt {
  attempt: number;
  startedAt: number;
  endedAt?: number;
  status: "sent" | "retrying" | "completed" | "failed" | "aborted";
  httpStatus?: number;
  errorCode?: string;
}

export interface ContextManifestV1 {
  schemaVersion: 1;
  manifestId: string;
  logicalRequestId: string;
  createdAt: number;
  updatedAt: number;
  status: ContextManifestStatus;
  purpose: ContextManifestPurpose;
  runId?: string;
  conversationId?: string;
  requestId?: string;
  agentId: string;
  providerId: string;
  modelName: string;
  scope: {
    kind: "workspace" | "managed_worktree" | "review_checkout";
    auditWorkspaceId: string;
    effectiveScopeId: string;
    worktreeId?: string;
    baseSha?: string;
    headSha?: string;
    indexGeneration?: string;
  };
  policyVersion: number;
  controlsVersion: number;
  payloadDigest: string;
  items: ContextManifestItem[];
  estimatedPromptTokens: number;
  actualPromptTokens?: number;
  excludedCount: number;
  redactedCount: number;
  truncatedCount: number;
  attempts: ContextManifestAttempt[];
  errorCode?: string;
}

export interface ContextAuditOptions {
  storeWorkspaceDir: string;
  effectiveWorkspaceDir?: string;
  scope: {
    kind: ContextManifestV1["scope"]["kind"];
    scopeId: string;
    worktreeId?: string;
    baseSha?: string;
    headSha?: string;
    indexGeneration?: string;
  };
  purpose: ContextManifestPurpose;
  runId?: string;
  conversationId?: string;
  requestId?: string;
  agentId: string;
  policyVersion?: number;
  controlsVersion?: number;
  systemPromptSources?: ContextSourceHint[];
  messageSources?: ContextSourceHint[];
  toolSources?: ContextSourceHint[];
  /** Policy decisions for candidates that were evaluated but not sent. */
  additionalSources?: ContextSourceHint[];
}

export interface ContextManifestState {
  manifestId: string;
  logicalRequestId: string;
  status: ContextManifestStatus;
  purpose: ContextManifestPurpose;
  runId?: string;
  conversationId?: string;
  requestId?: string;
  estimatedPromptTokens: number;
  actualPromptTokens?: number;
  includedCount: number;
  excludedCount: number;
  redactedCount: number;
  truncatedCount: number;
  attemptCount: number;
  updatedAt: number;
}

export interface BuildContextManifestInput {
  audit: ContextAuditOptions;
  providerId: string;
  modelName: string;
  systemPrompt?: string;
  messages: OpenAIMessage[];
  tools?: OpenAIToolDef[];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function contextDigest(value: unknown): string {
  return crypto.createHash("sha256").update(canonical(redactSecrets(value))).digest("hex");
}

export function estimateContextTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(typeof value === "string" ? value : canonical(value), "utf8") / 4);
}

function canonicalRoot(value: string, field: string): string {
  const resolved = path.resolve(value);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`${field} is unavailable`);
  }
  if (!stat.isDirectory()) throw new Error(`${field} must be a directory`);
  return fs.realpathSync.native(resolved);
}

function cleanIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)) {
    throw new Error(`Invalid context ${field}`);
  }
  return normalized;
}

function cleanPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.length > 1000 || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) return undefined;
  return redactSecrets(normalized);
}

function itemFromHint(hint: ContextSourceHint, fallbackContent: unknown, index: number): ContextManifestItem {
  const content = hint.content ?? (typeof fallbackContent === "string" ? fallbackContent : canonical(fallbackContent));
  const decision = hint.decision || "included";
  return {
    itemId: `ctx-${index + 1}-${contextDigest([hint.kind, hint.sourceType, content]).slice(0, 12)}`,
    kind: redactSecrets(hint.kind).slice(0, 100) || "unknown",
    source: {
      type: redactSecrets(hint.sourceType).slice(0, 100) || "unknown",
      ...(cleanPath(hint.path) ? { path: cleanPath(hint.path) } : {}),
      ...(hint.messageId ? { messageId: redactSecrets(hint.messageId).slice(0, 200) } : {}),
      ...(hint.toolCallId ? { toolCallId: redactSecrets(hint.toolCallId).slice(0, 200) } : {}),
      ...(hint.skillName ? { skillName: redactSecrets(hint.skillName).slice(0, 200) } : {}),
      ...(hint.planId ? { planId: redactSecrets(hint.planId).slice(0, 200) } : {}),
      ...(hint.revision ? { revision: redactSecrets(hint.revision).slice(0, 200) } : {}),
      ...(hint.indexDocumentId ? { indexDocumentId: redactSecrets(hint.indexDocumentId).slice(0, 200) } : {}),
    },
    reason: redactSecrets(hint.reason).slice(0, 500) || "Included in provider request",
    estimatedTokens: decision === "included" || decision === "redacted" || decision === "truncated" ? estimateContextTokens(content) : 0,
    chars: typeof content === "string" ? content.length : canonical(content).length,
    contentDigest: contextDigest(content),
    observedAt: hint.observedAt || Date.now(),
    ...(typeof hint.sourceUpdatedAt === "number" ? { sourceUpdatedAt: hint.sourceUpdatedAt } : {}),
    freshness: hint.freshness || "unknown",
    trust: hint.trust || "model_generated",
    integrity: hint.integrity || "observed",
    decision,
    ruleIds: (hint.ruleIds || []).filter((item) => typeof item === "string" && item.trim()).map((item) => redactSecrets(item).slice(0, 120)).slice(0, 20),
    pinned: hint.pinned === true,
  };
}

function defaultMessageHint(message: OpenAIMessage): ContextSourceHint {
  if (message.role === "user") return { kind: "conversation_message", sourceType: "user_message", reason: "Current or recent user instruction", trust: "authenticated_user", integrity: "observed" };
  if (message.role === "tool") return { kind: "tool_result", sourceType: "local_tool", reason: "Tool result needed for continuation", toolCallId: message.tool_call_id, trust: "local_tool_output", integrity: "observed" };
  return { kind: "conversation_message", sourceType: "assistant_message", reason: "Model-generated conversation continuity", trust: "model_generated", integrity: "observed" };
}

export function buildContextManifest(input: BuildContextManifestInput): ContextManifestV1 {
  const auditRoot = canonicalRoot(input.audit.storeWorkspaceDir, "Context audit workspace");
  const effectiveRoot = canonicalRoot(input.audit.effectiveWorkspaceDir || input.audit.storeWorkspaceDir, "Effective context workspace");
  if (input.audit.scope.kind === "workspace" && auditRoot !== effectiveRoot) {
    throw new Error("Workspace context scope cannot cross its audit workspace");
  }
  const scopeId = cleanIdentifier(input.audit.scope.scopeId, "scope id");
  const logicalRequestId = crypto.randomUUID();
  const now = Date.now();
  const safePayload = redactSecrets({ systemPrompt: input.systemPrompt, messages: input.messages, tools: input.tools });
  for (const hint of [...(input.audit.systemPromptSources || []), ...(input.audit.messageSources || []), ...(input.audit.toolSources || []), ...(input.audit.additionalSources || [])]) {
    if (!hint.path || hint.decision === "excluded") continue;
    const policy = evaluateContextPath(hint.path);
    const authorizedInstruction = hint.path === ".codex/AGENTS.md" &&
      hint.kind === "project_instruction" &&
      hint.sourceType === "workspace_guidance" &&
      hint.ruleIds?.includes("authorized_instruction_file");
    if (!policy.allowed && !authorizedInstruction) {
      throw new Error(`Context source is not authorized: ${policy.reason || "invalid_path"}`);
    }
  }
  const items: ContextManifestItem[] = [];
  if (input.systemPrompt) {
    const hints = input.audit.systemPromptSources?.length
      ? input.audit.systemPromptSources
      : [{ kind: "system_prompt", sourceType: "runtime_system", reason: "Runtime and project instructions", trust: "platform" as const, integrity: "observed" as const, content: input.systemPrompt }];
    for (const hint of hints) items.push(itemFromHint(hint, input.systemPrompt, items.length));
  }
  input.messages.forEach((message, index) => {
    const hint = input.audit.messageSources?.[index] || defaultMessageHint(message);
    items.push(itemFromHint(hint, message, items.length));
  });
  (input.tools || []).forEach((tool, index) => {
    const hint = input.audit.toolSources?.[index] || { kind: "tool_schema", sourceType: "runtime_tool", reason: "Tool schema exposed to the model", trust: "platform" as const, integrity: "verified_digest" as const };
    items.push(itemFromHint(hint, tool, items.length));
  });
  for (const hint of input.audit.additionalSources || []) {
    items.push(itemFromHint(hint, hint.content || "", items.length));
  }
  if (items.length === 0) throw new Error("Context manifest cannot cover an empty provider payload");
  const estimatedPromptTokens = estimateContextTokens(safePayload);
  return {
    schemaVersion: CONTEXT_MANIFEST_SCHEMA_VERSION,
    manifestId: `ctx-${crypto.randomUUID()}`,
    logicalRequestId,
    createdAt: now,
    updatedAt: now,
    status: "prepared",
    purpose: input.audit.purpose,
    ...(input.audit.runId ? { runId: cleanIdentifier(input.audit.runId, "run id") } : {}),
    ...(input.audit.conversationId ? { conversationId: cleanIdentifier(input.audit.conversationId, "conversation id") } : {}),
    ...(input.audit.requestId ? { requestId: cleanIdentifier(input.audit.requestId, "request id") } : {}),
    agentId: redactSecrets(input.audit.agentId).slice(0, 200) || "agent",
    providerId: redactSecrets(input.providerId).slice(0, 100),
    modelName: redactSecrets(input.modelName).slice(0, 200),
    scope: {
      kind: input.audit.scope.kind,
      auditWorkspaceId: contextDigest(auditRoot),
      effectiveScopeId: contextDigest([effectiveRoot, scopeId]),
      ...(input.audit.scope.worktreeId ? { worktreeId: cleanIdentifier(input.audit.scope.worktreeId, "worktree id") } : {}),
      ...(input.audit.scope.baseSha ? { baseSha: redactSecrets(input.audit.scope.baseSha).slice(0, 200) } : {}),
      ...(input.audit.scope.headSha ? { headSha: redactSecrets(input.audit.scope.headSha).slice(0, 200) } : {}),
      ...(input.audit.scope.indexGeneration ? { indexGeneration: redactSecrets(input.audit.scope.indexGeneration).slice(0, 200) } : {}),
    },
    policyVersion: Math.max(1, Math.floor(input.audit.policyVersion || 1)),
    controlsVersion: Math.max(0, Math.floor(input.audit.controlsVersion || 0)),
    payloadDigest: contextDigest(safePayload),
    items,
    estimatedPromptTokens,
    excludedCount: items.filter((item) => item.decision === "excluded").length,
    redactedCount: items.filter((item) => item.decision === "redacted").length,
    truncatedCount: items.filter((item) => item.decision === "truncated").length,
    attempts: [],
  };
}

export function toContextManifestState(manifest: ContextManifestV1): ContextManifestState {
  return {
    manifestId: manifest.manifestId,
    logicalRequestId: manifest.logicalRequestId,
    status: manifest.status,
    purpose: manifest.purpose,
    ...(manifest.runId ? { runId: manifest.runId } : {}),
    ...(manifest.conversationId ? { conversationId: manifest.conversationId } : {}),
    ...(manifest.requestId ? { requestId: manifest.requestId } : {}),
    estimatedPromptTokens: manifest.estimatedPromptTokens,
    ...(manifest.actualPromptTokens !== undefined ? { actualPromptTokens: manifest.actualPromptTokens } : {}),
    includedCount: manifest.items.filter((item) => item.decision !== "excluded").length,
    excludedCount: manifest.excludedCount,
    redactedCount: manifest.redactedCount,
    truncatedCount: manifest.truncatedCount,
    attemptCount: manifest.attempts.length,
    updatedAt: manifest.updatedAt,
  };
}
