export type Decision = "pending" | "approved" | "rejected";
export type ChangeSetState = "none" | "ready_for_review" | "reviewed" | "needs_revision" | "applied";
export type ValidationState = "idle" | "failed" | "passed";
export type RollbackState = "idle" | "conflicted" | "rolled_back";
export type DeliveryState = "idle" | "prepared" | "approved" | "published" | "patch_exported";

export interface FrontendFlowState {
  plan: Decision;
  amendment: Decision | "none";
  child: "idle" | "running" | "completed";
  changeSet: ChangeSetState;
  revision?: string;
  validation: ValidationState;
  rollback: RollbackState;
  delivery: DeliveryState;
  deliveryDigest?: string;
}

export type FrontendFlowEvent =
  | { type: "approve_plan" }
  | { type: "request_amendment" }
  | { type: "decide_amendment"; decision: "approved" | "rejected" }
  | { type: "start_child" }
  | { type: "finish_child"; revision: string }
  | { type: "review_change_set"; revision: string; decision: "approve" | "request_revision" }
  | { type: "validation_failed" }
  | { type: "validation_passed" }
  | { type: "integrate_change_set"; revision: string }
  | { type: "request_rollback"; conflict: boolean }
  | { type: "resolve_rollback_conflict" }
  | { type: "prepare_delivery"; revision: string; digest: string }
  | { type: "approve_delivery"; digest: string }
  | { type: "publish_delivery"; digest: string }
  | { type: "export_patch"; revision: string; digest: string };

export const INITIAL_FRONTEND_FLOW_STATE: FrontendFlowState = {
  plan: "pending",
  amendment: "none",
  child: "idle",
  changeSet: "none",
  validation: "idle",
  rollback: "idle",
  delivery: "idle",
};

function requireState(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function transitionFrontendFlow(state: FrontendFlowState, event: FrontendFlowEvent): FrontendFlowState {
  switch (event.type) {
    case "approve_plan":
      requireState(state.plan === "pending", "plan is not awaiting approval");
      return { ...state, plan: "approved" };
    case "request_amendment":
      requireState(state.plan === "approved" && state.child !== "completed", "amendment is outside the active plan window");
      return { ...state, amendment: "pending" };
    case "decide_amendment":
      requireState(state.amendment === "pending", "amendment is not pending");
      return { ...state, amendment: event.decision };
    case "start_child":
      requireState(state.plan === "approved" && state.amendment !== "pending", "plan approval or amendment decision is missing");
      return { ...state, child: "running" };
    case "finish_child":
      requireState(state.child === "running", "isolated child is not running");
      return { ...state, child: "completed", changeSet: "ready_for_review", revision: event.revision };
    case "review_change_set":
      requireState(state.changeSet === "ready_for_review", "ChangeSet is not reviewable");
      requireState(state.revision === event.revision, "review revision is stale");
      return { ...state, changeSet: event.decision === "approve" ? "reviewed" : "needs_revision" };
    case "validation_failed":
      requireState(state.changeSet === "reviewed", "validation requires a reviewed ChangeSet");
      return { ...state, validation: "failed" };
    case "validation_passed":
      requireState(state.changeSet === "reviewed", "validation requires a reviewed ChangeSet");
      return { ...state, validation: "passed" };
    case "integrate_change_set":
      requireState(state.changeSet === "reviewed" && state.validation === "passed", "review and validation must pass before integration");
      requireState(state.revision === event.revision, "integration revision is stale");
      return { ...state, changeSet: "applied" };
    case "request_rollback":
      requireState(state.changeSet === "applied", "no applied ChangeSet is available for rollback");
      return { ...state, rollback: event.conflict ? "conflicted" : "rolled_back" };
    case "resolve_rollback_conflict":
      requireState(state.rollback === "conflicted", "rollback has no unresolved conflict");
      return { ...state, rollback: "rolled_back" };
    case "prepare_delivery":
      requireState(state.changeSet === "applied" && state.revision === event.revision, "delivery must bind the applied revision");
      return { ...state, delivery: "prepared", deliveryDigest: event.digest };
    case "approve_delivery":
      requireState(state.delivery === "prepared" && state.deliveryDigest === event.digest, "delivery approval digest is stale");
      return { ...state, delivery: "approved" };
    case "publish_delivery":
      requireState(state.delivery === "approved" && state.deliveryDigest === event.digest, "publish digest is stale or unapproved");
      return { ...state, delivery: "published" };
    case "export_patch":
      requireState(state.changeSet === "applied" && state.revision === event.revision, "patch export revision is stale");
      return { ...state, delivery: "patch_exported", deliveryDigest: event.digest };
  }
}

export function completionBlocked(state: FrontendFlowState): boolean {
  return state.plan !== "approved"
    || state.amendment === "pending"
    || state.child === "running"
    || state.changeSet !== "applied"
    || state.validation === "failed"
    || state.rollback === "conflicted";
}
