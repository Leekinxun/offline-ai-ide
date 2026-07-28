import React, { useMemo, useState } from "react";
import {
  ArchiveRestore,
  Camera,
  FolderOpen,
  GitBranch,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useCheckpoints } from "../hooks/useCheckpoints";
import { useWorktrees } from "../hooks/useWorktrees";
import { useI18n } from "../i18n";

interface CheckpointPanelProps {
  visible: boolean;
  token: string;
  conversationId?: string | null;
  runId?: string | null;
  readOnly: boolean;
  onClose: () => void;
  onRestored: () => Promise<void> | void;
  onOpenWorktree: (path: string) => Promise<void> | void;
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
  readOnly,
  onClose,
  onRestored,
  onOpenWorktree,
  onNotify,
}) => {
  const { t } = useI18n();
  const { checkpoints, loading, busyId, error, refresh, create, restore } = useCheckpoints(
    token,
    visible
  );
  const [label, setLabel] = useState("");
  const [activeTab, setActiveTab] = useState<"snapshots" | "worktrees">("snapshots");
  const [worktreeName, setWorktreeName] = useState("");
  const [worktreeRevision, setWorktreeRevision] = useState("HEAD");
  const worktreeState = useWorktrees(token, visible && activeTab === "worktrees");
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

  const handleRestore = async (id: string, checkpointLabel: string) => {
    if (readOnly) return;
    if (!window.confirm(t("checkpoint.restoreConfirm", { label: checkpointLabel }))) return;
    try {
      await restore(id);
      await onRestored();
      onNotify(t("checkpoint.restored", { label: checkpointLabel }));
    } catch (nextError) {
      onNotify(nextError instanceof Error ? nextError.message : t("checkpoint.restoreFailed"));
    }
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

  const handleRemoveWorktree = async (id: string, branch: string) => {
    if (readOnly) return;
    if (!window.confirm(t("worktree.removeConfirm", { branch }))) return;
    try {
      await worktreeState.remove(id);
      onNotify(t("worktree.removed", { branch }));
    } catch (nextError) {
      onNotify(nextError instanceof Error ? nextError.message : t("worktree.removeFailed"));
    }
  };

  return (
    <aside className="checkpoint-panel panel-shell workspace-drawer" aria-label={t("recovery.aria")} tabIndex={-1} data-workspace-drawer="checkpoints">
      <div className="workbench-panel-header">
        <div className="workbench-panel-title"><ShieldCheck size={15} /><strong>{t("recovery.title")}</strong></div>
        <div className="workbench-panel-actions">
          <button
            type="button"
            className="sidebar-action-btn"
            onClick={() => void (activeTab === "snapshots" ? refresh() : worktreeState.refresh())}
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

      <div className="recovery-tabs" role="tablist" aria-label={t("recovery.sections")}>
        <button type="button" role="tab" aria-selected={activeTab === "snapshots"} className={activeTab === "snapshots" ? "active" : ""} onClick={() => setActiveTab("snapshots")}>
          <ArchiveRestore size={13} /> {t("recovery.snapshots")}
        </button>
        <button type="button" role="tab" aria-selected={activeTab === "worktrees"} className={activeTab === "worktrees" ? "active" : ""} onClick={() => setActiveTab("worktrees")}>
          <GitBranch size={13} /> {t("recovery.worktrees")}
        </button>
      </div>
      {readOnly && <div className="checkpoint-notice" role="note">{t("recovery.readOnly")}</div>}

      {activeTab === "snapshots" ? (
        <>
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
        </>
      ) : (
        <>
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
        </>
      )}
    </aside>
  );
};
