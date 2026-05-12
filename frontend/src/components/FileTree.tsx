import React, { useState, useCallback } from "react";
import { FileNode, TeamClaim, TeamPresence } from "../types";
import { ChevronRight, Download, File, Folder } from "lucide-react";
import { useI18n } from "../i18n";

interface FileTreeProps {
  nodes: FileNode[];
  activeFilePath: string | null;
  selectedPaths: Set<string>;
  multiSelectEnabled: boolean;
  canEditWorkspace?: boolean;
  onFileSelect: (path: string) => void;
  onToggleSelect: (path: string, selected: boolean) => void;
  onDownload: (path: string, type: FileNode["type"]) => void;
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void;
  claims?: TeamClaim[];
  presence?: TeamPresence[];
  depth?: number;
}

export const FileTree: React.FC<FileTreeProps> = ({
  nodes,
  activeFilePath,
  selectedPaths,
  multiSelectEnabled,
  canEditWorkspace = true,
  onFileSelect,
  onToggleSelect,
  onDownload,
  onContextMenu,
  claims,
  presence,
  depth = 0,
}) => {
  return (
    <>
      {nodes.map((node) => (
        <FileTreeItem
          key={node.path}
          node={node}
          activeFilePath={activeFilePath}
          selectedPaths={selectedPaths}
          multiSelectEnabled={multiSelectEnabled}
          canEditWorkspace={canEditWorkspace}
          onFileSelect={onFileSelect}
          onToggleSelect={onToggleSelect}
          onDownload={onDownload}
          onContextMenu={onContextMenu}
          claims={claims}
          presence={presence}
          depth={depth}
        />
      ))}
    </>
  );
};

interface FileTreeItemProps {
  node: FileNode;
  activeFilePath: string | null;
  selectedPaths: Set<string>;
  multiSelectEnabled: boolean;
  canEditWorkspace: boolean;
  onFileSelect: (path: string) => void;
  onToggleSelect: (path: string, selected: boolean) => void;
  onDownload: (path: string, type: FileNode["type"]) => void;
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void;
  claims?: TeamClaim[];
  presence?: TeamPresence[];
  depth: number;
}

const FileTreeItem: React.FC<FileTreeItemProps> = ({
  node,
  activeFilePath,
  selectedPaths,
  multiSelectEnabled,
  canEditWorkspace,
  onFileSelect,
  onToggleSelect,
  onDownload,
  onContextMenu,
  claims,
  presence,
  depth,
}) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(depth < 1);

  const handleClick = useCallback((event: React.MouseEvent) => {
    if (multiSelectEnabled || event.ctrlKey || event.metaKey) {
      onToggleSelect(node.path, !selectedPaths.has(node.path));
      return;
    }

    if (node.type === "directory") {
      setExpanded((prev) => !prev);
    } else {
      onFileSelect(node.path);
    }
  }, [node, onFileSelect, onToggleSelect, selectedPaths]);

  const isActive = node.path === activeFilePath;
  const isSelected = selectedPaths.has(node.path);
  const claim = claims?.find((entry) => entry.path === node.path);
  const viewers = presence?.filter((entry) => entry.activeFilePath === node.path) || [];

  return (
    <div>
      <div
        className={`tree-item${isActive ? " active" : ""}${isSelected ? " selected" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={handleClick}
        onContextMenu={(e) => onContextMenu(e, node)}
      >
        {node.type === "directory" && (
          <ChevronRight
            className={`tree-chevron${expanded ? " open" : ""}`}
            size={14}
          />
        )}
        <input
          type="checkbox"
          className={`tree-item-checkbox${multiSelectEnabled ? " visible" : ""}`}
          checked={isSelected}
          disabled={!canEditWorkspace}
          onChange={(e) => {
            e.stopPropagation();
            onToggleSelect(node.path, e.target.checked);
          }}
          onClick={(e) => e.stopPropagation()}
          title={t("sidebar.selectForBatchDelete")}
        />
        {node.type === "directory" ? (
          <Folder className="tree-item-icon folder" size={15} />
        ) : (
          <File className="tree-item-icon" size={15} />
        )}
        <span className="tree-item-name">{node.name}</span>
        {(claim || viewers.length > 0) && (
          <span className="tree-item-collab">
            {claim ? `✋ ${claim.username}` : `${viewers.length} 👀`}
          </span>
        )}
        <button
          className="tree-item-action"
          title={
            node.type === "directory"
              ? t("sidebar.downloadFolder")
              : t("sidebar.downloadFile")
          }
          onClick={(e) => {
            e.stopPropagation();
            void onDownload(node.path, node.type);
          }}
        >
          <Download size={13} />
        </button>
      </div>
      {node.type === "directory" && expanded && node.children && (
        <div className="tree-children">
          <FileTree
            nodes={node.children}
            activeFilePath={activeFilePath}
            selectedPaths={selectedPaths}
            multiSelectEnabled={multiSelectEnabled}
            canEditWorkspace={canEditWorkspace}
            onFileSelect={onFileSelect}
            onToggleSelect={onToggleSelect}
            onDownload={onDownload}
            onContextMenu={onContextMenu}
            claims={claims}
            presence={presence}
            depth={depth + 1}
          />
        </div>
      )}
    </div>
  );
};
