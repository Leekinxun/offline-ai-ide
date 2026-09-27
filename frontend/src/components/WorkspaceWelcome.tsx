import React from "react";
import { ArrowUpRight, FilePlus2, FolderOpen, MessageSquareText, Search, TerminalSquare } from "lucide-react";
import { FileNode, OpenFile } from "../types";
import { useI18n } from "../i18n";
import { BrandMark } from "./BrandMark";
import { PRODUCT_NAME } from "../brand";
import "./WorkspaceWelcome.css";

interface WorkspaceWelcomeProps {
  workspaceDir: string;
  tree: FileNode[];
  openFiles: OpenFile[];
  onQuickOpen: () => void;
  onOpenFolder: () => void;
  folderPickerBusy: boolean;
  onFocusChat: () => void;
  onOpenTerminal: () => void;
  onOpenFile: (path: string) => void;
}

function workspaceName(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).pop() || value;
}

function countFiles(nodes: FileNode[]): number {
  return nodes.reduce(
    (count, node) => count + (node.type === "file" ? 1 : countFiles(node.children || [])),
    0
  );
}

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform || "";
  const userAgent = navigator.userAgent || "";
  return /Mac|iPhone|iPad|iPod/.test(platform) || /Macintosh|Mac OS X|iPhone|iPad|iPod/.test(userAgent);
}

function getShortcutLabels() {
  if (isMacPlatform()) {
    return {
      quickOpen: "⌘P",
      commands: "⌘⇧P",
      toggleChat: "⌘J",
      openTerminal: "⌘`",
    };
  }

  return {
    quickOpen: "Ctrl+P",
    commands: "Ctrl+Shift+P",
    toggleChat: "Ctrl+J",
    openTerminal: "Ctrl+`",
  };
}

export const WorkspaceWelcome: React.FC<WorkspaceWelcomeProps> = ({
  workspaceDir,
  tree,
  openFiles,
  onQuickOpen,
  onOpenFolder,
  folderPickerBusy,
  onFocusChat,
  onOpenTerminal,
  onOpenFile,
}) => {
  const { t } = useI18n();
  const fileCount = countFiles(tree);
  const shortcuts = getShortcutLabels();

  return (
    <div className="workspace-welcome">
      <div className="workspace-welcome-hero">
        <BrandMark size={48} title={PRODUCT_NAME} subtitle={t("welcome.privateWorkspace")} stacked />
        <span className="workspace-welcome-eyebrow">{t("welcome.workspace")}</span>
        <h1>{workspaceName(workspaceDir)}</h1>
        <p className="workspace-welcome-desc">
          <span className="welcome-desc-dot" />
          <span>{t("welcome.description", { count: fileCount })}</span>
        </p>
      </div>

      <div className="workspace-welcome-actions">
        <button type="button" className="welcome-action" onClick={onQuickOpen}>
          <div className="welcome-action-icon">
            <Search size={19} />
          </div>
          <div className="welcome-action-text">
            <strong>{t("welcome.quickOpen")}</strong>
            <small>{t("welcome.quickOpenHint")}</small>
          </div>
          <div className="welcome-action-aside">
            <kbd className="welcome-keycap">{shortcuts.quickOpen}</kbd>
          </div>
        </button>

        <button type="button" className="welcome-action" onClick={onFocusChat}>
          <div className="welcome-action-icon welcome-action-icon-ai">
            <MessageSquareText size={19} />
          </div>
          <div className="welcome-action-text">
            <strong>{t("welcome.askAi")}</strong>
            <small>{t("welcome.askAiHint")}</small>
          </div>
          <div className="welcome-action-aside">
            <kbd className="welcome-keycap">{shortcuts.toggleChat}</kbd>
          </div>
        </button>

        <button type="button" className="welcome-action" onClick={onOpenTerminal}>
          <div className="welcome-action-icon">
            <TerminalSquare size={19} />
          </div>
          <div className="welcome-action-text">
            <strong>{t("welcome.openTerminal")}</strong>
            <small>{t("welcome.openTerminalHint")}</small>
          </div>
          <div className="welcome-action-aside">
            <kbd className="welcome-keycap">{shortcuts.openTerminal}</kbd>
          </div>
        </button>

        <button type="button" className="welcome-action" onClick={onOpenFolder} disabled={folderPickerBusy}>
          <div className="welcome-action-icon">
            <FolderOpen size={19} />
          </div>
          <div className="welcome-action-text">
            <strong>{t("welcome.openFolder")}</strong>
            <small>{t("welcome.openFolderHint")}</small>
          </div>
          <div className="welcome-action-aside">
            <span className="welcome-action-arrow">
              <ArrowUpRight size={17} />
            </span>
          </div>
        </button>
      </div>

      {openFiles.length > 0 && (
        <div className="workspace-welcome-recent">
          <div className="workspace-welcome-section-title"><span>{t("welcome.recentFiles")}</span><FilePlus2 size={14} /></div>
          {openFiles.slice(0, 5).map((file) => (
            <button type="button" key={file.path} onClick={() => onOpenFile(file.path)} className="welcome-recent-item">
              <span>{file.name}</span><small>{file.path}</small>
            </button>
          ))}
        </div>
      )}

      <div className="workspace-welcome-shortcuts">
        <span><kbd>{shortcuts.quickOpen}</kbd> {t("welcome.quickOpen")}</span>
        <span><kbd>{shortcuts.commands}</kbd> {t("welcome.commands")}</span>
        <span><kbd>{shortcuts.toggleChat}</kbd> {t("welcome.toggleChat")}</span>
      </div>
    </div>
  );
};
