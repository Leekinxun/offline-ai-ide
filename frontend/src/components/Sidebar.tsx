import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { FileNode } from "../types";
import { FileTree } from "./FileTree";
import {
  FilePlus,
  FolderPlus,
  FolderOpen,
  Trash2,
  Pencil,
  Download,
  ChevronRight,
  Folder,
} from "lucide-react";

interface SidebarProps {
  tree: FileNode[];
  activeFilePath: string | null;
  visible: boolean;
  onFileSelect: (path: string) => void;
  onCreateEntry: (path: string, isDirectory: boolean) => Promise<void>;
  onDeleteEntry: (path: string) => Promise<void>;
  onDeleteEntries: (paths: string[]) => Promise<void>;
  onRenameEntry: (oldPath: string, newPath: string) => Promise<void>;
  onDownloadEntry: (path: string, type: FileNode["type"]) => Promise<void>;
  onRefreshTree: () => void;
  workspaceDir: string;
  onChangeWorkspace: (path: string) => Promise<void>;
  token: string;
  style?: React.CSSProperties;
}

function isPathEqualOrDescendant(candidate: string, target: string): boolean {
  return candidate === target || candidate.startsWith(`${target}/`);
}

function collectTreePaths(nodes: FileNode[]): Set<string> {
  const paths = new Set<string>();

  const visit = (entries: FileNode[]) => {
    for (const node of entries) {
      paths.add(node.path);
      if (node.children) {
        visit(node.children);
      }
    }
  };

  visit(nodes);
  return paths;
}

export const Sidebar: React.FC<SidebarProps> = ({
  tree,
  activeFilePath,
  visible,
  onFileSelect,
  onCreateEntry,
  onDeleteEntry,
  onDeleteEntries,
  onRenameEntry,
  onDownloadEntry,
  onRefreshTree,
  workspaceDir,
  onChangeWorkspace,
  token,
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
  const [folderBrowser, setFolderBrowser] = useState<{
    currentPath: string;
    entries: { name: string; path: string }[];
    loading: boolean;
  } | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const dialogInputRef = useRef<HTMLInputElement>(null);
  const selectedPathSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);

  useEffect(() => {
    if (dialog && dialogInputRef.current) {
      dialogInputRef.current.focus();
    }
  }, [dialog]);

  useEffect(() => {
    const availablePaths = collectTreePaths(tree);
    setSelectedPaths((prev) => prev.filter((path) => availablePaths.has(path)));
  }, [tree]);

  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  useEffect(() => {
    setSelectedPaths([]);
  }, [workspaceDir]);

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
        setSelectedPaths((prev) =>
          prev.filter((path) => !isPathEqualOrDescendant(path, node.path))
        );
        onRefreshTree();
      }
    },
    [onDeleteEntry, onRefreshTree]
  );

  const handleToggleSelection = useCallback((path: string, selected: boolean) => {
    setSelectedPaths((prev) => {
      if (selected) {
        return prev.includes(path) ? prev : [...prev, path];
      }
      return prev.filter((item) => item !== path);
    });
  }, []);

  const handleBatchDelete = useCallback(async () => {
    if (selectedPaths.length === 0) return;

    setContextMenu(null);
    if (
      !confirm(
        `Delete ${selectedPaths.length} selected item${selectedPaths.length > 1 ? "s" : ""}?`
      )
    ) {
      return;
    }

    try {
      await onDeleteEntries(selectedPaths);
      setSelectedPaths([]);
      onRefreshTree();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Batch delete failed");
    }
  }, [onDeleteEntries, onRefreshTree, selectedPaths]);

  const handleDownload = useCallback(
    async (path: string, type: FileNode["type"]) => {
      setContextMenu(null);
      try {
        await onDownloadEntry(path, type);
      } catch (e) {
        alert(e instanceof Error ? e.message : "Download failed");
      }
    },
    [onDownloadEntry]
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

  // --- Folder browser ---
  const fetchDirectories = useCallback(
    async (dir: string) => {
      setFolderBrowser((prev) => ({
        currentPath: dir,
        entries: prev?.entries || [],
        loading: true,
      }));
      try {
        const res = await fetch(
          `/api/auth/workspace/list?path=${encodeURIComponent(dir)}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!res.ok) throw new Error("Failed to list directories");
        const data = await res.json();
        setFolderBrowser({
          currentPath: dir,
          entries: data.entries,
          loading: false,
        });
      } catch {
        setFolderBrowser((prev) =>
          prev ? { ...prev, entries: [], loading: false } : null
        );
      }
    },
    [token]
  );

  const openFolderBrowser = useCallback(() => {
    // Start from parent of current workspace
    const parent = workspaceDir.split("/").slice(0, -1).join("/") || "/";
    fetchDirectories(parent);
  }, [workspaceDir, fetchDirectories]);

  const handleFolderSelect = useCallback(
    async (path: string) => {
      setFolderBrowser(null);
      await onChangeWorkspace(path);
    },
    [onChangeWorkspace]
  );

  const handleFolderNavigate = useCallback(
    (path: string) => {
      fetchDirectories(path);
    },
    [fetchDirectories]
  );

  const handleFolderUp = useCallback(() => {
    if (!folderBrowser) return;
    const parent = folderBrowser.currentPath.split("/").slice(0, -1).join("/") || "/";
    fetchDirectories(parent);
  }, [folderBrowser, fetchDirectories]);

  if (!visible) return null;

  const workspaceName = workspaceDir.split("/").pop() || workspaceDir;

  return (
    <div className="sidebar" style={style}>
      <div className="sidebar-header">
        <span className="sidebar-title">Explorer</span>
        <div className="sidebar-actions">
          <button
            className="sidebar-action-btn"
            title="Open Folder"
            onClick={openFolderBrowser}
          >
            <FolderOpen size={15} />
          </button>
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
          <button
            className="sidebar-action-btn"
            title={
              selectedPaths.length > 0
                ? `Delete ${selectedPaths.length} selected`
                : "Delete Selected"
            }
            onClick={() => void handleBatchDelete()}
            disabled={selectedPaths.length === 0}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
      <div className="sidebar-workspace-path" title={workspaceDir}>
        {workspaceName}
      </div>
      {selectedPaths.length > 0 && (
        <div className="sidebar-selection-bar">
          <span className="sidebar-selection-text">
            {selectedPaths.length} selected
          </span>
          <div className="sidebar-selection-actions">
            <button
              className="sidebar-selection-btn danger"
              onClick={() => void handleBatchDelete()}
            >
              Delete
            </button>
            <button
              className="sidebar-selection-btn"
              onClick={() => setSelectedPaths([])}
            >
              Clear
            </button>
          </div>
        </div>
      )}
      <div className="file-tree">
        <FileTree
          nodes={tree}
          activeFilePath={activeFilePath}
          selectedPaths={selectedPathSet}
          onFileSelect={onFileSelect}
          onToggleSelect={handleToggleSelection}
          onDownload={handleDownload}
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
            onClick={() =>
              void handleDownload(contextMenu.node.path, contextMenu.node.type)
            }
          >
            <Download size={14} /> Download
          </button>
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

      {/* Create/Rename Dialog */}
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

      {/* Folder Browser Dialog */}
      {folderBrowser && (
        <div className="dialog-overlay" onClick={() => setFolderBrowser(null)}>
          <div
            className="dialog folder-browser"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dialog-title">Open Folder</div>
            <div className="folder-browser-breadcrumb">
              <button
                className="folder-browser-up"
                onClick={handleFolderUp}
                title="Go up"
              >
                ..
              </button>
              <span className="folder-browser-path">
                {folderBrowser.currentPath}
              </span>
            </div>
            <div className="folder-browser-list">
              {folderBrowser.loading ? (
                <div className="folder-browser-loading">Loading...</div>
              ) : folderBrowser.entries.length === 0 ? (
                <div className="folder-browser-empty">No subdirectories</div>
              ) : (
                folderBrowser.entries.map((entry) => (
                  <div
                    key={entry.path}
                    className="folder-browser-item"
                    onClick={() => handleFolderNavigate(entry.path)}
                  >
                    <Folder size={14} />
                    <span>{entry.name}</span>
                    <ChevronRight size={12} className="folder-browser-chevron" />
                  </div>
                ))
              )}
            </div>
            <div className="dialog-actions">
              <button
                className="dialog-btn"
                onClick={() => setFolderBrowser(null)}
              >
                Cancel
              </button>
              <button
                className="dialog-btn primary"
                onClick={() => handleFolderSelect(folderBrowser.currentPath)}
              >
                Open This Folder
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
