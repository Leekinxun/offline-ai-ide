import React, { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, ExternalLink, FileWarning, GitCompare, X } from "lucide-react";
import { getEditorThemeName } from "../editor/themeNames";
import { useI18n } from "../i18n";
import { getLanguage, GitDiffPayload, GitStatusEntry } from "../types";

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
  onClose,
  onOpenFile,
}) => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const copyDiff = useCallback(async () => {
    if (!payload?.diff) return;
    try {
      await navigator.clipboard.writeText(payload.diff);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // The raw patch remains selectable when clipboard access is unavailable.
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
          <button type="button" className="sidebar-action-btn" onClick={onClose} aria-label={t("common.close")}>
            <X size={14} />
          </button>
        </header>

        <div className="git-diff-dialog-toolbar">
          <span className="git-diff-toolbar-label">{t("git.reviewCanvas")}</span>
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
