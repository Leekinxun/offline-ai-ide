import type { ExecutionPlan } from "../chat/executionPlans.js";

/** The runtime authority under which Code mode is operating. */
export type CodeExecutionContract =
  | { kind: "direct_code" }
  | { kind: "approved_plan"; plan: ExecutionPlan };

export interface AmendmentRequiredDecision {
  allowed: false;
  decision: "amendment_required";
  amendmentRequired: true;
  /** @deprecated Use amendmentRequired. Retained for existing callers. */
  requiresReplan: true;
  reason: string;
}

export function resolveCodeExecutionContract(executionPlan?: ExecutionPlan): CodeExecutionContract {
  return executionPlan
    ? { kind: "approved_plan", plan: executionPlan }
    : { kind: "direct_code" };
}

export function amendmentRequired(reason: string): AmendmentRequiredDecision {
  return {
    allowed: false,
    decision: "amendment_required",
    amendmentRequired: true,
    requiresReplan: true,
    reason,
  };
}

export function codeModeInstruction(contract: CodeExecutionContract): string {
  if (contract.kind === "direct_code") {
    return "Work directly on the user's request. You may inspect, edit, and validate workspace changes without a Plan artifact. Keep changes focused on the request.";
  }

  return "Execute only the approved Plan artifact supplied below. Modify only its declared file scope and run only its declared verification commands. If an amendment-required decision occurs because the request or a tool call exceeds that scope, call request_plan_amendment with the reason and any requested files or verification commands instead of stopping or restarting.";
}
