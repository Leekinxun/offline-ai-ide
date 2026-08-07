import {
  findLatestApprovedExecutionPlan,
  type ExecutionPlan,
} from "./executionPlans.js";

export const PLAN_CODE_HANDOFF_PROMPT =
  "The user approved the execution plan. Switch to Code mode and execute the approved plan now. Complete the declared steps, stay within the approved file scope, and run the approved verification commands.";

export function resolvePlanCodeHandoff(options: {
  workspaceDir: string;
  conversationId: string;
  planRunId: string;
  finalStatus: "completed" | "failed" | "stopped";
}): ExecutionPlan | null {
  if (options.finalStatus !== "completed") return null;
  const plan = findLatestApprovedExecutionPlan(
    options.workspaceDir,
    options.conversationId
  );
  if (!plan || plan.status !== "approved" || plan.planRunId !== options.planRunId) {
    return null;
  }
  return plan;
}
