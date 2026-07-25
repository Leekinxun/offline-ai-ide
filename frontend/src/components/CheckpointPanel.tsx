import React, { useMemo, useState } from "react";
import { ArchiveRestore, Camera, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useCheckpoints } from "../hooks/useCheckpoints";
import { useI18n } from "../i18n";

interface CheckpointPanelProps {
  visible: boolean;
  token: string;
  conversationId?: string | null;
  runId?: string | null;
  onClose: () => void;
  onRestored: () => Promise<void> | void;
  onNotify: (message: string) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const CheckpointPanel: React.FC<CheckpointPanelProps> = ({
  visible,
  token,
  conversationId,
  runId,
  onClose,
  onRestored,
  onNotify,
}) => {
  const { t } = useI18n();
  const { checkpoints, loading, busyId, error, refresh, create, restore } = useCheckpoints(
    token,
    visible
  );
  const [label, setLabel] = useState("");
  const sorted = useMemo(
    () => [...checkpoints].sort((left, right) => right.createdAt - left.createdAt),
    [checkpoints]
  );

  if (!visible) return null;

  const handleCreate = async () => {
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

  const handleRestore = async (id: string, checkpointLabel: string) => {
    if (!window.confirm(t("checkpoint.restoreConfirm", { label: checkpointLabel }))) return;
    try {
      await restore(id);
      await onRestored();
      onNotify(t("checkpoint.restored", { label: checkpointLabel }));
    } catch (nextError) {
      onNotify(nextError instanceof Error ? nextError.message : t("checkpoint.restoreFailed"));
    }
  };

  return (
    <aside className="checkpoint-panel panel-shell workspace-drawer" aria-label={t("checkpoint.aria")} tabIndex={-1} data-workspace-drawer="checkpoints">
      <div className="workbench-panel-header">
        <div className="workbench-panel-title"><ShieldCheck size={15} /><strong>{t("checkpoint.title")}</strong></div>
        <div className="workbench-panel-actions">
          <button type="button" className="sidebar-action-btn" onClick={() => void refresh()} title={t("checkpoint.refresh")} aria-label={t("checkpoint.refresh")}>
            <RefreshCw size={14} className={loading ? "chat-spin" : ""} />
          </button>
          <button type="button" className="sidebar-action-btn" onClick={onClose} title={t("checkpoint.close")} aria-label={t("checkpoint.close")}>
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="checkpoint-create">
        <input
          className="dialog-input"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && void handleCreate()}
          placeholder={t("checkpoint.labelPlaceholder")}
          aria-label={t("checkpoint.labelPlaceholder")}
        />
        <button type="button" className="dialog-btn primary" onClick={() => void handleCreate()} disabled={busyId !== null}>
          <Camera size={13} /> {t("checkpoint.create")}
        </button>
      </div>

      <div className="checkpoint-notice">
        {t("checkpoint.notice")}
      </div>
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
              <span>{t("checkpoint.files", { count: checkpoint.fileCount })}</span><span>{formatSize(checkpoint.totalBytes)}</span>
              {checkpoint.runId && <code>{checkpoint.runId}</code>}
            </div>
            <button type="button" className="dialog-btn" onClick={() => void handleRestore(checkpoint.id, checkpoint.label)} disabled={busyId !== null}>
              <ArchiveRestore size={13} /> {busyId === checkpoint.id ? t("checkpoint.restoring") : t("checkpoint.restore")}
            </button>
          </article>
        ))}
      </div>
    </aside>
  );
};
