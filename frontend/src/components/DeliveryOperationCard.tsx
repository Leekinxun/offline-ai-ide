import React, { useState } from "react";
import { AlertTriangle, Ban, CheckCircle2, Clock3, GitCommitHorizontal, LoaderCircle, RefreshCw, ShieldAlert } from "lucide-react";
import type { GitOperation } from "../types";
import { useI18n } from "../i18n";

interface DeliveryOperationCardProps {
  operation: GitOperation;
  busy?: boolean;
  readOnly?: boolean;
  onApprove?: (operation: GitOperation) => Promise<void> | void;
  onCancel?: (operation: GitOperation) => Promise<void> | void;
  onRebuild?: (operation: GitOperation) => Promise<void> | void;
}

function StatusIcon({ status }: { status: GitOperation["status"] }) {
  if (status === "completed") return <CheckCircle2 size={15} />;
  if (status === "running") return <LoaderCircle size={15} className="chat-spin" />;
  if (status === "conflicted" || status === "manual_recovery") return <AlertTriangle size={15} />;
  if (status === "failed" || status === "cancelled") return <Ban size={15} />;
  if (status === "awaiting_approval") return <ShieldAlert size={15} />;
  return <Clock3 size={15} />;
}

export const DeliveryOperationCard: React.FC<DeliveryOperationCardProps> = ({ operation, busy, readOnly, onApprove, onCancel, onRebuild }) => {
  const { t } = useI18n();
  const [actionError, setActionError] = useState<string | null>(null);
  const invoke = async (action: (() => Promise<void> | void) | undefined) => {
    if (!action) return;
    setActionError(null);
    try { await action(); }
    catch (nextError) { setActionError(nextError instanceof Error ? nextError.message : t("delivery.operationFailed")); }
  };
  const conflicted = operation.status === "conflicted" || operation.status === "manual_recovery";
  const branch = "branch" in operation.input ? operation.input.branch : operation.input.remoteRef.replace(/^refs\/heads\//, "");
  const target = operation.input.action === "push" ? `${operation.input.remote}/${operation.input.remoteRef}` : (operation.before.ref as string | undefined);
  const changedFiles = operation.preflight.evidenceSummary?.changedFiles || [];
  return <article className={`delivery-operation-card status-${operation.status}`} aria-labelledby={`delivery-operation-${operation.id}`}>
    <header>
      <span className="delivery-operation-status"><StatusIcon status={operation.status} /></span>
      <div><strong id={`delivery-operation-${operation.id}`}><GitCommitHorizontal size={13} />{t(`delivery.gitAction.${operation.action}`)}</strong><small>{t(`delivery.operationStatus.${operation.status}`)} · {operation.id.slice(0, 12)}</small></div>
      <time>{new Date(operation.updatedAt).toLocaleString()}</time>
    </header>
    <dl className="delivery-operation-facts">
      <div><dt>{t("delivery.branch")}</dt><dd>{branch || "—"}</dd></div>
      <div><dt>HEAD</dt><dd><code>{String(operation.before.headSha || operation.before.desiredSha || "—").slice(0, 12)}</code></dd></div>
      <div><dt>{t("delivery.scope")}</dt><dd>{changedFiles.length ? t("delivery.files", { count: changedFiles.length }) : operation.preflight.repositoryId.slice(0, 12)}</dd></div>
      {target && <div><dt>{t("delivery.target")}</dt><dd><code>{target}</code></dd></div>}
    </dl>
    {operation.preflight.warnings?.length ? <ul className="delivery-operation-warnings">{operation.preflight.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}
    {operation.conflicts?.length ? <div className="delivery-operation-conflicts" role="status">{operation.conflicts.map((conflict, index) => <p key={`${String(conflict.code || index)}:${String(conflict.path || "")}`}><AlertTriangle size={13} /><span>{Boolean(conflict.path) && <code>{String(conflict.path)}</code>}{String(conflict.message || conflict.error || conflict.code || t("delivery.operationConflict"))}</span></p>)}</div> : null}
    {operation.error && <div className="delivery-inline-error" role="alert">{operation.error}</div>}
    {actionError && <div className="delivery-inline-error" role="alert">{actionError}</div>}
    <footer>
      {operation.status === "awaiting_approval" && onApprove && <button type="button" className="dialog-btn primary" disabled={busy || readOnly} onClick={() => void invoke(() => onApprove(operation))}>{t("delivery.reviewApproval")}</button>}
      {(["awaiting_approval", "queued", "running"] as GitOperation["status"][]).includes(operation.status) && onCancel && <button type="button" className="dialog-btn" disabled={busy || readOnly} onClick={() => void invoke(() => onCancel(operation))}>{t("common.cancel")}</button>}
      {conflicted && onRebuild && <button type="button" className="dialog-btn" disabled={busy || readOnly} onClick={() => void invoke(() => onRebuild(operation))}><RefreshCw size={13} />{t("delivery.refreshRebuild")}</button>}
    </footer>
  </article>;
};
