import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export type DeliveryWebhookErrorCode = "invalid_signature" | "invalid_token" | "invalid_timestamp" | "invalid_payload";

export class DeliveryWebhookError extends Error {
  constructor(readonly code: DeliveryWebhookErrorCode, message: string) {
    super(message);
    this.name = "DeliveryWebhookError";
  }
}

export function header(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function equalText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function parseWebhookJson(rawBody: Buffer): Record<string, any> {
  try {
    const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, any>;
  } catch { throw new DeliveryWebhookError("invalid_payload", "Webhook body is not a JSON object"); }
}

export function verifyGithubWebhook(rawBody: Buffer, headers: IncomingHttpHeaders, secret: string): { deliveryId: string; event: string } {
  const received = header(headers, "x-hub-signature-256");
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  if (!received || !equalText(received, expected)) throw new DeliveryWebhookError("invalid_signature", "Invalid GitHub webhook signature");
  const deliveryId = header(headers, "x-github-delivery").trim();
  const event = header(headers, "x-github-event").trim();
  if (!deliveryId || !event) throw new DeliveryWebhookError("invalid_payload", "Missing GitHub webhook identity headers");
  return { deliveryId, event };
}

export function verifyGitlabWebhook(rawBody: Buffer, headers: IncomingHttpHeaders, secret: string, now = Date.now()): { deliveryId: string; event: string } {
  const signature = header(headers, "webhook-signature").trim();
  const deliveryId = (header(headers, "webhook-id") || header(headers, "idempotency-key") || header(headers, "x-gitlab-event-uuid")).trim();
  if (signature) {
    const timestamp = header(headers, "webhook-timestamp").trim();
    const numeric = Number(timestamp);
    if (!deliveryId) throw new DeliveryWebhookError("invalid_payload", "Missing GitLab webhook delivery ID");
    if (!Number.isFinite(numeric) || Math.abs(now - numeric * 1_000) > 5 * 60_000) throw new DeliveryWebhookError("invalid_timestamp", "Invalid or stale GitLab webhook timestamp");
    const encoded = secret.startsWith("whsec_") ? secret.slice(6) : secret;
    if (!/^[a-z0-9+/]+={0,2}$/i.test(encoded)) throw new Error("GitLab webhook signing secret configuration is invalid");
    const key = Buffer.from(encoded, "base64");
    if (!key.length || key.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) throw new Error("GitLab webhook signing secret configuration is invalid");
    const digest = crypto.createHmac("sha256", key).update(`${deliveryId}.${timestamp}.`).update(rawBody).digest("base64");
    if (!signature.split(/\s+/).some((entry) => equalText(entry, `v1,${digest}`))) throw new DeliveryWebhookError("invalid_signature", "Invalid GitLab webhook signature");
  } else {
    const received = header(headers, "x-gitlab-token");
    if (!received || !equalText(received, secret)) throw new DeliveryWebhookError("invalid_token", "Invalid legacy GitLab webhook token");
    if (!deliveryId) throw new DeliveryWebhookError("invalid_payload", "Missing GitLab webhook delivery ID");
  }
  const event = header(headers, "x-gitlab-event").trim();
  if (!event) throw new DeliveryWebhookError("invalid_payload", "Missing GitLab webhook event header");
  return { deliveryId, event };
}

export function verifyGiteaWebhook(rawBody: Buffer, headers: IncomingHttpHeaders, secret: string): { deliveryId: string; event: string } {
  const received = header(headers, "x-gitea-signature").trim();
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  if (!received || !equalText(received, expected)) throw new DeliveryWebhookError("invalid_signature", "Invalid Gitea webhook signature");
  const deliveryId = header(headers, "x-gitea-delivery").trim();
  const event = (header(headers, "x-gitea-event-type") || header(headers, "x-gitea-event")).trim();
  if (!deliveryId || !event) throw new DeliveryWebhookError("invalid_payload", "Missing Gitea webhook identity headers");
  return { deliveryId, event };
}
