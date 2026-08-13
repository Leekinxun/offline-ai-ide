import { isCurrentChangeSet, type ChangeSet, type ChangeSetDecision, type ChangeSetStatus } from "../hooks/changeSetContract";

export type { ChangeSetDecision } from "../hooks/changeSetContract";
export type ChangeSetStatusTone = "neutral" | "working" | "success" | "warning" | "danger";

const INTEGRATION_DECISIONS = new Set<ChangeSetDecision>(["apply", "merge", "cherry_pick"]);
const SAFE_RECOVERY_STATUSES = new Set<ChangeSetStatus>(["ready_for_review", "needs_revision", "needs_attention"]);

export function isChangeSetIntegrable(changeSet: ChangeSet): boolean {
  return isCurrentChangeSet(changeSet) && changeSet.status === "ready_for_review";
}

export function changeSetRecoveryDecisions(changeSet: ChangeSet): ChangeSetDecision[] {
  return isCurrentChangeSet(changeSet) && SAFE_RECOVERY_STATUSES.has(changeSet.status) ? ["request_revision", "reject"] : [];
}

export function changeSetDecisionAllowed(changeSet: ChangeSet, decision: ChangeSetDecision): boolean {
  if (INTEGRATION_DECISIONS.has(decision)) return isChangeSetIntegrable(changeSet);
  return changeSetRecoveryDecisions(changeSet).includes(decision);
}

export function changeSetStatusTone(status: ChangeSetStatus): ChangeSetStatusTone {
  if (status === "applied") return "success";
  if (status === "failed" || status === "rejected") return "danger";
  if (status === "needs_attention" || status === "needs_revision") return "warning";
  if (status === "running" || status === "applying") return "working";
  return "neutral";
}
