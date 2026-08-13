import React, { useMemo, useRef, useState } from "react";
import {
  ArchiveRestore,
  Camera,
  FolderOpen,
  GitBranch,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useCheckpoints, type ChangeSet } from "../hooks/useCheckpoints";
import { useWorktrees } from "../hooks/useWorktrees";
import { useI18n } from "../i18n";
import { useFindings } from "../hooks/useFindings";
import { useOfflineBundles } from "../hooks/useOfflineBundles";
import { OfflineBundlePanel } from "./OfflineBundlePanel";
import { TaskStateStrip } from "./TaskStateStrip";
import { ActionConfirmDialog, type ActionConfirmIntent } from "./ActionConfirmDialog";
import { changeSetReviewRevision, isCurrentChangeSet } from "../hooks/changeSetContract";
import {
  changeSetDecisionAllowed,
  changeSetRecoveryDecisions,
  changeSetStatusTone,
  isChangeSetIntegrable,
  type ChangeSetDecision,
} from "./changeSetRecoveryPolicy";

interface CheckpointPanelProps {
  visible: boolean;
  token: string;
  workspaceDir: string;
  conversationId?: string | null;
  runId?: string | null;
  readOnly: boolean;
  onClose: () => void;
  onRestored: () => Promise<void> | void;
  onOpenWorktree: (path: string) => Promise<void> | void;
  onNotify: (message: string) => void;
}

type RecoveryConfirmAction =
  | { kind: "restore"; id: string; label: string }
  | { kind: "rollback"; id: string; path: string; hunkId?: string }
  | { kind: "integrate"; id: string; decision: ChangeSetDecision }
  | { kind: "recover"; id: string }
  | { kind: "remove-worktree"; id: string; branch: string };

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const CheckpointPanel: React.FC<CheckpointPanelProps> = ({
  visible,
  token,
  workspaceDir,
  conversationId,
  runId,
  readOnly,
  onClose,
  onRestored,
  onOpenWorktree,
  onNotify,
}) => {
  const { t } = useI18n();
  const { checkpoints, mutations, changeSets, reviewRuns, storage, loading, busyId, error, refresh, create, restore, rollback, decideChangeSet, recoverChangeSet, startChangeSetReview, setRetention } = useCheckpoints(
    token,
    visible
  );
  const [label, setLabel] = useState("");
  const [activeTab, setActiveTab] = useState<"snapshots" | "mutations" | "changeSets" | "worktrees">("snapshots");
  const [worktreeName, setWorktreeName] = useState("");
  const [worktreeRevision, setWorktreeRevision] = useState("HEAD");
  const [confirmIntent, setConfirmIntent] = useState<ActionConfirmIntent | null>(null);
  const [confirmAction, setConfirmAction] = useState<RecoveryConfirmAction | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const worktreeState = useWorktrees(token, visible && activeTab === "worktrees");
  const bundleState = useOfflineBundles(token, workspaceDir);
  const changeSetFindingScope = useMemo(() => changeSets.map((changeSet) => changeSet.id), [changeSets]);
  // Fetch each ChangeSet through the server-scoped query contract. This keeps
  // unrelated findings outside pagination and prevents a global 500-row page
  // from hiding a blocking finding for the card being rendered.
  const findingState = useFindings(token, {
    changeSetIds: changeSetFindingScope,
    enabled: visible && activeTab === "changeSets",
  });
  const sorted = useMemo(
    () => [...checkpoints].sort((left, right) => right.createdAt - left.createdAt),
    [checkpoints]
  );

  if (!visible) return null;

  const handleCreate = async () => {
    if (readOnly) return;
    try {
      await create({
        label: label.trim() || t("checkpoint.manualLabel"),
        conversationId: conversationId || undefined,
        runId: runId || undefined,
      });
      setLabel("");
      onNotify(t("checkpoint.created"));
    } catch (nextError) {
      onNotify(nextError instanceof Error ? nextError.message : t("checkpoint.createFailed"));
    }
  };

  const requestConfirmation = (action: RecoveryConfirmAction, intent: Omit<ActionConfirmIntent, "id">) => {
    setConfirmError(null);
    setConfirmAction(action);
    setConfirmIntent({ ...intent, id: `${action.kind}:${"id" in action ? action.id : "action"}` });
  };
  const handleRestore = (id: string, checkpointLabel: string) => {
    if (readOnly) return;
    requestConfirmation({ kind: "restore", id, label: checkpointLabel }, { title: t("checkpoint.restore"), description: t("checkpoint.restoreConfirm", { label: checkpointLabel }), confirmLabel: t("checkpoint.restore"), tone: "danger" });
  };
  const handleRollback = (id: string, path: string) => {
    if (readOnly) return;
    requestConfirmation({ kind: "rollback", id, path }, { title: t("recovery.rollback"), description: t("recovery.rollbackConfirm", { path }), confirmLabel: t("recovery.rollback"), tone: "danger" });
  };
  const handleHunkRollback = (id: string, hunkId: string, path: string) => {
    if (readOnly) return;
    requestConfirmation({ kind: "rollback", id, path, hunkId }, { title: t("recovery.rollback"), description: t("recovery.rollbackConfirm", { path }), confirmLabel: t("recovery.rollback"), tone: "danger" });
  };
  const handleDecision = async (changeSet: ChangeSet, decision: ChangeSetDecision) => {
    if (readOnly) return;
    if (!changeSetDecisionAllowed(changeSet, decision)) { onNotify(t("recovery.decisionUnavailable")); return; }
    if (["apply", "cherry_pick", "merge"].includes(decision)) { requestConfirmation({ kind: "integrate", id: changeSet.id, decision }, { title: t("recovery.apply"), description: t("recovery.integrateConfirm"), confirmLabel: t("recovery.apply"), tone: "primary" }); return; }
    try { await decideChangeSet(changeSet.id, decision); onNotify(t("recovery.decisionDone")); } catch (nextError) { onNotify(nextError instanceof Error ? nextError.message : t("recovery.decisionFailed")); }
  };
  const handleRecovery = (changeSet: ChangeSet) => {
    if (readOnly || !isCurrentChangeSet(changeSet)) return;
    requestConfirmation({ kind: "recover", id: changeSet.id }, { title: t("recovery.recover"), description: t("recovery.recoverConfirm"), confirmLabel: t("recovery.recover"), tone: "danger" });
  };
  const handleReview = async (changeSet: ChangeSet, stage: "review" | "reverify") => {
    if (readOnly || !isCurrentChangeSet(changeSet)) return;
    try { await startChangeSetReview(changeSet.id, stage); onNotify(t(stage === "review" ? "recovery.reviewStarted" : "recovery.reverifyStarted")); }
    catch (nextError) { onNotify(nextError instanceof Error ? nextError.message : t("recovery.reviewFailed")); }
  };

  const handleCreateWorktree = async () => {
    if (readOnly) return;
    try {
      const worktree = await worktreeState.create({
        name: worktreeName.trim() || undefined,
        revision: worktreeRevision.trim() || "HEAD",
      });
      setWorktreeName("");
      onNotify(t("worktree.created", { branch: worktree.branch || worktree.id }));
    } catch (nextError) {
      onNotify(nextError instanceof Error ? nextError.message : t("worktree.createFailed"));
    }
  };

  const handleRemoveWorktree = (id: string, branch: string) => {
    if (readOnly) return;
    requestConfirmation({ kind: "remove-worktree", id, branch }, { title: t("worktree.remove"), description: t("worktree.removeConfirm", { branch }), confirmLabel: t("worktree.remove"), tone: "danger" });
  };

  const executeConfirmedAction = async () => {
    const action = confirmAction;
    if (!action) return;
    try {
      if (action.kind === "restore") { await restore(action.id); await onRestored(); onNotify(t("checkpoint.restored", { label: action.label })); }
      else if (action.kind === "rollback") { await rollback({ ids: [action.id], ...(action.hunkId ? { hunkIds: [action.hunkId] } : {}) }); onNotify(t("recovery.rollbackDone")); }
      else if (action.kind === "integrate") {
        const currentChangeSet = changeSets.find((changeSet) => changeSet.id === action.id);
        if (!currentChangeSet || !changeSetDecisionAllowed(currentChangeSet, action.decision)) throw new Error(t("recovery.decisionUnavailable"));
        await decideChangeSet(action.id, action.decision); onNotify(t("recovery.decisionDone"));
      }
      else if (action.kind === "recover") { await recoverChangeSet(action.id); onNotify(t("recovery.recoverDone")); }
      else { await worktreeState.remove(action.id); onNotify(t("worktree.removed", { branch: action.branch })); }
      setConfirmIntent(null); setConfirmAction(null); setConfirmError(null);
    } catch (nextError) {
      const fallback = action.kind === "restore" ? t("checkpoint.restoreFailed") : action.kind === "rollback" ? t("recovery.rollbackFailed") : action.kind === "integrate" ? t("recovery.decisionFailed") : action.kind === "recover" ? t("recovery.recoverFailed") : t("worktree.removeFailed");
      const message = nextError instanceof Error ? nextError.message : fallback;
      setConfirmError(message);
      onNotify(message);
    }
  };

  const tabs = ["snapshots", "mutations", "changeSets", "worktrees"] as const;
  const moveTabFocus = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex = index;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    else return;
    event.preventDefault();
    setActiveTab(tabs[nextIndex]);
    tabRefs.current[nextIndex]?.focus();
  };

  const recoveryBusy = busyId !== null || worktreeState.busyId !== null;
  const evidenceCount = checkpoints.length + mutations.length + changeSets.length + Object.values(reviewRuns).reduce((count, runs) => count + runs.length, 0);

  return (
    <aside className="checkpoint-panel panel-shell workspace-drawer" aria-label={t("recovery.aria")} tabIndex={-1} data-workspace-drawer="checkpoints">
      <div className="workbench-panel-header">
        <div className="workbench-panel-title"><ShieldCheck size={15} /><strong>{t("recovery.title")}</strong></div>
        <div className="workbench-panel-actions">
          <button
            type="button"
            className="sidebar-action-btn"
            onClick={() => void (activeTab === "worktrees" ? worktreeState.refresh() : refresh())}
            title={t("recovery.refresh")}
            aria-label={t("recovery.refresh")}
          >
            <RefreshCw size={14} className={loading || worktreeState.loading ? "chat-spin" : ""} />
          </button>
          <button type="button" className="sidebar-action-btn" onClick={onClose} title={t("checkpoint.close")} aria-label={t("checkpoint.close")}>
            <X size={14} />
          </button>
        </div>
      </div>

      <TaskStateStrip
        requested={t("recovery.title")}
        running={recoveryBusy ? t("common.loading") : t("taskState.ready")}
        runningTone={recoveryBusy ? "running" : error || worktreeState.error ? "danger" : "success"}
        evidence={evidenceCount ? t("taskState.evidenceCount", { count: evidenceCount }) : t("taskState.noEvidence")}
        evidenceTone={evidenceCount ? "success" : "neutral"}
        action={t("recovery.refresh")}
        onAction={() => void (activeTab === "worktrees" ? worktreeState.refresh() : refresh())}
        actionDisabled={loading || worktreeState.loading}
        actionDisabledReason={loading || worktreeState.loading ? t("common.loading") : undefined}
        compact
      />

      <div className="recovery-tabs" role="tablist" aria-label={t("recovery.sections")}>
        <button ref={(node) => { tabRefs.current[0] = node; }} id="recovery-tab-snapshots" aria-controls="recovery-panel-snapshots" tabIndex={activeTab === "snapshots" ? 0 : -1} onKeyDown={(event) => moveTabFocus(event, 0)} type="button" role="tab" aria-selected={activeTab === "snapshots"} className={activeTab === "snapshots" ? "active" : ""} onClick={() => setActiveTab("snapshots")}>
          <ArchiveRestore size={13} /> {t("recovery.snapshots")}
        </button>
        <button ref={(node) => { tabRefs.current[1] = node; }} id="recovery-tab-mutations" aria-controls="recovery-panel-mutations" tabIndex={activeTab === "mutations" ? 0 : -1} onKeyDown={(event) => moveTabFocus(event, 1)} type="button" role="tab" aria-selected={activeTab === "mutations"} className={activeTab === "mutations" ? "active" : ""} onClick={() => setActiveTab("mutations")}>
          <RefreshCw size={13} /> {t("recovery.mutations")}
        </button>
        <button ref={(node) => { tabRefs.current[2] = node; }} id="recovery-tab-changeSets" aria-controls="recovery-panel-changeSets" tabIndex={activeTab === "changeSets" ? 0 : -1} onKeyDown={(event) => moveTabFocus(event, 2)} type="button" role="tab" aria-selected={activeTab === "changeSets"} className={activeTab === "changeSets" ? "active" : ""} onClick={() => setActiveTab("changeSets")}>
          <GitBranch size={13} /> {t("recovery.changeSets")}
        </button>
        <button ref={(node) => { tabRefs.current[3] = node; }} id="recovery-tab-worktrees" aria-controls="recovery-panel-worktrees" tabIndex={activeTab === "worktrees" ? 0 : -1} onKeyDown={(event) => moveTabFocus(event, 3)} type="button" role="tab" aria-selected={activeTab === "worktrees"} className={activeTab === "worktrees" ? "active" : ""} onClick={() => setActiveTab("worktrees")}>
          <GitBranch size={13} /> {t("recovery.worktrees")}
        </button>
      </div>
      {readOnly && <div className="checkpoint-notice" role="note">{t("recovery.readOnly")}</div>}

      {activeTab === "snapshots" ? (
        <div id="recovery-panel-snapshots" role="tabpanel" aria-labelledby="recovery-tab-snapshots">
          <div className="checkpoint-create">
            <input
              className="dialog-input"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void handleCreate()}
              placeholder={t("checkpoint.labelPlaceholder")}
              aria-label={t("checkpoint.labelPlaceholder")}
            />
            <button type="button" className="dialog-btn primary" onClick={() => void handleCreate()} disabled={readOnly || busyId !== null} title={readOnly ? t("recovery.readOnly") : undefined}>
              <Camera size={13} /> {t("checkpoint.create")}
            </button>
          </div>
          <div className="checkpoint-notice">{t("checkpoint.notice")}</div>
          {storage && <div className="checkpoint-notice">{t("recovery.storage", { size: formatSize(storage.blobBytes), count: storage.checkpointCount })}<label className="retention-control">{t("recovery.retention")}<input type="number" min="4" max="100" defaultValue={storage.retention.maxCheckpoints} disabled={readOnly || busyId !== null} onBlur={(event) => { const value = Number(event.currentTarget.value); if (Number.isInteger(value) && value !== storage.retention.maxCheckpoints) void setRetention(value).catch((nextError) => onNotify(nextError instanceof Error ? nextError.message : t("recovery.retentionFailed"))); }} /></label></div>}
          {error && <div className="workbench-panel-error" role="alert">{error}</div>}
          {!loading && sorted.length === 0 && (
            <div className="workbench-panel-empty"><ArchiveRestore size={24} /><strong>{t("checkpoint.emptyTitle")}</strong><span>{t("checkpoint.emptyHint")}</span></div>
          )}
          <div className="checkpoint-list">
            {sorted.map((checkpoint) => (
              <article className="checkpoint-card" key={checkpoint.id}>
                <div className="checkpoint-card-head">
                  <strong>{checkpoint.label}</strong>
                  <time>{new Date(checkpoint.createdAt).toLocaleString()}</time>
                </div>
                <div className="checkpoint-meta">
                  {checkpoint.kind && <span className={`checkpoint-kind kind-${checkpoint.kind}`}>{t(`checkpoint.kind.${checkpoint.kind}`)}</span>}
                  <span>{t("checkpoint.files", { count: checkpoint.fileCount })}</span>
                  <span>{formatSize(checkpoint.totalBytes)}</span>
                  {checkpoint.runId && <code>{checkpoint.runId}</code>}
                </div>
                <button type="button" className="dialog-btn" onClick={() => void handleRestore(checkpoint.id, checkpoint.label)} disabled={readOnly || busyId !== null} title={readOnly ? t("recovery.readOnly") : undefined}>
                  <ArchiveRestore size={13} /> {busyId === checkpoint.id ? t("checkpoint.restoring") : t("checkpoint.restore")}
                </button>
              </article>
            ))}
          </div>
        </div>
      ) : activeTab === "mutations" ? (
        <div id="recovery-panel-mutations" aria-labelledby="recovery-tab-mutations" className="checkpoint-list" role="tabpanel">
          <div className="checkpoint-notice">{t("recovery.mutationsHint")}</div>
          {mutations.length === 0 && <div className="workbench-panel-empty"><RefreshCw size={24} /><strong>{t("recovery.mutationsEmpty")}</strong></div>}
          {mutations.map((mutation) => <article className="checkpoint-card" key={mutation.id}>
            <div className="checkpoint-card-head"><strong>{mutation.path}</strong><time>{new Date(mutation.recordedAt).toLocaleString()}</time></div>
            <div className="checkpoint-meta"><span>{mutation.operation}</span><span>{mutation.rollbackScope}</span>{mutation.runId && <code>{mutation.runId}</code>}{mutation.toolCallId && <code>{mutation.toolCallId}</code>}</div>
            <button type="button" className="dialog-btn" disabled={readOnly || busyId !== null} onClick={() => void handleRollback(mutation.id, mutation.path)}><ArchiveRestore size={13} /> {t("recovery.rollback")}</button>
            {mutation.hunks?.length ? <div className="worktree-actions" aria-label={t("recovery.hunks")}><span>{t("recovery.hunks")}</span>{mutation.hunks.map((hunk, index) => <button type="button" className="dialog-btn" key={hunk.id} disabled={readOnly || busyId !== null} onClick={() => void handleHunkRollback(mutation.id, hunk.id, mutation.path)}>{t("recovery.rollbackHunk", { count: index + 1 })}</button>)}</div> : null}
          </article>)}
        </div>
      ) : activeTab === "changeSets" ? (
        <div id="recovery-panel-changeSets" aria-labelledby="recovery-tab-changeSets" className="checkpoint-list" role="tabpanel">
          <div className="checkpoint-notice">{t("recovery.changeSetsHint")}</div>
          <OfflineBundlePanel controller={bundleState} changeSets={changeSets} readOnly={readOnly} />
          {changeSets.length === 0 && <div className="workbench-panel-empty"><GitBranch size={24} /><strong>{t("recovery.changeSetsEmpty")}</strong></div>}
          {changeSets.map((changeSet) => {
            const runs = reviewRuns[changeSet.id] || [];
            const latest = runs[0];
            const revision = changeSetReviewRevision(changeSet);
            const reviewComplete = Boolean(revision) && runs.some((reviewRun) => reviewRun.stage === "review" && reviewRun.status === "completed" && reviewRun.revision === revision);
            const currentFindings = revision ? findingState.findings.filter((finding) => (finding.changeSetId === changeSet.id || finding.reviewer?.changeSetId === changeSet.id || finding.verifier?.changeSetId === changeSet.id) && (finding.revision === revision || finding.reviewer?.revision === revision || finding.verifier?.revision === revision)) : [];
            const fixedFindings = currentFindings.some((finding) => finding.lifecycle === "fixed");
            const findingsAllowApply = findingState.available && !findingState.loading && !findingState.error && !currentFindings.some((finding) => (finding.severity === "critical" || finding.severity === "error") && finding.lifecycle !== "verified" && finding.lifecycle !== "dismissed");
            const canApply = isChangeSetIntegrable(changeSet) && reviewComplete && findingsAllowApply;
            const reviewBusy = runs.some((reviewRun) => reviewRun.status === "queued" || reviewRun.status === "running");
            const recoveryDecisions = changeSetRecoveryDecisions(changeSet);
            const canRequestRevision = recoveryDecisions.includes("request_revision");
            const canReject = recoveryDecisions.includes("reject");
            const canOfferIntegration = isChangeSetIntegrable(changeSet);
            const currentSchema = isCurrentChangeSet(changeSet);
            const statusLabel = t(`recovery.changeSetStatus.${changeSet.status}`);
            return <article className={`checkpoint-card status-${changeSet.status}`} data-change-set-status={changeSet.status} key={changeSet.id}>
            <div className="checkpoint-card-head"><strong>{changeSet.id.slice(0, 12)}</strong><span className={`checkpoint-kind status-${changeSetStatusTone(changeSet.status)}`} role="status" aria-label={statusLabel}>{statusLabel}</span></div>
            <div className="checkpoint-meta"><code>{changeSet.baseSha.slice(0, 12)} → {changeSet.headSha.slice(0, 12)}</code><span>{changeSet.dirty ? t("recovery.dirty") : t("recovery.clean")}</span><span>{t("recovery.filesChanged", { count: changeSet.changedFiles.length })}</span></div>
            <div className="changeset-files">{changeSet.changedFiles.slice(0, 8).map((file) => <code key={file}>{file}</code>)}</div>
            {latest && <div className="changeset-review" aria-label={t("recovery.reviewRun")}><strong>{t(`recovery.reviewStage.${latest.stage}`)} · {t(`recovery.reviewStatus.${latest.status}`)}</strong><span>{t("recovery.reviewAttempt", { count: latest.attempt })} · {latest.reviewer.modelName}</span><code>{latest.revision.slice(0, 12)}</code>{latest.error && <span role="alert">{latest.error}</span>}</div>}
            {!currentSchema && <div className="checkpoint-notice" role="status">{t("recovery.legacyChangeSetReadOnly", { version: changeSet.schemaVersion })}</div>}
            {changeSet.recovery?.inspectionRequired && <div className="checkpoint-notice" role="status">{changeSet.recovery.state === "interrupted" ? t("recovery.interrupted") : t("recovery.failedInspect")}</div>}
            {changeSet.status === "needs_attention" && <div className="checkpoint-notice change-set-attention" role="status" aria-live="polite"><ShieldAlert size={14} aria-hidden="true" /><span>{t("recovery.needsAttentionDescription")}</span></div>}
            {changeSet.status === "applying" && currentSchema ? <button type="button" className="dialog-btn" disabled={readOnly || busyId !== null} onClick={() => void handleRecovery(changeSet)}><RefreshCw size={13} /> {t("recovery.recover")}</button> : changeSet.status === "no_changes" ? <div className="checkpoint-notice">{t("recovery.noChanges")}</div> : recoveryDecisions.length > 0 && <><div className="worktree-actions" role="group" aria-label={changeSet.status === "needs_attention" ? t("recovery.needsAttentionActions") : undefined}>{changeSet.status === "ready_for_review" && !reviewComplete && <button type="button" className="dialog-btn primary" disabled={readOnly || busyId !== null || reviewBusy} onClick={() => void handleReview(changeSet, "review")}>{t("recovery.startReview")}</button>}{reviewComplete && fixedFindings && changeSet.status === "ready_for_review" && <button type="button" className="dialog-btn" disabled={readOnly || busyId !== null || reviewBusy} onClick={() => void handleReview(changeSet, "reverify")}>{t("recovery.reverify")}</button>}{canOfferIntegration && <button type="button" className="dialog-btn primary" disabled={readOnly || busyId !== null || !canApply} title={!canApply ? t("recovery.applyReviewBlocked") : undefined} onClick={() => void handleDecision(changeSet, "apply")}>{t("recovery.apply")}</button>}{canRequestRevision && <button type="button" className="dialog-btn" disabled={readOnly || busyId !== null} onClick={() => void handleDecision(changeSet, "request_revision")}>{t("recovery.requestRevision")}</button>}{canReject && <button type="button" className="dialog-btn danger" disabled={readOnly || busyId !== null} onClick={() => void handleDecision(changeSet, "reject")}>{t("recovery.reject")}</button>}</div>{canOfferIntegration && !canApply && <div className="checkpoint-notice" role="status">{t("recovery.applyReviewBlocked")}</div>}</>}
          </article>;
          })}
        </div>
      ) : (
        <div id="recovery-panel-worktrees" role="tabpanel" aria-labelledby="recovery-tab-worktrees">
          <div className="worktree-create">
            <label>
              <span>{t("worktree.name")}</span>
              <input className="dialog-input" value={worktreeName} onChange={(event) => setWorktreeName(event.target.value)} placeholder={t("worktree.namePlaceholder")} />
            </label>
            <label>
              <span>{t("worktree.revision")}</span>
              <input className="dialog-input" value={worktreeRevision} onChange={(event) => setWorktreeRevision(event.target.value)} placeholder="HEAD" />
            </label>
            <button type="button" className="dialog-btn primary" onClick={() => void handleCreateWorktree()} disabled={readOnly || worktreeState.busyId !== null} title={readOnly ? t("recovery.readOnly") : undefined}>
              <Plus size={13} /> {worktreeState.busyId === "create" ? t("worktree.creating") : t("worktree.create")}
            </button>
          </div>
          <div className="checkpoint-notice">{t("worktree.notice")}</div>
          {worktreeState.error && <div className="workbench-panel-error" role="alert">{worktreeState.error}</div>}
          {!worktreeState.loading && worktreeState.worktrees.length === 0 && !worktreeState.error && (
            <div className="workbench-panel-empty"><GitBranch size={24} /><strong>{t("worktree.emptyTitle")}</strong><span>{t("worktree.emptyHint")}</span></div>
          )}
          <div className="checkpoint-list">
            {worktreeState.worktrees.map((worktree) => (
              <article className="checkpoint-card worktree-card" key={worktree.id}>
                <div className="checkpoint-card-head">
                  <strong>{worktree.branch || worktree.id}</strong>
                  {worktree.detached && <span className="checkpoint-kind">{t("worktree.detached")}</span>}
                </div>
                <code className="worktree-path" title={worktree.path}>{worktree.path}</code>
                <div className="checkpoint-meta">
                  {worktree.head && <code>{worktree.head.slice(0, 12)}</code>}
                </div>
                <div className="worktree-actions">
                  <button type="button" className="dialog-btn primary" onClick={() => void onOpenWorktree(worktree.path)} disabled={worktreeState.busyId !== null}>
                    <FolderOpen size={13} /> {t("worktree.open")}
                  </button>
                  <button type="button" className="dialog-btn danger" onClick={() => void handleRemoveWorktree(worktree.id, worktree.branch || worktree.id)} disabled={readOnly || worktreeState.busyId !== null} title={readOnly ? t("recovery.readOnly") : undefined}>
                    <Trash2 size={13} /> {worktreeState.busyId === worktree.id ? t("worktree.removing") : t("worktree.remove")}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}
      <ActionConfirmDialog
        intent={confirmIntent}
        busy={recoveryBusy}
        error={confirmError}
        onClose={() => { setConfirmIntent(null); setConfirmAction(null); setConfirmError(null); }}
        onConfirm={() => executeConfirmedAction()}
      />
    </aside>
  );
};
