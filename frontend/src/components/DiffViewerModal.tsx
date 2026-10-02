import React, { FC, Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import type { OpenFile } from "../types";
import { useI18n } from "../i18n";
import { getEditorThemeName } from "../editor/themeNames";
import { DEFAULT_EDITOR_FONT_OPTIONS } from "../editor/fontDefaults";
import { useModalDialogFocus } from "./useModalDialogFocus";
import {
  applyHunkSelections,
  buildConflictHunks,
  countRemoteSelections,
  formatLineRange,
} from "../utils/conflicts";
import "./DiffViewerModal.css";

const DiffEditor = lazy(() =>
  import("@monaco-editor/react").then((module) => ({ default: module.DiffEditor }))
);

export interface DiffViewerModalProps {
  file: OpenFile;
  conflictSourceMessage?: string | null;
  theme: "light" | "dark";
  editorFont: string;
  onClose: () => void;
  onApplyMerge: (mergedContent: string) => void;
  onKeepLocalVersion: () => void;
  onReloadRemoteVersion: () => void;
  onForceSave?: () => void;
}

/**
 * 远程版本冲突差异比对与交互式三向合流合并模态框
 */
export const DiffViewerModal: FC<DiffViewerModalProps> = ({
  file,
  conflictSourceMessage,
  theme,
  editorFont,
  onClose,
  onApplyMerge,
  onKeepLocalVersion,
  onReloadRemoteVersion,
  onForceSave,
}) => {
  const { t } = useI18n();
  const [mergeSelections, setMergeSelections] = useState<Record<string, "local" | "remote">>({});

  const diffDialogRef = useModalDialogFocus<HTMLDivElement>({
    open: Boolean(file.remoteContent !== undefined),
    onClose,
  });

  const conflictHunks = useMemo(
    () =>
      file.remoteContent !== undefined
        ? buildConflictHunks(file.content, file.remoteContent)
        : [],
    [file.content, file.remoteContent]
  );

  useEffect(() => {
    if (file.remoteContent === undefined) {
      setMergeSelections({});
      return;
    }

    setMergeSelections((current) => {
      const next: Record<string, "local" | "remote"> = {};
      for (const hunk of conflictHunks) {
        next[hunk.id] = current[hunk.id] || "local";
      }
      return next;
    });
  }, [conflictHunks, file.remoteContent]);

  const mergedConflictContent = useMemo(
    () =>
      file.remoteContent !== undefined
        ? applyHunkSelections(file.content, conflictHunks, mergeSelections)
        : null,
    [file.content, file.remoteContent, conflictHunks, mergeSelections]
  );

  const remoteSelectedCount = countRemoteSelections(conflictHunks, mergeSelections);

  const handleUseAllRemoteBlocks = useCallback(() => {
    setMergeSelections(
      Object.fromEntries(
        conflictHunks.map((hunk) => [hunk.id, "remote" as const])
      )
    );
  }, [conflictHunks]);

  const handleKeepAllLocalBlocks = useCallback(() => {
    setMergeSelections(
      Object.fromEntries(
        conflictHunks.map((hunk) => [hunk.id, "local" as const])
      )
    );
  }, [conflictHunks]);

  const handleApplyMergedResult = useCallback(() => {
    if (mergedConflictContent === null) return;
    onApplyMerge(mergedConflictContent);
  }, [mergedConflictContent, onApplyMerge]);

  return (
    <div className="settings-modal-overlay" onClick={onClose}>
      <div
        ref={diffDialogRef}
        tabIndex={-1}
        className="settings-modal diff-modal panel-shell"
        role="dialog"
        aria-modal="true"
        aria-labelledby="diff-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-modal-header">
          <div className="settings-modal-title">
            <h2 id="diff-modal-title">{t("app.diffViewerTitle")}</h2>
          </div>
          <button
            className="settings-modal-close"
            aria-label={t("common.close")}
            title={t("common.close")}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="diff-modal-meta">
          <span>{file.path}</span>
          {conflictSourceMessage && (
            <span className="diff-modal-source">{conflictSourceMessage}</span>
          )}
        </div>
        <div className="diff-modal-body">
          <Suspense fallback={<div className="panel-loading">{t("common.loading")}</div>}>
            <DiffEditor
              height="100%"
              original={file.remoteContent}
              modified={file.content}
              language={file.language}
              theme={getEditorThemeName(theme)}
              options={{
                readOnly: true,
                renderSideBySide: true,
                minimap: { enabled: false },
                ...DEFAULT_EDITOR_FONT_OPTIONS,
                fontFamily: editorFont,
                automaticLayout: true,
              }}
            />
          </Suspense>
        </div>
        <div className="diff-merge-panel">
          <div className="diff-merge-header">
            <div>
              <strong>{t("app.mergeConflictBlocks")}</strong>
              <p>{t("app.mergeConflictBlocksHint")}</p>
            </div>
            <div className="diff-merge-summary">
              <span className="diff-merge-count">
                {t("app.mergeRemoteSelectedCount", {
                  count: remoteSelectedCount,
                  total: conflictHunks.length,
                })}
              </span>
              {conflictHunks.length > 0 && (
                <div className="diff-merge-bulk-actions">
                  <button className="dialog-btn" onClick={handleKeepAllLocalBlocks}>
                    {t("app.mergeKeepAllLocal")}
                  </button>
                  <button className="dialog-btn" onClick={handleUseAllRemoteBlocks}>
                    {t("app.mergeUseAllRemote")}
                  </button>
                </div>
              )}
            </div>
          </div>
          {conflictHunks.length === 0 ? (
            <div className="diff-merge-empty">{t("app.mergeNoBlocks")}</div>
          ) : (
            <div className="diff-merge-list">
              {conflictHunks.map((hunk, index) => {
                const selection = mergeSelections[hunk.id] || "local";
                return (
                  <div key={hunk.id} className="diff-hunk-card">
                    <div className="diff-hunk-head">
                      <span className="diff-hunk-index">#{index + 1}</span>
                      <span className="diff-hunk-selection">
                        {selection === "remote"
                          ? t("app.mergeBlockRemote")
                          : t("app.mergeBlockLocal")}
                      </span>
                    </div>
                    <div className="diff-hunk-columns">
                      <div className="diff-hunk-side">
                        <div className="diff-hunk-label">
                          {t("app.mergeLocalSnippet", {
                            range: formatLineRange(hunk.localStart, hunk.localEnd),
                          })}
                        </div>
                        <pre className="diff-hunk-code">
                          {hunk.localLines.join("\n") || " "}
                        </pre>
                        <button
                          className={`dialog-btn${selection === "local" ? " primary" : ""}`}
                          onClick={() =>
                            setMergeSelections((prev) => ({
                              ...prev,
                              [hunk.id]: "local",
                            }))
                          }
                        >
                          {t("app.mergeKeepLocalBlock")}
                        </button>
                      </div>
                      <div className="diff-hunk-side">
                        <div className="diff-hunk-label">
                          {t("app.mergeRemoteSnippet", {
                            range: formatLineRange(hunk.remoteStart, hunk.remoteEnd),
                          })}
                        </div>
                        <pre className="diff-hunk-code">
                          {hunk.remoteLines.join("\n") || " "}
                        </pre>
                        <button
                          className={`dialog-btn${selection === "remote" ? " primary" : ""}`}
                          onClick={() =>
                            setMergeSelections((prev) => ({
                              ...prev,
                              [hunk.id]: "remote",
                            }))
                          }
                        >
                          {t("app.mergeUseRemoteBlock")}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="dialog-actions diff-modal-actions">
          <button className="dialog-btn primary" onClick={handleApplyMergedResult}>
            {t("app.mergeApplyResult")}
          </button>
          <button className="dialog-btn" onClick={onKeepLocalVersion}>
            {t("app.keepLocalVersion")}
          </button>
          <button className="dialog-btn" onClick={onReloadRemoteVersion}>
            {t("app.loadRemoteVersion")}
          </button>
          {file.remoteConflictReason === "save" && onForceSave && (
            <button className="dialog-btn primary" onClick={onForceSave}>
              {t("app.overwriteRemoteVersion")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
