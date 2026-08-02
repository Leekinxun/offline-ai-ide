import type { ExecutionPlan } from "../chat/executionPlans.js";
import type { AgentMode } from "./types.js";

export interface ModeCapabilityDecision {
  allowed: boolean;
  reason?: string;
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
    return denied("Review mode is read-only and cannot modify workspace state");
  }

  if (!executionPlan) return { allowed: true };
  if (INSPECTION_TOOLS.has(toolName)) return { allowed: true };

  if (toolName === "write_file" || toolName === "edit_file") {
    const target = typeof input.path === "string" ? normalizePath(input.path) : "";
    const allowed = executionPlan.files.some((entry) => scopeContains(entry, target));
    return allowed
      ? { allowed: true }
      : denied(
          `Execution plan scope violation: ${target || "missing path"} is not in the approved file scope`,
          true
        );
  }

  if (toolName === "bash") {
    const command = typeof input.command === "string" ? input.command.trim() : "";
    if (executionPlan.verificationCommands.includes(command)) return { allowed: true };
    const inspection = evaluateInspectionCommand(command);
    return inspection.allowed
      ? inspection
      : denied(
          "Execution plan scope violation: shell commands must be read-only inspection commands or an approved verification command",
          true
        );
  }

  return denied(
    `Execution plan scope violation: ${toolName} is not part of the approved execution capability set`,
    true
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

function denied(reason: string, requiresReplan = false): ModeCapabilityDecision {
  return { allowed: false, reason, ...(requiresReplan ? { requiresReplan: true } : {}) };
}
