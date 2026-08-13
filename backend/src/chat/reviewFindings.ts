export type ReviewSeverity = "critical" | "error" | "warning" | "info";

export interface ReviewFinding {
  id: string;
  severity: ReviewSeverity;
  path: string;
  line: number;
  column?: number;
  message: string;
  fingerprint?: string;
  evidence?: string[];
  lifecycle?: ReviewFindingLifecycle;
  reviewer?: ReviewActor;
  /** Server-owned correlation. Model/tool payloads must not choose these values. */
  runId?: string;
  conversationId?: string;
  changeSetId?: string;
  reviewRunId?: string;
}

export type ReviewFindingLifecycle = "open" | "accepted" | "disputed" | "fixed" | "verified" | "dismissed";
export interface ReviewActor { id: string; modelName?: string; profile?: string; revision?: string; changeSetId?: string; reviewRunId?: string; }
export interface StructuredReviewFinding extends ReviewFinding {
  fingerprint: string;
  evidence: string[];
  lifecycle: ReviewFindingLifecycle;
  reviewer?: ReviewActor;
}

const REVIEW_FINDING_PATTERN =
  /^\s*(?:[-*]\s*)?\[(critical|error|warning|info|high|medium|low)\]\s+`?([^`\n]+?):(\d+)(?::(\d+))?`?\s*(?:—|–|-|:)+\s*(.+?)\s*$/i;

function normalizeSeverity(value: string): ReviewSeverity {
  switch (value.toLowerCase()) {
    case "critical":
    case "high":
      return "critical";
    case "error":
      return "error";
    case "medium":
    case "warning":
      return "warning";
    default:
      return "info";
  }
}

function normalizeFindingPath(value: string): string {
  return value
    .trim()
    .replace(/^\.\//, "")
    .replace(/\\/g, "/");
}

export function createReviewFingerprint(finding: Pick<ReviewFinding, "severity" | "path" | "line" | "column" | "message">): string {
  const canonical = `${finding.severity}|${normalizeFindingPath(finding.path).toLowerCase()}|${finding.line}|${finding.column || 0}|${finding.message.replace(/\s+/g, " ").trim().toLowerCase()}`;
  let hash = 2166136261;
  for (let index = 0; index < canonical.length; index += 1) hash = Math.imul(hash ^ canonical.charCodeAt(index), 16777619);
  return `rf-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** Compatibility parser for model prose plus the structured tool payload emitted by reviewers. */
export function normalizeReviewFinding(raw: unknown, fallbackId = "review-1"): StructuredReviewFinding | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<ReviewFinding> & { evidence?: unknown; lifecycle?: unknown; reviewer?: unknown };
  if (!(["critical", "error", "warning", "info"] as string[]).includes(String(value.severity)) || typeof value.path !== "string" || !value.path.trim() || !Number.isSafeInteger(value.line) || (value.line || 0) < 1 || typeof value.message !== "string" || !value.message.trim()) return null;
  const finding: ReviewFinding = { id: typeof value.id === "string" && value.id ? value.id.slice(0, 160) : fallbackId, severity: value.severity as ReviewSeverity, path: normalizeFindingPath(value.path).slice(0, 1000), line: value.line as number, ...(Number.isSafeInteger(value.column) && (value.column || 0) > 0 ? { column: value.column as number } : {}), message: value.message.trim().slice(0, 4000) };
  const evidence = Array.isArray(value.evidence) ? value.evidence.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map(item => item.trim().slice(0, 2000)).slice(0, 20) : [];
  if ((finding.severity === "critical" || finding.severity === "error") && evidence.length === 0) return null;
  const lifecycle = (["open", "accepted", "disputed", "fixed", "verified", "dismissed"] as string[]).includes(String(value.lifecycle)) ? value.lifecycle as ReviewFindingLifecycle : "open";
  const actor = value.reviewer && typeof value.reviewer === "object" ? value.reviewer as Partial<ReviewActor> : undefined;
  return { ...finding, fingerprint: typeof value.fingerprint === "string" && value.fingerprint ? value.fingerprint.slice(0, 160) : createReviewFingerprint(finding), evidence, lifecycle, ...(actor?.id ? { reviewer: { id: actor.id.slice(0, 160), ...(actor.modelName ? { modelName: actor.modelName.slice(0, 200) } : {}), ...(actor.profile ? { profile: actor.profile.slice(0, 160) } : {}), ...(actor.revision ? { revision: actor.revision.slice(0, 160) } : {}), ...(actor.changeSetId ? { changeSetId: actor.changeSetId.slice(0, 160) } : {}), ...(actor.reviewRunId ? { reviewRunId: actor.reviewRunId.slice(0, 160) } : {}) } } : {}) };
}

export function parseReviewFindings(content: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const seen = new Set<string>();

  for (const lineText of content.split(/\r?\n/)) {
    const match = lineText.match(REVIEW_FINDING_PATTERN);
    if (!match) continue;

    const path = normalizeFindingPath(match[2]);
    const line = Number(match[3]);
    const column = match[4] ? Number(match[4]) : undefined;
    const message = match[5].trim();
    if (!path || !message || !Number.isSafeInteger(line) || line < 1) continue;
    if (column !== undefined && (!Number.isSafeInteger(column) || column < 1)) continue;

    const severity = normalizeSeverity(match[1]);
    const key = `${severity}:${path}:${line}:${column || 0}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const base: ReviewFinding = {
      id: `review-${findings.length + 1}-${path}:${line}:${column || 0}`,
      severity,
      path,
      line,
      ...(column ? { column } : {}),
      message,
    };
    findings.push({ ...base, fingerprint: createReviewFingerprint(base), evidence: [], lifecycle: "open" });

    if (findings.length >= 100) break;
  }

  const severityRank: Record<ReviewSeverity, number> = {
    critical: 0,
    error: 1,
    warning: 2,
    info: 3,
  };
  return findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
}
