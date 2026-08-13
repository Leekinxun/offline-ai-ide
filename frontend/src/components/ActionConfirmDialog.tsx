import React, { useEffect, useId, useRef } from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { claimModalEscape } from "./modalKeyboardContract";

export interface ActionConfirmIntent {
  id: string;
  title: string;
  description: string;
  confirmLabel?: string;
  tone?: "primary" | "danger";
}

interface ActionConfirmDialogProps {
  intent: ActionConfirmIntent | null;
  busy?: boolean;
  error?: string | null;
  onConfirm: (intent: ActionConfirmIntent) => Promise<void> | void;
  onClose: () => void;
}

export const ActionConfirmDialog: React.FC<ActionConfirmDialogProps> = ({ intent, busy = false, error, onConfirm, onClose }) => {
  const { t } = useI18n();
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!intent) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => cancelRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (claimModalEscape(event, () => { if (!busyRef.current) onCloseRef.current(); })) return;
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'));
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => { window.removeEventListener("keydown", handleKeyDown, true); requestAnimationFrame(() => returnFocusRef.current?.focus()); };
  }, [intent?.id]);
  if (!intent) return null;
  return createPortal(
    <div className="delivery-approval-overlay" onMouseDown={() => !busy && onClose()}>
      <section ref={dialogRef} className="delivery-approval-dialog panel-shell" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={busy} onMouseDown={(event) => event.stopPropagation()}>
        <header className="delivery-approval-header">
          <span className="delivery-approval-icon" aria-hidden="true"><AlertTriangle size={20} /></span>
          <div><strong id={titleId}>{intent.title}</strong><p id={descriptionId}>{intent.description}</p></div>
          <button type="button" onClick={onClose} disabled={busy} aria-label={t("common.close")}><X size={16} /></button>
        </header>
        {error && <div className="delivery-inline-error" role="alert" aria-live="assertive">{error}</div>}
        {busy && <div className="sr-only" role="status" aria-live="polite">{t("common.loading")}</div>}
        <footer className="delivery-approval-actions">
          <button ref={cancelRef} type="button" className="dialog-btn" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
          <button type="button" className={`dialog-btn ${intent.tone === "danger" ? "danger" : "primary"}`} onClick={() => void onConfirm(intent)} disabled={busy}><Check size={14} />{busy ? t("common.loading") : intent.confirmLabel || t("common.confirm")}</button>
        </footer>
      </section>
    </div>,
    document.body
  );
};
