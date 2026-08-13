import React, { useMemo, useState } from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  FileSearch,
  GitCompare,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { ConversationRunSummary, ReviewFinding, ReviewFindingLifecycle } from "../types";
import { useI18n } from "../i18n";
import { allowedFindingTransitions, useFindings } from "../hooks/useFindings";

interface ChangeSummaryProps {
  token: string;
  runId?: string;
  summary: ConversationRunSummary;
  expanded: boolean;
  onToggle: () => void;
  onOpenFile: (path: string) => void;
  onOpenDiff: (path: string) => void;
  onOpenLocation: (finding: ReviewFinding) => void;
  onRetry: () => void;
  onPlanAmendmentDecision: (planId: string, amendmentId: string, decision: "approved" | "rejected") => Promise<void> | void;
}

export const ChangeSummary: React.FC<ChangeSummaryProps> = ({
  token,
  runId,
  summary,
  expanded,
  onToggle,
  onOpenFile,
  onOpenDiff,
  onOpenLocation,
  onRetry,
  onPlanAmendmentDecision,
}) => {
  const { t } = useI18n();
  const { findings: serverFindings, available: findingsAvailable, transition, transitioningIds, transitionErrors, exportFindings } = useFindings(token, { runId });
  const findings = findingsAvailable && serverFindings.length > 0 ? serverFindings : summary.reviewFindings || [];
  const serverLifecycle = findingsAvailable && serverFindings.length > 0;
  const [findingFilter, setFindingFilter] = useState<"all" | "needs_action" | ReviewFindingLifecycle>("all");
  const [findingAction, setFindingAction] = useState<{ finding: ReviewFinding; to: ReviewFindingLifecycle; reason: string; fixRef: string; evidence: string } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const visibleFindings = useMemo(() => findings.filter((finding) => {
    const status = finding.lifecycle || "open";
    return findingFilter === "all" || (findingFilter === "needs_action" ? !["verified", "dismissed"].includes(status) : status === findingFilter);
  }), [findingFilter, findings]);
  const evidence = summary.completionEvidence;
  const failed = evidence ? ["failed", "validation_failed"].includes(evidence.outcome) : summary.errorCount > 0;
  const successful = evidence ? evidence.outcome === "completed" : summary.errorCount === 0;
  const pendingAmendments = summary.executionPlan?.amendmentRequests?.filter((item) => item.status === "pending") || [];

  return (
    <section className={`change-summary${expanded ? " expanded" : ""}`} aria-label={t("chat.completionSummary")}>
      <button type="button" className="change-summary-header" onClick={onToggle} aria-expanded={expanded}>
        <span className={`change-summary-outcome${successful ? "" : " failed"}`}>
          {successful ? <ShieldCheck size={14} /> : <AlertCircle size={14} />}
        </span>
        <span className="change-summary-title">
          <strong>{findings.length > 0 ? t("chat.reviewSummary") : t("chat.completionSummary")}</strong>
          <small>
            {t("chat.summaryFiles", { count: summary.changedFiles.length })}
            {findings.length > 0 ? ` · ${t("chat.reviewFindings", { count: findings.length })}` : ""}
          </small>
        </span>
        <span className={`chat-summary-status${successful ? " completed" : " failed"}`}>
          {evidence ? t(`chat.outcome.${evidence.outcome}`) : t(`chat.taskStatus.${failed ? "failed" : "completed"}`)}
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
          {evidence && <div className="run-check-list" aria-label={t("chat.evidence") }>
            <div><CheckIcon /><span>{t("chat.outcome")}</span><strong>{t(`chat.outcome.${evidence.outcome}`)}</strong></div>
            {evidence.ledger.verification.map((check, index) => <div key={`${check.command}-${index}`} className={check.status === "passed" ? "" : "warning"}><CheckIcon /><span><code>{check.command}</code><small>{check.toolCallId || "—"} · {check.outputDigest || "—"}</small></span><strong>{t(`chat.verification.${check.status}`)}{check.exitCode !== undefined ? ` (${check.exitCode})` : ""}</strong></div>)}
            {evidence.ledger.criteria.map((criterion, index) => <div key={`${criterion.criterion}-${index}`} className={criterion.state === "passed" ? "" : "warning"}><CheckIcon /><span>{criterion.criterion}<small>{criterion.evidenceRefs.join(", ") || "—"}</small></span><strong>{t(`chat.criterion.${criterion.state}`)}</strong></div>)}
            {evidence.ledger.blockers.map((blocker) => <div className="warning" key={blocker}><AlertCircle size={14} /><span>{t("chat.blocker")}</span><strong>{blocker}</strong></div>)}
          </div>}
          {pendingAmendments.map((amendment) => <div className="change-summary-empty" key={amendment.id}>
            <AlertCircle size={16} /><span><strong>{t("chat.amendmentPending")}</strong><small>{amendment.reason}<br />{amendment.requestedFiles.join(", ")}<br />{amendment.requestedVerificationCommands.join(", ")}</small></span>
            <button type="button" aria-label={`${t("chat.approve")}: ${amendment.reason}`} onClick={() => void onPlanAmendmentDecision(summary.executionPlan!.id, amendment.id, "approved")}>{t("chat.approve")}</button>
            <button type="button" aria-label={`${t("chat.reject")}: ${amendment.reason}`} onClick={() => void onPlanAmendmentDecision(summary.executionPlan!.id, amendment.id, "rejected")}>{t("chat.reject")}</button>
          </div>)}

          {findings.length > 0 && (
            <div className="review-findings" aria-label={t("chat.reviewFindings", { count: findings.length })}>
              <div className="review-findings-toolbar" role="group" aria-label={t("chat.reviewFilter")}>
                {(["all", "needs_action", "open", "accepted", "disputed", "fixed", "verified", "dismissed"] as const).map((filter) => <button key={filter} type="button" className={findingFilter === filter ? "active" : ""} aria-pressed={findingFilter === filter} onClick={() => setFindingFilter(filter)}>{t(`chat.reviewFilter.${filter}`)}</button>)}
                {serverLifecycle && <span className="review-export-actions"><button type="button" onClick={() => { setExportError(null); void exportFindings("crewforge").catch((error) => setExportError(error instanceof Error ? error.message : t("chat.reviewExportFailed"))); }}><Download size={12} />JSON</button><button type="button" onClick={() => { setExportError(null); void exportFindings("sarif").catch((error) => setExportError(error instanceof Error ? error.message : t("chat.reviewExportFailed"))); }}><Download size={12} />SARIF</button></span>}
              </div>
              {exportError && <div className="delivery-inline-error" role="alert">{exportError}</div>}
              {visibleFindings.map((finding) => {
                const status = finding.lifecycle || "open";
                return <div className={`review-finding severity-${finding.severity}`} key={finding.id}>
                  <button type="button" className="review-finding-main" onClick={() => onOpenLocation(finding)}>
                  <span className="review-finding-severity">{t(`chat.reviewSeverity.${finding.severity}`)}</span>
                  <span className="review-finding-copy">
                    <strong>{finding.message}</strong>
                    <code>{finding.path}:{finding.line}{finding.column ? `:${finding.column}` : ""}</code>
                    {(finding.reviewer || finding.revision || finding.evidence?.length || finding.verifier) && <small>{[finding.reviewer?.id, finding.verifier?.id ? t("chat.reviewVerifiedBy", { reviewer: finding.verifier.id }) : "", finding.revision, finding.evidence?.length ? t("chat.reviewEvidence", { count: finding.evidence.length }) : ""].filter(Boolean).join(" · ")}</small>}
                    {finding.dismissalReason && <small>{t("chat.reviewDismissalReason", { reason: finding.dismissalReason })}</small>}
                  </span>
                  <ExternalLink size={12} />
                  </button>
                  {serverLifecycle && <div className="review-finding-lifecycle"><span>{t(`chat.reviewStatus.${status}`)}</span>{allowedFindingTransitions(finding).filter((to) => to !== "verified").map((to) => <button key={to} type="button" disabled={transitioningIds.has(finding.id)} onClick={() => setFindingAction({ finding, to, reason: "", fixRef: "", evidence: "" })}>{t(`chat.reviewAction.${to}`)}</button>)}{status === "fixed" && <small>{t("chat.reviewNeedsReverify")}</small>}</div>}
                  {transitionErrors[finding.id] && <div className="delivery-inline-error" role="alert">{transitionErrors[finding.id]}</div>}
                </div>;
              })}
              {!visibleFindings.length && <div className="change-summary-empty">{t("chat.reviewNoMatches")}</div>}
            </div>
          )}

          {findingAction && <section className="review-transition-form" role="dialog" aria-modal="false" aria-labelledby="review-transition-title">
            <strong id="review-transition-title">{t("chat.reviewTransitionTitle", { status: t(`chat.reviewStatus.${findingAction.to}`) })}</strong>
            {["disputed", "dismissed"].includes(findingAction.to) && <label><span>{t("chat.reviewReason")}</span><textarea className="dialog-input" value={findingAction.reason} onChange={(event) => setFindingAction((current) => current ? { ...current, reason: event.target.value } : current)} /></label>}
            {findingAction.to === "fixed" && <><label><span>{t("chat.reviewFixRef")}</span><input className="dialog-input" value={findingAction.fixRef} onChange={(event) => setFindingAction((current) => current ? { ...current, fixRef: event.target.value } : current)} placeholder="commit / patch / file:line" /></label><label><span>{t("chat.reviewEvidenceInput")}</span><textarea className="dialog-input" value={findingAction.evidence} onChange={(event) => setFindingAction((current) => current ? { ...current, evidence: event.target.value } : current)} /></label></>}
            <div><button type="button" className="dialog-btn" onClick={() => setFindingAction(null)}>{t("common.cancel")}</button><button type="button" className="dialog-btn primary" disabled={transitioningIds.has(findingAction.finding.id) || (["disputed", "dismissed"].includes(findingAction.to) && !findingAction.reason.trim()) || (findingAction.to === "fixed" && !findingAction.fixRef.trim())} onClick={() => { const action = findingAction; void transition(action.finding, action.to, { ...(action.reason.trim() ? { reason: action.reason.trim() } : {}), ...(action.fixRef.trim() ? { fixRef: action.fixRef.trim() } : {}), ...(action.evidence.trim() ? { evidence: action.evidence.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) } : {}) }).then(() => setFindingAction(null)).catch((error) => setExportError(error instanceof Error ? error.message : t("chat.reviewTransitionFailed"))); }}>{t("common.confirm")}</button></div>
          </section>}

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

function CheckIcon() { return <ShieldCheck size={14} />; }
