import React, { useState, useEffect, useCallback, useRef } from "react";
import { FileNode } from "../types";
import { FileTree } from "./FileTree";
import { FilePlus, FolderPlus, Trash2, Pencil } from "lucide-react";

interface SidebarProps {
  tree: FileNode[];
  activeFilePath: string | null;
  visible: boolean;
  onFileSelect: (path: string) => void;
  onCreateEntry: (path: string, isDirectory: boolean) => Promise<void>;
  onDeleteEntry: (path: string) => Promise<void>;
  onRenameEntry: (oldPath: string, newPath: string) => Promise<void>;
  onRefreshTree: () => void;
  style?: React.CSSProperties;
}

export const Sidebar: React.FC<SidebarProps> = ({
  tree,
  activeFilePath,
  visible,
  onFileSelect,
  onCreateEntry,
  onDeleteEntry,
  onRenameEntry,
  onRefreshTree,
  style,
}) => {
  const [dialog, setDialog] = useState<{
    type: "file" | "folder" | "rename";
    parentPath?: string;
    oldPath?: string;
    oldName?: string;
  } | null>(null);
  const [dialogValue, setDialogValue] = useState("");
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    node: FileNode;
  } | null>(null);
  const dialogInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (dialog && dialogInputRef.current) {
      dialogInputRef.current.focus();
    }
  }, [dialog]);

  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, node: FileNode) => {
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, node });
    },
    []
  );

  const handleCreateFile = useCallback(
    (parentPath: string = "") => {
      setDialog({ type: "file", parentPath });
      setDialogValue("");
      setContextMenu(null);
    },
    []
  );

  const handleCreateFolder = useCallback(
    (parentPath: string = "") => {
      setDialog({ type: "folder", parentPath });
      setDialogValue("");
      setContextMenu(null);
    },
    []
  );

  const handleRename = useCallback((node: FileNode) => {
    setDialog({ type: "rename", oldPath: node.path, oldName: node.name });
    setDialogValue(node.name);
    setContextMenu(null);
  }, []);

  const handleDelete = useCallback(
    async (node: FileNode) => {
      setContextMenu(null);
      if (confirm(`Delete "${node.name}"?`)) {
        await onDeleteEntry(node.path);
        onRefreshTree();
      }
    },
    [onDeleteEntry, onRefreshTree]
  );

  const handleDialogSubmit = useCallback(async () => {
    if (!dialog || !dialogValue.trim()) return;
    try {
      if (dialog.type === "rename" && dialog.oldPath) {
        const parts = dialog.oldPath.split("/");
        parts[parts.length - 1] = dialogValue.trim();
        await onRenameEntry(dialog.oldPath, parts.join("/"));
      } else {
        const parent = dialog.parentPath || "";
        const path = parent ? `${parent}/${dialogValue.trim()}` : dialogValue.trim();
        await onCreateEntry(path, dialog.type === "folder");
      }
      onRefreshTree();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Operation failed");
    }
    setDialog(null);
  }, [dialog, dialogValue, onCreateEntry, onRenameEntry, onRefreshTree]);

  if (!visible) return null;

  return (
    <div className="sidebar" style={style}>
      <div className="sidebar-header">
        <span className="sidebar-title">Explorer</span>
        <div className="sidebar-actions">
          <button
            className="sidebar-action-btn"
            title="New File"
            onClick={() => handleCreateFile()}
          >
            <FilePlus size={15} />
          </button>
          <button
            className="sidebar-action-btn"
            title="New Folder"
            onClick={() => handleCreateFolder()}
          >
            <FolderPlus size={15} />
          </button>
        </div>
      </div>
      <div className="file-tree">
        <FileTree
          nodes={tree}
          activeFilePath={activeFilePath}
          onFileSelect={onFileSelect}
          onContextMenu={handleContextMenu}
        />
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.node.type === "directory" && (
            <>
              <button
                className="context-menu-item"
                onClick={() => handleCreateFile(contextMenu.node.path)}
              >
                <FilePlus size={14} /> New File
              </button>
              <button
                className="context-menu-item"
                onClick={() => handleCreateFolder(contextMenu.node.path)}
              >
                <FolderPlus size={14} /> New Folder
              </button>
              <div className="context-menu-separator" />
            </>
          )}
          <button
            className="context-menu-item"
            onClick={() => handleRename(contextMenu.node)}
          >
            <Pencil size={14} /> Rename
          </button>
          <button
            className="context-menu-item danger"
            onClick={() => handleDelete(contextMenu.node)}
          >
            <Trash2 size={14} /> Delete
          </button>
        </div>
      )}

      {/* Dialog */}
      {dialog && (
        <div className="dialog-overlay" onClick={() => setDialog(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-title">
              {dialog.type === "file"
                ? "New File"
                : dialog.type === "folder"
                ? "New Folder"
                : "Rename"}
            </div>
            <input
              ref={dialogInputRef}
              className="dialog-input"
              placeholder={
                dialog.type === "rename" ? "New name" : "Enter name..."
              }
              value={dialogValue}
              onChange={(e) => setDialogValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleDialogSubmit();
                if (e.key === "Escape") setDialog(null);
              }}
            />
            <div className="dialog-actions">
              <button className="dialog-btn" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button
                className="dialog-btn primary"
                onClick={handleDialogSubmit}
              >
                {dialog.type === "rename" ? "Rename" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
