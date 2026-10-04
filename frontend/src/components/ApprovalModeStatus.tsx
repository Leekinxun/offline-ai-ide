import React from "react";
import { Shield, ShieldAlert } from "lucide-react";
import type { ApprovalModeState } from "../hooks/approvalModeClient";
import type { ActionConfirmIntent } from "./ActionConfirmDialog";

type Translate = (key: string, values?: Record<string, string | number>) => string;

interface ApprovalModeStatusProps {
  state: ApprovalModeState;
  conversationId: string | null;
  workspaceDir: string;
  taskTitle: string;
  connected: boolean;
  t: Translate;
  onEnable: () => void;
  onDisable: () => void;
  onRetry: () => void;
}

export function ApprovalModeStatus({ state, conversationId, workspaceDir, taskTitle, connected, t, onEnable, onDisable, onRetry }: ApprovalModeStatusProps): React.JSX.Element {
  const fullAccess = state.snapshot?.mode === "full_access";
  const ready = state.verified && Boolean(state.snapshot);
  const unavailable = !conversationId ? "chat.approvalMode.taskRequired"
    : ready && !state.snapshot?.canEnable ? "chat.approvalMode.unavailable" : null;
  const disabled = state.busy || !ready || (!fullAccess && (!connected || !state.snapshot?.canEnable));
  const statusKey = !conversationId ? "chat.approvalMode.ask"
    : !ready ? (fullAccess ? "chat.approvalMode.fullUnverified" : "chat.approvalMode.unknown")
      : fullAccess ? "chat.approvalMode.full" : "chat.approvalMode.ask";
  return (
    <section className={`chat-approval-mode${fullAccess ? " is-full-access" : ""}`} aria-label={t("chat.approvalMode.label")} aria-busy={state.busy} data-approval-mode={ready ? state.snapshot?.mode : "unknown"}>
      <div className="chat-approval-mode-row">
        <span className="chat-approval-mode-status" role="status" aria-live="polite">
          {fullAccess ? <ShieldAlert size={15} aria-hidden="true" /> : <Shield size={15} aria-hidden="true" />}
          <strong>{t(statusKey)}</strong>
        </span>
        <button type="button" className="chat-approval-mode-action" disabled={disabled} onClick={fullAccess ? onDisable : onEnable} title={unavailable ? t(unavailable) : undefined}>
          {state.busy ? t("common.loading") : fullAccess ? t("chat.approvalMode.disable") : t("chat.approvalMode.enable")}
        </button>
      </div>
      {fullAccess && <p className="chat-approval-mode-boundaries">{t("chat.approvalMode.activeScope", { workspace: workspaceDir, task: taskTitle })}</p>}
      {unavailable && <p className="chat-approval-mode-hint">{t(unavailable)}</p>}
      {state.error && <div className="chat-approval-mode-error" role="alert">
        <span>{t(`chat.approvalMode.error.${state.error}`)}</span>
        <button type="button" onClick={onRetry} disabled={state.busy || state.loading}>{t("chat.approvalMode.retry")}</button>
      </div>}
    </section>
  );
}

export function approvalModeEnableIntent(t: Translate, workspaceDir: string, conversationId: string, taskTitle: string): ActionConfirmIntent {
  return {
    id: `approval-mode:${conversationId}:${workspaceDir}`,
    title: t("chat.approvalMode.enableTitle"),
    description: t("chat.approvalMode.enableDescription", { workspace: workspaceDir, task: taskTitle, conversationId }),
    confirmLabel: t("chat.approvalMode.confirmEnable"),
    tone: "danger",
  };
}
