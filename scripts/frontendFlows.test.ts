import assert from "node:assert/strict";
import test from "node:test";
import {
  INITIAL_FRONTEND_FLOW_STATE,
  completionBlocked,
  transitionFrontendFlow,
  type FrontendFlowEvent,
  type FrontendFlowState,
} from "./fixtures/ws15FrontendFlowModel.js";

function run(events: FrontendFlowEvent[]): FrontendFlowState {
  return events.reduce(transitionFrontendFlow, INITIAL_FRONTEND_FLOW_STATE);
}

const approvedReviewedValidated: FrontendFlowEvent[] = [
  { type: "approve_plan" },
  { type: "request_amendment" },
  { type: "decide_amendment", decision: "approved" },
  { type: "start_child" },
  { type: "finish_child", revision: "rev-1" },
  { type: "review_change_set", revision: "rev-1", decision: "approve" },
  { type: "validation_passed" },
];

test("plan approval and amendment gate isolated execution", () => {
  assert.throws(() => run([{ type: "start_child" }]), /plan approval/i);
  const pending = run([{ type: "approve_plan" }, { type: "request_amendment" }]);
  assert.equal(completionBlocked(pending), true);
  assert.throws(() => transitionFrontendFlow(pending, { type: "start_child" }), /amendment/i);
  const rejected = transitionFrontendFlow(pending, { type: "decide_amendment", decision: "rejected" });
  assert.equal(transitionFrontendFlow(rejected, { type: "start_child" }).child, "running");
});

test("isolated child produces an exact-revision reviewable ChangeSet", () => {
  const ready = run(approvedReviewedValidated.slice(0, 5));
  assert.equal(ready.changeSet, "ready_for_review");
  assert.throws(() => transitionFrontendFlow(ready, { type: "review_change_set", revision: "stale", decision: "approve" }), /stale/i);
  assert.equal(transitionFrontendFlow(ready, { type: "review_change_set", revision: "rev-1", decision: "request_revision" }).changeSet, "needs_revision");
});

test("validation failure blocks integration and preserves the failed state", () => {
  const reviewed = run(approvedReviewedValidated.slice(0, 6));
  const failed = transitionFrontendFlow(reviewed, { type: "validation_failed" });
  assert.equal(completionBlocked(failed), true);
  assert.throws(() => transitionFrontendFlow(failed, { type: "integrate_change_set", revision: "rev-1" }), /validation/i);
  const recovered = transitionFrontendFlow(failed, { type: "validation_passed" });
  assert.equal(completionBlocked(recovered), true);
  const integrated = transitionFrontendFlow(recovered, { type: "integrate_change_set", revision: "rev-1" });
  assert.equal(integrated.changeSet, "applied");
  assert.equal(completionBlocked(integrated), false);
});

test("rollback conflict refuses silent overwrite until explicitly resolved", () => {
  const applied = run([...approvedReviewedValidated, { type: "integrate_change_set", revision: "rev-1" }]);
  const conflict = transitionFrontendFlow(applied, { type: "request_rollback", conflict: true });
  assert.equal(conflict.rollback, "conflicted");
  assert.equal(completionBlocked(conflict), true);
  assert.equal(transitionFrontendFlow(conflict, { type: "resolve_rollback_conflict" }).rollback, "rolled_back");
});

test("PR publish and offline patch export stay bound to revision and digest", () => {
  const applied = run([...approvedReviewedValidated, { type: "integrate_change_set", revision: "rev-1" }]);
  assert.throws(() => transitionFrontendFlow(applied, { type: "prepare_delivery", revision: "stale", digest: "digest-1" }), /revision/i);
  const prepared = transitionFrontendFlow(applied, { type: "prepare_delivery", revision: "rev-1", digest: "digest-1" });
  assert.throws(() => transitionFrontendFlow(prepared, { type: "approve_delivery", digest: "stale" }), /digest/i);
  const approved = transitionFrontendFlow(prepared, { type: "approve_delivery", digest: "digest-1" });
  assert.equal(transitionFrontendFlow(approved, { type: "publish_delivery", digest: "digest-1" }).delivery, "published");
  assert.equal(transitionFrontendFlow(applied, { type: "export_patch", revision: "rev-1", digest: "bundle-1" }).delivery, "patch_exported");
});
