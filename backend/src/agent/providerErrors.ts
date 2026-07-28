export interface ProviderHttpError {
  status: number;
  body: string;
}

export type ProviderErrorCode =
  | "context_overflow"
  | "rate_limit"
  | "authentication"
  | "model_not_found"
  | "server_error"
  | "timeout"
  | "invalid_request"
  | "network"
  | "response_parse";

export class ProviderRequestError extends Error {
  readonly code: ProviderErrorCode;
  readonly status?: number;
  readonly body?: string;
  readonly attempts: number;
  readonly retryable: boolean;

  constructor(options: {
    code: ProviderErrorCode;
    message: string;
    status?: number;
    body?: string;
    attempts?: number;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "ProviderRequestError";
    this.code = options.code;
    this.status = options.status;
    this.body = options.body;
    this.attempts = options.attempts || 1;
    this.retryable = options.retryable || false;
  }
}

const CONTEXT_OVERFLOW_PATTERNS = [
  /context(?:_|\s|-)*(?:length|window).*(?:exceed|overflow|maximum|limit|too long)/i,
  /maximum context length/i,
  /too many tokens/i,
  /prompt.*(?:too long|exceeds)/i,
  /input.*token.*(?:limit|maximum|exceed)/i,
];

/** Detect provider-specific context overflow responses without coupling the loop to one API vendor. */
export function isContextOverflowError(error: ProviderHttpError): boolean {
  if (![400, 413, 422].includes(error.status)) return false;
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(error.body));
}

export function classifyProviderHttpError(error: ProviderHttpError): {
  code: ProviderErrorCode;
  retryable: boolean;
} {
  if (isContextOverflowError(error)) {
    return { code: "context_overflow", retryable: false };
  }
  if (error.status === 401 || error.status === 403) {
    return { code: "authentication", retryable: false };
  }
  if (error.status === 404 && /model/i.test(error.body)) {
    return { code: "model_not_found", retryable: false };
  }
  if (error.status === 408) {
    return { code: "timeout", retryable: true };
  }
  if (error.status === 429) {
    return { code: "rate_limit", retryable: true };
  }
  if (error.status >= 500) {
    return { code: "server_error", retryable: true };
  }
  return { code: "invalid_request", retryable: false };
}

export function parseRetryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - now);
}
