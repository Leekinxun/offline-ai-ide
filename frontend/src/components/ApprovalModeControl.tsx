import React, { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { useApprovalMode } from "../hooks/useApprovalMode";
import { ActionConfirmDialog } from "./ActionConfirmDialog";
import { ApprovalModeStatus, approvalModeEnableIntent } from "./ApprovalModeStatus";

interface ApprovalModeControlProps {
  token: string;
  workspaceDir: string;
  conversationId: string | null;
  taskTitle: string;
  connected: boolean;
}

export function ApprovalModeControl({ token, workspaceDir, conversationId, taskTitle, connected }: ApprovalModeControlProps): React.JSX.Element {
  const { t } = useI18n();
  const mode = useApprovalMode({ token, workspaceDir, conversationId }, connected);
  const [confirmOpen, setConfirmOpen] = useState(false);
  useEffect(() => {
    if (mode.snapshot?.mode === "full_access" || (mode.verified && !mode.snapshot?.canEnable)) setConfirmOpen(false);
  }, [mode.snapshot?.mode, mode.snapshot?.canEnable, mode.verified]);
  const intent = useMemo(() => confirmOpen && conversationId && mode.snapshot?.mode === "ask"
    ? approvalModeEnableIntent(t, workspaceDir, conversationId, taskTitle) : null,
  [confirmOpen, conversationId, mode.snapshot?.mode, t, taskTitle, workspaceDir]);
  return <>
    <ApprovalModeStatus state={mode} conversationId={conversationId} workspaceDir={workspaceDir} taskTitle={taskTitle} connected={connected} t={t}
      onEnable={() => setConfirmOpen(true)} onDisable={() => { setConfirmOpen(false); void mode.setMode("ask"); }} onRetry={() => { void mode.refresh(); }} />
    <ActionConfirmDialog intent={intent} busy={mode.busy} confirmDisabled={!connected || !mode.verified || !mode.snapshot?.canEnable} error={mode.error ? t(`chat.approvalMode.error.${mode.error}`) : null}
      onClose={() => setConfirmOpen(false)} onConfirm={async () => { if (await mode.setMode("full_access", true)) setConfirmOpen(false); }} />
  </>;
}
