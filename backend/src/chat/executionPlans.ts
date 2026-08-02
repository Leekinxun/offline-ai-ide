import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PLAN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_PLANS = 100;

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

export interface ExecutionPlan extends ExecutionPlanInput {
  id: string;
  conversationId: string;
  planRunId: string;
  status: ExecutionPlanStatus;
  createdAt: number;
  approvedAt?: number;
  updatedAt: number;
  executionRunIds: string[];
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
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    normalized.split("/").includes("..") ||
    normalized.startsWith(".history/") ||
    normalized.startsWith(".git/")
  ) {
    throw new Error(`Invalid plan file scope: ${value}`);
  }
  return normalized.slice(0, 1000);
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
    id: `plan-${now}-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`,
    conversationId: context.conversationId,
    planRunId: context.planRunId,
    ...input,
    status: "approved",
    createdAt: now,
    approvedAt: now,
    updatedAt: now,
    executionRunIds: [],
  };
  writeExecutionPlan(workspaceDir, plan);
  prunePlans(workspaceDir);
  return plan;
}

export function readExecutionPlan(workspaceDir: string, planId: string): ExecutionPlan {
  const parsed = JSON.parse(fs.readFileSync(planPath(workspaceDir, planId), "utf8"));
  if (!parsed || typeof parsed !== "object" || parsed.id !== planId) {
    throw new Error("Execution plan is invalid");
  }
  return parsed as ExecutionPlan;
}

export function findLatestApprovedExecutionPlan(
  workspaceDir: string,
  conversationId: string
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
      plan.conversationId === conversationId &&
      (plan.status === "approved" || plan.status === "in_progress")
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

function writeExecutionPlan(workspaceDir: string, plan: ExecutionPlan): void {
  const target = planPath(workspaceDir, plan.id);
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, target);
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
