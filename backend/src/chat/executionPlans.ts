import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createExecutionPlanApprovalFingerprint,
  type ExecutionPlanApprovalFingerprint,
} from "./planFreshness.js";

const PLAN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_PLANS = 100;
export const CURRENT_EXECUTION_PLAN_SCHEMA_VERSION = 1;

export type ExecutionPlanStatus =
  | "approved"
  | "in_progress"
  | "completed"
  | "needs_revision"
  | "rejected";

export interface ExecutionPlanInput {
  goal: string;
  files: string[];
  steps: string[];
  risks: string[];
  verificationCommands: string[];
  acceptanceCriteria: string[];
}

export type ExecutionPlanAmendmentStatus = "pending" | "approved" | "rejected";

export interface ExecutionPlanAmendmentRequest {
  id: string;
  reason: string;
  requestedFiles: string[];
  requestedVerificationCommands: string[];
  status: ExecutionPlanAmendmentStatus;
  requestedAt: number;
  requestedByRunId: string;
  resolvedAt?: number;
}

export interface ExecutionPlanAmendmentInput {
  reason: string;
  requestedFiles?: string[];
  requestedVerificationCommands?: string[];
}

export interface ExecutionPlan extends ExecutionPlanInput {
  /** Persisted-record schema version. Optional for source compatibility with legacy callers. */
  schemaVersion?: number;
  id: string;
  conversationId: string;
  planRunId: string;
  status: ExecutionPlanStatus;
  createdAt: number;
  approvedAt?: number;
  updatedAt: number;
  executionRunIds: string[];
  /** Missing legacy values normalize to an empty amendment history. */
  amendmentRequests?: ExecutionPlanAmendmentRequest[];
  /** Snapshot captured at approval. Legacy plans may omit this once. */
  approvalFingerprint?: ExecutionPlanApprovalFingerprint;
}

function plansDir(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), ".history", "plans");
}

function ensurePlansDir(workspaceDir: string): string {
  const directory = plansDir(workspaceDir);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function planPath(workspaceDir: string, planId: string): string {
  if (!PLAN_ID_PATTERN.test(planId)) throw new Error("Invalid execution plan id");
  return path.join(ensurePlansDir(workspaceDir), `${planId}.json`);
}

function stringValue(value: unknown, field: string, maxLength = 4000): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim().slice(0, maxLength);
}

function stringList(
  value: unknown,
  field: string,
  options: { required?: boolean; maxItems?: number; maxLength?: number } = {}
): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const result = Array.from(new Set(value.map((entry) =>
    stringValue(entry, field, options.maxLength || 2000)
  ))).slice(0, options.maxItems || 50);
  if (options.required && result.length === 0) {
    throw new Error(`${field} must contain at least one item`);
  }
  return result;
}

function normalizePlanFile(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    (!normalized && value !== ".") ||
    path.posix.isAbsolute(normalized) ||
    normalized.split("/").includes("..") ||
    normalized.startsWith(".history/") ||
    normalized.startsWith(".git/") ||
    normalized.split("/").some((segment) =>
      segment === ".checkpoints" || segment === "node_modules" || segment === "dist"
    )
  ) {
    throw new Error(`Invalid plan file scope: ${value}`);
  }
  return (normalized || ".").slice(0, 1000);
}

export function normalizeExecutionPlanInput(raw: unknown): ExecutionPlanInput {
  if (!raw || typeof raw !== "object") throw new Error("Execution plan input is required");
  const value = raw as Record<string, unknown>;
  return {
    goal: stringValue(value.goal, "goal"),
    files: stringList(value.files, "files", { required: true, maxItems: 100, maxLength: 1000 })
      .map(normalizePlanFile),
    steps: stringList(value.steps, "steps", { required: true }),
    risks: stringList(value.risks, "risks"),
    verificationCommands: stringList(value.verification_commands, "verification_commands", {
      required: true,
      maxItems: 30,
      maxLength: 1000,
    }),
    acceptanceCriteria: stringList(value.acceptance_criteria, "acceptance_criteria", {
      required: true,
    }),
  };
}

export function createApprovedExecutionPlan(
  workspaceDir: string,
  raw: unknown,
  context: { conversationId: string; planRunId: string }
): ExecutionPlan {
  const input = normalizeExecutionPlanInput(raw);
  const now = Date.now();
  const plan: ExecutionPlan = {
    schemaVersion: CURRENT_EXECUTION_PLAN_SCHEMA_VERSION,
    id: `plan-${now}-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`,
    conversationId: context.conversationId,
    planRunId: context.planRunId,
    ...input,
    status: "approved",
    createdAt: now,
    approvedAt: now,
    updatedAt: now,
    executionRunIds: [],
    amendmentRequests: [],
  };
  plan.approvalFingerprint = createExecutionPlanApprovalFingerprint(workspaceDir, plan.files);
  writeExecutionPlan(workspaceDir, plan);
  prunePlans(workspaceDir);
  return plan;
}

export function readExecutionPlan(workspaceDir: string, planId: string): ExecutionPlan {
  const parsed = JSON.parse(fs.readFileSync(planPath(workspaceDir, planId), "utf8"));
  const plan = normalizeExecutionPlanRecord(parsed);
  if (!plan || plan.id !== planId) {
    throw new Error("Execution plan is invalid");
  }
  return plan;
}

export function findLatestApprovedExecutionPlan(
  workspaceDir: string,
  conversationId: string
): ExecutionPlan | null {
  return findLatestExecutionPlan(workspaceDir, conversationId, new Set(["approved", "in_progress"]));
}

/**
 * Returns the newest active plan bound to a conversation, including a plan that
 * requires revision. Code callers must use this rather than silently falling
 * back to direct Code when a previously approved plan becomes stale.
 */
export function findLatestBoundExecutionPlan(
  workspaceDir: string,
  conversationId: string
): ExecutionPlan | null {
  return findLatestExecutionPlan(
    workspaceDir,
    conversationId,
    new Set(["approved", "in_progress", "needs_revision"])
  );
}

function findLatestExecutionPlan(
  workspaceDir: string,
  conversationId: string,
  statuses: Set<ExecutionPlanStatus>
): ExecutionPlan | null {
  const directory = ensurePlansDir(workspaceDir);
  const plans = fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      try {
        return [readExecutionPlan(workspaceDir, name.slice(0, -5))];
      } catch {
        return [];
      }
    })
    .filter((plan) =>
      plan.conversationId === conversationId && statuses.has(plan.status)
    )
    .sort((left, right) => right.updatedAt - left.updatedAt);
  return plans[0] || null;
}

export function updateExecutionPlanStatus(
  workspaceDir: string,
  planId: string,
  status: ExecutionPlanStatus,
  executionRunId?: string
): ExecutionPlan {
  const plan = readExecutionPlan(workspaceDir, planId);
  plan.status = status;
  plan.updatedAt = Date.now();
  if (executionRunId && !plan.executionRunIds.includes(executionRunId)) {
    plan.executionRunIds.push(executionRunId);
  }
  writeExecutionPlan(workspaceDir, plan);
  return plan;
}

export function requestExecutionPlanAmendment(
  workspaceDir: string,
  planId: string,
  input: ExecutionPlanAmendmentInput,
  runId: string
): ExecutionPlan {
  const plan = readExecutionPlan(workspaceDir, planId);
  const amendment = normalizeExecutionPlanAmendmentInput(input, runId);
  const now = Date.now();
  plan.amendmentRequests = [
    ...(plan.amendmentRequests || []),
    {
      id: `amendment-${now}-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`,
      ...amendment,
      status: "pending",
      requestedAt: now,
    },
  ];
  plan.status = "needs_revision";
  plan.updatedAt = now;
  writeExecutionPlan(workspaceDir, plan);
  return plan;
}

export function resolveExecutionPlanAmendment(
  workspaceDir: string,
  planId: string,
  amendmentId: string,
  status: Extract<ExecutionPlanAmendmentStatus, "approved" | "rejected">
): ExecutionPlan {
  const plan = readExecutionPlan(workspaceDir, planId);
  const amendment = (plan.amendmentRequests || []).find((entry) => entry.id === amendmentId);
  if (!amendment) throw new Error("Execution plan amendment not found");
  if (amendment.status !== "pending") throw new Error("Execution plan amendment is already resolved");

  const now = Date.now();
  amendment.status = status;
  amendment.resolvedAt = now;
  if (status === "approved") {
    plan.files = dedupe([ ...plan.files, ...amendment.requestedFiles ]);
    plan.verificationCommands = dedupe([
      ...plan.verificationCommands,
      ...amendment.requestedVerificationCommands,
    ]);
    // A fresh approval is the compatibility migration point for legacy plans.
    plan.approvalFingerprint = createExecutionPlanApprovalFingerprint(workspaceDir, plan.files);
  }
  // Never revive a plan while another amendment still requires a decision.
  const hasPendingAmendments = (plan.amendmentRequests || []).some(
    (entry) => entry.status === "pending"
  );
  plan.status = hasPendingAmendments ? "needs_revision" : "approved";
  plan.updatedAt = now;
  writeExecutionPlan(workspaceDir, plan);
  return plan;
}

function writeExecutionPlan(workspaceDir: string, plan: ExecutionPlan): void {
  plan.schemaVersion = CURRENT_EXECUTION_PLAN_SCHEMA_VERSION;
  const target = planPath(workspaceDir, plan.id);
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, target);
}

function normalizeExecutionPlanRecord(raw: unknown): ExecutionPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const plan = raw as ExecutionPlan;
  const schemaVersion = normalizeExecutionPlanSchemaVersion(plan.schemaVersion);
  if (schemaVersion === null) return null;
  const amendmentRequests = normalizeExecutionPlanAmendments(plan.amendmentRequests);
  const approvalFingerprint = normalizeApprovalFingerprint(plan.approvalFingerprint);
  if (amendmentRequests === null || approvalFingerprint === null) return null;
  return { ...plan, schemaVersion, amendmentRequests, ...(approvalFingerprint ? { approvalFingerprint } : {}) };
}

function normalizeApprovalFingerprint(raw: unknown): ExecutionPlanApprovalFingerprint | undefined | null {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<ExecutionPlanApprovalFingerprint>;
  return value.version === 1 && value.algorithm === "sha256" &&
    typeof value.digest === "string" && /^[a-f0-9]{64}$/.test(value.digest)
    ? { version: 1, algorithm: "sha256", digest: value.digest }
    : null;
}

function normalizeExecutionPlanAmendmentInput(
  raw: ExecutionPlanAmendmentInput,
  runId: string
): Pick<ExecutionPlanAmendmentRequest, "reason" | "requestedFiles" | "requestedVerificationCommands" | "requestedByRunId"> {
  const value = raw && typeof raw === "object" ? raw as unknown as Record<string, unknown> : null;
  if (!value) throw new Error("Execution plan amendment input is required");
  const requestedFiles = dedupe(
    stringList(value.requestedFiles ?? [], "requestedFiles", { maxItems: 100, maxLength: 1000 })
      .map(normalizePlanFile)
  );
  const requestedVerificationCommands = stringList(
    value.requestedVerificationCommands ?? [],
    "requestedVerificationCommands",
    { maxItems: 30, maxLength: 1000 }
  );
  if (requestedFiles.length === 0 && requestedVerificationCommands.length === 0) {
    throw new Error("Execution plan amendment must request files or verification commands");
  }
  return {
    reason: stringValue(value.reason, "reason"),
    requestedFiles,
    requestedVerificationCommands,
    requestedByRunId: stringValue(runId, "runId", 160),
  };
}

function normalizeExecutionPlanAmendments(raw: unknown): ExecutionPlanAmendmentRequest[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const amendments: ExecutionPlanAmendmentRequest[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const value = entry as Partial<ExecutionPlanAmendmentRequest>;
    if (
      typeof value.id !== "string" ||
      !PLAN_ID_PATTERN.test(value.id) ||
      typeof value.reason !== "string" ||
      !value.reason.trim() ||
      !Array.isArray(value.requestedFiles) ||
      !Array.isArray(value.requestedVerificationCommands) ||
      (value.status !== "pending" && value.status !== "approved" && value.status !== "rejected") ||
      typeof value.requestedAt !== "number" ||
      typeof value.requestedByRunId !== "string" ||
      !value.requestedByRunId.trim()
    ) return null;
    try {
      amendments.push({
        id: value.id,
        reason: value.reason.trim().slice(0, 4000),
        requestedFiles: dedupe(value.requestedFiles.map((file) => normalizePlanFile(stringValue(file, "requestedFiles", 1000)))),
        requestedVerificationCommands: stringList(
          value.requestedVerificationCommands,
          "requestedVerificationCommands",
          { maxItems: 30, maxLength: 1000 }
        ),
        status: value.status,
        requestedAt: value.requestedAt,
        requestedByRunId: value.requestedByRunId.trim().slice(0, 160),
        ...(typeof value.resolvedAt === "number" ? { resolvedAt: value.resolvedAt } : {}),
      });
    } catch {
      return null;
    }
  }
  return amendments;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

function normalizeExecutionPlanSchemaVersion(raw: unknown): number | null {
  if (raw === undefined) return CURRENT_EXECUTION_PLAN_SCHEMA_VERSION;
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < 1 ||
    raw > CURRENT_EXECUTION_PLAN_SCHEMA_VERSION
  ) return null;
  return CURRENT_EXECUTION_PLAN_SCHEMA_VERSION;
}

function prunePlans(workspaceDir: string): void {
  const directory = ensurePlansDir(workspaceDir);
  const entries = fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ name, mtimeMs: fs.statSync(path.join(directory, name)).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const entry of entries.slice(MAX_PLANS)) {
    fs.rmSync(path.join(directory, entry.name), { force: true });
  }
}
