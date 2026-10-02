import type { ExecutionFactsSummary } from "../types";

interface ExecutionFactsCardProps {
  facts?: ExecutionFactsSummary | null;
  t: (key: string, values?: Record<string, string | number>) => string;
}

const MAX_VISIBLE_RANGES = 20;
const knownNumber = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Displays server-recorded metadata; assistant text never supplies these counts. */
export function ExecutionFactsCard({ facts, t }: ExecutionFactsCardProps) {
  const complete = facts?.schemaVersion === 1 && facts.completeness === "complete"
    && [facts.toolCalls, facts.successfulToolCalls, facts.failedToolCalls, facts.deniedToolCalls, facts.fileReads,
      facts.duplicateFileReads, facts.pagedFileReads, facts.updatedFileReads, facts.unclassifiedFileReads,
      facts.compactions?.summaryCount, facts.compactions?.failedCount, facts.compactions?.fallbackTrimCount].every(knownNumber)
    && Array.isArray(facts.readRanges);
  const validCount = (value: unknown): string | number => knownNumber(value) ? complete ? value : t("chat.executionFacts.knownCount", { count: value }) : "—";
  const ranges = Array.isArray(facts?.readRanges) ? facts.readRanges
    .filter((read) => read && typeof read.path === "string" && typeof read.version === "string" && knownNumber(read.start) && knownNumber(read.end) && read.end >= read.start && knownNumber(read.count) && read.count > 0)
    .sort((a, b) => Number(b.count > 1) - Number(a.count > 1)) : [];
  const visibleRanges = ranges.slice(0, MAX_VISIBLE_RANGES);
  const last = facts?.compactions?.last;
  const hasFallback = knownNumber(facts?.compactions?.fallbackTrimCount) && facts.compactions.fallbackTrimCount > 0;
  const hasRepeat = knownNumber(facts?.duplicateFileReads) && facts.duplicateFileReads > 0;
  const warning = !complete || hasFallback || hasRepeat;
  const summary = complete ? t("chat.executionFacts.summary", { reads: facts.fileReads, duplicates: facts.duplicateFileReads, summaries: facts.compactions.summaryCount }) : t("chat.executionFacts.unknown");
  const metrics: Array<{ key: string; value: unknown; hint?: string }> = [
    { key: "reads", value: facts?.fileReads },
    { key: "duplicates", value: facts?.duplicateFileReads },
    { key: "pages", value: facts?.pagedFileReads, hint: "pagesHint" },
    { key: "versions", value: facts?.updatedFileReads },
    { key: "summarySuccess", value: facts?.compactions?.summaryCount },
    { key: "summaryFailed", value: facts?.compactions?.failedCount },
    { key: "fallbacks", value: facts?.compactions?.fallbackTrimCount },
  ];
  if (knownNumber(facts?.unclassifiedFileReads) && facts.unclassifiedFileReads > 0) metrics.push({ key: "unclassified", value: facts.unclassifiedFileReads });

  return <details className={`execution-facts-card${warning ? " warning" : ""}`} data-completeness={complete ? "complete" : "unknown"}>
    <summary>
      <span className="execution-facts-heading"><strong>{t("chat.executionFacts.title")}</strong><small>{summary}</small></span>
      <span className={`execution-facts-badge${complete ? "" : " unknown"}`}>{t(complete ? "chat.executionFacts.complete" : "chat.executionFacts.unknown")}</span>
    </summary>
    <div className="execution-facts-body">
      {!complete && <p className="execution-facts-notice" role="status">{t("chat.executionFacts.unknownHint")}</p>}
      <dl className="execution-facts-metrics">
        {metrics.map(({ key, value, hint }) => <div key={key}>
          <dt title={hint ? t(`chat.executionFacts.${hint}`) : undefined}>{t(`chat.executionFacts.${key}`)}</dt>
          <dd>{validCount(value)}</dd>
        </div>)}
      </dl>
      {last && ["summary", "fallback_trim", "failed"].includes(last.outcome) && <div className="execution-facts-last">
        <strong>{t("chat.executionFacts.lastCompaction")}</strong>
        <span>{t(`chat.executionFacts.outcome.${last.outcome}`)}</span>
        <code>{t("chat.executionFacts.tokens", { before: knownNumber(last.tokensBefore) ? last.tokensBefore : "—", after: knownNumber(last.tokensAfter) ? last.tokensAfter : "—" })}</code>
      </div>}
      {visibleRanges.length > 0 && <div className="execution-facts-ranges">
        <strong>{t("chat.executionFacts.ranges")}</strong>
        <ol>
          {visibleRanges.map((read, index) => <li key={`${read.path}-${read.version}-${read.start}-${read.end}-${index}`} className={read.count > 1 ? "repeated" : undefined}>
            <code className="execution-facts-path">{read.path}</code>
            <span>{t("chat.executionFacts.range", { start: read.start, end: read.end })} · {t("chat.executionFacts.count", { count: read.count })}</span>
            <code className="execution-facts-version" title={read.version}>{read.version}</code>
            <code className="execution-facts-tool" title={read.firstToolCallId === read.lastToolCallId ? read.firstToolCallId : `${read.firstToolCallId} → ${read.lastToolCallId}`}>{read.firstToolCallId}{read.firstToolCallId !== read.lastToolCallId ? ` → ${read.lastToolCallId}` : ""}</code>
          </li>)}
        </ol>
        {ranges.length > MAX_VISIBLE_RANGES && <small>{t("chat.executionFacts.shown", { shown: MAX_VISIBLE_RANGES, total: ranges.length })}</small>}
      </div>}
      <small className="execution-facts-source">{t("chat.executionFacts.source")}</small>
    </div>
  </details>;
}
