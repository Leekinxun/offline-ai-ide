import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowDown, ArrowUp, Bot, CheckCircle2, ExternalLink, FilePenLine, FilePlus2, FileWarning, FileX2, GitBranch, GitCompare, GitPullRequest, History, RefreshCw } from "lucide-react";
import type { GitDiffPayload, GitOperation, GitStatusEntry } from "../types";
import { useI18n } from "../i18n";
import { useCheckpoints } from "../hooks/useCheckpoints";
import { useGitDelivery } from "../hooks/useGitDelivery";
import { useProviderDelivery } from "../hooks/useProviderDelivery";
import { useOfflineBundles } from "../hooks/useOfflineBundles";
import { ChangeDiffDialog } from "./ChangeDiffDialog";
import { DeliveryOperationCard } from "./DeliveryOperationCard";
import { GitLocalPanel } from "./GitLocalPanel";
import { OfflineBundlePanel } from "./OfflineBundlePanel";
import { OperationApprovalDialog, type ApprovalIntent } from "./OperationApprovalDialog";
import { ProviderDeliveryPanel } from "./ProviderDeliveryPanel";
import { TaskStateStrip } from "./TaskStateStrip";
import { useModalDialogFocus } from "./useModalDialogFocus";

type GitPanelTab = "changes" | "local" | "delivery" | "activity";

interface GitPanelProps {
  visible: boolean;
  token: string;
  workspaceDir: string;
  theme: "light" | "dark";
  drawerMode?: boolean;
  readOnly?: boolean;
  conversationId?: string | null;
  runId?: string | null;
  requestedDiffPath?: string | null;
  requestedDiffId?: number;
  onOpenFile: (path: string) => void;
  onAskReview?: () => void;
  onFollowUpCreated?: (result: { taskId: number; followUpRunId: string }) => Promise<void> | void;
  onOpenFollowUpRun?: (runId: string) => Promise<void> | void;
  onClose: () => void;
}

function entryIcon(kind: GitStatusEntry["kind"]): React.ReactNode {
  if (kind === "conflicted") return <FileWarning size={13} />;
  if (kind === "added" || kind === "untracked") return <FilePlus2 size={13} />;
  if (kind === "deleted") return <FileX2 size={13} />;
  return <FilePenLine size={13} />;
}

function operationIntent(operation: GitOperation, t: ReturnType<typeof useI18n>["t"]): ApprovalIntent {
  const branch = "branch" in operation.input ? operation.input.branch : operation.input.remoteRef.replace(/^refs\/heads\//, "");
  const protectedBranch = branch === "main" || branch === "master" || branch.startsWith("release/");
  return {
    id: operation.id,
    kind: "git",
    title: t("delivery.approveGitOperation", { action: t(`delivery.gitAction.${operation.action}`) }),
    description: t("delivery.gitApprovalHint"),
    impact: [
      { label: t("delivery.risk"), value: t(`delivery.risk.${operation.risk}`), warning: operation.risk === "high" },
      { label: t("delivery.branch"), value: branch || "—" },
      { label: t("delivery.command"), value: operation.preflight.exactArgs.join(" ") },
      { label: t("delivery.approvalDigest"), value: operation.preflight.approvalDigest.slice(0, 16) },
    ],
    warnings: operation.preflight.warnings,
    confirmLabel: t("delivery.approveRun"),
    reasonRequired: protectedBranch,
  };
}

export const GitPanel: React.FC<GitPanelProps> = ({ visible, token, workspaceDir, theme, drawerMode = false, readOnly = false, conversationId, runId, requestedDiffPath, requestedDiffId, onOpenFile, onAskReview, onFollowUpCreated, onOpenFollowUpRun, onClose }) => {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<GitPanelTab>("changes");
  const [selectedChange, setSelectedChange] = useState<GitStatusEntry | null>(null);
  const [diffPayload, setDiffPayload] = useState<GitDiffPayload | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [selectedOperation, setSelectedOperation] = useState<GitOperation | null>(null);
  const [showBundles, setShowBundles] = useState(false);
  const handledRequestRef = useRef(0);
  const panelRef = useModalDialogFocus<HTMLElement>({ open: visible && drawerMode, onClose, suspended: Boolean(selectedChange || selectedOperation) });
  const diffControllerRef = useRef<AbortController | null>(null);
  const diffSequenceRef = useRef(0);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const git = useGitDelivery(token, workspaceDir, visible);
  const provider = useProviderDelivery(token, workspaceDir, visible && activeTab === "delivery");
  const checkpointState = useCheckpoints(token, visible && (activeTab === "local" || activeTab === "delivery"));
  const bundles = useOfflineBundles(token, workspaceDir);
  const status = git.status;

  useEffect(() => {
    diffControllerRef.current?.abort();
    setSelectedChange(null);
    setDiffPayload(null);
    setDiffError(null);
    setSelectedOperation(null);
    setActiveTab("changes");
    setShowBundles(false);
  }, [workspaceDir]);
  useEffect(() => () => diffControllerRef.current?.abort(), []);

  const openDiff = useCallback(async (entry: GitStatusEntry) => {
    diffControllerRef.current?.abort();
    const controller = new AbortController();
    diffControllerRef.current = controller;
    const sequence = ++diffSequenceRef.current;
    const scope = workspaceDir;
    setSelectedChange(entry);
    setDiffPayload(null);
    setDiffError(null);
    setDiffLoading(true);
    try {
      const response = await fetch(`/api/files/git-diff?path=${encodeURIComponent(entry.path)}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
      if (!response.ok) throw new Error(t("git.diffFailed"));
      const payload = await response.json() as GitDiffPayload;
      if (controller.signal.aborted || sequence !== diffSequenceRef.current || scope !== workspaceDir) return;
      setDiffPayload(payload);
    } catch (nextError) {
      if (controller.signal.aborted) return;
      setDiffError(nextError instanceof Error ? nextError.message : t("git.diffFailed"));
    } finally {
      if (sequence === diffSequenceRef.current) setDiffLoading(false);
    }
  }, [t, token, workspaceDir]);

  useEffect(() => {
    if (!visible || !requestedDiffPath || !requestedDiffId || requestedDiffId <= handledRequestRef.current || !status) return;
    handledRequestRef.current = requestedDiffId;
    setActiveTab("changes");
    const entry = status.entries.find((candidate) => candidate.path === requestedDiffPath) || { path: requestedDiffPath, indexStatus: " ", worktreeStatus: "M", kind: "modified" as const };
    void openDiff(entry);
  }, [openDiff, requestedDiffId, requestedDiffPath, status, visible]);

  const groupedEntries = useMemo(() => {
    const entries = status?.entries || [];
    return [
      { key: "conflicted", label: t("git.group.conflicted"), entries: entries.filter((entry) => entry.kind === "conflicted") },
      { key: "tracked", label: t("git.group.tracked"), entries: entries.filter((entry) => entry.kind !== "conflicted" && entry.kind !== "untracked") },
      { key: "untracked", label: t("git.group.untracked"), entries: entries.filter((entry) => entry.kind === "untracked") },
    ].filter((group) => group.entries.length > 0);
  }, [status?.entries, t]);

  if (!visible) return null;
  const tabs: Array<{ id: GitPanelTab; icon: React.ReactNode }> = [{ id: "changes", icon: <GitCompare size={13} /> }, { id: "local", icon: <GitBranch size={13} /> }, { id: "delivery", icon: <GitPullRequest size={13} /> }, { id: "activity", icon: <History size={13} /> }];
  const changeCounts = status?.entries.reduce((counts, entry) => { counts[entry.kind] += 1; return counts; }, { modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0, conflicted: 0 });
  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    setActiveTab(tabs[next].id);
    tabRefs.current[next]?.focus();
  };

  return <aside ref={panelRef} className="git-panel panel-shell workspace-drawer" role={drawerMode ? "dialog" : "complementary"} aria-modal={drawerMode || undefined} inert={selectedChange || selectedOperation ? true : undefined} aria-hidden={selectedChange || selectedOperation ? true : undefined} aria-labelledby="git-panel-title" tabIndex={-1} data-workspace-drawer="git">
    <div className="git-panel-header"><div className="git-panel-title"><GitBranch size={15} /><strong id="git-panel-title">{t("git.title")}</strong></div><div className="git-panel-actions">{onAskReview && <button type="button" className="sidebar-action-btn" onClick={onAskReview} title={t("git.askReview")} aria-label={t("git.askReview")}><Bot size={14} /></button>}<button type="button" className="sidebar-action-btn" onClick={() => void git.refresh()} title={t("common.refresh")} aria-label={t("common.refresh")}><RefreshCw size={14} className={git.loading ? "chat-spin" : ""} /></button><button type="button" className="sidebar-action-btn" onClick={onClose} title={t("common.close")} aria-label={t("common.close")}>×</button></div></div>
    <TaskStateStrip requested={t(`delivery.tab.${activeTab}`)} running={git.busyId || provider.loading ? t("chat.taskStatus.running") : t("taskState.ready")} runningTone={git.busyId || provider.loading ? "running" : "neutral"} evidence={(status?.entries.length || git.operations.length) ? t("taskState.evidenceCount", { count: (status?.entries.length || 0) + git.operations.length + provider.deliveries.length }) : t("taskState.noEvidence")} evidenceTone={(status?.entries.length || git.operations.length) ? "success" : "neutral"} action={status?.entries.length ? t("git.openDiff") : t("common.refresh")} onAction={() => { const first = status?.entries[0]; if (first) void openDiff(first); else void git.refresh(); }} actionDisabled={git.loading || Boolean(git.busyId)} actionDisabledReason={git.loading || git.busyId ? t("chat.taskStatus.running") : undefined} compact />
    {status?.isRepo && <><div className="git-panel-branch"><div><GitBranch size={14} /><strong>{status.branch}</strong></div><span><code>{status.headSha?.slice(0, 10) || "—"}</code> · {status.entries.length} {t("git.changesCount")}</span></div><div className="git-panel-summary" aria-label={t("git.changesCount")}><span className="git-summary-total"><GitCompare size={12} />{status.entries.length}</span>{Boolean(changeCounts?.conflicted) && <span className="git-summary-item conflicted">! {changeCounts?.conflicted}</span>}<span className="git-summary-item modified">M {changeCounts?.modified || 0}</span><span className="git-summary-item added">+ {((changeCounts?.added || 0) + (changeCounts?.untracked || 0))}</span><span className="git-summary-item deleted">− {changeCounts?.deleted || 0}</span></div>{(status.ahead > 0 || status.behind > 0) && <div className="git-panel-sync">{status.ahead > 0 && <span><ArrowUp size={12} />{status.ahead}</span>}{status.behind > 0 && <span><ArrowDown size={12} />{status.behind}</span>}<small>{status.upstream || t("git.noUpstream")}</small></div>}</>}
    <div className="git-delivery-tabs" role="tablist" aria-label={t("delivery.sections")}>{tabs.map((tab, index) => <button ref={(node) => { tabRefs.current[index] = node; }} key={tab.id} id={`git-tab-${tab.id}`} type="button" role="tab" aria-selected={activeTab === tab.id} aria-controls={`git-panel-${tab.id}`} tabIndex={activeTab === tab.id ? 0 : -1} className={activeTab === tab.id ? "active" : ""} onClick={() => setActiveTab(tab.id)} onKeyDown={(event) => handleTabKeyDown(event, index)}>{tab.icon}{t(`delivery.tab.${tab.id}`)}</button>)}</div>
    {(git.error && activeTab !== "local" && activeTab !== "activity") && <div className="git-panel-error" role="alert"><FileWarning size={16} />{git.error}</div>}
    {git.loading && !status && <div className="git-panel-empty">{t("common.loading")}</div>}
    {!git.loading && status && !status.isRepo && <div className="git-panel-empty"><GitBranch size={18} /><strong>{t("git.notRepo")}</strong></div>}

    {activeTab === "changes" && status?.isRepo && <div id="git-panel-changes" role="tabpanel" aria-labelledby="git-tab-changes" className="git-panel-tab-body"><div className="git-panel-list">{status.entries.length === 0 ? <div className="git-panel-empty git-panel-clean"><CheckCircle2 size={20} /><strong>{t("git.clean")}</strong><span>{t("git.cleanHint")}</span></div> : groupedEntries.map((group) => <section className="git-change-group" key={group.key} aria-labelledby={`git-group-${group.key}`}><div className="git-change-group-header" id={`git-group-${group.key}`}><span>{group.label}</span><small>{group.entries.length}</small></div>{group.entries.map((entry) => <div className={`git-panel-entry kind-${entry.kind}`} key={`${entry.kind}:${entry.path}`}><button type="button" className="git-entry-diff" onClick={() => void openDiff(entry)} title={`${t("git.openDiff")}: ${entry.path}`}><span className={`git-entry-icon kind-${entry.kind}`}>{entryIcon(entry.kind)}</span><span className="git-entry-copy"><code>{entry.path}</code><small>{t(`git.kind.${entry.kind}`)}</small></span><span className={`git-entry-status kind-${entry.kind}`}>{entry.indexStatus}{entry.worktreeStatus}</span></button><button type="button" className="git-entry-open" onClick={() => onOpenFile(entry.path)} disabled={entry.kind === "deleted"} title={`${t("git.openFile")}: ${entry.path}`} aria-label={`${t("git.openFile")}: ${entry.path}`}><ExternalLink size={12} /></button></div>)}</section>)}</div></div>}
    {activeTab === "local" && status?.isRepo && <div id="git-panel-local" role="tabpanel" aria-labelledby="git-tab-local" className="git-panel-tab-body"><GitLocalPanel controller={git} changeSets={checkpointState.changeSets} readOnly={readOnly} conversationId={conversationId} runId={runId} onPrepared={setSelectedOperation} /></div>}
    {activeTab === "delivery" && status?.isRepo && <div id="git-panel-delivery" role="tabpanel" aria-labelledby="git-tab-delivery" className="git-panel-tab-body"><ProviderDeliveryPanel controller={provider} gitOperations={git.operations} changeSets={checkpointState.changeSets} readOnly={readOnly} onFollowUpCreated={onFollowUpCreated} onOpenFollowUpRun={onOpenFollowUpRun} onShowOfflineBundles={() => setShowBundles(true)} /><button type="button" className="offline-bundle-disclosure" aria-expanded={showBundles} onClick={() => setShowBundles((value) => !value)}><Activity size={14} />{t("bundle.title")}</button>{showBundles && <OfflineBundlePanel controller={bundles} changeSets={checkpointState.changeSets} readOnly={readOnly} />}</div>}
    {activeTab === "activity" && <div id="git-panel-activity" role="tabpanel" aria-labelledby="git-tab-activity" className="git-panel-tab-body delivery-activity-list" aria-live="polite">{git.operations.length === 0 ? <div className="git-panel-empty"><History size={20} /><strong>{t("delivery.noActivity")}</strong><span>{t("delivery.noActivityHint")}</span></div> : git.operations.map((operation) => <DeliveryOperationCard key={operation.id} operation={operation} busy={git.busyId === operation.id} readOnly={readOnly} onApprove={(item) => { setSelectedOperation(item); }} onCancel={async (item) => { await git.cancel(item); }} onRebuild={async () => { await git.refresh(); setActiveTab("local"); }} />)}</div>}
    <div className="git-panel-footer">{workspaceDir}</div>
    {selectedChange && <ChangeDiffDialog path={selectedChange.path} kind={selectedChange.kind} payload={diffPayload} loading={diffLoading} error={diffError} theme={theme} revision={status?.headSha || undefined} stale={Boolean(diffPayload && diffPayload.updatedAt < (status?.updatedAt || 0))} onRetry={() => void openDiff(selectedChange)} onClose={() => setSelectedChange(null)} onOpenFile={onOpenFile} />}
    <OperationApprovalDialog intent={selectedOperation ? operationIntent(selectedOperation, t) : null} busy={Boolean(selectedOperation && git.busyId === selectedOperation.id)} error={git.error} onApprove={async (_intent, reason) => { if (!selectedOperation) return; await git.approve(selectedOperation, reason); setSelectedOperation(null); setActiveTab("activity"); }} onClose={() => { if (!git.busyId) setSelectedOperation(null); }} />
  </aside>;
};
