import { Router } from "express";
import type { UserSession } from "../auth/sessionManager.js";
import { createCheckpoint, getCheckpointStorageStats, listCheckpoints, pruneCheckpointBlobs, readCheckpointSettings, restoreCheckpoint, updateCheckpointRetention, verifyCheckpointBlobs } from "../chat/checkpoints.js";
import { canWriteActiveWorkspace } from "../team/sessionBridge.js";
import { listFileMutations, rollbackFileMutations } from "../files/mutationRegistry.js";
import { applyChangeSetDecision, ChangeSetCollaborationGateError, ChangeSetIntegrationConflictError, ChangeSetLockRecoveryRequiredError, ChangeSetReviewGateError, getChangeSet, listChangeSets, preflightChangeSetDecision, recoverInterruptedChangeSetWithOutcome, type ChangeSet, type ChangeSetDecision } from "../chat/changeSets.js";
import { listChangeSetReviewRuns, scheduleChangeSetReview } from "../chat/changeSetReviewRun.js";
import { buildReviewArtifact, toSarifReviewArtifact } from "../artifacts/reviewArtifact.js";
import { EVIDENCE_BUNDLE_MEDIA_TYPE, verifyEvidenceBundle } from "../artifacts/evidenceBundle.js";
import { EvidenceBundleExportStore } from "../artifacts/evidenceBundleStore.js";

export const checkpointsRouter = Router();

function workspace(req: unknown): string {
  return ((req as any).userSession as UserSession).workspaceDir;
}
function writable(req: unknown, res: any): boolean { if (canWriteActiveWorkspace((req as any).userSession as UserSession)) return true; res.status(403).json({ error: "Workspace is read-only" }); return false; }
function strings(value: unknown): string[] | undefined { return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 200) ? value : undefined; }
function publicMutation(mutation: ReturnType<typeof listFileMutations>[number]) { const { workspaceDir: _workspaceDir, preimageContent: _preimageContent, preimageBlob: _preimageBlob, postimageBlob: _postimageBlob, hunks, ...metadata } = mutation; return { ...metadata, hunks: hunks?.map(({ preimage: _preimage, postimage: _postimage, ...hunk }) => hunk) }; }
function publicChangeSet(changeSet: ChangeSet) { const { patchBlob: _patchBlob, patchManifest: _patchManifest, ...metadata } = changeSet; const recovery = changeSet.status === "applying" ? { state: "interrupted", actionAvailable: true, inspectionRequired: true } : changeSet.status === "failed" ? { state: "failed", actionAvailable: false, inspectionRequired: true } : { state: "not_required", actionAvailable: false, inspectionRequired: false }; return { ...metadata, recovery, patch: { sha256: changeSet.patchSha256, bytes: undefined, available: Boolean(changeSet.patchBlob), files: changeSet.patchManifest?.map(({ path, sha256, kind }) => ({ path, sha256, kind })) || [] } }; }
function changeSetError(error: unknown): { status: number; error: string; code?: string; blockingFindings?: unknown; collaborationConflicts?: unknown } { const message = error instanceof Error ? error.message : "Change set request failed"; if (error instanceof ChangeSetLockRecoveryRequiredError) return { status: 409, error: message, code: error.code }; if (error instanceof ChangeSetCollaborationGateError) return { status: 409, error: message, collaborationConflicts: error.collaborationConflicts }; if (error instanceof ChangeSetReviewGateError) return { status: 409, error: message, blockingFindings: error.blockingFindings }; if (message === "Change set not found") return { status: 404, error: message }; if (message === "Invalid change set id") return { status: 400, error: message }; if (message.startsWith("Change set preflight failed")) return { status: 409, error: message }; return { status: 400, error: message }; }
function decisionActor(req: unknown) { const session = (req as any).userSession as UserSession; return { id: session.username, isAdmin: session.isAdmin === true }; }

checkpointsRouter.get("/", (req, res) => {
  const workspaceDir = workspace(req); res.json({ checkpoints: listCheckpoints(workspaceDir), storage: getCheckpointStorageStats(workspaceDir) });
});

checkpointsRouter.get("/mutations", (req, res) => {
  const query = req.query as Record<string, unknown>;
  const valid = ["runId", "toolCallId", "path"].every((key) => query[key] === undefined || typeof query[key] === "string");
  if (!valid) return res.status(400).json({ error: "Mutation filters must be strings" });
  res.json({ mutations: listFileMutations(workspace(req), { runId: query.runId as string | undefined, toolCallId: query.toolCallId as string | undefined, path: query.path as string | undefined }).map(publicMutation) });
});

checkpointsRouter.post("/mutations/rollback", (req, res) => {
  if (!writable(req, res)) return;
  const ids = req.body?.ids === undefined ? undefined : strings(req.body.ids); const hunkIds = req.body?.hunkIds === undefined ? undefined : strings(req.body.hunkIds);
  if ((req.body?.ids !== undefined && !ids) || (req.body?.hunkIds !== undefined && !hunkIds) || (req.body?.strategy !== undefined && req.body.strategy !== "refuse" && req.body.strategy !== "skip-conflicts")) return res.status(400).json({ error: "Invalid rollback selection" });
  const selected = { ...(typeof req.body?.runId === "string" ? { runId: req.body.runId } : {}), ...(typeof req.body?.toolCallId === "string" ? { toolCallId: req.body.toolCallId } : {}), ...(typeof req.body?.path === "string" ? { path: req.body.path } : {}), ...(ids ? { ids } : {}), ...(hunkIds ? { hunkIds } : {}) };
  if (!ids && !selected.runId && !selected.toolCallId && !selected.path) return res.status(400).json({ error: "Select a mutation, run, tool call, or file" });
  if (ids && ids.some((id) => !listFileMutations(workspace(req)).some((mutation) => mutation.id === id))) return res.status(400).json({ error: "Invalid mutation id" });
  const result = rollbackFileMutations(workspace(req), selected, { strategy: req.body?.strategy });
  if (result.conflicts.length && req.body?.strategy !== "skip-conflicts") return res.status(409).json({ error: "Rollback conflicts detected; no files were changed", ...result });
  res.json(result);
});

checkpointsRouter.post("/verify", (req, res) => { const id = typeof req.body?.checkpointId === "string" ? req.body.checkpointId : undefined; res.json({ verification: verifyCheckpointBlobs(workspace(req), id) }); });
checkpointsRouter.post("/repair", (req, res) => { if (!writable(req, res)) return; const apply = req.body?.apply === true; res.json({ dryRun: !apply, removed: pruneCheckpointBlobs(workspace(req), { dryRun: !apply }) }); });
checkpointsRouter.get("/retention", (req, res) => { const workspaceDir = workspace(req); res.json({ settings: readCheckpointSettings(workspaceDir), storage: getCheckpointStorageStats(workspaceDir) }); });
checkpointsRouter.put("/retention", (req, res) => { if (!writable(req, res)) return; try { const { maxCheckpoints, dryRun } = req.body || {}; if (dryRun !== undefined && typeof dryRun !== "boolean") return res.status(400).json({ error: "dryRun must be boolean" }); res.json(updateCheckpointRetention(workspace(req), { maxCheckpoints, ...(dryRun === true ? { dryRun } : {}) })); } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Invalid retention policy" }); } });

checkpointsRouter.get("/change-sets", (req, res) => { try { res.json({ changeSets: listChangeSets(workspace(req)).map(publicChangeSet) }); } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Failed to list change sets" }); } });
checkpointsRouter.get("/change-sets/:id", (req, res) => { try { res.json({ changeSet: publicChangeSet(getChangeSet(workspace(req), req.params.id)) }); } catch (error) { const response = changeSetError(error); res.status(response.status).json({ error: response.error }); } });
checkpointsRouter.get("/change-sets/:id/review-runs", (req, res) => { try { getChangeSet(workspace(req), req.params.id); res.json({ reviewRuns: listChangeSetReviewRuns(workspace(req), req.params.id) }); } catch (error) { const response = changeSetError(error); res.status(response.status).json({ error: response.error }); } });
checkpointsRouter.get("/change-sets/:id/review-artifact", (req, res) => { try { const revision = typeof req.query.revision === "string" ? req.query.revision : undefined; const artifact = buildReviewArtifact(workspace(req), req.params.id, revision); if (req.query.format === "sarif") return res.type("application/sarif+json").json(toSarifReviewArtifact(artifact)); if (req.query.format !== undefined && req.query.format !== "crewforge") return res.status(400).json({ error: "format must be crewforge or sarif" }); res.type("application/vnd.crewforge.review.v1+json").json(artifact); } catch (error) { const response = changeSetError(error); res.status(response.status).json({ error: response.error }); } });
checkpointsRouter.post("/change-sets/:id/bundle-exports", (req, res) => { if (!writable(req, res)) return; try { const revision = typeof req.body?.revision === "string" ? req.body.revision : undefined; const exportRecord = new EvidenceBundleExportStore(workspace(req)).schedule(req.params.id, revision, { includeTrace: req.body?.includeTrace, includeTestOutput: req.body?.includeTestOutput, requireSignature: req.body?.requireSignature }); res.status(202).json({ export: exportRecord }); } catch (error) { const response = changeSetError(error); res.status(response.status).json({ error: response.error }); } });
checkpointsRouter.post("/change-sets/:id/review", (req, res) => { if (!writable(req, res)) return; try { const run = scheduleChangeSetReview(workspace(req), req.params.id, decisionActor(req).id || "authenticated-user", "review"); res.status(202).json({ reviewRun: run }); } catch (error) { const response = changeSetError(error); res.status(response.status).json({ error: response.error }); } });
checkpointsRouter.post("/change-sets/:id/reverify", (req, res) => { if (!writable(req, res)) return; try { const run = scheduleChangeSetReview(workspace(req), req.params.id, decisionActor(req).id || "authenticated-user", "reverify"); res.status(202).json({ reviewRun: run }); } catch (error) { const response = changeSetError(error); res.status(response.status).json({ error: response.error }); } });
checkpointsRouter.post("/change-sets/:id/preflight", (req, res) => { const decision = req.body?.decision as ChangeSetDecision; if (!["apply", "cherry_pick", "merge", "reject", "request_revision"].includes(decision)) return res.status(400).json({ error: "Invalid change set decision" }); try { res.json({ preflight: preflightChangeSetDecision(workspace(req), req.params.id, decision, decisionActor(req)) }); } catch (error) { const response = changeSetError(error); res.status(response.status).json({ error: response.error, ...(response.blockingFindings ? { blockingFindings: response.blockingFindings } : {}) }); } });
checkpointsRouter.post("/change-sets/:id/decision", (req, res) => { if (!writable(req, res)) return; const decision = req.body?.decision as ChangeSetDecision; if (!["apply", "cherry_pick", "merge", "reject", "request_revision"].includes(decision)) return res.status(400).json({ error: "Invalid change set decision" }); try { const result = applyChangeSetDecision(workspace(req), req.params.id, decision, decisionActor(req)); res.json({ changeSet: publicChangeSet(result.changeSet), preflight: result.preflight }); } catch (error) { const response = changeSetError(error); res.status(response.status).json({ error: response.error, ...(response.code ? { code: response.code, recovery: { state: "manual_recovery", transactionStatus: "lock_stale", manualRecoveryRequired: true } } : {}), ...(response.blockingFindings ? { blockingFindings: response.blockingFindings } : {}), ...(response.collaborationConflicts ? { collaborationConflicts: response.collaborationConflicts } : {}) }); } });
checkpointsRouter.post("/change-sets/:id/recover", (req, res) => {
  if (!writable(req, res)) return;
  try {
    const result = recoverInterruptedChangeSetWithOutcome(workspace(req), req.params.id);
    res.json({ changeSet: publicChangeSet(result.changeSet), recovery: result.recovery });
  } catch (error) {
    if (error instanceof ChangeSetIntegrationConflictError) return res.status(409).json({ error: error.message, code: error.code, recovery: { state: "integration_in_progress", transactionStatus: "live", manualRecoveryRequired: false } });
    if (error instanceof ChangeSetLockRecoveryRequiredError) return res.status(409).json({ error: error.message, code: error.code, recovery: { state: "manual_recovery", transactionStatus: "lock_stale", manualRecoveryRequired: true } });
    const message = error instanceof Error ? error.message : "Change set recovery failed";
    if (message === "Invalid change set id") return res.status(400).json({ error: message });
    if (message.includes("ENOENT") || message.includes("no such file") || message === "Change set not found") return res.status(404).json({ error: "Change set not found" });
    if (message.includes("manual recovery") || message.includes("transaction") || message.includes("transaction record")) return res.status(409).json({ error: "Interrupted integration requires manual recovery; inspect the parent repository state", recovery: { state: "manual_recovery", transactionStatus: "interrupted", manualRecoveryRequired: true } });
    res.status(400).json({ error: "Change set recovery failed" });
  }
});

checkpointsRouter.get("/bundle-exports", (req, res) => { try { res.json({ exports: new EvidenceBundleExportStore(workspace(req)).list() }); } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Failed to list evidence bundle exports" }); } });
checkpointsRouter.get("/bundle-exports/:id/download", (req, res) => { try { const bytes = new EvidenceBundleExportStore(workspace(req)).download(req.params.id); res.setHeader("Content-Type", EVIDENCE_BUNDLE_MEDIA_TYPE); res.setHeader("Content-Disposition", `attachment; filename="crewforge-${req.params.id}.cfbundle"`); res.send(bytes); } catch (error) { const message = error instanceof Error ? error.message : "Failed to download evidence bundle"; res.status(message.includes("not found") ? 404 : message.includes("not ready") ? 409 : 400).json({ error: message }); } });
checkpointsRouter.get("/bundle-exports/:id", (req, res) => { try { res.json({ export: new EvidenceBundleExportStore(workspace(req)).get(req.params.id) }); } catch (error) { const message = error instanceof Error ? error.message : "Failed to load evidence bundle export"; res.status(message.includes("not found") ? 404 : 400).json({ error: message }); } });
checkpointsRouter.post("/bundles/verify", (req, res) => { const value = req.body?.bundleBase64; if (typeof value !== "string" || value.length > 48 * 1024 * 1024 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || Buffer.from(value, "base64").toString("base64") !== value) return res.status(400).json({ error: "bundleBase64 must be canonical base64" }); res.json({ verification: verifyEvidenceBundle(workspace(req), Buffer.from(value, "base64")) }); });

checkpointsRouter.post("/create", (req, res) => {
  if (!canWriteActiveWorkspace((req as any).userSession as UserSession)) {
    return res.status(403).json({ error: "Workspace is read-only" });
  }
  try {
    const checkpoint = createCheckpoint(workspace(req), {
      label: typeof req.body?.label === "string" ? req.body.label : undefined,
      conversationId:
        typeof req.body?.conversationId === "string" ? req.body.conversationId : undefined,
      runId: typeof req.body?.runId === "string" ? req.body.runId : undefined,
      kind: "manual",
    });
    res.status(201).json({ checkpoint });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Checkpoint failed" });
  }
});

checkpointsRouter.post("/:id/restore", (req, res) => {
  if (!canWriteActiveWorkspace((req as any).userSession as UserSession)) {
    return res.status(403).json({ error: "Workspace is read-only" });
  }
  try {
    const checkpoint = restoreCheckpoint(workspace(req), req.params.id);
    res.json({ restored: true, checkpoint });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Restore failed";
    res.status(message === "Checkpoint not found" ? 404 : 400).json({ error: message });
  }
});
