import React from "react";
import { FilePlus2, FolderOpen, MessageSquareText, Search, TerminalSquare } from "lucide-react";
import { FileNode, OpenFile } from "../types";
import { useI18n } from "../i18n";
import { BrandMark } from "./BrandMark";

interface WorkspaceWelcomeProps {
  workspaceDir: string;
  tree: FileNode[];
  openFiles: OpenFile[];
  onQuickOpen: () => void;
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

export const WorkspaceWelcome: React.FC<WorkspaceWelcomeProps> = ({
  workspaceDir,
  tree,
  openFiles,
  onQuickOpen,
  onFocusChat,
  onOpenTerminal,
  onOpenFile,
}) => {
  const { t } = useI18n();
  const fileCount = countFiles(tree);

  return (
    <div className="workspace-welcome">
      <div className="workspace-welcome-hero">
        <BrandMark size={48} title="AI IDE" subtitle={t("welcome.privateWorkspace")} stacked />
        <span className="workspace-welcome-eyebrow">{t("welcome.workspace")}</span>
        <h1>{workspaceName(workspaceDir)}</h1>
        <p>{t("welcome.description", { count: fileCount })}</p>
      </div>

      <div className="workspace-welcome-actions">
        <button type="button" className="welcome-action primary" onClick={onQuickOpen}>
          <Search size={18} />
          <span><strong>{t("welcome.quickOpen")}</strong><small>Cmd/Ctrl+P</small></span>
        </button>
        <button type="button" className="welcome-action" onClick={onFocusChat}>
          <MessageSquareText size={18} />
          <span><strong>{t("welcome.askAi")}</strong><small>{t("welcome.askAiHint")}</small></span>
        </button>
        <button type="button" className="welcome-action" onClick={onOpenTerminal}>
          <TerminalSquare size={18} />
          <span><strong>{t("welcome.openTerminal")}</strong><small>Cmd/Ctrl+`</small></span>
        </button>
        <button type="button" className="welcome-action" onClick={onQuickOpen}>
          <FolderOpen size={18} />
          <span><strong>{t("welcome.openFolder")}</strong><small>{t("welcome.openFolderHint")}</small></span>
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
        <span><kbd>⌘P</kbd> {t("welcome.quickOpen")}</span>
        <span><kbd>⌘⇧P</kbd> {t("welcome.commands")}</span>
        <span><kbd>⌘J</kbd> {t("welcome.toggleChat")}</span>
      </div>
    </div>
  );
};
