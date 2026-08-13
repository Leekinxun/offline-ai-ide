import React, { lazy, Suspense, useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, ExternalLink, FileWarning, GitCompare, RefreshCw, X } from "lucide-react";
import { getEditorThemeName } from "../editor/themeNames";
import { useI18n } from "../i18n";
import { getLanguage, GitDiffPayload, GitStatusEntry } from "../types";
import { useModalDialogFocus } from "./useModalDialogFocus";

const DiffEditor = lazy(() =>
  import("@monaco-editor/react").then((module) => ({ default: module.DiffEditor }))
);

interface ChangeDiffDialogProps {
  path: string;
  kind: GitStatusEntry["kind"];
  payload: GitDiffPayload | null;
  loading: boolean;
  error: string | null;
  theme: "light" | "dark";
  revision?: string;
  stale?: boolean;
  onRetry?: () => void;
  onClose: () => void;
  onOpenFile: (path: string) => void;
}

export const ChangeDiffDialog: React.FC<ChangeDiffDialogProps> = ({
  path,
  kind,
  payload,
  loading,
  error,
  theme,
  revision,
  stale = false,
  onRetry,
  onClose,
  onOpenFile,
}) => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDialogFocus<HTMLElement>({ open: true, onClose, initialFocusRef: closeRef });

  const copyDiff = useCallback(async () => {
    if (!payload?.diff) return;
    try {
      setCopyError(null);
      await navigator.clipboard.writeText(payload.diff);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (reason) {
      setCopyError(reason instanceof Error ? reason.message : t("git.copyFailed"));
    }
  }, [payload?.diff]);

  const unavailableReason = payload?.isBinary
    ? t("git.binaryDiff")
    : payload?.isTooLarge
      ? t("git.largeDiff")
      : payload && !payload.hasChanges
        ? t("git.noDiff")
        : null;

  return createPortal(
    <div className="git-diff-overlay" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="git-diff-dialog panel-shell"
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-diff-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="git-diff-dialog-header">
          <div>
            <GitCompare size={14} />
            <span className={`git-change-kind kind-${kind}`}>{t(`git.kind.${kind}`)}</span>
            <strong id="git-diff-title">{path}</strong>
          </div>
          <button ref={closeRef} type="button" className="sidebar-action-btn" onClick={onClose} aria-label={t("common.close")}>
            <X size={14} />
          </button>
        </header>

        <div className="git-diff-dialog-toolbar">
          <span className="git-diff-toolbar-label">{t("git.reviewCanvas")}</span>
          {revision && <code className="git-diff-revision">{revision.slice(0, 12)}</code>}
          {stale && <span className="git-diff-stale" role="status"><FileWarning size={13} />{t("git.diffStale")}</span>}
          {stale && onRetry && <button type="button" className="dialog-btn" onClick={onRetry}><RefreshCw size={13} />{t("common.refresh")}</button>}
          <button
            type="button"
            className="dialog-btn"
            onClick={() => {
              onOpenFile(path);
              onClose();
            }}
            disabled={kind === "deleted"}
          >
            <ExternalLink size={13} /> {t("git.openFile")}
          </button>
          <button type="button" className="dialog-btn" onClick={() => void copyDiff()} disabled={!payload?.diff}>
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? t("git.copied") : t("git.copyDiff")}
          </button>
        </div>
        {copyError && <div className="delivery-inline-error" role="alert">{copyError}</div>}

        <div className="git-diff-editor" aria-live="polite">
          {loading ? (
            <div className="git-diff-state">{t("git.loadingDiff")}</div>
          ) : error ? (
            <div className="git-diff-state error"><FileWarning size={18} />{error}</div>
          ) : unavailableReason ? (
            <div className="git-diff-state"><FileWarning size={18} />{unavailableReason}</div>
          ) : payload ? (
            <Suspense fallback={<div className="git-diff-state">{t("git.loadingDiff")}</div>}>
              <DiffEditor
                original={payload.original}
                modified={payload.modified}
                language={getLanguage(path)}
                theme={getEditorThemeName(theme)}
                options={{
                  readOnly: true,
                  originalEditable: false,
                  renderSideBySide: true,
                  automaticLayout: true,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  wordWrap: "on",
                  renderOverviewRuler: true,
                }}
              />
            </Suspense>
          ) : null}
        </div>

        {payload?.diff && (
          <details className="git-raw-diff">
            <summary>{t("git.rawPatch")}</summary>
            <pre>{payload.diff}</pre>
          </details>
        )}
      </section>
    </div>,
    document.body
  );
};
