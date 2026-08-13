import express, { Router } from "express";
import type { IncomingHttpHeaders } from "node:http";
import type { UserSession } from "../auth/sessionManager.js";
import { getDeliverySettings } from "../config.js";
import { DeliveryFeedbackVersionConflictError } from "../integrations/feedbackStore.js";
import { registerDeliveryService, registeredDeliveryServices, type DeliveryService } from "../integrations/delivery/service.js";
import type { DeliveryActor, PrepareDeliveryInput, RepositoryRef } from "../integrations/delivery/types.js";
import { DeliveryConflictError, DeliveryUnavailableError } from "../integrations/delivery/types.js";
import { DeliveryWebhookError } from "../integrations/delivery/webhook.js";
import { canWriteActiveWorkspace } from "../team/sessionBridge.js";

export const deliveryRouter = Router();
export const deliveryWebhookRouter = Router();

export type DeliveryWebhookService = Pick<DeliveryService, "workspace" | "verifyWebhook" | "consumeVerifiedWebhook" | "pollAll">;
export interface DeliveryWebhookServiceAggregate {
  total: number;
  verified: number;
  verificationFailed: number;
  consumed: number;
  duplicates: number;
  pollSucceeded: number;
  pollFailed: number;
  internalFailed: number;
}
export type DeliveryWebhookDispatch =
  | { status: 202; body: { accepted: false; pollFallback: true; retryable: false; services: DeliveryWebhookServiceAggregate } }
  | { status: 202; body: { accepted: true; duplicate: boolean; feedbackId?: string; services: DeliveryWebhookServiceAggregate } }
  | { status: 400; body: { code: "INVALID_WEBHOOK"; error: "Webhook verification failed"; services: DeliveryWebhookServiceAggregate } }
  | { status: 401; body: { code: "INVALID_WEBHOOK_SIGNATURE"; error: "Webhook signature verification failed"; services: DeliveryWebhookServiceAggregate } }
  | { status: 500; body: { code: "WEBHOOK_INTERNAL_ERROR"; error: "Webhook processing failed"; retryable: true; services: DeliveryWebhookServiceAggregate } }
  | { status: 503; body: { code: "POLL_FALLBACK_INCOMPLETE"; error: "Delivery polling fallback did not complete for every service"; accepted: false; pollFallback: true; retryable: true; services: DeliveryWebhookServiceAggregate } };

const DEFAULT_WEBHOOK_POLL_TIMEOUT_MS = 10_000;

function uniqueWebhookServices(services: readonly DeliveryWebhookService[]): DeliveryWebhookService[] {
  const workspaces = new Set<string>();
  const unique: DeliveryWebhookService[] = [];
  for (const service of services) {
    if (workspaces.has(service.workspace)) continue;
    workspaces.add(service.workspace);
    unique.push(service);
  }
  return unique;
}

function aggregate(total: number, verified = 0, verificationFailed = 0, consumed = 0, duplicates = 0, pollSucceeded = 0, pollFailed = 0, internalFailed = 0): DeliveryWebhookServiceAggregate {
  return { total, verified, verificationFailed, consumed, duplicates, pollSucceeded, pollFailed, internalFailed };
}

function internalFailure(services: DeliveryWebhookServiceAggregate): DeliveryWebhookDispatch {
  return { status: 500, body: { code: "WEBHOOK_INTERNAL_ERROR", error: "Webhook processing failed", retryable: true, services } };
}

async function pollWithTimeout(service: DeliveryWebhookService, requestedTimeoutMs: number): Promise<void> {
  const timeoutMs = Math.max(1, Math.min(requestedTimeoutMs, 30_000));
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("Delivery polling fallback timed out")); }, timeoutMs);
      Promise.resolve().then(() => service.pollAll(controller.signal)).then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function dispatchDeliveryWebhook(providerConfigId: string, body: Buffer, headers: IncomingHttpHeaders, candidates: readonly DeliveryWebhookService[], pollTimeoutMs = DEFAULT_WEBHOOK_POLL_TIMEOUT_MS): Promise<DeliveryWebhookDispatch> {
  const services = uniqueWebhookServices(candidates);
  if (services.length === 0) return { status: 202, body: { accepted: false, pollFallback: true, retryable: false, services: aggregate(0) } };

  const verified: Array<{ service: DeliveryWebhookService; event: ReturnType<DeliveryWebhookService["verifyWebhook"]> }> = [];
  const clientFailures: DeliveryWebhookError[] = [];
  let internalFailures = 0;
  for (const service of services) {
    try {
      verified.push({ service, event: service.verifyWebhook(providerConfigId, body, headers) });
    } catch (error) {
      if (error instanceof DeliveryWebhookError) clientFailures.push(error);
      else internalFailures += 1;
    }
  }

  if (internalFailures > 0) return internalFailure(aggregate(services.length, verified.length, clientFailures.length, 0, 0, 0, 0, internalFailures));

  if (verified.length === 0) {
    const serviceAggregate = aggregate(services.length, 0, clientFailures.length);
    if (clientFailures.length > 0 && clientFailures.every((error) => error.code !== "invalid_payload")) {
      return { status: 401, body: { code: "INVALID_WEBHOOK_SIGNATURE", error: "Webhook signature verification failed", services: serviceAggregate } };
    }
    return { status: 400, body: { code: "INVALID_WEBHOOK", error: "Webhook verification failed", services: serviceAggregate } };
  }

  const consumed: ReturnType<DeliveryWebhookService["consumeVerifiedWebhook"]>[] = [];
  let consumeFailures = 0;
  for (const { service, event } of verified) {
    try {
      const result = service.consumeVerifiedWebhook(structuredClone(event));
      if (result.consumed) consumed.push(result);
    } catch {
      consumeFailures += 1;
    }
  }
  if (consumeFailures > 0) return internalFailure(aggregate(services.length, verified.length, clientFailures.length, consumed.length, consumed.filter((result) => result.duplicate).length, 0, 0, consumeFailures));
  if (consumed.length > 0) {
    const feedbackId = consumed.find((result) => !result.duplicate && result.feedback)?.feedback?.id;
    const serviceAggregate = aggregate(services.length, verified.length, clientFailures.length, consumed.length, consumed.filter((result) => result.duplicate).length);
    return {
      status: 202,
      body: {
        accepted: true,
        duplicate: consumed.every((result) => result.duplicate),
        ...(feedbackId ? { feedbackId } : {}),
        services: serviceAggregate,
      },
    };
  }

  const polls = await Promise.allSettled(verified.map(({ service }) => pollWithTimeout(service, pollTimeoutMs)));
  const pollSucceeded = polls.filter((result) => result.status === "fulfilled").length;
  const pollFailed = polls.length - pollSucceeded;
  const serviceAggregate = aggregate(services.length, verified.length, clientFailures.length, 0, 0, pollSucceeded, pollFailed);
  if (pollFailed > 0) return { status: 503, body: { code: "POLL_FALLBACK_INCOMPLETE", error: "Delivery polling fallback did not complete for every service", accepted: false, pollFallback: true, retryable: true, services: serviceAggregate } };
  return { status: 202, body: { accepted: false, pollFallback: true, retryable: false, services: serviceAggregate } };
}

function session(req: unknown): UserSession { return (req as any).userSession as UserSession; }
function service(req: unknown) { return registerDeliveryService(session(req).workspaceDir, getDeliverySettings()); }
function actor(req: unknown): DeliveryActor { const current = session(req); return { username: current.username, isAdmin: current.isAdmin === true }; }
function requestSignal(req: any): AbortSignal {
  const controller = new AbortController();
  req.once("aborted", () => controller.abort());
  return controller.signal;
}
function writable(req: unknown, res: any): boolean {
  if (canWriteActiveWorkspace(session(req))) return true;
  res.status(403).json({ code: "FORBIDDEN", error: "Workspace is read-only" });
  return false;
}
function repository(value: any): RepositoryRef {
  const providerConfigId = typeof value?.providerConfigId === "string" ? value.providerConfigId.trim() : "";
  const remoteRepositoryId = typeof value?.remoteRepositoryId === "string" ? value.remoteRepositoryId.trim() : "";
  if (!providerConfigId || !remoteRepositoryId) throw new Error("providerConfigId and remoteRepositoryId are required");
  return {
    providerConfigId,
    remoteRepositoryId,
    ...(typeof value?.owner === "string" && value.owner.trim() ? { owner: value.owner.trim() } : {}),
    ...(typeof value?.name === "string" && value.name.trim() ? { name: value.name.trim() } : {}),
    ...(typeof value?.gitRemoteName === "string" && value.gitRemoteName.trim() ? { gitRemoteName: value.gitRemoteName.trim() } : {}),
  };
}
function respondError(res: any, error: unknown): void {
  if (error instanceof DeliveryConflictError || error instanceof DeliveryFeedbackVersionConflictError) {
    res.status(409).json({ code: "code" in error ? error.code : "CONFLICT", error: error.message }); return;
  }
  if (error instanceof DeliveryUnavailableError) {
    res.status(503).json({ code: "PROVIDER_UNAVAILABLE", health: error.health, error: error.message }); return;
  }
  const message = error instanceof Error ? error.message : "Delivery request failed";
  const status = message.includes("not found") || message.includes("not belong") ? 404 : message.includes("disabled or missing") ? 503 : 400;
  res.status(status).json({ code: status === 404 ? "NOT_FOUND" : status === 503 ? "PROVIDER_UNAVAILABLE" : "INVALID_REQUEST", error: message });
}

deliveryRouter.get("/providers", (_req, res) => {
  const settings = getDeliverySettings();
  res.json({ providers: settings.providers.map(({ tokenEnv, webhookSecretEnv, ...provider }) => ({ ...provider, credentialConfigured: Boolean(process.env[tokenEnv]), webhookConfigured: Boolean(webhookSecretEnv && process.env[webhookSecretEnv]) })), pollIntervalSeconds: settings.pollIntervalSeconds });
});

deliveryRouter.get("/capabilities", async (req, res) => {
  try {
    const ref = repository(req.query);
    res.json({ capabilities: await service(req).capabilities(ref, ref.providerConfigId, requestSignal(req)) });
  } catch (error) { respondError(res, error); }
});

deliveryRouter.get("/current", (req, res) => {
  try {
    const deliveryId = typeof req.query.deliveryId === "string" ? req.query.deliveryId : undefined;
    const current = service(req);
    const deliveries = deliveryId ? [current.getBinding(deliveryId)].filter(Boolean) : current.listBindings();
    res.json({ deliveries, feedback: current.listFeedback(deliveryId) });
  } catch (error) { respondError(res, error); }
});

deliveryRouter.get("/operations", (req, res) => {
  try { res.json({ operations: service(req).listOperations() }); }
  catch (error) { respondError(res, error); }
});

deliveryRouter.get("/operations/:operationId", (req, res) => {
  try { res.json({ operation: service(req).getOperation(req.params.operationId) }); }
  catch (error) { respondError(res, error); }
});

deliveryRouter.post("/operations", (req, res) => {
  if (!writable(req, res)) return;
  try {
    const idempotencyKey = req.get("Idempotency-Key") || "";
    const input = { ...(req.body || {}), repository: repository(req.body?.repository) } as PrepareDeliveryInput;
    res.status(201).json({ operation: service(req).prepare(input, idempotencyKey, actor(req)) });
  } catch (error) { respondError(res, error); }
});

deliveryRouter.post("/operations/:operationId/approve", (req, res) => {
  if (!writable(req, res)) return;
  try {
    if (!Number.isSafeInteger(req.body?.expectedVersion) || typeof req.body?.approvalDigest !== "string") throw new Error("expectedVersion and approvalDigest are required");
    res.json({ operation: service(req).approve(req.params.operationId, req.body.expectedVersion, req.body.approvalDigest, actor(req)) });
  } catch (error) { respondError(res, error); }
});

async function publishOperation(req: any, res: any): Promise<void> {
  if (!writable(req, res)) return;
  try {
    const operationId = req.params.operationId || req.body?.operationId;
    if (typeof operationId !== "string" || !Number.isSafeInteger(req.body?.expectedVersion)) throw new Error("operationId and expectedVersion are required");
    res.json({ delivery: await service(req).publishApproved(operationId, req.body.expectedVersion, actor(req), requestSignal(req)) });
  } catch (error) { respondError(res, error); }
}
deliveryRouter.post("/operations/:operationId/publish", (req, res) => { void publishOperation(req, res); });
deliveryRouter.post("/publish", (req, res) => { void publishOperation(req, res); });

deliveryRouter.post("/operations/:operationId/reconcile", async (req, res) => {
  try { res.json({ delivery: await service(req).reconcileOperation(req.params.operationId, requestSignal(req)) }); }
  catch (error) { respondError(res, error); }
});

deliveryRouter.get("/:deliveryId/status", (req, res) => {
  try {
    const current = service(req); const delivery = current.getBinding(req.params.deliveryId);
    if (!delivery) throw new Error("Delivery binding not found");
    res.json({ delivery, feedback: current.listFeedback(req.params.deliveryId) });
  } catch (error) { respondError(res, error); }
});

deliveryRouter.post("/:deliveryId/refresh", async (req, res) => {
  try { res.json(await service(req).refresh(req.params.deliveryId, requestSignal(req))); }
  catch (error) { respondError(res, error); }
});

deliveryRouter.get("/:deliveryId/follow-ups", (req, res) => {
  try { res.json({ feedback: service(req).listFeedback(req.params.deliveryId) }); }
  catch (error) { respondError(res, error); }
});

deliveryRouter.post("/:deliveryId/follow-ups/:feedbackId/approve", (req, res) => {
  if (!writable(req, res)) return;
  try {
    if (!Number.isSafeInteger(req.body?.expectedVersion) || typeof req.body?.approvalId !== "string" || !req.body.approvalId.trim()) throw new Error("expectedVersion and approvalId are required");
    const actorId = `${session(req).username}:${req.body.approvalId.trim()}`;
    res.status(201).json({ feedback: service(req).approveFeedback(req.params.deliveryId, req.params.feedbackId, actorId, req.body.expectedVersion) });
  } catch (error) { respondError(res, error); }
});

deliveryWebhookRouter.post("/:providerConfigId", express.raw({ type: "*/*", limit: "2mb" }), async (req, res) => {
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  try {
    const candidates = registeredDeliveryServices(req.params.providerConfigId);
    const result = await dispatchDeliveryWebhook(req.params.providerConfigId, body, req.headers, candidates);
    res.status(result.status).json(result.body);
  } catch {
    res.status(500).json({ code: "WEBHOOK_INTERNAL_ERROR", error: "Webhook processing failed", retryable: true, services: aggregate(0, 0, 0, 0, 0, 0, 0, 1) });
  }
});
