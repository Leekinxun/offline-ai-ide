import React, { useEffect, useState } from "react";
import { GitBranch, GitCommitHorizontal, ShieldCheck } from "lucide-react";
import type { GitOperation } from "../types";
import type { ChangeSet } from "../hooks/useCheckpoints";
import type { useGitDelivery } from "../hooks/useGitDelivery";
import { useI18n } from "../i18n";
import { isChangeSetIntegrable } from "./changeSetRecoveryPolicy";

type GitDeliveryController = ReturnType<typeof useGitDelivery>;

interface GitLocalPanelProps {
  controller: GitDeliveryController;
  changeSets: ChangeSet[];
  readOnly: boolean;
  conversationId?: string | null;
  runId?: string | null;
  onPrepared: (operation: GitOperation) => void;
}

export const GitLocalPanel: React.FC<GitLocalPanelProps> = ({ controller, changeSets, readOnly, conversationId, runId, onPrepared }) => {
  const { t } = useI18n();
  const [action, setAction] = useState<"create_branch" | "commit_change_set">("commit_change_set");
  const [branchName, setBranchName] = useState("");
  const [subject, setSubject] = useState("");
  const [changeSetId, setChangeSetId] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const headSha = controller.status?.headSha || "";
  const currentBranch = controller.status?.branch || "";
  const readyChangeSets = changeSets.filter(isChangeSetIntegrable);
  const selectedReadyChangeSet = readyChangeSets.find((item) => item.id === changeSetId);

  useEffect(() => {
    if (!branchName && currentBranch && currentBranch !== "HEAD") setBranchName(currentBranch);
  }, [branchName, currentBranch]);
  useEffect(() => {
    if (!selectedReadyChangeSet) setChangeSetId(readyChangeSets[0]?.id || "");
  }, [readyChangeSets, selectedReadyChangeSet]);

  const prepare = async () => {
    setLocalError(null);
    try {
      if (!headSha) throw new Error(t("delivery.noHead"));
      if (action === "commit_change_set" && !selectedReadyChangeSet) throw new Error(t("delivery.noReadyChangeSets"));
      const input = action === "create_branch"
        ? { action, branch: branchName.trim(), baseSha: headSha, expectedRefSha: null } as const
        : { action, branch: branchName.trim(), changeSetId: selectedReadyChangeSet!.id, expectedRefSha: headSha, ...(subject.trim() ? { subject: subject.trim() } : {}) } as const;
      const operation = await controller.prepare({
        idempotencyKey: crypto.randomUUID(),
        input,
        provenance: {
          ...(conversationId ? { conversationId } : {}),
          ...(runId ? { runId } : {}),
          ...(action === "commit_change_set" ? { changeSetId } : {}),
        },
      });
      onPrepared(operation);
    } catch (nextError) {
      setLocalError(nextError instanceof Error ? nextError.message : t("delivery.prepareFailed"));
    }
  };

  const invalid = !branchName.trim() || !headSha || (action === "commit_change_set" && !selectedReadyChangeSet);
  return <div className="git-local-panel">
    <div className="delivery-mode-tabs" role="tablist" aria-label={t("delivery.localActions")}>
      <button type="button" role="tab" aria-selected={action === "commit_change_set"} className={action === "commit_change_set" ? "active" : ""} onClick={() => setAction("commit_change_set")}><GitCommitHorizontal size={14} />{t("delivery.commit")}</button>
      <button type="button" role="tab" aria-selected={action === "create_branch"} className={action === "create_branch" ? "active" : ""} onClick={() => setAction("create_branch")}><GitBranch size={14} />{t("delivery.createBranch")}</button>
    </div>
    {readOnly && <div className="delivery-notice" role="note">{t("delivery.readOnly")}</div>}
    {!controller.capabilities.canPrepare && !readOnly && <div className="delivery-notice" role="note">{t("delivery.prepareUnavailable")}</div>}
    <div className="delivery-form">
      <label><span>{t("delivery.branchName")}</span><input className="dialog-input" value={branchName} onChange={(event) => setBranchName(event.target.value)} placeholder="crewforge/my-change" disabled={readOnly} /></label>
      {action === "commit_change_set" && <>
        <label><span>{t("delivery.changeSet")}</span><select className="dialog-input" value={changeSetId} onChange={(event) => setChangeSetId(event.target.value)} disabled={readOnly || readyChangeSets.length === 0}><option value="">{t("delivery.selectChangeSet")}</option>{readyChangeSets.map((item) => <option key={item.id} value={item.id}>{item.id.slice(0, 12)} · {t("delivery.files", { count: item.changedFiles.length })}</option>)}</select></label>
        <label><span>{t("delivery.commitMessage")}</span><input className="dialog-input" value={subject} onChange={(event) => setSubject(event.target.value)} placeholder={t("delivery.commitMessagePlaceholder")} disabled={readOnly} /></label>
      </>}
    </div>
    {action === "commit_change_set" && readyChangeSets.length === 0 && <div className="delivery-notice">{t("delivery.noReadyChangeSets")}</div>}
    <div className="delivery-preflight-summary"><ShieldCheck size={15} /><div><strong>{t("delivery.serverPreflight")}</strong><span>{t("delivery.serverPreflightHint")}</span></div><code>{headSha.slice(0, 12) || "—"}</code></div>
    {(controller.error || localError) && <div className="delivery-inline-error" role="alert">{localError || controller.error}</div>}
    {controller.conflict && <div className="delivery-stale-card" role="alert"><div><strong>{t("delivery.stateChanged")}</strong><span>{controller.conflict.message}</span></div><button type="button" className="dialog-btn" onClick={() => void controller.refresh()}>{t("delivery.refreshRebuild")}</button></div>}
    <button type="button" className="dialog-btn primary delivery-preflight-button" disabled={invalid || readOnly || !controller.capabilities.canPrepare || controller.busyId !== null} onClick={() => void prepare()}><ShieldCheck size={14} />{controller.busyId === "prepare" ? t("delivery.preflighting") : t("delivery.previewOperation")}</button>
  </div>;
};
