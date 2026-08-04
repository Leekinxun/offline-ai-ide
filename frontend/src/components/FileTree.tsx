import React, { useState, useCallback } from "react";
import { FileNode, TeamClaim, TeamPresence } from "../types";
import { ChevronRight, Download, File, Folder } from "lucide-react";
import { useI18n } from "../i18n";

export const FILE_TREE_DRAG_TYPE = "application/x-crewforge-file-path";

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
  onDropFiles: (targetPath: string, files: FileList) => void;
  onMoveEntry: (sourcePath: string, targetDirectory: string) => void;
  claims?: TeamClaim[];
  presence?: TeamPresence[];
  filterQuery?: string;
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
  onDropFiles,
  onMoveEntry,
  claims,
  presence,
  filterQuery = "",
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
          onDropFiles={onDropFiles}
          onMoveEntry={onMoveEntry}
          claims={claims}
          presence={presence}
          filterQuery={filterQuery}
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
  onDropFiles: (targetPath: string, files: FileList) => void;
  onMoveEntry: (sourcePath: string, targetDirectory: string) => void;
  claims?: TeamClaim[];
  presence?: TeamPresence[];
  filterQuery: string;
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
  onDropFiles,
  onMoveEntry,
  claims,
  presence,
  filterQuery,
  depth,
}) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [dropActive, setDropActive] = useState(false);

  const activateNode = useCallback((event?: React.MouseEvent) => {
    if (multiSelectEnabled || event?.ctrlKey || event?.metaKey) {
      onToggleSelect(node.path, !selectedPaths.has(node.path));
      return;
    }

    if (node.type === "directory") {
      setExpanded((prev) => !prev);
    } else {
      onFileSelect(node.path);
    }
  }, [multiSelectEnabled, node, onFileSelect, onToggleSelect, selectedPaths]);

  const handleClick = useCallback((event: React.MouseEvent) => {
    activateNode(event);
  }, [activateNode]);

  const isActive = node.path === activeFilePath;
  const isFilterActive = Boolean(filterQuery.trim());
  const isExpanded = isFilterActive || expanded;
  const isSelected = selectedPaths.has(node.path);
  const claim = claims?.find((entry) => entry.path === node.path);
  const viewers = presence?.filter((entry) => entry.activeFilePath === node.path) || [];

  return (
    <div>
      <div
        className={`tree-item${isActive ? " active" : ""}${isSelected ? " selected" : ""}${dropActive ? " drop-target" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={handleClick}
        onContextMenu={(e) => onContextMenu(e, node)}
        draggable={canEditWorkspace}
        onDragStart={(event) => {
          if (!canEditWorkspace) {
            event.preventDefault();
            return;
          }
          event.stopPropagation();
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(FILE_TREE_DRAG_TYPE, node.path);
          event.dataTransfer.setData("text/plain", node.path);
        }}
        onDragEnd={() => setDropActive(false)}
        onDragOver={(event) => {
          const isWorkspaceEntry = event.dataTransfer.types.includes(FILE_TREE_DRAG_TYPE);
          const isExternalFile = event.dataTransfer.types.includes("Files");
          if (
            !canEditWorkspace ||
            node.type !== "directory" ||
            (!isWorkspaceEntry && !isExternalFile)
          ) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = isWorkspaceEntry ? "move" : "copy";
          setDropActive(true);
        }}
        onDragLeave={(event) => {
          if (node.type !== "directory") return;
          if (
            event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget)
          ) {
            return;
          }
          setDropActive(false);
        }}
        onDrop={(event) => {
          if (!canEditWorkspace || node.type !== "directory") {
            return;
          }
          const sourcePath = event.dataTransfer.getData(FILE_TREE_DRAG_TYPE);
          if (!sourcePath && event.dataTransfer.files.length === 0) return;
          event.preventDefault();
          event.stopPropagation();
          setDropActive(false);
          if (sourcePath) {
            onMoveEntry(sourcePath, node.path);
          } else {
            onDropFiles(node.path, event.dataTransfer.files);
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          activateNode();
        }}
        role="treeitem"
        tabIndex={0}
        aria-selected={isActive || isSelected}
        aria-expanded={node.type === "directory" ? isExpanded : undefined}
      >
        {node.type === "directory" && (
          <ChevronRight
            className={`tree-chevron${isExpanded ? " open" : ""}`}
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
      {node.type === "directory" && isExpanded && node.children && (
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
            onDropFiles={onDropFiles}
            onMoveEntry={onMoveEntry}
            claims={claims}
            presence={presence}
            filterQuery={filterQuery}
            depth={depth + 1}
          />
        </div>
      )}
    </div>
  );
};
