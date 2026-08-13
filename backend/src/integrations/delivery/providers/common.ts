import crypto from "node:crypto";
import type { DeliveryProviderConfig, PageCursor, ProviderHealth, RepositoryRef } from "../types.js";
import { DeliveryUnavailableError } from "../types.js";
import type { ProviderHttpClient } from "../httpClient.js";
import { ProviderHttpError } from "../httpClient.js";

export function requiredToken(config: DeliveryProviderConfig): string {
  const token = process.env[config.tokenEnv];
  if (!token) throw new DeliveryUnavailableError("unauthorized", `Delivery token environment variable is not set: ${config.tokenEnv}`);
  return token;
}
export function repoParts(repository: RepositoryRef): { owner: string; name: string } {
  if (repository.owner && repository.name) return { owner: repository.owner, name: repository.name };
  const parts = repository.remoteRepositoryId.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("Repository owner/name is required");
  return { owner: parts.slice(0, -1).join("/"), name: parts.at(-1)! };
}
export function query(path: string, values: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  return `${path}${params.size ? `?${params}` : ""}`;
}
export function pagePath(client: ProviderHttpClient, cursor: PageCursor | undefined, fallback: string): string {
  return cursor?.value ? client.resolve(cursor.value).toString() : fallback;
}
export function opaqueCursor(value: string | undefined): PageCursor | undefined { return value ? { value } : undefined; }
export function digest(value: unknown): string { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function healthFromError(error: unknown): ProviderHealth {
  if (error instanceof DeliveryUnavailableError) return error.health;
  if (error instanceof ProviderHttpError) {
    if (error.status === 401) return "unauthorized";
    if (error.status === 429 || (error.status === 403 && (error.headers["retry-after"] || error.headers["x-ratelimit-remaining"] === "0"))) return "rate_limited";
    if (error.status === 404 || error.status === 410) return "unsupported";
    return error.status >= 500 ? "degraded" : "offline";
  }
  return "offline";
}
export function text(value: unknown): string { return typeof value === "string" ? value : ""; }
export function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0; }
