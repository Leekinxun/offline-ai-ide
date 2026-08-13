export interface ChangeEvidenceGap { path?: string; reason: string; }

const GAP_KEYS = new Set(["mutationEvidenceGaps", "changeEvidenceGaps"]);
const BLOCKED_STATUSES = new Set(["blocked", "incomplete", "needs_attention", "failed"]);

/** Collects persisted mutation/change evidence blockers from supported nested shapes. */
export function collectChangeEvidenceGaps(...sources: readonly unknown[]): ChangeEvidenceGap[] {
  const seen = new WeakSet<object>();
  const gaps: ChangeEvidenceGap[] = [];

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const entry of value) visit(entry); return; }
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (GAP_KEYS.has(key)) entries(nested, "mutation evidence gap");
      else if (key === "changeEvidence") entries(nested, "change evidence gap");
      else visit(nested);
    }
  };

  const entries = (value: unknown, fallbackReason: string): void => {
    if (value === true) { gaps.push({ reason: fallbackReason }); return; }
    if (typeof value === "string") { if (value.trim()) gaps.push({ reason: value.trim() }); return; }
    if (Array.isArray(value)) { for (const entry of value) entries(entry, fallbackReason); return; }
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    const reason = typeof record.reason === "string" && record.reason.trim() ? record.reason.trim() : fallbackReason;
    const evidencePath = typeof record.path === "string" && record.path.trim() ? record.path.trim() : undefined;
    const status = typeof record.status === "string" ? record.status.toLowerCase() : "";
    if (record.blocked === true || record.gap === true || BLOCKED_STATUSES.has(status) || record.reason || record.path) {
      gaps.push({ ...(evidencePath ? { path: evidencePath } : {}), reason });
    }
    for (const [key, nested] of Object.entries(record)) {
      if (GAP_KEYS.has(key)) entries(nested, "mutation evidence gap");
      else if (key === "changeEvidence") entries(nested, "change evidence gap");
      else if (!["reason", "path", "blocked", "gap", "status"].includes(key)) visit(nested);
    }
  };

  for (const source of sources) visit(source);
  const unique = new Map<string, ChangeEvidenceGap>();
  for (const gap of gaps) unique.set(`${gap.path || ""}\0${gap.reason}`, gap);
  return [...unique.values()];
}
