import type { ExecutionPlan } from "../chat/executionPlans.js";
import type { AgentMode } from "./types.js";
import {
  amendmentRequired,
  resolveCodeExecutionContract,
} from "./executionContract.js";

export interface ModeCapabilityDecision {
  allowed: boolean;
  reason?: string;
  decision?: "amendment_required";
  amendmentRequired?: boolean;
  requiresReplan?: boolean;
}

const INSPECTION_TOOLS = new Set([
  "compress",
  "memory_read",
  "skill_load",
  "read_file",
  "TodoWrite",
]);

export function evaluateModeCapability(options: {
  mode: AgentMode;
  toolName: string;
  input: Record<string, unknown>;
  executionPlan?: ExecutionPlan;
}): ModeCapabilityDecision {
  const { mode, toolName, input, executionPlan } = options;

  if (mode === "ask") {
    return INSPECTION_TOOLS.has(toolName)
      ? { allowed: true }
      : denied("Ask mode is limited to inspection and explanation");
  }

  if (mode === "plan") {
    if (INSPECTION_TOOLS.has(toolName) || toolName === "submit_plan") return { allowed: true };
    if (toolName === "bash") return evaluateInspectionCommand(input.command);
    return denied("Plan mode cannot modify files, execute side-effecting tools, or persist task state");
  }

  if (mode === "review") {
    if (INSPECTION_TOOLS.has(toolName)) return { allowed: true };
    if (toolName === "bash") return evaluateInspectionCommand(input.command);
    if (toolName === "report_review_finding") return { allowed: true };
    return denied("Review mode is read-only and cannot modify workspace state");
  }

  if (toolName === "report_review_finding") {
    return denied("report_review_finding is only available in Review mode");
  }

  const contract = resolveCodeExecutionContract(executionPlan);
  if (toolName === "request_plan_amendment" && contract.kind === "direct_code") {
    return denied("Plan-amendment requests are only available while executing an approved plan");
  }
  if (contract.kind === "direct_code") return { allowed: true };
  const approvedPlan = contract.plan;
  if (INSPECTION_TOOLS.has(toolName)) return { allowed: true };
  if (toolName === "submit_completion_evidence") return { allowed: true };
  if (toolName === "request_plan_amendment") return { allowed: true };

  if (toolName === "write_file" || toolName === "edit_file") {
    const target = typeof input.path === "string" ? normalizePath(input.path) : "";
    const allowed = approvedPlan.files.some((entry) => scopeContains(entry, target));
    return allowed
      ? { allowed: true }
      : amendmentRequired(
          `Execution plan scope violation: ${target || "missing path"} is not in the approved file scope`
        );
  }

  if (toolName === "bash") {
    const command = typeof input.command === "string" ? input.command.trim() : "";
    if (approvedPlan.verificationCommands.includes(command)) return { allowed: true };
    const inspection = evaluateInspectionCommand(command);
    return inspection.allowed
      ? inspection
      : amendmentRequired(
          "Execution plan scope violation: shell commands must be read-only inspection commands or an approved verification command"
        );
  }

  return amendmentRequired(
    `Execution plan scope violation: ${toolName} is not part of the approved execution capability set`
  );
}

export function evaluateInspectionCommand(commandValue: unknown): ModeCapabilityDecision {
  const command = typeof commandValue === "string" ? commandValue.trim() : "";
  if (!command) return denied("Inspection command is empty");
  if (/\n|\r|[;&|><`]|\$\(/.test(command)) {
    return denied("Inspection commands cannot contain shell composition or redirection");
  }
  if (/\bfind\b.*\s-(?:delete|exec|execdir|ok|okdir)\b/.test(command)) {
    return denied("Mutating find actions are unavailable in read-only modes");
  }
  const allowed = [
    /^(?:rg|grep)(?:\s|$)/,
    /^sed\s+-n(?:\s|$)/,
    /^(?:ls|cat|head|tail|wc|pwd)(?:\s|$)/,
    /^find(?:\s|$)/,
    /^git\s+(?:status|diff|show|log|rev-parse|ls-files|branch\s+--show-current)(?:\s|$)/,
  ].some((pattern) => pattern.test(command));
  return allowed
    ? { allowed: true }
    : denied("Only read-only repository inspection commands are available in this mode");
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function scopeContains(scopeValue: string, targetValue: string): boolean {
  const scope = normalizePath(scopeValue);
  const target = normalizePath(targetValue);
  return Boolean(scope && target && (scope === target || target.startsWith(`${scope}/`)));
}

function denied(reason: string): ModeCapabilityDecision {
  return { allowed: false, reason };
}
