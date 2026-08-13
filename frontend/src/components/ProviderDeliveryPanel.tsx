import React, { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, CloudOff, ExternalLink, GitPullRequest, LoaderCircle, MessageSquare, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import type { DeliveryFeedback, GitOperation, ProviderDeliveryOperation } from "../types";
import type { ChangeSet } from "../hooks/useCheckpoints";
import type { DeliveryRepositoryRef, useProviderDelivery } from "../hooks/useProviderDelivery";
import { useI18n } from "../i18n";
import { OperationApprovalDialog, type ApprovalIntent } from "./OperationApprovalDialog";
import { SafeExternalLink } from "./SafeExternalLink";
import { changeSetPatchContentSha256, changeSetReviewRevision, isCurrentChangeSet } from "../hooks/changeSetContract";

type ProviderController = ReturnType<typeof useProviderDelivery>;
interface ProviderDeliveryPanelProps { controller: ProviderController; gitOperations: GitOperation[]; changeSets: ChangeSet[]; readOnly: boolean; onFollowUpCreated?: (result: { taskId: number; followUpRunId: string }) => Promise<void> | void; onOpenFollowUpRun?: (runId: string) => Promise<void> | void; onShowOfflineBundles?: () => void; }

export const ProviderDeliveryPanel: React.FC<ProviderDeliveryPanelProps> = ({ controller, gitOperations, changeSets, readOnly, onFollowUpCreated, onOpenFollowUpRun, onShowOfflineBundles }) => {
  const { t } = useI18n();
  const completedCommits = gitOperations.filter((item) => item.action === "commit_change_set" && item.status === "completed" && item.preflight.evidenceSummary);
  const [operationId, setOperationId] = useState("");
  const selectedOperation = completedCommits.find((item) => item.id === operationId) || completedCommits[0];
  const evidence = selectedOperation?.preflight.evidenceSummary;
  const selectedChangeSet = changeSets.find((item) => item.id === evidence?.changeSetId);
  const selectedRevision = selectedChangeSet ? changeSetReviewRevision(selectedChangeSet) : undefined;
  const selectedPatchContentSha256 = selectedChangeSet ? changeSetPatchContentSha256(selectedChangeSet) : undefined;
  const selectedChangeSetNeedsAttention = selectedChangeSet?.status === "needs_attention";
  const selectedChangeSetReadOnly = Boolean(selectedChangeSet && !isCurrentChangeSet(selectedChangeSet));
  const branch = selectedOperation && "branch" in selectedOperation.input ? selectedOperation.input.branch : "";
  const expectedHeadSha = String(selectedOperation?.after?.headSha || evidence?.headSha || "");
  const [providerConfigId, setProviderConfigId] = useState("");
  const providerConfig = controller.providers.find((item) => item.id === providerConfigId) || controller.providers[0];
  const [repositoryId, setRepositoryId] = useState("");
  const [owner, setOwner] = useState(""); const [repositoryName, setRepositoryName] = useState("");
  const [baseBranch, setBaseBranch] = useState("main"); const [title, setTitle] = useState(""); const [generatedBody, setGeneratedBody] = useState(""); const [draft, setDraft] = useState(true);
  const [approval, setApproval] = useState<ApprovalIntent | null>(null); const [publicationOperation, setPublicationOperation] = useState<ProviderDeliveryOperation | null>(null); const [feedbackApproval, setFeedbackApproval] = useState<DeliveryFeedback | null>(null); const [localError, setLocalError] = useState<string | null>(null);
  const current = controller.deliveries.find((item) => Boolean(selectedChangeSet && selectedRevision && selectedPatchContentSha256 && providerConfig && repositoryId.trim())
    && item.changeSetId === selectedChangeSet!.id
    && item.revision === selectedRevision
    && item.patchContentSha256 === selectedPatchContentSha256
    && item.headSha === expectedHeadSha
    && item.remote.headSha === expectedHeadSha
    && item.remote.headBranch === branch
    && item.remote.baseBranch === baseBranch
    && item.providerConfigId === providerConfig!.id
    && item.repositoryId === repositoryId.trim());
  const bindingConflict = controller.deliveries.find((item) => Boolean(selectedChangeSet && selectedRevision && selectedPatchContentSha256 && providerConfig && repositoryId.trim())
    && item.changeSetId === selectedChangeSet!.id
    && item.id !== current?.id
    && (item.revision !== selectedRevision || item.patchContentSha256 !== selectedPatchContentSha256 || item.headSha !== expectedHeadSha || item.remote.headBranch !== branch || item.remote.baseBranch !== baseBranch || item.providerConfigId !== providerConfig!.id || item.repositoryId !== repositoryId.trim()));
  const capability = controller.capabilities.find((item) => item.providerConfigId === providerConfig?.id);
  const offline = !providerConfig?.credentialConfigured || (capability && !["online", "degraded"].includes(capability.health));
  const feedback = current ? controller.feedback.filter((item) => item.deliveryId === current.id || item.proposalKey === current.proposalKey) : [];

  useEffect(() => { if (!operationId && completedCommits[0]) setOperationId(completedCommits[0].id); }, [completedCommits, operationId]);
  useEffect(() => { if (!providerConfigId && controller.providers[0]) setProviderConfigId(controller.providers[0].id); }, [controller.providers, providerConfigId]);
  useEffect(() => { if (!title && branch) setTitle(branch.replace(/[-_/]+/g, " ")); }, [branch, title]);

  const repository = (): DeliveryRepositoryRef | null => providerConfig && repositoryId.trim() ? { providerConfigId: providerConfig.id, remoteRepositoryId: repositoryId.trim(), ...(owner.trim() ? { owner: owner.trim() } : {}), ...(repositoryName.trim() ? { name: repositoryName.trim() } : {}), ...(providerConfig.gitRemoteName ? { gitRemoteName: providerConfig.gitRemoteName } : {}) } : null;
  const probe = async () => { const ref = repository(); if (!ref) return; setLocalError(null); try { await controller.probe(ref); } catch (error) { setLocalError(error instanceof Error ? error.message : t("delivery.providerUnavailable")); } };
  const reviewPublish = async () => {
    if (!providerConfig || !selectedChangeSet || !isCurrentChangeSet(selectedChangeSet) || selectedChangeSet.status === "needs_attention" || !evidence || !expectedHeadSha) return;
    const ref = repository(); if (!ref) return;
    setFeedbackApproval(null); setPublicationOperation(null); setLocalError(null);
    try {
      const operation = await controller.prepare({ providerConfigId: providerConfig.id, repository: ref, title: title.trim(), generatedBody: generatedBody.trim(), headBranch: branch, baseBranch, changeSetId: selectedChangeSet.id, draft, existingDeliveryId: current?.id }, `${selectedChangeSet.captureIntegritySha256}:${changeSetPatchContentSha256(selectedChangeSet)}:${evidence.verificationDigest}`);
      if (!["awaiting_approval", "approved"].includes(operation.status)) throw new Error(operation.error || t(`delivery.operationStatus.${operation.status}`));
      setPublicationOperation(operation);
      setApproval({ id: operation.id, kind: "provider", title: current ? t("delivery.approveUpdate") : t("delivery.approvePublish"), description: t("delivery.providerApprovalHint"), impact: [{ label: t("delivery.provider"), value: operation.request.providerConfigId }, { label: t("delivery.repository"), value: operation.request.repository.remoteRepositoryId }, { label: t("delivery.title"), value: operation.request.title }, { label: t("delivery.head"), value: `${operation.request.headBranch} @ ${operation.request.expectedHeadSha.slice(0, 12)}` }, { label: t("delivery.base"), value: operation.request.baseBranch }, { label: t("delivery.changeSet"), value: `${operation.request.changeSetId.slice(0, 12)} @ ${operation.request.revision.slice(0, 12)}` }, { label: t("delivery.requestDigest"), value: operation.requestDigest.slice(0, 16) }, { label: t("delivery.approvalDigest"), value: operation.approvalDigest.slice(0, 16) }, { label: t("delivery.reviewArtifact"), value: operation.request.reviewArtifactDigest.slice(0, 16) }], warnings: capability?.health === "degraded" ? [t("delivery.providerDegraded")] : [], confirmLabel: current ? t("delivery.updateDelivery") : t("delivery.publish") });
    } catch (error) { setLocalError(error instanceof Error ? error.message : t("delivery.preflightFailed")); }
  };
  const reviewFollowUp = (item: DeliveryFeedback) => {
    setFeedbackApproval(item);
    const sourceLabel = item.source.kind === "ci_check" ? item.source.name : `${item.source.author || t("delivery.unknownAuthor")} · ${item.source.path || t("delivery.reviewComment")}`;
    setApproval({ id: crypto.randomUUID(), kind: "follow_up", title: t("delivery.approveFollowUp"), description: t("delivery.followUpApprovalHint"), impact: [{ label: t("delivery.source"), value: sourceLabel }, { label: t("delivery.revision"), value: (item.revision || item.headSha).slice(0, 12), warning: item.stale }, { label: t("delivery.changeSet"), value: item.changeSetId?.slice(0, 12) || "—" }], warnings: item.stale ? [t("delivery.followUpStale")] : [], confirmLabel: t("delivery.createFollowUp") });
  };
  const approve = async (intent: ApprovalIntent) => {
    if (intent.kind === "provider") {
      if (!publicationOperation || publicationOperation.id !== intent.id) throw new Error(t("delivery.preflightMissing"));
      const approved = publicationOperation.status === "approved" ? publicationOperation : await controller.approvePublication(publicationOperation);
      await controller.publish(approved);
    } else if (current && feedbackApproval) {
      const next = await controller.approveFollowUp(current, feedbackApproval, intent.id);
      if (!next.taskId || !next.followUpRunId) throw new Error(t("delivery.followUpIncomplete"));
      await onFollowUpCreated?.({ taskId: next.taskId, followUpRunId: next.followUpRunId });
    }
    setApproval(null); setPublicationOperation(null); setFeedbackApproval(null);
  };

  return <div className="provider-delivery-panel">
    <div className={`provider-health health-${capability?.health || (providerConfig?.credentialConfigured ? "unknown" : "unauthorized")}`} role="status" aria-live="polite" aria-atomic="true"><GitPullRequest size={16} /><div><strong>{providerConfig ? providerConfig.kind : t("delivery.noProvider")}</strong><span>{capability ? t(`delivery.providerHealth.${capability.health}`) : t("delivery.providerNeedsProbe")}</span></div><button type="button" className="sidebar-action-btn" onClick={() => void controller.refresh()} aria-label={t("common.refresh")}><RefreshCw size={14} /></button></div>
    <div className="delivery-form provider-publish-form">
      <label><span>{t("delivery.provider")}</span><select className="dialog-input" value={providerConfig?.id || ""} onChange={(event) => { setProviderConfigId(event.target.value); controller.clearError(); }}><option value="">{t("delivery.selectProvider")}</option>{controller.providers.map((item) => <option key={item.id} value={item.id}>{item.kind} · {item.id}</option>)}</select></label>
      <label><span>{t("delivery.repositoryId")}</span><input className="dialog-input" value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)} placeholder="owner/repository" /></label>
      <label><span>{t("delivery.repositoryOwner")}</span><input className="dialog-input" value={owner} onChange={(event) => setOwner(event.target.value)} /></label><label><span>{t("delivery.repositoryName")}</span><input className="dialog-input" value={repositoryName} onChange={(event) => setRepositoryName(event.target.value)} /></label>
      <button type="button" className="dialog-btn" disabled={!repositoryId.trim() || controller.busyId !== null} onClick={() => void probe()}>{t("delivery.checkCapabilities")}</button>
      <label><span>{t("delivery.verifiedCommit")}</span><select className="dialog-input" value={selectedOperation?.id || ""} onChange={(event) => setOperationId(event.target.value)}><option value="">{t("delivery.selectVerifiedCommit")}</option>{completedCommits.map((item) => <option key={item.id} value={item.id}>{String(item.after?.headSha || item.preflight.evidenceSummary?.headSha).slice(0, 12)} · {item.preflight.evidenceSummary?.changeSetId.slice(0, 12)}</option>)}</select></label>
      <label><span>{t("delivery.baseBranch")}</span><input className="dialog-input" value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} disabled={readOnly} /></label><label><span>{t("delivery.title")}</span><input className="dialog-input" value={title} onChange={(event) => setTitle(event.target.value)} disabled={readOnly} /></label><label className="wide"><span>{t("delivery.generatedBody")}</span><textarea className="dialog-input" value={generatedBody} onChange={(event) => setGeneratedBody(event.target.value)} disabled={readOnly} /></label><label className="delivery-checkbox"><input type="checkbox" checked={draft} onChange={(event) => setDraft(event.target.checked)} disabled={readOnly} />{t("delivery.createDraft")}</label>
    </div>
    {(offline || !providerConfig) && <div className="delivery-offline-state"><CloudOff size={20} /><strong>{t("delivery.offlineTitle")}</strong><span>{providerConfig?.credentialConfigured ? capability?.error || t("delivery.offlineHint") : t("delivery.providerCredentialsMissing")}</span>{onShowOfflineBundles && <button type="button" className="dialog-btn primary" onClick={onShowOfflineBundles}>{t("delivery.openOfflineBundles")}</button>}</div>}
    {current?.stale && <div className="delivery-stale-card" role="alert"><AlertTriangle size={15} /><div><strong>{t("delivery.deliveryStale")}</strong><span>{t("delivery.deliveryStaleHint", { old: current.headSha.slice(0, 12), current: expectedHeadSha.slice(0, 12) || "—" })}</span></div><button type="button" className="dialog-btn" onClick={() => void controller.refreshDelivery(current)}>{t("common.refresh")}</button></div>}
    {bindingConflict && <div className="delivery-stale-card" role="alert"><AlertTriangle size={15} /><div><strong>{t("delivery.bindingConflict")}</strong><span>{t("delivery.bindingConflictHint")}</span><code>{bindingConflict.id.slice(0, 12)} · {bindingConflict.revision.slice(0, 12)}</code></div></div>}
    {selectedChangeSetNeedsAttention && <div className="delivery-stale-card" role="status" aria-live="polite"><AlertTriangle size={15} /><div><strong>{t("recovery.changeSetStatus.needs_attention")}</strong><span>{t("recovery.needsAttentionDescription")}</span></div></div>}
    {selectedChangeSetReadOnly && selectedChangeSet && <div className="delivery-stale-card" role="status"><AlertTriangle size={15} /><div><strong>{t("delivery.changeSet")}</strong><span>{t("recovery.legacyChangeSetReadOnly", { version: selectedChangeSet.schemaVersion })}</span></div></div>}
    {controller.conflict && <div className="delivery-stale-card" role="alert"><AlertTriangle size={15} /><div><strong>{controller.conflict.code === "binding_conflict" ? t("delivery.bindingConflict") : t("delivery.serverConflict")}</strong><span>{controller.conflict.message}</span><code>{controller.conflict.code}</code></div></div>}
    {(localError || (controller.error && !controller.conflict)) && <div className="delivery-inline-error" role="alert">{localError || controller.error}</div>}
    <button type="button" className="dialog-btn primary" disabled={readOnly || offline || !capability?.supports.changeRequests || !title.trim() || !generatedBody.trim() || !selectedChangeSet || selectedChangeSetReadOnly || selectedChangeSetNeedsAttention || controller.busyId !== null || Boolean(current?.stale)} onClick={() => void reviewPublish()}><ShieldCheck size={14} />{current ? t("delivery.reviewUpdate") : t("delivery.reviewPublish")}</button>
    {current && <section className="provider-current-delivery"><header><div><strong>{current.remote.title}</strong><span>{t(`delivery.status.${current.remote.state}`)} · {t(`delivery.merge.${current.remote.mergeReadiness}`)}</span></div><SafeExternalLink href={current.remote.url}><ExternalLink size={13} />{t("delivery.openProvider")}</SafeExternalLink></header><div className="delivery-check-list">{current.checks.map((check) => <article key={check.id} className={`delivery-check status-${check.state}`}>{check.state === "success" ? <CheckCircle2 size={14} /> : check.state === "failure" ? <XCircle size={14} /> : <LoaderCircle size={14} className={check.state === "running" ? "chat-spin" : ""} />}<div><strong>{check.name}</strong><span>{t(`delivery.check.${check.state}`)}{check.description ? ` · ${check.description}` : ""}</span></div><SafeExternalLink href={check.url} aria-label={check.name}><ExternalLink size={13} /></SafeExternalLink></article>)}</div></section>}
    {feedback.length > 0 && <section className="delivery-feedback-list"><h4><MessageSquare size={14} />{t("delivery.followUps", { count: feedback.length })}</h4>{feedback.map((item) => <article key={item.id} className={item.stale ? "stale" : ""}><div><strong>{item.source.kind === "ci_check" ? item.source.name : item.source.author || t("delivery.reviewComment")}</strong><span>{t(`delivery.feedback.${item.lifecycle}`)} · {(item.revision || item.headSha).slice(0, 12)}</span></div><p>{item.source.kind === "ci_check" ? item.source.evidence?.join("\n") || item.source.conclusion : item.source.body}</p>{item.lifecycle === "pending_approval" && !item.stale && <button type="button" className="dialog-btn" disabled={readOnly || controller.busyId !== null} onClick={() => reviewFollowUp(item)}>{t("delivery.reviewFollowUp")}</button>}{item.taskId && <code>{t("delivery.taskCreated", { id: item.taskId })}</code>}{item.followUpRunId ? <button type="button" className="dialog-btn" onClick={() => void onOpenFollowUpRun?.(item.followUpRunId!)} disabled={!onOpenFollowUpRun}>{t("delivery.openFollowUpRun")} · <code>{item.followUpRunId.slice(0, 12)}</code></button> : item.lifecycle === "task_created" || item.lifecycle === "in_progress" ? <div className="delivery-inline-error" role="alert">{t("delivery.followUpRunMissing")}</div> : null}</article>)}</section>}
    <OperationApprovalDialog intent={approval} busy={controller.busyId !== null} error={controller.error} onApprove={approve} onClose={() => { if (!controller.busyId) { setApproval(null); setPublicationOperation(null); setFeedbackApproval(null); } }} />
  </div>;
};
