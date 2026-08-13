const SECRET_KEY = /^(?:api[_-]?key|access[_-]?token|token|password|passwd|secret|private[_-]?key|authorization|credential|cookie)$/i;
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----/gi;
const UNTERMINATED_PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/gi;
const BEARER_TOKEN = /\b(Bearer\s+)[A-Za-z0-9._~+\-/=]{8,}/gi;
const KEY_PREFIX = /\b(?:sk|pk)[_-][A-Za-z0-9_-]{8,}|\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9_-]{8,}|\bgithub_pat_[A-Za-z0-9_-]{8,}|\bxox(?:b|p|a|r)-[A-Za-z0-9-]{8,}|\bAKIA[A-Z0-9]{12,}\b/g;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi;
const QUERY_SECRET = /([?&](?:api[_-]?key|access[_-]?token|auth(?:orization)?|token|password|passwd|secret|credential)=[^&#\s]*)/gi;
const KEY_VALUE = /(^|[^A-Za-z0-9_])((?:api[_-]?key|access[_-]?token|auth(?:orization)?|token|password|passwd|secret|private[_-]?key|credential)\s*=\s*)[^\s,;&#]*/gim;

export const REDACTED = "[REDACTED]";

function redactString(value: string): string {
  return value
    .replace(PEM_BLOCK, REDACTED)
    .replace(UNTERMINATED_PEM, REDACTED)
    .replace(BEARER_TOKEN, `$1${REDACTED}`)
    .replace(KEY_PREFIX, REDACTED)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(QUERY_SECRET, (match) => `${match.slice(0, match.indexOf("=") + 1)}${REDACTED}`)
    .replace(KEY_VALUE, `$1$2${REDACTED}`);
}

/** Produces a redacted copy suitable for model prompts, logs, and artifacts. */
export function redactSecrets<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (typeof value === "string") return redactString(value) as T;
  if (!value || typeof value !== "object") return value;
  if (seen.has(value as object)) return seen.get(value as object) as T;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(redactSecrets(item, seen));
    return copy as T;
  }
  const copy: Record<string, unknown> = {};
  seen.set(value as object, copy);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = SECRET_KEY.test(key) ? REDACTED : redactSecrets(item, seen);
  }
  return copy as T;
}
