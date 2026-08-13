import { redactSecrets } from "../../agent/secretRedaction.js";

export interface HttpResult<T> { status: number; data: T; headers: Headers; url: string; }
export interface ProviderHttpClientOptions {
  timeoutMs?: number;
  maxGetAttempts?: number;
  maxRetryDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class ProviderHttpError extends Error {
  constructor(readonly status: number, message: string, readonly headers: Record<string, string> = {}) { super(message); }
}
export class ProviderNetworkError extends Error {
  constructor(message: string, readonly requestMayHaveBeenSent: boolean) { super(message); }
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

function safeMessage(value: unknown, secrets: readonly string[]): string {
  let result = redactSecrets(value instanceof Error ? value.message : String(value));
  for (const secret of secrets) if (secret) result = result.split(secret).join("[REDACTED]");
  return result.slice(0, 1_000);
}

function headerObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of headers.entries()) result[key.toLowerCase()] = value;
  return result;
}

function retryDelay(headers: Headers, attempt: number, maximum: number): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const date = Date.parse(retryAfter);
    const ms = Number.isFinite(seconds) ? seconds * 1_000 : Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
    if (ms > 0) return Math.min(maximum, ms);
  }
  const reset = Number(headers.get("x-ratelimit-reset") || headers.get("ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return Math.min(maximum, Math.max(0, reset * 1_000 - Date.now()));
  return Math.min(maximum, 150 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 100));
}

export function nextLink(headers: Headers, baseUrl: string): string | undefined {
  const link = headers.get("link");
  if (!link) return undefined;
  const match = link.split(",").map((entry) => entry.trim()).find((entry) => /;\s*rel="?next"?\s*$/.test(entry));
  const raw = match?.match(/^<([^>]+)>/)?.[1];
  if (!raw) return undefined;
  const base = new URL(baseUrl);
  const target = new URL(raw, base);
  if (target.origin !== base.origin) throw new ProviderHttpError(502, "Provider pagination attempted to change origin");
  return target.toString();
}

export class ProviderHttpClient {
  private readonly base: URL;
  private readonly timeoutMs: number;
  private readonly maxGetAttempts: number;
  private readonly maxRetryDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(baseUrl: string, options: ProviderHttpClientOptions = {}) {
    this.base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    if (!/^https?:$/.test(this.base.protocol) || this.base.username || this.base.password) throw new Error("Delivery provider baseUrl must be an HTTP(S) URL without userinfo");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxGetAttempts = options.maxGetAttempts ?? 3;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  resolve(pathOrUrl: string): URL {
    const target = new URL(pathOrUrl.replace(/^\//, ""), this.base);
    if (target.origin !== this.base.origin) throw new ProviderHttpError(400, "Provider request attempted to change origin");
    const basePath = this.base.pathname.replace(/\/$/, "");
    if (basePath && !target.pathname.startsWith(`${basePath}/`) && target.pathname !== basePath) throw new ProviderHttpError(400, "Provider request escaped configured API base path");
    return target;
  }

  async request<T>(input: { method?: string; path: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal; explicitSecrets?: readonly string[] }): Promise<HttpResult<T>> {
    const method = (input.method || "GET").toUpperCase();
    const safe = method === "GET" || method === "HEAD";
    const attempts = safe ? this.maxGetAttempts : 1;
    const secrets = input.explicitSecrets || [];
    let target = this.resolve(input.path);
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(target, {
          method,
          headers: { Accept: "application/json", ...(input.body === undefined ? {} : { "Content-Type": "application/json" }), ...(input.headers || {}) },
          ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
          signal: input.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal,
          redirect: "manual",
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!safe || !location) throw new ProviderHttpError(response.status, "Unsafe or incomplete provider redirect denied", headerObject(response.headers));
          const redirected = new URL(location, target);
          if (redirected.origin !== this.base.origin) throw new ProviderHttpError(response.status, "Cross-origin provider redirect denied", headerObject(response.headers));
          target = this.resolve(redirected.toString());
          if (attempt < attempts) continue;
          throw new ProviderHttpError(response.status, "Provider redirect limit exceeded", headerObject(response.headers));
        }
        const text = await response.text();
        if (!response.ok) {
          const error = new ProviderHttpError(response.status, `Provider request failed (${response.status}): ${safeMessage(text, secrets)}`, headerObject(response.headers));
          if (safe && attempt < attempts && RETRYABLE.has(response.status)) {
            lastError = error;
            await this.sleep(retryDelay(response.headers, attempt, this.maxRetryDelayMs));
            continue;
          }
          throw error;
        }
        let data: unknown = undefined;
        if (text.trim()) {
          try { data = JSON.parse(text); }
          catch { throw new ProviderHttpError(502, "Provider returned invalid JSON", headerObject(response.headers)); }
        }
        return { status: response.status, data: data as T, headers: response.headers, url: target.toString() };
      } catch (error) {
        if (error instanceof ProviderHttpError) throw error;
        lastError = error;
        if (input.signal?.aborted) throw new ProviderNetworkError("Provider request aborted", !safe);
        if (safe && attempt < attempts) {
          await this.sleep(Math.min(this.maxRetryDelayMs, 150 * (2 ** (attempt - 1))));
          continue;
        }
        throw new ProviderNetworkError(safeMessage(error, secrets), !safe);
      } finally { clearTimeout(timer); }
    }
    throw lastError instanceof Error ? lastError : new ProviderNetworkError("Provider request failed", !safe);
  }
}
