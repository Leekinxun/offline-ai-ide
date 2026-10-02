export const MIN_PROCESS_TIMEOUT_MINUTES = 1;
export const MAX_PROCESS_TIMEOUT_MINUTES = 1440;
export const DEFAULT_PROCESS_TIMEOUT_MINUTES = 10;
export const PROCESS_TIMEOUT_STEP_MINUTES = 1;

const RUNNING_STATUS = "running";

export interface ProcessSessionTimingInput {
  status: string;
  timeoutMs?: number | null;
  deadlineAt?: number | null;
}

export interface ProcessSessionTiming {
  hasRecordedDeadline: boolean;
  timeoutMs?: number;
  deadlineAt?: number;
  remainingMs?: number;
  expired: boolean;
}

export interface NormalizedProcessTimeout {
  minutes: number;
  timeoutMs: number;
  valid: boolean;
}

export interface ProcessSessionStartPolicyInput {
  readOnly: boolean;
  busy: boolean;
  hasTask: boolean;
  timeoutMinutes: unknown;
  currentScope: string;
  expectedScope: string | null | undefined;
}

function parseTimeoutMinutes(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

export function normalizeProcessTimeoutMinutes(value: unknown): NormalizedProcessTimeout {
  const parsed = parseTimeoutMinutes(value);
  const valid = parsed !== null && parsed >= MIN_PROCESS_TIMEOUT_MINUTES && parsed <= MAX_PROCESS_TIMEOUT_MINUTES;
  const minutes = valid ? parsed : DEFAULT_PROCESS_TIMEOUT_MINUTES;
  return { minutes, timeoutMs: minutes * 60_000, valid };
}

export function getProcessSessionTiming(session: ProcessSessionTimingInput | null | undefined, now = Date.now()): ProcessSessionTiming {
  const deadlineAt = typeof session?.deadlineAt === "number" && Number.isFinite(session.deadlineAt)
    ? session.deadlineAt
    : undefined;
  const timeoutMs = typeof session?.timeoutMs === "number" && Number.isFinite(session.timeoutMs) && session.timeoutMs > 0
    ? session.timeoutMs
    : undefined;
  if (deadlineAt === undefined) return { hasRecordedDeadline: false, expired: false };
  const remainingMs = Math.max(0, deadlineAt - now);
  return {
    hasRecordedDeadline: true,
    timeoutMs,
    deadlineAt,
    remainingMs,
    expired: session?.status === RUNNING_STATUS && remainingMs === 0,
  };
}

export function canStartProcessSession(input: ProcessSessionStartPolicyInput): boolean {
  if (input.readOnly || input.busy || !input.hasTask) return false;
  if (!input.expectedScope || input.currentScope !== input.expectedScope) return false;
  return normalizeProcessTimeoutMinutes(input.timeoutMinutes).valid;
}
