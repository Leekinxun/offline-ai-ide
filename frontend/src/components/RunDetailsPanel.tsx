import React, { useRef, useState } from "react";
import { Check, ChevronRight, Download, ExternalLink, FileCode2, GitPullRequest, Network, TerminalSquare, Trash2, X } from "lucide-react";
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
        <div>
          <strong>{t("workbench.runDetails")}</strong>
          <span>{runState ? t(`chat.taskStatus.${runState.status}`) : t("workbench.ready")}</span>
        </div>
        <button type="button" onClick={onClose} aria-label={t("common.close")} title={t("common.close")}>
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
          <section className="run-details-summary">
            <span>{t("workbench.filesChanged")}</span>
            <strong>{changedFiles.length}</strong>
          </section>
          <div className="run-details-section-title">
            <span>{t("workbench.changedFiles")}</span>
            <span>{changedFiles.length}</span>
          </div>
          {changedFiles.length === 0 ? (
            <div className="run-details-empty">{t("chat.noChanges")}</div>
          ) : (
            <div className="run-details-file-list">
              {changedFiles.map((path) => (
                <button type="button" key={path} onClick={() => onOpenDiff(path)}>
                  <FileCode2 size={14} />
                  <span><strong>{path.split("/").pop()}</strong><small>{path}</small></span>
                  <span className="run-details-file-state">M</span>
                  <ChevronRight size={13} />
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className="run-details-open-file"
            disabled={changedFiles.length === 0}
            onClick={() => changedFiles[0] && onOpenFile(changedFiles[0])}
          >
            {t("workbench.openFirstChange")}
          </button>
        </div>
      )}

      {activeTab === "checks" && (
        <div id="run-details-checks" role="tabpanel" aria-labelledby="run-details-tab-checks" className="run-details-body run-check-list">
          {evidence && <>
            <div className={evidenceOutcome === "completed" ? "" : "warning"} role={evidenceOutcome === "completed" ? undefined : "alert"}>{evidenceOutcome === "completed" ? <Check size={14} /> : <X size={14} />}<span>{t("chat.outcome")}</span><strong>{t(`chat.outcome.${evidenceOutcome}`)}</strong></div>
            {evidence.ledger.verification.map((check, index) => <div className={check.status === "passed" ? "" : "warning"} key={`${check.command}-${index}`}><Check size={14} /><span><code>{check.command}</code><small>{check.toolCallId || "—"} · {check.outputDigest || "—"}</small></span><strong>{t(`chat.verification.${check.status}`)} {check.exitCode !== undefined ? check.exitCode : ""}</strong></div>)}
            {evidence.ledger.criteria.map((criterion, index) => <div className={criterion.state === "passed" ? "" : "warning"} key={`${criterion.criterion}-${index}`}><Check size={14} /><span>{criterion.criterion}<small>{criterion.evidenceRefs.join(", ") || "—"}</small></span><strong>{t(`chat.criterion.${criterion.state}`)}</strong></div>)}
            {evidence.ledger.blockers.map((blocker) => <div className="warning" key={blocker}><X size={14} /><span>{t("chat.blocker")}</span><strong>{blocker}</strong></div>)}
          </>}
          {qualityGate && <div className={qualityGate.status === "blocked" ? "warning" : ""} role={qualityGate.status === "blocked" ? "alert" : undefined}>{qualityGate.status === "blocked" ? <X size={14} /> : <Check size={14} />}<span>{t("chat.qualityGate")}{qualityGate.error && <small>{qualityGate.error}</small>}</span><strong>{t(`chat.qualityGate.${qualityGate.status}`)}</strong></div>}
          <div><Check size={14} /><span>{t("workbench.toolCalls")}</span><strong>{summary?.toolCallCount || 0}</strong></div>
          <div><Check size={14} /><span>{t("workbench.commands")}</span><strong>{summary?.commandCount || 0}</strong></div>
          <div className={errorCount ? "warning" : ""}><Check size={14} /><span>{t("problems.error")}</span><strong>{errorCount}</strong></div>
          <div className={warningCount ? "warning" : ""}><Check size={14} /><span>{t("problems.warning")}</span><strong>{warningCount}</strong></div>
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
        <section className="run-details-summary"><span>{t("delivery.operations")}</span><strong>{gitDelivery.operations.length}</strong></section>
        {gitDelivery.error && <div className="run-details-empty" role="alert">{gitDelivery.error}</div>}
        {gitDelivery.operations.filter((operation) => !runState?.runId || operation.provenance.runId === runState.runId || operation.preflight.evidenceSummary?.runId === runState.runId).map((operation) => <DeliveryOperationCard key={operation.id} operation={operation} />)}
        {providerDelivery.deliveries.filter((delivery) => !runState?.runId || delivery.originRunId === runState.runId || delivery.parentRunId === runState.runId).map((delivery) => <article className="run-delivery-card" key={delivery.id}><GitPullRequest size={15} /><div><strong>{delivery.remote.title}</strong><span>{t(`delivery.status.${delivery.remote.state}`)} · {t(`delivery.merge.${delivery.remote.mergeReadiness}`)}</span><code>{delivery.headSha.slice(0, 12)} · {delivery.evidenceLedgerDigest.slice(0, 12)}</code></div><SafeExternalLink href={delivery.remote.url} aria-label={t("delivery.openProvider")}><ExternalLink size={13} /></SafeExternalLink></article>)}
        {!gitDelivery.loading && !providerDelivery.loading && gitDelivery.operations.length === 0 && providerDelivery.deliveries.length === 0 && <div className="run-details-empty">{t("delivery.noRunEvidence")}</div>}
      </div>}

      {activeTab === "terminal" && (
        <div id="run-details-terminal" role="tabpanel" aria-labelledby="run-details-tab-terminal" className="run-details-terminal">
          <TerminalSquare size={15} />
          <div>
            <strong>{runState?.event?.label || t("workbench.terminalIdle")}</strong>
            <pre>{runState?.event?.detail || t("workbench.terminalHint")}</pre>
          </div>
        </div>
      )}
      {activeTab === "trace" && <div id="run-details-trace" role="tabpanel" aria-labelledby="run-details-tab-trace" className="run-details-body trace-panel">
        <div className="trace-toolbar"><span>{trace.metrics ? t("trace.metrics", { count: trace.metrics.eventCount, bytes: Math.round(trace.metrics.totalBytes / 1024) }) : t("trace.retentionHint")}</span><button type="button" onClick={() => void trace.exportTrace()} disabled={!events.length || !trace.available}><Download size={12} />{t("trace.export")}</button><button type="button" onClick={() => { setTraceActionError(null); setConfirmIntent({ id: "trace-delete", title: t("trace.deleteTitle"), description: t("trace.deleteConfirm"), confirmLabel: t("common.delete"), tone: "danger" }); }} disabled={!events.length || !trace.available}><Trash2 size={12} />{t("common.delete")}</button></div>
        {trace.retention && <details className="trace-retention"><summary>{t("trace.retention")}</summary><span>{t("trace.retentionPreview", { archive: trace.preview?.wouldArchive || 0, delete: trace.preview?.wouldDelete || 0 })}</span><button type="button" onClick={() => void trace.updateRetention({}, true)}>{t("trace.applyRetention")}</button></details>}
        {trace.error && <div className="run-details-empty" role="status">{trace.error}</div>}
        {!events.length ? <div className="run-details-empty">{t("trace.empty")}</div> : <ol className="trace-timeline" aria-label={t("trace.title")}>{events.map((event, index) => <li key={event.eventId} className={traceEventFailed(event) ? "failed" : ""}><span className="trace-node"><Network size={12} /></span><details><summary><strong>{event.action}</strong><small>{new Date(event.timestamp).toLocaleTimeString()} · {t(`trace.kind.${event.kind}`)}</small></summary>{event.evidence && <pre>{event.evidence}</pre>}{event.toolCallId && <code>{event.toolCallId}</code>}{(event.agentId || event.metadata) && <small>{[event.agentId, event.metadata?.path as string, event.metadata?.validation as string].filter(Boolean).join(" · ")}</small>}</details><span>{index + 1}</span></li>)}</ol>}
      </div>}
      <ActionConfirmDialog intent={confirmIntent} error={traceActionError} onClose={() => setConfirmIntent(null)} onConfirm={async () => { try { await trace.deleteTrace(); setConfirmIntent(null); } catch (error) { setTraceActionError(error instanceof Error && error.message === "active" ? t("trace.deleteActive") : t("trace.deleteFailed")); } }} />
    </aside>
  );
};
