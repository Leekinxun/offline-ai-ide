import React, { useMemo } from "react";
import {
  FileCode2,
  ChevronRight,
  Bot,
  TerminalSquare,
  GitBranch,
  Play,
  Columns2,
  Link2,
  Unlink2,
  X,
} from "lucide-react";
import { useI18n } from "../i18n";
import { WorkbenchSelect } from "./WorkbenchSelect";
import type { FilePreviewMode } from "../plugins/types";
import "./EditorToolbar.css";

export interface EditorToolbarProps {
  activeFile: {
    path: string;
    name: string;
    modified?: boolean;
    remoteUpdated?: boolean;
    language?: string;
  };
  workspaceLabel?: string;

  // 预览模式切换 (针对 Markdown 等可预览文件)
  hasPreview?: boolean;
  activePreviewMode?: FilePreviewMode;
  onSelectPreviewMode?: (mode: FilePreviewMode) => void;

  // 工具栏功能按钮
  chatConnected?: boolean;
  editorAssistantVisible?: boolean;
  onToggleEditorAssistant?: () => void;
  terminalVisible?: boolean;
  onToggleTerminal?: () => void;
  runDetailsVisible?: boolean;
  onOpenChanges?: () => void;

  // 运行/调试
  canRunCurrent?: boolean;
  onRunCurrent?: () => void;
  readOnlyWorkspace?: boolean;

  // 文件比对
  openFiles?: Array<{ path: string; name: string }>;
  compareFilePath?: string | null;
  onSelectCompareFile?: (path: string | null) => void;
  compareFileActive?: boolean;
  compareScrollLinked?: boolean;
  onToggleCompareScrollLinked?: () => void;
  onCloseCompare?: () => void;
}

/**
 * 编辑器顶部微型工具栏组件 (深度解耦)
 * 将文件面包屑路径、可预览文件的编辑/预览/分栏切换控制器、以及核心操作按钮群聚合在单行 32px 紧凑空间内，
 * 消除层叠大标题冗余，还归代码主视区高度。
 */
export const EditorToolbar: React.FC<EditorToolbarProps> = ({
  activeFile,
  workspaceLabel,
  hasPreview = false,
  activePreviewMode = "edit",
  onSelectPreviewMode,
  chatConnected = false,
  editorAssistantVisible = false,
  onToggleEditorAssistant,
  terminalVisible = false,
  onToggleTerminal,
  runDetailsVisible = false,
  onOpenChanges,
  canRunCurrent = false,
  onRunCurrent,
  readOnlyWorkspace = false,
  openFiles = [],
  compareFilePath = null,
  onSelectCompareFile,
  compareFileActive = false,
  compareScrollLinked = false,
  onToggleCompareScrollLinked,
  onCloseCompare,
}) => {
  const { t } = useI18n();

  // 精炼路径导航：超过 2 层目录时折叠中间冗余祖先，保持单行精简
  const visibleBreadcrumbParts = useMemo(() => {
    const parts = activeFile.path.split("/");
    if (parts.length <= 2) {
      return parts.map((part, index) => ({
        label: part,
        isCurrent: index === parts.length - 1,
      }));
    }
    return [
      { label: "…", isCurrent: false },
      { label: parts[parts.length - 2], isCurrent: false },
      { label: parts[parts.length - 1], isCurrent: true },
    ];
  }, [activeFile.path]);

  return (
    <div className="editor-toolbar" role="toolbar" aria-label={t("workbench.editorActions")}>
      {/* 1. 左侧：精炼文件面包屑路径导航 */}
      <div className="editor-toolbar-breadcrumb" title={activeFile.path} aria-label={t("workbench.fileBreadcrumb")}>
        <FileCode2 size={13} className="editor-toolbar-breadcrumb-icon" />
        {workspaceLabel && <span className="editor-toolbar-breadcrumb-workspace">{workspaceLabel}</span>}
        {workspaceLabel && <ChevronRight size={11} className="editor-toolbar-breadcrumb-sep" />}
        {visibleBreadcrumbParts.map((item, index) => (
          <React.Fragment key={`${item.label}-${index}`}>
            <span className={`editor-toolbar-breadcrumb-part${item.isCurrent ? " current" : ""}`}>
              {item.label}
            </span>
            {index < visibleBreadcrumbParts.length - 1 && <ChevronRight size={11} className="editor-toolbar-breadcrumb-sep" />}
          </React.Fragment>
        ))}
      </div>

      {/* 2. 中间：Markdown / 可预览文件专属的分段切换控制器 */}
      {hasPreview && onSelectPreviewMode && (
        <div className="editor-toolbar-preview-modes" role="group" aria-label="Preview Modes">
          <button
            type="button"
            className={`editor-toolbar-preview-btn${activePreviewMode === "edit" ? " active" : ""}`}
            onClick={() => onSelectPreviewMode("edit")}
            aria-pressed={activePreviewMode === "edit"}
            title={t("editor.modeEdit")}
          >
            {t("editor.modeEdit")}
          </button>
          <button
            type="button"
            className={`editor-toolbar-preview-btn${activePreviewMode === "preview" ? " active" : ""}`}
            onClick={() => onSelectPreviewMode("preview")}
            aria-pressed={activePreviewMode === "preview"}
            title={t("editor.modePreview")}
          >
            {t("editor.modePreview")}
          </button>
          <button
            type="button"
            className={`editor-toolbar-preview-btn${activePreviewMode === "split" ? " active" : ""}`}
            onClick={() => onSelectPreviewMode("split")}
            aria-pressed={activePreviewMode === "split"}
            title={t("editor.modeSplit")}
          >
            {t("editor.modeSplit")}
          </button>
        </div>
      )}

      {/* 3. 右侧：操作按钮与状态群 (已移除多余的重复在线指示器) */}
      <div className="editor-toolbar-actions">
        {/* 助手 / 终端 / 变更 快捷动作组 */}
        <div className="editor-toolbar-primary-actions" role="group">
          {onToggleEditorAssistant && (
            <button
              type="button"
              className={`editor-toolbar-btn${editorAssistantVisible ? " active" : ""}`}
              onClick={onToggleEditorAssistant}
              title={t("workbench.editorAssistant")}
            >
              <Bot size={13} />
              <span>{t("workbench.editorAssistant")}</span>
            </button>
          )}
          {onToggleTerminal && (
            <button
              type="button"
              className={`editor-toolbar-btn${terminalVisible ? " active" : ""}`}
              onClick={onToggleTerminal}
              title={t("workbench.details.terminal")}
            >
              <TerminalSquare size={13} />
              <span>{t("workbench.details.terminal")}</span>
            </button>
          )}
          {onOpenChanges && (
            <button
              type="button"
              className={`editor-toolbar-btn${runDetailsVisible ? " active" : ""}`}
              onClick={onOpenChanges}
              title={t("chat.changes")}
            >
              <GitBranch size={13} />
              <span>{t("chat.changes")}</span>
            </button>
          )}
        </div>

        {/* 运行/调试按钮 */}
        {canRunCurrent && onRunCurrent && (
          <button
            type="button"
            className="editor-toolbar-run-btn"
            onClick={onRunCurrent}
            disabled={readOnlyWorkspace}
            title={t("debug.runCurrentFile")}
            aria-label={t("debug.runCurrentFile")}
          >
            <Play size={12} />
            <span>{t("debug.run")}</span>
          </button>
        )}

        {/* 双文件比对选择器 */}
        {openFiles.length > 1 && onSelectCompareFile && (
          <div className="editor-toolbar-compare-picker">
            <Columns2 size={13} aria-hidden="true" />
            <WorkbenchSelect
              label={t("editor.compareWith")}
              className="editor-toolbar-compare-select"
              value={compareFilePath || ""}
              onChange={(value) => onSelectCompareFile(value || null)}
              options={[
                { value: "", label: t("editor.compareNone") },
                ...openFiles
                  .filter((file) => file.path !== activeFile.path)
                  .map((file) => ({ value: file.path, label: file.name })),
              ]}
            />
          </div>
        )}

        {/* 比对同步滚动开关 */}
        {compareFileActive && onToggleCompareScrollLinked && (
          <button
            type="button"
            className={`editor-toolbar-icon-btn${compareScrollLinked ? " active" : ""}`}
            onClick={onToggleCompareScrollLinked}
            aria-pressed={compareScrollLinked}
            title={compareScrollLinked ? t("editor.disableSyncScroll") : t("editor.enableSyncScroll")}
          >
            {compareScrollLinked ? <Link2 size={13} /> : <Unlink2 size={13} />}
          </button>
        )}

        {/* 退出比对按钮 */}
        {compareFileActive && onCloseCompare && (
          <button
            type="button"
            className="editor-toolbar-icon-btn"
            onClick={onCloseCompare}
            title={t("editor.stopCompare")}
            aria-label={t("editor.stopCompare")}
          >
            <X size={13} />
          </button>
        )}

        {/* 未保存 / 远端变更 芯片 */}
        {activeFile.modified && (
          <span className="editor-toolbar-status modified" title={t("editor.unsaved")}>
            {t("editor.unsaved")}
          </span>
        )}
        {activeFile.remoteUpdated && (
          <span className="editor-toolbar-status remote" title={t("editor.remoteUpdated")}>
            {t("editor.remoteUpdated")}
          </span>
        )}
      </div>
    </div>
  );
};
