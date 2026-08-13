import type { DeliveryBinding, NormalizedCheck, NormalizedReviewFeedback, RemoteChangeRequest } from "./types.js";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const ENCODED_CONTROL = /%(?:0[0-9a-f]|1[0-9a-f]|7f|c2%8[0-9a-f]|c2%9[0-9a-f])/i;
const MALFORMED_PERCENT = /%(?![0-9a-f]{2})/i;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface ProviderWebUrlOptions {
  allowLoopbackHttp?: boolean;
}

function containsEncodedControl(value: string): boolean {
  let candidate = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (ENCODED_CONTROL.test(candidate)) return true;
    const decodedPercent = candidate.replace(/%25/gi, "%");
    if (decodedPercent === candidate) return false;
    candidate = decodedPercent;
  }
  return ENCODED_CONTROL.test(candidate);
}

export function normalizeProviderWebUrl(value: unknown, options: ProviderWebUrlOptions = {}): string | undefined {
  if (typeof value !== "string" || !value || value !== value.trim()) return undefined;
  if (CONTROL_CHARACTERS.test(value) || value.includes("\\") || MALFORMED_PERCENT.test(value) || containsEncodedControl(value)) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || !parsed.hostname) return undefined;
    const secure = parsed.protocol === "https:";
    const fixtureLoopback = options.allowLoopbackHttp === true && parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
    return secure || fixtureLoopback ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function firstProviderWebUrl(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = normalizeProviderWebUrl(value);
    if (normalized) return normalized;
  }
  return undefined;
}

export function requireProviderWebUrl(value: unknown, label: string): string {
  const normalized = normalizeProviderWebUrl(value);
  if (!normalized) throw new Error(`${label} returned an unsafe or malformed web URL`);
  return normalized;
}

export function normalizeRemoteChangeRequestUrl(remote: RemoteChangeRequest): RemoteChangeRequest {
  return { ...remote, url: requireProviderWebUrl(remote.url, "Delivery provider") };
}

export function normalizeCheckUrl(check: NormalizedCheck): NormalizedCheck {
  const { url: _url, ...rest } = check;
  const url = normalizeProviderWebUrl(check.url);
  return { ...rest, ...(url ? { url } : {}) };
}

export function normalizeReviewFeedbackUrl(feedback: NormalizedReviewFeedback): NormalizedReviewFeedback {
  const { url: _url, ...rest } = feedback;
  const url = normalizeProviderWebUrl(feedback.url);
  return { ...rest, ...(url ? { url } : {}) };
}

export function normalizeDeliveryBindingUrls(binding: DeliveryBinding): DeliveryBinding {
  return {
    ...binding,
    remote: normalizeRemoteChangeRequestUrl(binding.remote),
    checks: binding.checks.map(normalizeCheckUrl),
    feedback: binding.feedback.map(normalizeReviewFeedbackUrl),
  };
}
