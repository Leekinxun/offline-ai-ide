import { Router } from "express";
import type { UserSession } from "../auth/sessionManager.js";
import { readGitStatus } from "../files/gitStatus.js";
import { GitDeliveryError, GitDeliveryService } from "../integrations/gitDelivery/service.js";
import type { GitDeliveryActor, GitDeliveryInput, GitDeliveryProvenance } from "../integrations/gitDelivery/types.js";
import { canWriteActiveWorkspace, resolveActiveTeam } from "../team/sessionBridge.js";

export const gitDeliveryRouter = Router();

function session(req: unknown): UserSession {
  return (req as any).userSession as UserSession;
}

function service(req: unknown): GitDeliveryService {
  return new GitDeliveryService(session(req).workspaceDir);
}

function actor(req: unknown): GitDeliveryActor {
  const current = session(req);
  const team = resolveActiveTeam(current);
  return {
    username: current.username,
    isAdmin: current.isAdmin === true,
    ...(team?.role ? { teamRole: team.role } : {}),
  };
}

function writable(req: unknown, res: any): boolean {
  if (canWriteActiveWorkspace(session(req))) return true;
  res.status(403).json({ code: "FORBIDDEN", error: "Workspace is read-only" });
  return false;
}

function respondError(res: any, error: unknown): void {
  if (error instanceof GitDeliveryError) {
    res.status(error.status).json({ code: error.code, error: error.message, ...(error.current ? { current: error.current } : {}) });
    return;
  }
  const message = error instanceof Error ? error.message : "Git delivery request failed";
  const status = message === "Git operation not found" ? 404
    : message.includes("Idempotency key") || message.includes("version conflict") || message.includes("stale") ? 409
      : 400;
  res.status(status).json({ code: status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : "INVALID_REQUEST", error: message });
}

gitDeliveryRouter.get("/status", (req, res) => {
  try {
    const current = session(req);
    const team = resolveActiveTeam(current);
    res.json({
      status: readGitStatus(current.workspaceDir),
      capabilities: {
        canPrepare: canWriteActiveWorkspace(current),
        canPush: canWriteActiveWorkspace(current) && (!team || team.role === "owner" || team.role === "admin"),
      },
    });
  } catch {
    res.json({ status: { isRepo: false, branch: null, headSha: null, upstream: null, ahead: 0, behind: 0, entries: [], updatedAt: Date.now() }, capabilities: { canPrepare: false, canPush: false } });
  }
});

gitDeliveryRouter.get("/operations", (req, res) => {
  try { res.json({ operations: service(req).list() }); }
  catch (error) { respondError(res, error); }
});

gitDeliveryRouter.get("/operations/:id", (req, res) => {
  try { res.json({ operation: service(req).get(req.params.id) }); }
  catch (error) { respondError(res, error); }
});

gitDeliveryRouter.post("/operations", (req, res) => {
  if (!writable(req, res)) return;
  try {
    const header = req.get("Idempotency-Key");
    const operation = service(req).prepare({
      idempotencyKey: header || "",
      input: req.body?.input as GitDeliveryInput,
      ...(req.body?.provenance && typeof req.body.provenance === "object" ? { provenance: req.body.provenance as GitDeliveryProvenance } : {}),
    }, actor(req));
    res.status(201).json({ operation });
  } catch (error) { respondError(res, error); }
});

gitDeliveryRouter.post("/operations/:id/approve", (req, res) => {
  if (!writable(req, res)) return;
  try {
    if (!Number.isSafeInteger(req.body?.expectedVersion) || typeof req.body?.approvalDigest !== "string") throw new GitDeliveryError("INVALID_APPROVAL", "expectedVersion and approvalDigest are required");
    const operation = service(req).approve(req.params.id, req.body.expectedVersion, req.body.approvalDigest, actor(req), typeof req.body?.reason === "string" ? req.body.reason : undefined);
    res.json({ operation });
  } catch (error) { respondError(res, error); }
});

gitDeliveryRouter.post("/operations/:id/cancel", (req, res) => {
  if (!writable(req, res)) return;
  try {
    if (!Number.isSafeInteger(req.body?.expectedVersion)) throw new GitDeliveryError("INVALID_VERSION", "expectedVersion is required");
    res.json({ operation: service(req).cancel(req.params.id, req.body.expectedVersion, actor(req)) });
  } catch (error) { respondError(res, error); }
});

gitDeliveryRouter.post("/reconcile", (req, res) => {
  if (!writable(req, res)) return;
  try { res.json({ operations: service(req).reconcile() }); }
  catch (error) { respondError(res, error); }
});
