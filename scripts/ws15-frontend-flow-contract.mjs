import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contracts = [
  { id: "plan-approval-control", file: "frontend/src/components/ToolApprovalCard.tsx", tokens: ['request.name === "submit_plan"', '"chat.approval.approvePlan"', '"chat.approval.rejectPlan"', 'onRespond(request.approvalId, "allow_once")', 'onRespond(request.approvalId, "deny")'] },
  { id: "plan-amendment-api", file: "frontend/src/hooks/useChat.ts", tokens: ["decidePlanAmendment", "/amendments/", 'decision: "approved" | "rejected"'] },
  { id: "plan-amendment-controls", file: "frontend/src/components/ChangeSummary.tsx", tokens: ["pendingAmendments", "onPlanAmendmentDecision", '"approved"', '"rejected"'] },
  { id: "isolated-changeset-review", file: "frontend/src/components/CheckpointPanel.tsx", tokens: ["startChangeSetReview", "decideChangeSet", "recoverChangeSet", 'action.kind === "integrate"'] },
  { id: "needs-attention-recovery", file: "frontend/src/components/CheckpointPanel.tsx", tokens: ['changeSet.status === "needs_attention"', "changeSetRecoveryDecisions", "changeSetDecisionAllowed", "recovery.needsAttentionDescription"] },
  { id: "needs-attention-integration-gate", file: "frontend/src/components/changeSetRecoveryPolicy.ts", tokens: ['changeSet.status === "ready_for_review"', '["request_revision", "reject"]', "INTEGRATION_DECISIONS", "isCurrentChangeSet"] },
  { id: "changeset-v3-contract", file: "frontend/src/hooks/changeSetContract.ts", tokens: ["schemaVersion: 3", "captureIntegritySha256", "transitionVersion", "transitionIntegritySha256", "changeSetReviewRevision", "changeSetPatchContentSha256"] },
  { id: "validation-failure", file: "frontend/src/components/ChangeSummary.tsx", tokens: ['"validation_failed"', "summary.errorCount", 'className={check.status === "passed" ? "" : "warning"}'] },
  { id: "rollback-conflict", file: "frontend/src/components/CheckpointPanel.tsx", tokens: ['action.kind === "rollback"', "recovery.rollbackFailed", "role=\"alert\""] },
  { id: "verified-local-commit", file: "frontend/src/components/GitLocalPanel.tsx", tokens: ['"commit_change_set"', "selectedReadyChangeSet", "isChangeSetIntegrable", "expectedRefSha", "controller.prepare"] },
  { id: "provider-publish-binding", file: "frontend/src/components/ProviderDeliveryPanel.tsx", tokens: ["selectedChangeSet.captureIntegritySha256", "changeSetPatchContentSha256", "evidence.verificationDigest", "approvePublication", "controller.publish"] },
  { id: "offline-patch-binding", file: "frontend/src/components/OfflineBundlePanel.tsx", tokens: ["changeSetReviewRevision", "currentSelection", "controller.createExport", "controller.verify", "bundle-revision-lock"] },
  { id: "nested-modal-keyboard", file: "frontend/src/components/useModalDialogFocus.ts", tokens: ["claimModalEscape", "querySelectorAll<HTMLElement>", "document.activeElement", ".focus()"] },
  { id: "compact-drawer-background", file: "frontend/src/App.tsx", tokens: ["data-compact-modal-background", "compactModalDrawerOpen", "inert"] },
  { id: "file-tree-roving", file: "frontend/src/components/FileTree.tsx", tokens: ["resolveVisibleTreeIndex", 'role="tree"', 'role="treeitem"', "ArrowLeft", "ArrowRight", "tabIndex"] },
];

const failures = [];
for (const contract of contracts) {
  let source = "";
  try { source = fs.readFileSync(path.join(root, contract.file), "utf8"); }
  catch { failures.push(`[${contract.id}] missing ${contract.file}`); continue; }
  for (const token of contract.tokens) if (!source.includes(token)) failures.push(`[${contract.id}] ${contract.file} missing ${JSON.stringify(token)}`);
}

if (failures.length) {
  process.stderr.write(`WS-15 frontend flow contract found ${failures.length} gap(s):\n${failures.map((item) => `- ${item}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`CrewForge WS-15 frontend flow contract passed (${contracts.length} surfaces).\n`);
}
