import { Router, type Request, type Response } from "express";
import {
  deleteConversation,
  conversationExists,
  forkConversation,
  listConversationSummaries,
  readConversationMessages,
} from "../chat/history.js";
import type { UserSession } from "../auth/sessionManager.js";
import { sessionManager } from "../auth/sessionManager.js";
import {
  hasActiveRunForConversation,
  listChildRuns,
  listRunSummaries,
  readRunRecord,
} from "../chat/runHistory.js";
import { findCheckpointForRun, restoreCheckpoint } from "../chat/checkpoints.js";
import { listFileMutations, rollbackFileMutations } from "../files/mutationRegistry.js";
import { canWriteActiveWorkspace } from "../team/sessionBridge.js";
import {
  createManagedWorktree,
  listManagedWorktrees,
  removeManagedWorktree,
} from "../chat/worktrees.js";
import { config } from "../config.js";
import {
  listSelectableModelNames,
  resolveSelectableModelName,
} from "../agent/agentProfiles.js";
import {
  readExecutionPlan,
  resolveExecutionPlanAmendment,
} from "../chat/executionPlans.js";
import { TraceStore, type CausalTraceEvent, type TraceEventKind } from "../chat/traceStore.js";
import { allowedReviewFindingTransitions, ReviewFindingStore, ReviewFindingVersionConflictError, type ReviewFindingFilter } from "../chat/reviewFindingStore.js";
import type { ReviewFindingLifecycle, ReviewSeverity } from "../chat/reviewFindings.js";
import {
  ContextPreferencesVersionConflictError,
  listContextManifests,
  readContextManifest,
  readContextPreferences,
  updateContextPreferences,
} from "../agent/contextManifestStore.js";
import { toContextManifestState } from "../agent/contextManifest.js";
import { getContextIndexAdapter } from "../agent/contextManifestIndex.js";
import { toSarifReviewFindings } from "../artifacts/reviewArtifact.js";
import "../indexing/repositoryIndex.js";

export const chatRouter = Router();

function getSessionWorkspace(req: unknown): string {
  return ((req as any).userSession as UserSession).workspaceDir;
}

function writable(req: unknown, res: any): boolean {
  if (canWriteActiveWorkspace((req as any).userSession as UserSession)) return true;
  res.status(403).json({ error: "Workspace is read-only" });
  return false;
}

function traceFilter(query: Record<string, unknown>): Partial<Pick<CausalTraceEvent, "runId" | "correlationId" | "kind">> | null {
  const text = (key: "runId" | "correlationId") => query[key] === undefined ? undefined : typeof query[key] === "string" && query[key].trim() ? query[key].trim() : null;
  const runId = text("runId"); const correlationId = text("correlationId");
  if (runId === null || correlationId === null) return null;
  const kind = query.kind;
  const validKinds: TraceEventKind[] = ["run", "agent", "model", "tool", "approval", "checkpoint", "validation", "git", "review", "error", "decision"];
  if (kind !== undefined && (typeof kind !== "string" || !validKinds.includes(kind as TraceEventKind))) return null;
  return { ...(runId ? { runId } : {}), ...(correlationId ? { correlationId } : {}), ...(kind ? { kind: kind as TraceEventKind } : {}) };
}

function page(value: unknown, fallback: number, max: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed <= max ? parsed : null;
}

function reviewFindingFilter(query: Record<string, unknown>): ReviewFindingFilter | null {
  const identifier = (key: "runId" | "conversationId" | "changeSetId" | "reviewRunId") => {
    const value = query[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) return null;
    return value;
  };
  const runId = identifier("runId");
  const conversationId = identifier("conversationId");
  const changeSetId = identifier("changeSetId");
  const reviewRunId = identifier("reviewRunId");
  if (runId === null || conversationId === null || changeSetId === null || reviewRunId === null) return null;
  const statuses: ReviewFindingLifecycle[] = ["open", "accepted", "disputed", "fixed", "verified", "dismissed"];
  const severities: ReviewSeverity[] = ["critical", "error", "warning", "info"];
  const status = query.status;
  const severity = query.severity;
  if (status !== undefined && (typeof status !== "string" || !statuses.includes(status as ReviewFindingLifecycle))) return null;
  if (severity !== undefined && (typeof severity !== "string" || !severities.includes(severity as ReviewSeverity))) return null;
  return {
    ...(runId ? { runId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(changeSetId ? { changeSetId } : {}),
    ...(reviewRunId ? { reviewRunId } : {}),
    ...(status ? { status: status as ReviewFindingLifecycle } : {}),
    ...(severity ? { severity: severity as ReviewSeverity } : {}),
  };
}

function activeRun(workspaceDir: string, runId: string): boolean {
  try { const status = readRunRecord(workspaceDir, runId).status; return status === "running" || status === "queued"; } catch { return false; }
}

function planRouteError(error: unknown, fallback: string): { status: 400 | 404; error: string } {
  const message = error instanceof Error ? error.message : fallback;
  if (
    message === "Invalid execution plan id" ||
    message === "Execution plan is invalid" ||
    message === "Execution plan amendment is already resolved"
  ) return { status: 400, error: message };
  if (
    message === "Execution plan amendment not found" ||
    (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
  ) {
    return { status: 404, error: message === "Execution plan amendment not found" ? message : "Execution plan not found" };
  }
  return { status: 400, error: fallback };
}

chatRouter.get("/runtime-options", (_req, res) => {
  const modes = ["ask", "plan", "code", "review"] as const;
  res.json({
    defaultModelName: config.modelName,
    models: listSelectableModelNames(config.agentProfiles, config.modelName),
    modeModels: Object.fromEntries(
      modes.map((mode) => [
        mode,
        resolveSelectableModelName(mode, undefined, config.agentProfiles, config.modelName),
      ])
    ),
  });
});

chatRouter.get("/context-manifests", (req, res) => {
  const identifier = (value: unknown) => value === undefined ? undefined : typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value) ? value : null;
  const runId = identifier(req.query.runId); const conversationId = identifier(req.query.conversationId); const requestId = identifier(req.query.requestId);
  const offset = page(req.query.offset, 0, 1_000_000); const limit = page(req.query.limit, 100, 500);
  if (runId === null || conversationId === null || requestId === null || offset === null || limit === null || limit < 1) return res.status(400).json({ error: "Invalid context manifest filter or pagination" });
  const manifests = listContextManifests(getSessionWorkspace(req), { ...(runId ? { runId } : {}), ...(conversationId ? { conversationId } : {}), ...(requestId ? { requestId } : {}) });
  res.json({ manifests: manifests.slice(offset, offset + limit).map(toContextManifestState), page: { offset, limit, total: manifests.length } });
});

chatRouter.get("/context-manifests/:id", (req, res) => {
  try { res.json({ manifest: readContextManifest(getSessionWorkspace(req), req.params.id) }); }
  catch (error) { const message = error instanceof Error ? error.message : "Context manifest not found"; res.status(message === "Invalid context manifest id" ? 400 : 404).json({ error: message }); }
});

chatRouter.get("/context-preferences/:conversationId", (req, res) => {
  if (!conversationExists(getSessionWorkspace(req), req.params.conversationId)) return res.status(404).json({ error: "Conversation not found" });
  try { res.json({ preferences: readContextPreferences(getSessionWorkspace(req), req.params.conversationId) }); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Failed to read context preferences" }); }
});

chatRouter.put("/context-preferences/:conversationId", (req, res) => {
  if (!writable(req, res)) return;
  if (!conversationExists(getSessionWorkspace(req), req.params.conversationId)) return res.status(404).json({ error: "Conversation not found" });
  if (!Number.isSafeInteger(req.body?.expectedVersion) || (req.body?.pins !== undefined && !Array.isArray(req.body.pins)) || (req.body?.excludes !== undefined && !Array.isArray(req.body.excludes))) return res.status(400).json({ error: "expectedVersion and valid pins/excludes are required" });
  try { res.json({ preferences: updateContextPreferences(getSessionWorkspace(req), req.params.conversationId, req.body) }); }
  catch (error) { if (error instanceof ContextPreferencesVersionConflictError) return res.status(409).json({ error: error.message, preferences: error.current }); res.status(400).json({ error: error instanceof Error ? error.message : "Failed to update context preferences" }); }
});

chatRouter.get("/context-index/status", async (req, res) => {
  try { res.json({ index: await getContextIndexAdapter().status(getSessionWorkspace(req)) }); }
  catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : "Failed to read context index status" }); }
});

async function contextPreview(req: Request, res: Response) {
  const session = (req as any).userSession as UserSession;
  const conversationId = typeof req.body?.conversationId === "string" ? req.body.conversationId.trim() : "";
  const query = typeof req.body?.query === "string" ? req.body.query.trim().slice(0, 4_000) : "";
  const limit = req.body?.limit === undefined ? 20 : req.body.limit;
  const currentPath = typeof req.body?.currentPath === "string" && req.body.currentPath.trim()
    ? req.body.currentPath.trim().slice(0, 1_000)
    : undefined;
  const changedPaths = req.body?.changedPaths;
  if (conversationId && !conversationExists(getSessionWorkspace(req), conversationId)) return res.status(404).json({ error: "Conversation not found" });
  if (!query || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (changedPaths !== undefined && (!Array.isArray(changedPaths) || changedPaths.length > 100 || !changedPaths.every((item: unknown) => typeof item === "string" && item.length <= 1_000)))) return res.status(400).json({ error: "Valid query, limit, currentPath, and changedPaths are required" });
  try {
    const preferences = conversationId
      ? readContextPreferences(getSessionWorkspace(req), conversationId)
      : { schemaVersion: 1 as const, conversationId: "preview", version: 0, pins: [], excludes: [], updatedAt: 0 };
    const adapter = getContextIndexAdapter();
    const retrieved = await adapter.retrieve(getSessionWorkspace(req), {
      query,
      ...(currentPath ? { currentPath } : {}),
      ...(changedPaths ? { changedPaths } : {}),
      maxResults: limit,
      maxTokens: 8_000,
      preferences,
      viewer: { username: session.username, isAdmin: Boolean(session.isAdmin) },
      scope: { kind: session.isolated ? "managed_worktree" : "workspace", scopeId: session.isolated ? "isolated-preview" : "workspace-preview" },
    });
    const candidates = retrieved.map(({ content: _content, contentDigest: _contentDigest, ...candidate }) => candidate);
    const index = await adapter.status(getSessionWorkspace(req));
    res.json({ candidates, preferences, index });
  }
  catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : "Context preview failed" }); }
}

chatRouter.post("/context/preview", contextPreview);
chatRouter.post("/context-preview", contextPreview);

chatRouter.post("/context-index/refresh", async (req, res) => {
  if (!writable(req, res)) return;
  const paths = req.body?.paths;
  if (paths !== undefined && (!Array.isArray(paths) || !paths.every((item: unknown) => typeof item === "string" && item.length <= 1_000))) return res.status(400).json({ error: "paths must be a bounded string array" });
  try { res.status(202).json({ index: await getContextIndexAdapter().refresh(getSessionWorkspace(req), paths) }); }
  catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : "Context index refresh failed" }); }
});

chatRouter.post("/context-index/rebuild", async (req, res) => {
  if (!writable(req, res)) return;
  try { res.status(202).json({ index: await getContextIndexAdapter().rebuild(getSessionWorkspace(req)) }); }
  catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : "Context index rebuild failed" }); }
});

// Trace and review records are always scoped to the authenticated session's
// workspace.  They intentionally expose operational evidence only; TraceStore
// redacts secrets and rejects reasoning/prompt fields before persistence.
chatRouter.get("/traces/metrics", (req, res) => {
  res.json({ metrics: new TraceStore(getSessionWorkspace(req)).metrics() });
});

chatRouter.get("/traces/retention", (req, res) => {
  const store = new TraceStore(getSessionWorkspace(req));
  res.json({ retention: store.getRetention(), preview: store.previewPrune() });
});

chatRouter.put("/traces/retention", (req, res) => {
  if (!writable(req, res)) return;
  const input = req.body || {};
  const numeric = ["maxEvents", "maxArchiveEvents", "maxAgeMs", "maxArchiveAgeMs"];
  if (!numeric.every((key) => input[key] === undefined || (Number.isSafeInteger(input[key]) && input[key] >= 0)) || (input.archive !== undefined && typeof input.archive !== "boolean")) return res.status(400).json({ error: "Invalid trace retention policy" });
  try {
    const store = new TraceStore(getSessionWorkspace(req));
    const retention = store.setRetention(input);
    const preview = input.prune === true ? store.prune() : store.previewPrune();
    res.json({ retention, preview, ...(input.prune === true ? { metrics: store.metrics() } : {}) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Failed to update trace retention" });
  }
});

chatRouter.get("/traces/export", (req, res) => {
  const filter = traceFilter(req.query as Record<string, unknown>);
  if (!filter) return res.status(400).json({ error: "Invalid trace filter" });
  res.json(new TraceStore(getSessionWorkspace(req)).export(filter));
});

chatRouter.get("/traces", (req, res) => {
  const filter = traceFilter(req.query as Record<string, unknown>);
  const offset = page(req.query.offset, 0, 1_000_000);
  const limit = page(req.query.limit, 100, 500);
  if (!filter || offset === null || limit === null || limit < 1) return res.status(400).json({ error: "Invalid trace pagination or filter" });
  const events = new TraceStore(getSessionWorkspace(req)).list(filter);
  res.json({ events: events.slice(offset, offset + limit), page: { offset, limit, total: events.length } });
});

chatRouter.get("/traces/:eventId", (req, res) => {
  const event = new TraceStore(getSessionWorkspace(req)).list().find((entry) => entry.eventId === req.params.eventId);
  if (!event) return res.status(404).json({ error: "Trace event not found" });
  res.json({ event });
});

chatRouter.delete("/traces", (req, res) => {
  if (!writable(req, res)) return;
  const filter = traceFilter(req.query as Record<string, unknown>);
  if (!filter || (!filter.runId && !filter.correlationId && !filter.kind)) return res.status(400).json({ error: "Select a trace run, correlation, or kind" });
  const store = new TraceStore(getSessionWorkspace(req));
  if (store.list(filter).some((event) => event.runId && activeRun(getSessionWorkspace(req), event.runId))) return res.status(409).json({ error: "Cannot delete traces for an active run" });
  res.json({ deleted: store.delete(filter) });
});

chatRouter.get("/review-findings/export", (req, res) => {
  const filter = reviewFindingFilter(req.query as Record<string, unknown>);
  if (!filter) return res.status(400).json({ error: "Invalid review finding filter" });
  const format = typeof req.query.format === "string" ? req.query.format : "crewforge";
  if (format !== "crewforge" && format !== "sarif") return res.status(400).json({ error: "format must be crewforge or sarif" });
  const workspace = getSessionWorkspace(req);
  const findings = new ReviewFindingStore(workspace).list(filter);
  if (format === "sarif") return res.type("application/sarif+json").json(toSarifReviewFindings(workspace, findings, filter));
  res.type("application/vnd.crewforge.review-findings.v1+json").json({ schemaVersion: 1, findings });
});

chatRouter.get("/review-findings", (req, res) => {
  const filter = reviewFindingFilter(req.query as Record<string, unknown>);
  const offset = page(req.query.offset, 0, 1_000_000);
  const limit = page(req.query.limit, 100, 500);
  if (!filter || offset === null || limit === null || limit < 1) return res.status(400).json({ error: "Invalid findings pagination or filter" });
  const findings = new ReviewFindingStore(getSessionWorkspace(req)).list(filter);
  const isAdmin = Boolean(((req as any).userSession as UserSession).isAdmin);
  res.json({ findings: findings.slice(offset, offset + limit).map((finding) => ({ ...finding, allowedTransitions: allowedReviewFindingTransitions(finding, { isAdmin }) })), page: { offset, limit, total: findings.length }, canIntegrate: !findings.some((finding) => (finding.severity === "critical" || finding.severity === "error") && !["verified", "dismissed"].includes(finding.lifecycle)) });
});

chatRouter.post("/review-findings/:id/transition", (req, res) => {
  if (!writable(req, res)) return;
  const to = req.body?.to as ReviewFindingLifecycle;
  const expectedVersion = req.body?.expectedVersion;
  if (!Number.isInteger(expectedVersion) || !["open", "accepted", "disputed", "fixed", "dismissed"].includes(to)) return res.status(400).json({ error: "to and expectedVersion are required" });
  const store = new ReviewFindingStore(getSessionWorkspace(req));
  try {
    const current = store.list().find((finding) => finding.id === req.params.id);
    if (!current) return res.status(404).json({ error: "Review finding not found" });
    const session = (req as any).userSession as UserSession;
    if (to === "dismissed" && (current.severity === "critical" || current.severity === "error") && !session.isAdmin) {
      return res.status(403).json({ error: "Admin waiver is required to dismiss a critical or error finding" });
    }
    const actor = { id: session.username, ...(typeof req.body?.modelName === "string" ? { modelName: req.body.modelName } : {}), ...(typeof req.body?.revision === "string" ? { revision: req.body.revision } : {}) };
    const finding = store.transition(req.params.id, to, actor, {
      ...(typeof req.body?.reason === "string" ? { reason: req.body.reason } : {}),
      ...(typeof req.body?.fixRef === "string" ? { fixRef: req.body.fixRef } : {}),
      ...(Array.isArray(req.body?.evidence) && req.body.evidence.every((item: unknown) => typeof item === "string") ? { evidence: req.body.evidence } : {}),
      ...(typeof req.body?.revision === "string" ? { revision: req.body.revision } : {}),
      expectedVersion,
    });
    new TraceStore(getSessionWorkspace(req)).append({ kind: "review", action: `Review finding ${to}`, correlationId: finding.id, agentId: actor.id, decision: to, metadata: { severity: finding.severity, version: finding.version } });
    res.json({ finding: { ...finding, allowedTransitions: allowedReviewFindingTransitions(finding, { isAdmin: Boolean(session.isAdmin) }) }, canIntegrate: store.canIntegrate() });
  } catch (error) {
    if (error instanceof ReviewFindingVersionConflictError) {
      return res.status(409).json({ error: "Review finding version conflict", expectedVersion: error.expectedVersion, currentVersion: error.actualVersion });
    }
    const message = error instanceof Error ? error.message : "Review finding transition failed";
    res.status(message.includes("not found") ? 404 : 400).json({ error: message });
  }
});

chatRouter.delete("/review-findings/:id", (req, res) => {
  if (!writable(req, res)) return;
  res.set("Allow", "GET, POST").status(405).json({ error: "Review findings are append-only; use a lifecycle transition with a reason and expectedVersion" });
});

chatRouter.get("/plans/:planId", (req, res) => {
  try {
    res.json({ plan: readExecutionPlan(getSessionWorkspace(req), req.params.planId) });
  } catch (error) {
    const response = planRouteError(error, "Failed to load execution plan");
    res.status(response.status).json({ error: response.error });
  }
});

chatRouter.post("/plans/:planId/amendments/:amendmentId", (req, res) => {
  const decision = req.body?.decision;
  if (decision !== "approved" && decision !== "rejected") {
    return res.status(400).json({ error: "decision must be approved or rejected" });
  }
  try {
    res.json({
      plan: resolveExecutionPlanAmendment(
        getSessionWorkspace(req),
        req.params.planId,
        req.params.amendmentId,
        decision
      ),
    });
  } catch (error) {
    const response = planRouteError(error, "Failed to resolve execution plan amendment");
    res.status(response.status).json({ error: response.error });
  }
});

chatRouter.get("/conversations", (req, res) => {
  try {
    res.json({
      conversations: listConversationSummaries(getSessionWorkspace(req)),
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to list conversations",
    });
  }
});

chatRouter.get("/conversations/:id", (req, res) => {
  try {
    const summary = listConversationSummaries(getSessionWorkspace(req)).find(
      (conversation) => conversation.id === req.params.id
    );
    res.json({
      id: req.params.id,
      messages: readConversationMessages(getSessionWorkspace(req), req.params.id),
      ...(summary
        ? {
          mode: summary.mode,
          status: summary.status,
          summary: summary.summary,
          ...(summary.lastRunId ? { lastRunId: summary.lastRunId } : {}),
        }
        : {}),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load conversation";
    res.status(message === "Conversation not found" ? 404 : 400).json({
      error: message,
    });
  }
});

chatRouter.delete("/conversations/:id", async (req, res) => {
  try {
    const workspaceDir = getSessionWorkspace(req);
    if (hasActiveRunForConversation(workspaceDir, req.params.id)) {
      return res.status(409).json({
        error: "Cannot delete a conversation while it is running",
      });
    }
    await deleteConversation(workspaceDir, req.params.id);
    res.status(204).end();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete conversation";
    res.status(message === "Conversation not found" ? 404 : 400).json({ error: message });
  }
});

chatRouter.post("/conversations/:id/fork", (req, res) => {
  try {
    const upToTimestamp = req.body?.upToTimestamp;
    if (
      upToTimestamp !== undefined &&
      (typeof upToTimestamp !== "number" || !Number.isFinite(upToTimestamp))
    ) {
      return res.status(400).json({ error: "upToTimestamp must be a finite number" });
    }
    const conversation = forkConversation(getSessionWorkspace(req), req.params.id, {
      ...(typeof upToTimestamp === "number" ? { upToTimestamp } : {}),
      ...(typeof req.body?.title === "string" ? { title: req.body.title } : {}),
    });
    res.status(201).json({ conversation });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fork conversation";
    res.status(message === "Conversation not found" ? 404 : 400).json({ error: message });
  }
});

chatRouter.get("/runs", (req, res) => {
  try {
    const conversationId =
      typeof req.query.conversationId === "string" ? req.query.conversationId.trim() : undefined;
    res.json({ runs: listRunSummaries(getSessionWorkspace(req), conversationId) });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to list agent runs",
    });
  }
});

chatRouter.get("/runs/:runId/children", (req, res) => {
  try {
    res.json({ runs: listChildRuns(getSessionWorkspace(req), req.params.runId) });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to list child runs",
    });
  }
});

chatRouter.get("/runs/:runId", (req, res) => {
  try {
    res.json(readRunRecord(getSessionWorkspace(req), req.params.runId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load agent run";
    res.status(message === "Run not found" ? 404 : 400).json({ error: message });
  }
});

chatRouter.post("/runs/:runId/revert", (req, res) => {
  const session = (req as any).userSession as UserSession;
  if (!canWriteActiveWorkspace(session)) {
    return res.status(403).json({ error: "Workspace is read-only" });
  }
  try {
    const run = readRunRecord(session.workspaceDir, req.params.runId);
    if (run.status === "running" || run.status === "queued") {
      return res.status(409).json({ error: "Stop the agent run before reverting its workspace" });
    }
    const mutations = listFileMutations(session.workspaceDir, { runId: req.params.runId });
    if (mutations.length) {
      const rollback = rollbackFileMutations(session.workspaceDir, { runId: req.params.runId });
      if (rollback.conflicts.length || rollback.unavailable.length) {
        return res.status(409).json({ error: "Rollback conflicts detected; no files were changed", rollback });
      }
      return res.json({ restored: false, rollback, mode: "incremental" });
    }
    if (req.body?.legacyFullRestore !== true) {
      return res.status(409).json({
        error: "This legacy run has no mutation journal. Explicit destructive restore confirmation is required.",
        legacyFullRestoreRequired: true,
      });
    }
    const checkpoint = findCheckpointForRun(session.workspaceDir, req.params.runId);
    if (!checkpoint) return res.status(404).json({ error: "Run checkpoint not found" });
    res.json({ restored: true, checkpoint: restoreCheckpoint(session.workspaceDir, checkpoint.id), mode: "legacy-full-restore" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to revert run";
    res.status(message === "Run not found" || message === "Checkpoint not found" ? 404 : 400).json({ error: message });
  }
});

chatRouter.get("/worktrees", (req, res) => {
  try {
    res.json({ worktrees: listManagedWorktrees(getSessionWorkspace(req)) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Failed to list worktrees" });
  }
});

chatRouter.post("/worktrees", (req, res) => {
  if (!canWriteActiveWorkspace((req as any).userSession as UserSession)) {
    return res.status(403).json({ error: "Workspace is read-only" });
  }
  try {
    const worktree = createManagedWorktree(getSessionWorkspace(req), {
      ...(typeof req.body?.name === "string" ? { name: req.body.name } : {}),
      ...(typeof req.body?.revision === "string" ? { revision: req.body.revision } : {}),
    });
    res.status(201).json({ worktree });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Failed to create worktree" });
  }
});

chatRouter.post("/vibe-window", (req, res) => {
  const session = (req as any).userSession as UserSession;
  if (!canWriteActiveWorkspace(session)) {
    return res.status(403).json({ error: "Workspace is read-only" });
  }
  if (session.isolated) {
    return res.status(409).json({ error: "This window is already isolated" });
  }
  let worktree: ReturnType<typeof createManagedWorktree> | null = null;
  try {
    worktree = createManagedWorktree(session.workspaceDir, {
      name: typeof req.body?.name === "string" ? req.body.name : "vibe",
      ...(typeof req.body?.revision === "string" ? { revision: req.body.revision } : {}),
    });
    const isolatedSession = sessionManager.createIsolatedSession(session.token, worktree.path);
    res.status(201).json({ worktree, session: isolatedSession });
  } catch (error) {
    if (worktree) {
      try { removeManagedWorktree(session.workspaceDir, worktree.id); } catch { /* preserve the original failure */ }
    }
    res.status(400).json({ error: error instanceof Error ? error.message : "Failed to create isolated Vibe window" });
  }
});

chatRouter.delete("/worktrees/:id", (req, res) => {
  if (!canWriteActiveWorkspace((req as any).userSession as UserSession)) {
    return res.status(403).json({ error: "Workspace is read-only" });
  }
  try {
    res.json({ removed: true, worktree: removeManagedWorktree(getSessionWorkspace(req), req.params.id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to remove worktree";
    res.status(message === "Managed worktree not found" ? 404 : 400).json({ error: message });
  }
});
