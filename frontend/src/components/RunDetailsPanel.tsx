import React, { useRef, useState } from "react";
import { AlertCircle, Check, ChevronRight, Download, ExternalLink, FileCode2, GitPullRequest, Network, TerminalSquare, Trash2, X } from "lucide-react";
import { AgentRunState, CausalTraceEvent, ConversationRunSummary } from "../types";
import { useI18n } from "../i18n";
import { useTrace } from "../hooks/useTrace";
import { ContextInspector } from "./ContextInspector";
import type { ContextManifestController } from "../hooks/useContextManifest";
import { useGitDelivery } from "../hooks/useGitDelivery";
import { useProviderDelivery } from "../hooks/useProviderDelivery";
import { DeliveryOperationCard } from "./DeliveryOperationCard";
import { TaskStateStrip, type TaskStateTone } from "./TaskStateStrip";
import { ActionConfirmDialog, type ActionConfirmIntent } from "./ActionConfirmDialog";
import { SafeExternalLink } from "./SafeExternalLink";
import "./RunDetailsPanel.css";

interface RunDetailsPanelProps {
  token: string;
  workspaceDir: string;
  visible: boolean;
  summary: ConversationRunSummary | null;
  runState: AgentRunState | null;
  errorCount: number;
  warningCount: number;
  contextManifest: ContextManifestController;
  activeTab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
  onOpenFile: (path: string) => void;
  onOpenDiff: (path: string) => void;
  onClose: () => void;
}

export type DetailTab = "changes" | "checks" | "delivery" | "context" | "trace" | "terminal";

function traceEventFailed(event: CausalTraceEvent): boolean {
  return event.kind === "error" || event.decision === "blocked" || event.metadata?.blocked === true || event.metadata?.ok === false;
}

export const RunDetailsPanel: React.FC<RunDetailsPanelProps> = ({
  token,
  workspaceDir,
  visible,
  summary,
  runState,
  errorCount,
  warningCount,
  contextManifest,
  activeTab,
  onTabChange,
  onOpenFile,
  onOpenDiff,
  onClose,
}) => {
  const { t } = useI18n();
  const trace = useTrace(token, runState?.runId, visible);
  const gitDelivery = useGitDelivery(token, workspaceDir, visible && activeTab === "delivery");
  const providerDelivery = useProviderDelivery(token, workspaceDir, visible && activeTab === "delivery");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [confirmIntent, setConfirmIntent] = useState<ActionConfirmIntent | null>(null);
  const [traceActionError, setTraceActionError] = useState<string | null>(null);
  if (!visible) return null;

  const changedFiles = summary?.changedFiles || [];
  const evidence = runState?.completionEvidence || summary?.completionEvidence;
  const qualityGate = runState?.qualityGate || summary?.qualityGate;
  const evidenceOutcome = qualityGate?.status === "blocked" || (runState?.status === "failed" && evidence?.outcome === "completed") ? "failed" : evidence?.outcome;
  const liveEvents = runState?.events || [];
  const events: CausalTraceEvent[] = trace.available ? trace.events : liveEvents.map((event) => ({ eventId: event.id, timestamp: event.timestamp, kind: event.kind === "tool_call" || event.kind === "tool_result" ? "tool" : event.kind === "error" ? "error" : "agent", action: event.label, correlationId: event.requestId || event.id, runId: runState?.runId, evidence: event.detail, toolCallId: event.toolName }));
  const tabs: DetailTab[] = ["changes", "checks", "delivery", "context", "trace", "terminal"];
  const runTone: TaskStateTone = runState?.status === "running" || runState?.status === "queued" ? "running" : runState?.status === "completed" ? "success" : runState?.status === "failed" ? "danger" : "warning";
  const evidenceCount = (evidence?.ledger.verification.length || 0) + (evidence?.ledger.criteria.length || 0) + changedFiles.length + events.length;
  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault(); onTabChange(tabs[next]); tabRefs.current[next]?.focus();
  };
  return (
    <aside className="run-details-panel" aria-label={t("workbench.runDetails")}> 
      <header className="run-details-header">
        <div className="run-details-header-title">
          <strong>{t("workbench.runDetails")}</strong>
          <span className={`run-details-status-badge tone-${runTone}`}>
            {runState ? t(`chat.taskStatus.${runState.status}`) : t("workbench.ready")}
          </span>
        </div>
        <button type="button" className="run-details-close-btn" onClick={onClose} aria-label={t("common.close")} title={t("common.close")}>
          <X size={15} />
        </button>
      </header>
      <TaskStateStrip requested={`${t(`chat.mode.${runState?.mode || "code"}.label`)} · ${runState?.executionContractKind ? t(`chat.contract.${runState.executionContractKind}`) : t("taskState.directRequest")}`} running={runState ? t(`chat.taskStatus.${runState.status}`) : t("taskState.ready")} runningTone={runTone} evidence={evidenceCount ? t("taskState.evidenceCount", { count: evidenceCount }) : t("taskState.noEvidence")} evidenceTone={evidenceOutcome === "failed" ? "danger" : evidenceCount ? "success" : "neutral"} action={t("workbench.details.checks")} onAction={() => onTabChange("checks")} compact />
      <div className="run-details-tabs" role="tablist" aria-label={t("workbench.runDetails")}>
        {tabs.map((tab, index) => (
          <button
            ref={(node) => { tabRefs.current[index] = node; }}
            id={`run-details-tab-${tab}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            aria-controls={`run-details-${tab}`}
            tabIndex={activeTab === tab ? 0 : -1}
            className={activeTab === tab ? "active" : ""}
            onClick={() => onTabChange(tab)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
            key={tab}
          >
            {t(`workbench.details.${tab}`)}
          </button>
        ))}
      </div>

      {activeTab === "changes" && (
        <div id="run-details-changes" role="tabpanel" aria-labelledby="run-details-tab-changes" className="run-details-body">
          <div className="run-details-section-bar">
            <span className="run-details-section-title">
              <FileCode2 size={13} />
              {t("workbench.changedFiles")}
            </span>
            <span className="run-details-count-chip">{changedFiles.length}</span>
          </div>
          {changedFiles.length === 0 ? (
            <div className="run-details-empty">{t("chat.noChanges")}</div>
          ) : (
            <div className="run-details-file-list">
              {changedFiles.map((path) => (
                <button type="button" key={path} className="run-details-file-item" onClick={() => onOpenDiff(path)}>
                  <FileCode2 size={14} className="file-icon" />
                  <span className="file-info">
                    <strong>{path.split("/").pop()}</strong>
                    <small>{path}</small>
                  </span>
                  <span className="file-badge state-m">M</span>
                  <ChevronRight size={13} className="file-chevron" />
                </button>
              ))}
            </div>
          )}
          {changedFiles.length > 0 && (
            <div className="run-details-action-group">
              <button
                type="button"
                className="run-details-open-file"
                onClick={() => changedFiles[0] && onOpenFile(changedFiles[0])}
              >
                {t("workbench.openFirstChange")}
              </button>
            </div>
          )}
        </div>
      )}

      {activeTab === "checks" && (
        <div id="run-details-checks" role="tabpanel" aria-labelledby="run-details-tab-checks" className="run-details-body run-check-page">
          <div className={`run-outcome-card tone-${evidenceOutcome === "completed" ? "success" : evidenceOutcome === "failed" ? "danger" : "warning"}`} role={evidenceOutcome === "completed" ? undefined : "alert"}>
            <div className="run-outcome-icon">
              {evidenceOutcome === "completed" ? <Check size={18} /> : <AlertCircle size={18} />}
            </div>
            <div className="run-outcome-info">
              <strong>{evidenceOutcome ? t(`chat.outcome.${evidenceOutcome}`) : t("workbench.ready")}</strong>
              <span>
                {qualityGate ? `${t("chat.qualityGate")}: ${t(`chat.qualityGate.${qualityGate.status}`)}` : t("chat.outcome")}
                {qualityGate?.error && ` · ${qualityGate.error}`}
              </span>
            </div>
          </div>

          <div className="run-metrics-grid">
            <div className="run-metric-card">
              <span>{t("workbench.toolCalls")}</span>
              <strong>{summary?.toolCallCount || 0}</strong>
            </div>
            <div className="run-metric-card">
              <span>{t("workbench.commands")}</span>
              <strong>{summary?.commandCount || 0}</strong>
            </div>
            <div className={`run-metric-card ${errorCount ? "tone-danger" : ""}`}>
              <span>{t("problems.error")}</span>
              <strong>{errorCount}</strong>
            </div>
            <div className={`run-metric-card ${warningCount ? "tone-warning" : ""}`}>
              <span>{t("problems.warning")}</span>
              <strong>{warningCount}</strong>
            </div>
          </div>

          {evidence?.ledger.blockers.map((blocker) => (
            <div className="run-check-item tone-danger" key={blocker}>
              <span className="run-check-item-icon"><X size={14} /></span>
              <div className="run-check-item-content">
                <strong>{t("chat.blocker")}</strong>
                <small>{blocker}</small>
              </div>
            </div>
          ))}

          {evidence && evidence.ledger.verification.length > 0 && (
            <div className="run-check-section">
              <div className="run-details-section-bar">
                <span className="run-details-section-title">{t("taskState.evidence")}</span>
                <span className="run-details-count-chip">{evidence.ledger.verification.length}</span>
              </div>
              {evidence.ledger.verification.map((check, index) => (
                <div className={`run-check-item ${check.status === "passed" ? "tone-success" : "tone-warning"}`} key={`${check.command}-${index}`}>
                  <span className="run-check-item-icon">
                    {check.status === "passed" ? <Check size={14} /> : <AlertCircle size={14} />}
                  </span>
                  <div className="run-check-item-content">
                    <code>{check.command}</code>
                    <small>{check.toolCallId || "—"} · {check.outputDigest || "—"}</small>
                  </div>
                  <span className="run-check-item-badge">
                    {t(`chat.verification.${check.status}`)} {check.exitCode !== undefined ? check.exitCode : ""}
                  </span>
                </div>
              ))}
            </div>
          )}

          {evidence && evidence.ledger.criteria.length > 0 && (
            <div className="run-check-section">
              <div className="run-details-section-bar">
                <span className="run-details-section-title">{t("chat.criterion")}</span>
                <span className="run-details-count-chip">{evidence.ledger.criteria.length}</span>
              </div>
              {evidence.ledger.criteria.map((criterion, index) => (
                <div className={`run-check-item ${criterion.state === "passed" ? "tone-success" : "tone-warning"}`} key={`${criterion.criterion}-${index}`}>
                  <span className="run-check-item-icon">
                    {criterion.state === "passed" ? <Check size={14} /> : <AlertCircle size={14} />}
                  </span>
                  <div className="run-check-item-content">
                    <strong>{criterion.criterion}</strong>
                    <small>{criterion.evidenceRefs.join(", ") || "—"}</small>
                  </div>
                  <span className="run-check-item-badge">{t(`chat.criterion.${criterion.state}`)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "context" && (
        <div id="run-details-context" role="tabpanel" aria-labelledby="run-details-tab-context" className="run-details-body run-details-context">
          <ContextInspector
            manifests={contextManifest.manifests}
            selectedManifestId={contextManifest.selectedManifestId}
            indexState={contextManifest.indexState}
            mode="history"
            loading={contextManifest.historyLoading}
            error={contextManifest.error}
            onSelectManifest={contextManifest.setSelectedManifestId}
            onRetry={() => void contextManifest.refresh()}
          />
        </div>
      )}

      {activeTab === "delivery" && <div id="run-details-delivery" role="tabpanel" aria-labelledby="run-details-tab-delivery" className="run-details-body run-delivery-evidence">
        <div className="run-details-section-bar">
          <span className="run-details-section-title">{t("delivery.operations")}</span>
          <span className="run-details-count-chip">{gitDelivery.operations.length}</span>
        </div>
        {gitDelivery.error && <div className="run-details-empty" role="alert">{gitDelivery.error}</div>}
        {gitDelivery.operations.filter((operation) => !runState?.runId || operation.provenance.runId === runState.runId || operation.preflight.evidenceSummary?.runId === runState.runId).map((operation) => <DeliveryOperationCard key={operation.id} operation={operation} />)}
        {providerDelivery.deliveries.filter((delivery) => !runState?.runId || delivery.originRunId === runState.runId || delivery.parentRunId === runState.runId).map((delivery) => <article className="run-delivery-card" key={delivery.id}><GitPullRequest size={15} /><div><strong>{delivery.remote.title}</strong><span>{t(`delivery.status.${delivery.remote.state}`)} · {t(`delivery.merge.${delivery.remote.mergeReadiness}`)}</span><code>{delivery.headSha.slice(0, 12)} · {delivery.evidenceLedgerDigest.slice(0, 12)}</code></div><SafeExternalLink href={delivery.remote.url} aria-label={t("delivery.openProvider")}><ExternalLink size={13} /></SafeExternalLink></article>)}
        {!gitDelivery.loading && !providerDelivery.loading && gitDelivery.operations.length === 0 && providerDelivery.deliveries.length === 0 && <div className="run-details-empty">{t("delivery.noRunEvidence")}</div>}
      </div>}

      {activeTab === "terminal" && (
        <div id="run-details-terminal" role="tabpanel" aria-labelledby="run-details-tab-terminal" className="run-details-body run-terminal-page">
          <div className="run-details-terminal-window">
            <div className="run-details-terminal-titlebar">
              <div className="terminal-dots" aria-hidden="true">
                <span className="dot dot-close" />
                <span className="dot dot-minimize" />
                <span className="dot dot-expand" />
              </div>
              <div className="run-details-terminal-title">
                <TerminalSquare size={13} />
                <span>{runState?.event?.label || t("workbench.terminalIdle")}</span>
              </div>
              <span className={`terminal-status-badge ${runState?.status === "running" ? "running" : "idle"}`}>
                {runState?.status === "running" ? t("chat.taskStatus.running") : t("workbench.ready")}
              </span>
            </div>
            <div className="run-details-terminal-screen">
              <div className="terminal-prompt-line">
                <span className="terminal-prompt-char">❯</span>
                <span className="terminal-prompt-cmd">ide.run</span>
              </div>
              <pre>{runState?.event?.detail || t("workbench.terminalHint")}</pre>
            </div>
          </div>
        </div>
      )}
      {activeTab === "trace" && <div id="run-details-trace" role="tabpanel" aria-labelledby="run-details-tab-trace" className="run-details-body trace-panel">
        <div className="trace-toolbar">
          <span>{trace.metrics ? t("trace.metrics", { count: trace.metrics.eventCount, bytes: Math.round(trace.metrics.totalBytes / 1024) }) : t("trace.retentionHint")}</span>
          <div className="trace-actions">
            <button type="button" onClick={() => void trace.exportTrace()} disabled={!events.length || !trace.available}><Download size={12} />{t("trace.export")}</button>
            <button type="button" className="btn-danger" onClick={() => { setTraceActionError(null); setConfirmIntent({ id: "trace-delete", title: t("trace.deleteTitle"), description: t("trace.deleteConfirm"), confirmLabel: t("common.delete"), tone: "danger" }); }} disabled={!events.length || !trace.available}><Trash2 size={12} />{t("common.delete")}</button>
          </div>
        </div>
        {trace.retention && <details className="trace-retention"><summary>{t("trace.retention")}</summary><span>{t("trace.retentionPreview", { archive: trace.preview?.wouldArchive || 0, delete: trace.preview?.wouldDelete || 0 })}</span><button type="button" onClick={() => void trace.updateRetention({}, true)}>{t("trace.applyRetention")}</button></details>}
        {trace.error && <div className="run-details-empty" role="status">{trace.error}</div>}
        {!events.length ? <div className="run-details-empty">{t("trace.empty")}</div> : <ol className="trace-timeline" aria-label={t("trace.title")}>{events.map((event, index) => <li key={event.eventId} className={traceEventFailed(event) ? "failed" : ""}><span className="trace-node"><Network size={12} /></span><details><summary><strong>{event.action}</strong><small>{new Date(event.timestamp).toLocaleTimeString()} · {t(`trace.kind.${event.kind}`)}</small></summary>{event.evidence && <pre>{event.evidence}</pre>}{event.toolCallId && <code>{event.toolCallId}</code>}{(event.agentId || event.metadata) && <small>{[event.agentId, event.metadata?.path as string, event.metadata?.validation as string].filter(Boolean).join(" · ")}</small>}</details><span>{index + 1}</span></li>)}</ol>}
      </div>}
      <ActionConfirmDialog intent={confirmIntent} error={traceActionError} onClose={() => setConfirmIntent(null)} onConfirm={async () => { try { await trace.deleteTrace(); setConfirmIntent(null); } catch (error) { setTraceActionError(error instanceof Error && error.message === "active" ? t("trace.deleteActive") : t("trace.deleteFailed")); } }} />
    </aside>
  );
};

