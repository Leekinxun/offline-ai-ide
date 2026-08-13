import React, { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Check, ShieldAlert, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { useModalDialogFocus } from "./useModalDialogFocus";

export interface ApprovalIntent {
  id: string;
  kind: "git" | "provider" | "follow_up";
  title: string;
  description: string;
  impact: Array<{ label: string; value: string; warning?: boolean }>;
  warnings?: string[];
  confirmLabel: string;
  reasonRequired?: boolean;
}

interface OperationApprovalDialogProps {
  intent: ApprovalIntent | null;
  busy?: boolean;
  error?: string | null;
  onApprove: (intent: ApprovalIntent, reason?: string) => Promise<void> | void;
  onClose: () => void;
}

export const OperationApprovalDialog: React.FC<OperationApprovalDialogProps> = ({ intent, busy = false, error, onApprove, onClose }) => {
  const { t } = useI18n();
  const titleId = useId();
  const descriptionId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(busy);
  const [localError, setLocalError] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  useEffect(() => { busyRef.current = busy; }, [busy]);
  const dialogRef = useModalDialogFocus<HTMLElement>({ open: Boolean(intent), onClose: () => { if (!busyRef.current) onClose(); }, initialFocusRef: closeRef });

  useEffect(() => {
    if (!intent) return;
    setLocalError(null);
    setReason("");
  }, [intent?.id]);

  if (!intent) return null;

  const approve = async () => {
    setLocalError(null);
    try { await onApprove(intent, reason.trim() || undefined); }
    catch (nextError) { setLocalError(nextError instanceof Error ? nextError.message : t("delivery.approvalFailed")); }
  };

  return createPortal(
    <div className="delivery-approval-overlay" onMouseDown={() => !busy && onClose()}>
      <section
        ref={dialogRef}
        className="delivery-approval-dialog panel-shell"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="delivery-approval-header">
          <span className="delivery-approval-icon"><ShieldAlert size={20} /></span>
          <div><strong id={titleId}>{intent.title}</strong><p id={descriptionId}>{intent.description}</p></div>
          <button ref={closeRef} type="button" onClick={onClose} disabled={busy} aria-label={t("common.close")}><X size={16} /></button>
        </header>
        <dl className="delivery-approval-impact">
          {intent.impact.map((item) => <div key={`${item.label}:${item.value}`} className={item.warning ? "warning" : ""}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}
        </dl>
        {Boolean(intent.warnings?.length) && <div className="delivery-approval-warnings" role="note"><AlertTriangle size={16} /><ul>{intent.warnings?.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
        {intent.reasonRequired && <label className="delivery-approval-reason"><span>{t("delivery.approvalReason")}</span><textarea className="dialog-input" value={reason} onChange={(event) => setReason(event.target.value)} required aria-required="true" /></label>}
        {(error || localError) && <div className="delivery-inline-error" role="alert">{localError || error}</div>}
        <footer className="delivery-approval-actions">
          <button type="button" className="dialog-btn" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
          <button type="button" className="dialog-btn primary" onClick={() => void approve()} disabled={busy || (intent.reasonRequired && !reason.trim())}><Check size={14} />{busy ? t("delivery.approving") : intent.confirmLabel}</button>
        </footer>
      </section>
    </div>,
    document.body
  );
};
