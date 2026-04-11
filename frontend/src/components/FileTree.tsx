import React, { useState, useCallback } from "react";
import { FileNode } from "../types";
import { ChevronRight, File, Folder } from "lucide-react";

interface FileTreeProps {
  nodes: FileNode[];
  activeFilePath: string | null;
  onFileSelect: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void;
  depth?: number;
}

export const FileTree: React.FC<FileTreeProps> = ({
  nodes,
  activeFilePath,
  onFileSelect,
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
          onFileSelect={onFileSelect}
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
  onFileSelect: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void;
  depth: number;
}

const FileTreeItem: React.FC<FileTreeItemProps> = ({
  node,
  activeFilePath,
  onFileSelect,
  onContextMenu,
  depth,
}) => {
  const [expanded, setExpanded] = useState(depth < 1);

  const handleClick = useCallback(() => {
    if (node.type === "directory") {
      setExpanded((prev) => !prev);
    } else {
      onFileSelect(node.path);
    }
  }, [node, onFileSelect]);

  const isActive = node.path === activeFilePath;

  return (
    <div>
      <div
        className={`tree-item${isActive ? " active" : ""}`}
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
        {node.type === "directory" ? (
          <Folder className="tree-item-icon folder" size={15} />
        ) : (
          <File className="tree-item-icon" size={15} />
        )}
        <span className="tree-item-name">{node.name}</span>
      </div>
      {node.type === "directory" && expanded && node.children && (
        <div className="tree-children">
          <FileTree
            nodes={node.children}
            activeFilePath={activeFilePath}
            onFileSelect={onFileSelect}
            onContextMenu={onContextMenu}
            depth={depth + 1}
          />
        </div>
      )}
    </div>
  );
};
