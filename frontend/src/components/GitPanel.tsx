import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  CheckCircle2,
  ExternalLink,
  FilePenLine,
  FilePlus2,
  FileWarning,
  FileX2,
  GitBranch,
  GitCompare,
  RefreshCw,
} from "lucide-react";
import { GitDiffPayload, GitStatus, GitStatusEntry } from "../types";
import { useI18n } from "../i18n";
import { ChangeDiffDialog } from "./ChangeDiffDialog";

interface GitPanelProps {
  visible: boolean;
  token: string;
  workspaceDir: string;
  theme: "light" | "dark";
  requestedDiffPath?: string | null;
  requestedDiffId?: number;
  onOpenFile: (path: string) => void;
  onAskReview?: () => void;
  onClose: () => void;
}

function entryIcon(kind: GitStatusEntry["kind"]): React.ReactNode {
  if (kind === "conflicted") return <FileWarning size={13} />;
  if (kind === "added" || kind === "untracked") return <FilePlus2 size={13} />;
  if (kind === "deleted") return <FileX2 size={13} />;
  return <FilePenLine size={13} />;
}

export const GitPanel: React.FC<GitPanelProps> = ({
  visible,
  token,
  workspaceDir,
  theme,
  requestedDiffPath,
  requestedDiffId,
  onOpenFile,
  onAskReview,
  onClose,
}) => {
  const { t } = useI18n();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedChange, setSelectedChange] = useState<GitStatusEntry | null>(null);
  const [diffPayload, setDiffPayload] = useState<GitDiffPayload | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const handledRequestRef = useRef(0);

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

  const openDiff = useCallback(async (entry: GitStatusEntry) => {
    setSelectedChange(entry);
    setDiffPayload(null);
    setDiffError(null);
    setDiffLoading(true);
    try {
      const response = await fetch(`/api/files/git-diff?path=${encodeURIComponent(entry.path)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("Failed to load diff");
      setDiffPayload((await response.json()) as GitDiffPayload);
    } catch {
      setDiffError(t("git.diffFailed"));
    } finally {
      setDiffLoading(false);
    }
  }, [t, token]);

  useEffect(() => {
    if (visible) void refresh();
  }, [refresh, visible, workspaceDir]);

  useEffect(() => {
    if (
      !visible ||
      !requestedDiffPath ||
      !requestedDiffId ||
      requestedDiffId <= handledRequestRef.current ||
      !status
    ) return;
    handledRequestRef.current = requestedDiffId;
    const entry = status.entries.find((candidate) => candidate.path === requestedDiffPath) || {
      path: requestedDiffPath,
      indexStatus: " ",
      worktreeStatus: "M",
      kind: "modified" as const,
    };
    void openDiff(entry);
  }, [openDiff, requestedDiffId, requestedDiffPath, status, visible]);

  const groupedEntries = useMemo(() => {
    const entries = status?.entries || [];
    return [
      { key: "conflicted", label: t("git.group.conflicted"), entries: entries.filter((entry) => entry.kind === "conflicted") },
      { key: "tracked", label: t("git.group.tracked"), entries: entries.filter((entry) => entry.kind !== "conflicted" && entry.kind !== "untracked") },
      { key: "untracked", label: t("git.group.untracked"), entries: entries.filter((entry) => entry.kind === "untracked") },
    ].filter((group) => group.entries.length > 0);
  }, [status?.entries, t]);

  if (!visible) return null;

  const changeCounts = status?.entries.reduce(
    (counts, entry) => {
      counts[entry.kind] += 1;
      return counts;
    },
    { modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0, conflicted: 0 }
  );

  return (
    <aside className="git-panel panel-shell workspace-drawer" tabIndex={-1} data-workspace-drawer="git">
      <div className="git-panel-header">
        <div className="git-panel-title"><GitBranch size={15} /><strong>{t("git.title")}</strong></div>
        <div className="git-panel-actions">
          {onAskReview && (
            <button type="button" className="sidebar-action-btn" onClick={onAskReview} title={t("git.askReview")} aria-label={t("git.askReview")}>
              <Bot size={14} />
            </button>
          )}
          <button type="button" className="sidebar-action-btn" onClick={() => void refresh()} title={t("common.refresh")} aria-label={t("common.refresh")}>
            <RefreshCw size={14} className={loading ? "chat-spin" : ""} />
          </button>
          <button type="button" className="sidebar-action-btn" onClick={onClose} title={t("common.close")} aria-label={t("common.close")}>
            ×
          </button>
        </div>
      </div>

      {error && <div className="git-panel-error"><FileWarning size={16} />{error}</div>}
      {loading && !status && <div className="git-panel-empty">{t("common.loading")}</div>}
      {!loading && status && !status.isRepo && <div className="git-panel-empty"><GitBranch size={18} /><strong>{t("git.notRepo")}</strong></div>}
      {status?.isRepo && (
        <>
          <div className="git-panel-branch">
            <div><GitBranch size={14} /><strong>{status.branch}</strong></div>
            <span>{status.entries.length} {t("git.changesCount")}</span>
          </div>
          <div className="git-panel-summary" aria-label={t("git.changesCount")}>
            <span className="git-summary-total"><GitCompare size={12} />{status.entries.length}</span>
            {Boolean(changeCounts?.conflicted) && <span className="git-summary-item conflicted">! {changeCounts?.conflicted}</span>}
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
            {status.entries.length === 0 ? (
              <div className="git-panel-empty git-panel-clean">
                <CheckCircle2 size={20} />
                <strong>{t("git.clean")}</strong>
                <span>{t("git.cleanHint")}</span>
              </div>
            ) : groupedEntries.map((group) => (
              <section className="git-change-group" key={group.key} aria-labelledby={`git-group-${group.key}`}>
                <div className="git-change-group-header" id={`git-group-${group.key}`}>
                  <span>{group.label}</span><small>{group.entries.length}</small>
                </div>
                {group.entries.map((entry) => (
                  <div className={`git-panel-entry kind-${entry.kind}`} key={`${entry.kind}:${entry.path}`}>
                    <button type="button" className="git-entry-diff" onClick={() => void openDiff(entry)} title={`${t("git.openDiff")}: ${entry.path}`}>
                      <span className={`git-entry-icon kind-${entry.kind}`}>{entryIcon(entry.kind)}</span>
                      <span className="git-entry-copy">
                        <code>{entry.path}</code>
                        <small>{t(`git.kind.${entry.kind}`)}</small>
                      </span>
                      <span className={`git-entry-status kind-${entry.kind}`}>{entry.indexStatus}{entry.worktreeStatus}</span>
                    </button>
                    <button
                      type="button"
                      className="git-entry-open"
                      onClick={() => onOpenFile(entry.path)}
                      disabled={entry.kind === "deleted"}
                      title={`${t("git.openFile")}: ${entry.path}`}
                      aria-label={`${t("git.openFile")}: ${entry.path}`}
                    >
                      <ExternalLink size={12} />
                    </button>
                  </div>
                ))}
              </section>
            ))}
          </div>
        </>
      )}
      <div className="git-panel-footer">{workspaceDir}</div>

      {selectedChange && (
        <ChangeDiffDialog
          path={selectedChange.path}
          kind={selectedChange.kind}
          payload={diffPayload}
          loading={diffLoading}
          error={diffError}
          theme={theme}
          onClose={() => setSelectedChange(null)}
          onOpenFile={onOpenFile}
        />
      )}
    </aside>
  );
};
