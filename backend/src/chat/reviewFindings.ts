export type ReviewSeverity = "critical" | "error" | "warning" | "info";

export interface ReviewFinding {
  id: string;
  severity: ReviewSeverity;
  path: string;
  line: number;
  column?: number;
  message: string;
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

    findings.push({
      id: `review-${findings.length + 1}-${path}:${line}:${column || 0}`,
      severity,
      path,
      line,
      ...(column ? { column } : {}),
      message,
    });

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
