import React, { useCallback, useEffect, useState } from "react";
import { GitBranch, RefreshCw, FilePlus2, FileX2, FilePenLine, ArrowUp, ArrowDown, Copy, Check, Bot, GitCompare } from "lucide-react";
import { GitStatus } from "../types";
import { useI18n } from "../i18n";

interface GitPanelProps {
  visible: boolean;
  token: string;
  workspaceDir: string;
  onOpenFile: (path: string) => void;
  onAskReview?: () => void;
  onClose: () => void;
}

function entryIcon(kind: GitStatus["entries"][number]["kind"]): React.ReactNode {
  if (kind === "added" || kind === "untracked") return <FilePlus2 size={13} />;
  if (kind === "deleted") return <FileX2 size={13} />;
  return <FilePenLine size={13} />;
}

export const GitPanel: React.FC<GitPanelProps> = ({
  visible,
  token,
  workspaceDir,
  onOpenFile,
  onAskReview,
  onClose,
}) => {
  const { t } = useI18n();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [diffText, setDiffText] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/files/git-status", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("Failed to load git status");
      setStatus((await response.json()) as GitStatus);
    } catch {
      setError(t("git.failed"));
    } finally {
      setLoading(false);
    }
  }, [t, token]);

  const openDiff = useCallback(async (path: string) => {
    setDiffPath(path);
    setDiffText("");
    setDiffLoading(true);
    try {
      const response = await fetch(`/api/files/git-diff?path=${encodeURIComponent(path)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("Failed to load diff");
      const payload = (await response.json()) as { diff?: string };
      setDiffText(payload.diff || t("git.noDiff"));
    } catch {
      setDiffText(t("git.diffFailed"));
    } finally {
      setDiffLoading(false);
    }
  }, [t, token]);

  const copyDiff = useCallback(async () => {
    if (!diffText) return;
    try {
      await navigator.clipboard.writeText(diffText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // The diff remains selectable if clipboard access is unavailable.
    }
  }, [diffText]);

  useEffect(() => {
    if (visible) void refresh();
  }, [refresh, visible, workspaceDir]);

  if (!visible) return null;

  const changeCounts = status?.entries.reduce(
    (counts, entry) => {
      counts[entry.kind] += 1;
      return counts;
    },
    { modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0 }
  );

  return (
    <aside className="git-panel panel-shell">
      <div className="git-panel-header">
        <div className="git-panel-title"><GitBranch size={15} /><strong>{t("git.title")}</strong></div>
        <div className="git-panel-actions">
          {onAskReview && (
            <button type="button" className="sidebar-action-btn" onClick={onAskReview} title={t("git.askReview")}>
              <Bot size={14} />
            </button>
          )}
          <button type="button" className="sidebar-action-btn" onClick={() => void refresh()} title={t("common.refresh")}>
            <RefreshCw size={14} className={loading ? "chat-spin" : ""} />
          </button>
          <button type="button" className="sidebar-action-btn" onClick={onClose} title={t("common.close")}>
            ×
          </button>
        </div>
      </div>

      {error && <div className="git-panel-error">{error}</div>}
      {!loading && status && !status.isRepo && <div className="git-panel-empty">{t("git.notRepo")}</div>}
      {!loading && status?.isRepo && (
        <>
          <div className="git-panel-branch">
            <div><GitBranch size={14} /><strong>{status.branch}</strong></div>
            <span>{status.entries.length} {t("git.changesCount")}</span>
          </div>
          <div className="git-panel-summary" aria-label={t("git.changesCount")}>
            <span className="git-summary-total"><GitCompare size={12} />{status.entries.length}</span>
            <span className="git-summary-item modified">M {changeCounts?.modified || 0}</span>
            <span className="git-summary-item added">+ {((changeCounts?.added || 0) + (changeCounts?.untracked || 0))}</span>
            <span className="git-summary-item deleted">− {changeCounts?.deleted || 0}</span>
          </div>
          {(status.ahead > 0 || status.behind > 0) && (
            <div className="git-panel-sync">
              {status.ahead > 0 && <span><ArrowUp size={12} />{status.ahead}</span>}
              {status.behind > 0 && <span><ArrowDown size={12} />{status.behind}</span>}
              <small>{status.upstream || t("git.noUpstream")}</small>
            </div>
          )}
          <div className="git-panel-list">
            {status.entries.length > 0 && (
              <div className="git-panel-list-header">
                <span>{t("git.changesCount")}</span>
                <span>{t("git.openDiff")}</span>
              </div>
            )}
            {status.entries.length === 0 ? (
              <div className="git-panel-empty">{t("git.clean")}</div>
            ) : status.entries.map((entry) => (
              <button type="button" className="git-panel-entry" key={`${entry.kind}:${entry.path}`} onClick={() => void openDiff(entry.path)} title={t("git.openDiff")}>
                <span className={`git-entry-icon kind-${entry.kind}`}>{entryIcon(entry.kind)}</span>
                <code>{entry.path}</code>
                <small className={`git-entry-status kind-${entry.kind}`}>
                  {entry.indexStatus}{entry.worktreeStatus}
                </small>
              </button>
            ))}
          </div>
        </>
      )}
      <div className="git-panel-footer">{workspaceDir}</div>

      {diffPath && (
        <div className="git-diff-overlay" onMouseDown={() => setDiffPath(null)}>
          <div className="git-diff-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <div className="git-diff-dialog-header">
              <div><GitCompare size={14} /><strong>{diffPath}</strong></div>
              <button type="button" className="sidebar-action-btn" onClick={() => setDiffPath(null)}>×</button>
            </div>
            <div className="git-diff-dialog-toolbar">
              <span className="git-diff-toolbar-label">{t("git.openDiff")}</span>
              <button type="button" className="dialog-btn" onClick={() => { onOpenFile(diffPath); setDiffPath(null); }}>{t("git.openFile")}</button>
              <button type="button" className="dialog-btn" onClick={() => void copyDiff()}>
                {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? t("git.copied") : t("git.copyDiff")}
              </button>
            </div>
            <pre className="git-diff-content">{diffLoading ? t("git.loadingDiff") : diffText}</pre>
          </div>
        </div>
      )}
    </aside>
  );
};
