import React from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileSearch,
  GitCompare,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { ConversationRunSummary, ReviewFinding } from "../types";
import { useI18n } from "../i18n";

interface ChangeSummaryProps {
  summary: ConversationRunSummary;
  expanded: boolean;
  onToggle: () => void;
  onOpenFile: (path: string) => void;
  onOpenDiff: (path: string) => void;
  onOpenLocation: (finding: ReviewFinding) => void;
  onRetry: () => void;
}

export const ChangeSummary: React.FC<ChangeSummaryProps> = ({
  summary,
  expanded,
  onToggle,
  onOpenFile,
  onOpenDiff,
  onOpenLocation,
  onRetry,
}) => {
  const { t } = useI18n();
  const findings = summary.reviewFindings || [];
  const failed = summary.errorCount > 0;

  return (
    <section className={`change-summary${expanded ? " expanded" : ""}`} aria-label={t("chat.completionSummary")}>
      <button type="button" className="change-summary-header" onClick={onToggle} aria-expanded={expanded}>
        <span className={`change-summary-outcome${failed ? " failed" : ""}`}>
          {failed ? <AlertCircle size={14} /> : <ShieldCheck size={14} />}
        </span>
        <span className="change-summary-title">
          <strong>{findings.length > 0 ? t("chat.reviewSummary") : t("chat.completionSummary")}</strong>
          <small>
            {t("chat.summaryFiles", { count: summary.changedFiles.length })}
            {findings.length > 0 ? ` · ${t("chat.reviewFindings", { count: findings.length })}` : ""}
          </small>
        </span>
        <span className={`chat-summary-status${failed ? " failed" : " completed"}`}>
          {t(`chat.taskStatus.${failed ? "failed" : "completed"}`)}
        </span>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>

      {expanded && (
        <div className="change-summary-body">
          <div className="change-summary-stats">
            <span>{t("chat.summaryCommands", { count: summary.commandCount })}</span>
            <span>{t("chat.summaryTools", { count: summary.toolCallCount })}</span>
            {failed && <span className="failed">{t("chat.summaryErrors", { count: summary.errorCount })}</span>}
          </div>

          {findings.length > 0 && (
            <div className="review-findings" aria-label={t("chat.reviewFindings", { count: findings.length })}>
              {findings.map((finding) => (
                <button
                  type="button"
                  className={`review-finding severity-${finding.severity}`}
                  key={finding.id}
                  onClick={() => onOpenLocation(finding)}
                >
                  <span className="review-finding-severity">{t(`chat.reviewSeverity.${finding.severity}`)}</span>
                  <span className="review-finding-copy">
                    <strong>{finding.message}</strong>
                    <code>{finding.path}:{finding.line}{finding.column ? `:${finding.column}` : ""}</code>
                  </span>
                  <ExternalLink size={12} />
                </button>
              ))}
            </div>
          )}

          {findings.length === 0 && summary.changedFiles.length === 0 && (
            <div className="change-summary-empty">
              <FileSearch size={16} />
              <span>{t("chat.noChanges")}</span>
            </div>
          )}

          {summary.changedFiles.length > 0 && (
            <div className="change-summary-files">
              {summary.changedFiles.map((path) => (
                <div className="change-summary-file" key={path}>
                  <button type="button" className="change-summary-file-diff" onClick={() => onOpenDiff(path)} title={`${t("git.openDiff")}: ${path}`}>
                    <GitCompare size={12} />
                    <code>{path}</code>
                  </button>
                  <button type="button" className="change-summary-file-open" onClick={() => onOpenFile(path)} title={`${t("git.openFile")}: ${path}`} aria-label={`${t("git.openFile")}: ${path}`}>
                    <ExternalLink size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {failed && (
            <button type="button" className="chat-summary-retry" onClick={onRetry}>
              <RotateCcw size={12} /> {t("chat.retryTask")}
            </button>
          )}
        </div>
      )}
    </section>
  );
};
