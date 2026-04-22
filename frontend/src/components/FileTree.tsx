import React, { useState, useCallback } from "react";
import { FileNode } from "../types";
import { ChevronRight, Download, File, Folder } from "lucide-react";

interface FileTreeProps {
  nodes: FileNode[];
  activeFilePath: string | null;
  selectedPaths: Set<string>;
  onFileSelect: (path: string) => void;
  onToggleSelect: (path: string, selected: boolean) => void;
  onDownload: (path: string, type: FileNode["type"]) => void;
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void;
  depth?: number;
}

export const FileTree: React.FC<FileTreeProps> = ({
  nodes,
  activeFilePath,
  selectedPaths,
  onFileSelect,
  onToggleSelect,
  onDownload,
  onContextMenu,
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
          onFileSelect={onFileSelect}
          onToggleSelect={onToggleSelect}
          onDownload={onDownload}
          onContextMenu={onContextMenu}
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
  onFileSelect: (path: string) => void;
  onToggleSelect: (path: string, selected: boolean) => void;
  onDownload: (path: string, type: FileNode["type"]) => void;
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void;
  depth: number;
}

const FileTreeItem: React.FC<FileTreeItemProps> = ({
  node,
  activeFilePath,
  selectedPaths,
  onFileSelect,
  onToggleSelect,
  onDownload,
  onContextMenu,
  depth,
}) => {
  const [expanded, setExpanded] = useState(depth < 1);

  const handleClick = useCallback((event: React.MouseEvent) => {
    if (event.ctrlKey || event.metaKey) {
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
          className="tree-item-checkbox"
          checked={isSelected}
          onChange={(e) => {
            e.stopPropagation();
            onToggleSelect(node.path, e.target.checked);
          }}
          onClick={(e) => e.stopPropagation()}
          title="Select for batch delete"
        />
        {node.type === "directory" ? (
          <Folder className="tree-item-icon folder" size={15} />
        ) : (
          <File className="tree-item-icon" size={15} />
        )}
        <span className="tree-item-name">{node.name}</span>
        <button
          className="tree-item-action"
          title={`Download ${node.type === "directory" ? "folder" : "file"}`}
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
            onFileSelect={onFileSelect}
            onToggleSelect={onToggleSelect}
            onDownload={onDownload}
            onContextMenu={onContextMenu}
            depth={depth + 1}
          />
        </div>
      )}
    </div>
  );
};
