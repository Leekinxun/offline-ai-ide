import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { FileNode, TeamDetails } from "../types";
import { FileTree } from "./FileTree";
import {
  FilePlus,
  FileUp,
  FolderPlus,
  FolderUp,
  FolderOpen,
  RefreshCw,
  Trash2,
  Pencil,
  Download,
  ChevronRight,
  Folder,
  CheckSquare,
  Search,
  X,
} from "lucide-react";
import { useI18n } from "../i18n";

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
  onUploadEntries: (
    files: UploadedFileInput[],
    options?: { overwrite?: boolean; targetPath?: string }
  ) => Promise<{ uploaded: number; overwritten: number }>;
  onRefreshTree: () => void;
  workspaceDir: string;
  onChangeWorkspace: (path: string) => Promise<void>;
  token: string;
  activeTeam?: TeamDetails | null;
  style?: React.CSSProperties;
}

interface UploadedFileInput {
  path: string;
  file: File;
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

function filterTree(nodes: FileNode[], query: string): FileNode[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return nodes;

  return nodes.flatMap((node) => {
    const children = node.children ? filterTree(node.children, normalizedQuery) : [];
    const matches = node.name.toLocaleLowerCase().includes(normalizedQuery);
    if (!matches && children.length === 0) return [];

    return [{
      ...node,
      children: matches && node.children ? node.children : children,
    }];
  });
}

function countTreeNodes(nodes: FileNode[]): { files: number; folders: number } {
  return nodes.reduce(
    (counts, node) => {
      if (node.type === "directory") {
        counts.folders += 1;
        if (node.children) {
          const nested = countTreeNodes(node.children);
          counts.files += nested.files;
          counts.folders += nested.folders;
        }
      } else {
        counts.files += 1;
      }
      return counts;
    },
    { files: 0, folders: 0 }
  );
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
  onUploadEntries,
  onRefreshTree,
  workspaceDir,
  onChangeWorkspace,
  token,
  activeTeam,
  style,
}) => {
  const { t } = useI18n();
  const canEditWorkspace = activeTeam?.role !== "viewer";
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
    node: FileNode | null;
  } | null>(null);
  const [folderBrowser, setFolderBrowser] = useState<{
    currentPath: string;
    entries: { name: string; path: string }[];
    loading: boolean;
  } | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [multiSelectEnabled, setMultiSelectEnabled] = useState(false);
  const [treeQuery, setTreeQuery] = useState("");
  const [rootDropActive, setRootDropActive] = useState(false);
  const dialogInputRef = useRef<HTMLInputElement>(null);
  const fileUploadInputRef = useRef<HTMLInputElement>(null);
  const folderUploadInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetPathRef = useRef("");
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
    setMultiSelectEnabled(false);
    setTreeQuery("");
  }, [workspaceDir]);

  useEffect(() => {
    folderUploadInputRef.current?.setAttribute("webkitdirectory", "");
    folderUploadInputRef.current?.setAttribute("directory", "");
  }, []);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, node: FileNode) => {
      e.preventDefault();
      e.stopPropagation();
      if (selectedPathSet.size > 0 && !selectedPathSet.has(node.path)) {
        setSelectedPaths([node.path]);
      }
      setContextMenu({ x: e.clientX, y: e.clientY, node });
    },
    [selectedPathSet]
  );

  const handleRootContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, node: null });
  }, []);

  const handleCreateFile = useCallback(
    (parentPath: string = "") => {
      if (!canEditWorkspace) return;
      setDialog({ type: "file", parentPath });
      setDialogValue("");
      setContextMenu(null);
    },
    [canEditWorkspace]
  );

  const handleCreateFolder = useCallback(
    (parentPath: string = "") => {
      if (!canEditWorkspace) return;
      setDialog({ type: "folder", parentPath });
      setDialogValue("");
      setContextMenu(null);
    },
    [canEditWorkspace]
  );

  const handleRename = useCallback((node: FileNode) => {
    if (!canEditWorkspace) return;
    setDialog({ type: "rename", oldPath: node.path, oldName: node.name });
    setDialogValue(node.name);
    setContextMenu(null);
  }, [canEditWorkspace]);

  const handleDelete = useCallback(
    async (node: FileNode) => {
      if (!canEditWorkspace) return;
      setContextMenu(null);
      if (confirm(t("sidebar.confirmDelete", { name: node.name }))) {
        await onDeleteEntry(node.path);
        setSelectedPaths((prev) =>
          prev.filter((path) => !isPathEqualOrDescendant(path, node.path))
        );
        onRefreshTree();
      }
    },
    [canEditWorkspace, onDeleteEntry, onRefreshTree, t]
  );

  const handleToggleSelection = useCallback((path: string, selected: boolean) => {
    setSelectedPaths((prev) => {
      if (selected) {
        return prev.includes(path) ? prev : [...prev, path];
      }
      return prev.filter((item) => item !== path);
    });
  }, []);

  const handleToggleMultiSelect = useCallback(() => {
    setMultiSelectEnabled((prev) => {
      const next = !prev;
      if (!next) {
        setSelectedPaths([]);
      }
      return next;
    });
  }, []);

  const handleBatchDelete = useCallback(async () => {
    if (!canEditWorkspace) return;
    if (selectedPaths.length === 0) return;

    setContextMenu(null);
    if (
      !confirm(
        t("sidebar.confirmBatchDelete", {
          count: selectedPaths.length,
          suffix: selectedPaths.length > 1 ? "s" : "",
        })
      )
    ) {
      return;
    }

    try {
      await onDeleteEntries(selectedPaths);
      setSelectedPaths([]);
      onRefreshTree();
    } catch (e) {
      alert(e instanceof Error ? e.message : t("sidebar.batchDeleteFailed"));
    }
  }, [canEditWorkspace, onDeleteEntries, onRefreshTree, selectedPaths, t]);

  const handleDownload = useCallback(
    async (path: string, type: FileNode["type"]) => {
      setContextMenu(null);
      try {
        await onDownloadEntry(path, type);
      } catch (e) {
        alert(e instanceof Error ? e.message : t("sidebar.downloadFailed"));
      }
    },
    [onDownloadEntry, t]
  );

  const handleUploadFiles = useCallback(
    async (
      fileList: FileList | null,
      preserveRelativePath: boolean,
      targetPath = ""
    ) => {
      if (!canEditWorkspace || !fileList || fileList.length === 0) return;

      try {
        const files = Array.from(fileList).map((file) => ({
            path:
              preserveRelativePath && file.webkitRelativePath
                ? file.webkitRelativePath
                : file.name,
            file,
          }));

        try {
          await onUploadEntries(files, { targetPath });
          onRefreshTree();
        } catch (e) {
          const uploadError = e as Error & { code?: string; conflicts?: string[] };
          if (uploadError.code !== "UPLOAD_CONFLICT") {
            throw e;
          }

          const conflicts = uploadError.conflicts || [];
          const confirmed = confirm(
            t("sidebar.confirmUploadOverwrite", {
              count: conflicts.length,
              sample: conflicts.slice(0, 3).join(", "),
            })
          );
          if (!confirmed) return;

          await onUploadEntries(files, { overwrite: true, targetPath });
          onRefreshTree();
        }
      } catch (e) {
        alert(e instanceof Error ? e.message : t("sidebar.uploadFailed"));
      } finally {
        if (fileUploadInputRef.current) {
          fileUploadInputRef.current.value = "";
        }
        if (folderUploadInputRef.current) {
          folderUploadInputRef.current.value = "";
        }
      }
    },
    [canEditWorkspace, onRefreshTree, onUploadEntries, t]
  );

  const openUploadPicker = useCallback(
    (targetPath: string, preserveRelativePath: boolean) => {
      if (!canEditWorkspace) return;
      uploadTargetPathRef.current = targetPath;
      const input = preserveRelativePath
        ? folderUploadInputRef.current
        : fileUploadInputRef.current;
      input?.click();
      setContextMenu(null);
    },
    [canEditWorkspace]
  );

  const handleDroppedFiles = useCallback(
    (targetPath: string, fileList: FileList) => {
      setRootDropActive(false);
      void handleUploadFiles(fileList, false, targetPath);
    },
    [handleUploadFiles]
  );

  const handleDialogSubmit = useCallback(async () => {
    if (!canEditWorkspace) return;
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
      alert(e instanceof Error ? e.message : t("sidebar.operationFailed"));
    }
    setDialog(null);
  }, [canEditWorkspace, dialog, dialogValue, onCreateEntry, onRenameEntry, onRefreshTree, t]);

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
        if (!res.ok) throw new Error(t("sidebar.failedToListDirectories"));
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
    [t, token]
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
  const filteredTree = useMemo(() => filterTree(tree, treeQuery), [tree, treeQuery]);
  const treeStats = useMemo(() => countTreeNodes(filteredTree), [filteredTree]);

  return (
    <div className="sidebar" style={style}>
      <div className="sidebar-header">
        <div className="sidebar-heading">
          <span className="sidebar-eyebrow">{t("sidebar.workspaceLabel")}</span>
          <span className="sidebar-title">{t("sidebar.explorer")}</span>
        </div>
        <div className="sidebar-actions">
          <input
            ref={fileUploadInputRef}
            className="sidebar-hidden-file-input"
            type="file"
            multiple
            onChange={(e) =>
              void handleUploadFiles(
                e.target.files,
                false,
                uploadTargetPathRef.current
              )
            }
          />
          <input
            ref={folderUploadInputRef}
            className="sidebar-hidden-file-input"
            type="file"
            multiple
            onChange={(e) =>
              void handleUploadFiles(
                e.target.files,
                true,
                uploadTargetPathRef.current
              )
            }
          />
          <div className="sidebar-action-group sidebar-action-group-primary">
            <button
              className="sidebar-action-btn primary"
              title={t("sidebar.newFile")}
              aria-label={t("sidebar.newFile")}
              onClick={() => handleCreateFile()}
              disabled={!canEditWorkspace}
            >
              <FilePlus size={16} />
            </button>
            <button
              className="sidebar-action-btn primary"
              title={t("sidebar.newFolder")}
              aria-label={t("sidebar.newFolder")}
              onClick={() => handleCreateFolder()}
              disabled={!canEditWorkspace}
            >
              <FolderPlus size={16} />
            </button>
          </div>
          <span className="sidebar-action-divider" aria-hidden="true" />
          <button
            className="sidebar-action-btn"
            title={t("sidebar.openFolder")}
            aria-label={t("sidebar.openFolder")}
            onClick={openFolderBrowser}
          >
            <FolderOpen size={15} />
          </button>
          <button
            className="sidebar-action-btn"
            title={t("sidebar.uploadFiles")}
            aria-label={t("sidebar.uploadFiles")}
            onClick={() => openUploadPicker("", false)}
            disabled={!canEditWorkspace}
          >
            <FileUp size={15} />
          </button>
          <button
            className="sidebar-action-btn"
            title={t("sidebar.uploadFolder")}
            aria-label={t("sidebar.uploadFolder")}
            onClick={() => openUploadPicker("", true)}
            disabled={!canEditWorkspace}
          >
            <FolderUp size={15} />
          </button>
          <button
            className="sidebar-action-btn workbench-refresh"
            title={t("common.refresh")}
            aria-label={t("common.refresh")}
            onClick={onRefreshTree}
          >
            <RefreshCw size={15} />
          </button>
          <button
            className={`sidebar-action-btn${multiSelectEnabled ? " active" : ""}`}
            title={t("sidebar.toggleMultiSelect")}
            aria-label={t("sidebar.toggleMultiSelect")}
            onClick={handleToggleMultiSelect}
          >
            <CheckSquare size={15} />
          </button>
          <button
            className="sidebar-action-btn"
            title={
              selectedPaths.length > 0
                ? t("sidebar.deleteSelectedCount", { count: selectedPaths.length })
                : t("sidebar.deleteSelected")
            }
            aria-label={t("sidebar.deleteSelected")}
            onClick={() => void handleBatchDelete()}
            disabled={!canEditWorkspace || selectedPaths.length === 0}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
      <div className="sidebar-workspace-card" title={workspaceDir}>
        <div className="sidebar-workspace-icon" aria-hidden="true">
          <FolderOpen size={16} />
        </div>
        <div className="sidebar-workspace-copy">
          <span className="sidebar-workspace-label">{t("sidebar.currentWorkspace")}</span>
          <strong>{workspaceName}</strong>
          <span>{workspaceDir}</span>
        </div>
      </div>
      <div className="sidebar-tools">
        <label className="sidebar-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            value={treeQuery}
            onChange={(event) => setTreeQuery(event.target.value)}
            placeholder={t("sidebar.filterPlaceholder")}
            aria-label={t("sidebar.filterPlaceholder")}
          />
          {treeQuery && (
            <button
              type="button"
              className="sidebar-search-clear"
              onClick={() => setTreeQuery("")}
              title={t("common.clear")}
              aria-label={t("common.clear")}
            >
              <X size={14} />
            </button>
          )}
        </label>
        <div className="sidebar-tree-meta" aria-live="polite">
          <span>{treeStats.folders} {t("sidebar.folders")}</span>
          <span>{treeStats.files} {t("sidebar.files")}</span>
        </div>
      </div>
      {selectedPaths.length > 0 && (
        <div className="sidebar-selection-bar">
          <span className="sidebar-selection-text">
            {t("sidebar.selectedCount", { count: selectedPaths.length })}
          </span>
          <div className="sidebar-selection-actions">
            <button
              className="sidebar-selection-btn danger"
              onClick={() => void handleBatchDelete()}
              disabled={!canEditWorkspace}
            >
              {t("common.delete")}
            </button>
            <button
              className="sidebar-selection-btn"
              onClick={() => setSelectedPaths([])}
            >
              {t("common.clear")}
            </button>
          </div>
        </div>
      )}
      <div
        className={`file-tree${rootDropActive ? " drop-target" : ""}`}
        role="tree"
        aria-label={t("sidebar.explorer")}
        onContextMenu={handleRootContextMenu}
        onDragOver={(event) => {
          if (!canEditWorkspace || !event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setRootDropActive(true);
        }}
        onDragLeave={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget)
          ) {
            return;
          }
          setRootDropActive(false);
        }}
        onDrop={(event) => {
          if (!canEditWorkspace || event.dataTransfer.files.length === 0) return;
          event.preventDefault();
          setRootDropActive(false);
          handleDroppedFiles("", event.dataTransfer.files);
        }}
      >
        {rootDropActive && (
          <div className="sidebar-drop-hint" aria-hidden="true">
            <FileUp size={16} /> {t("sidebar.dropFilesHere")}
          </div>
        )}
        {filteredTree.length > 0 ? (
          <FileTree
            nodes={filteredTree}
            activeFilePath={activeFilePath}
            selectedPaths={selectedPathSet}
            multiSelectEnabled={multiSelectEnabled}
            canEditWorkspace={canEditWorkspace}
            claims={activeTeam?.claims}
            presence={activeTeam?.presence}
            filterQuery={treeQuery}
            onFileSelect={onFileSelect}
            onToggleSelect={handleToggleSelection}
            onDownload={handleDownload}
            onContextMenu={handleContextMenu}
            onDropFiles={handleDroppedFiles}
          />
        ) : (
          <div className="sidebar-tree-empty">
            <Search size={18} aria-hidden="true" />
            <strong>{treeQuery ? t("sidebar.noMatches") : t("sidebar.emptyWorkspace")}</strong>
            <span>{treeQuery ? t("sidebar.noMatchesHint") : t("sidebar.emptyWorkspaceHint")}</span>
          </div>
        )}
      </div>
      {!canEditWorkspace && (
        <div className="sidebar-readonly-banner">{t("team.readOnlyHint")}</div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.node ? (
            <>
              <button
                className="context-menu-item"
                onClick={() => {
                  handleToggleSelection(
                    contextMenu.node!.path,
                    !selectedPathSet.has(contextMenu.node!.path)
                  );
                  setMultiSelectEnabled(true);
                  setContextMenu(null);
                }}
              >
                <CheckSquare size={14} />{" "}
                {selectedPathSet.has(contextMenu.node.path)
                  ? t("sidebar.unselectItem")
                  : t("sidebar.selectItem")}
              </button>
              <div className="context-menu-separator" />
              {contextMenu.node.type === "directory" && (
                <>
                  <button
                    className="context-menu-item"
                    onClick={() => handleCreateFile(contextMenu.node!.path)}
                    disabled={!canEditWorkspace}
                  >
                    <FilePlus size={14} /> {t("sidebar.newFile")}
                  </button>
                  <button
                    className="context-menu-item"
                    onClick={() => handleCreateFolder(contextMenu.node!.path)}
                    disabled={!canEditWorkspace}
                  >
                    <FolderPlus size={14} /> {t("sidebar.newFolder")}
                  </button>
                  <button
                    className="context-menu-item"
                    onClick={() => openUploadPicker(contextMenu.node!.path, false)}
                    disabled={!canEditWorkspace}
                  >
                    <FileUp size={14} /> {t("sidebar.uploadFiles")}
                  </button>
                  <button
                    className="context-menu-item"
                    onClick={() => openUploadPicker(contextMenu.node!.path, true)}
                    disabled={!canEditWorkspace}
                  >
                    <FolderUp size={14} /> {t("sidebar.uploadFolder")}
                  </button>
                  <div className="context-menu-separator" />
                </>
              )}
              <button
                className="context-menu-item"
                onClick={() =>
                  void handleDownload(contextMenu.node!.path, contextMenu.node!.type)
                }
              >
                <Download size={14} />{" "}
                {contextMenu.node.type === "directory"
                  ? t("sidebar.downloadFolder")
                  : t("sidebar.downloadFile")}
              </button>
              <button
                className="context-menu-item"
                onClick={() => handleRename(contextMenu.node!)}
                disabled={!canEditWorkspace}
              >
                <Pencil size={14} /> {t("common.rename")}
              </button>
              <button
                className="context-menu-item danger"
                onClick={() => handleDelete(contextMenu.node!)}
                disabled={!canEditWorkspace}
              >
                <Trash2 size={14} /> {t("common.delete")}
              </button>
            </>
          ) : (
            <>
              <button
                className="context-menu-item"
                onClick={() => handleCreateFile()}
                disabled={!canEditWorkspace}
              >
                <FilePlus size={14} /> {t("sidebar.newFile")}
              </button>
              <button
                className="context-menu-item"
                onClick={() => handleCreateFolder()}
                disabled={!canEditWorkspace}
              >
                <FolderPlus size={14} /> {t("sidebar.newFolder")}
              </button>
              <div className="context-menu-separator" />
              <button
                className="context-menu-item"
                onClick={() => openUploadPicker("", false)}
                disabled={!canEditWorkspace}
              >
                <FileUp size={14} /> {t("sidebar.uploadFiles")}
              </button>
              <button
                className="context-menu-item"
                onClick={() => openUploadPicker("", true)}
                disabled={!canEditWorkspace}
              >
                <FolderUp size={14} /> {t("sidebar.uploadFolder")}
              </button>
              <div className="context-menu-separator" />
              <button
                className="context-menu-item"
                onClick={() => {
                  onRefreshTree();
                  setContextMenu(null);
                }}
              >
                <RefreshCw size={14} /> {t("common.refresh")}
              </button>
            </>
          )}
        </div>
      )}

      {/* Create/Rename Dialog */}
      {dialog && (
        <div className="dialog-overlay" onClick={() => setDialog(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-title">
              {dialog.type === "file"
                ? t("sidebar.dialogNewFile")
                : dialog.type === "folder"
                ? t("sidebar.dialogNewFolder")
                : t("sidebar.dialogRename")}
            </div>
            <input
              ref={dialogInputRef}
              className="dialog-input"
              placeholder={
                dialog.type === "rename"
                  ? t("sidebar.newName")
                  : t("sidebar.enterName")
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
                {t("common.cancel")}
              </button>
              <button
                className="dialog-btn primary"
                onClick={handleDialogSubmit}
              >
                {dialog.type === "rename" ? t("common.rename") : t("common.create")}
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
            <div className="dialog-title">{t("sidebar.openFolder")}</div>
            <div className="folder-browser-breadcrumb">
              <button
                className="folder-browser-up"
                onClick={handleFolderUp}
                title={t("sidebar.goUp")}
              >
                ..
              </button>
              <span className="folder-browser-path">
                {folderBrowser.currentPath}
              </span>
            </div>
            <div className="folder-browser-list">
              {folderBrowser.loading ? (
                <div className="folder-browser-loading">{t("common.loading")}</div>
              ) : folderBrowser.entries.length === 0 ? (
                <div className="folder-browser-empty">{t("sidebar.noSubdirectories")}</div>
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
                {t("common.cancel")}
              </button>
              <button
                className="dialog-btn primary"
                onClick={() => handleFolderSelect(folderBrowser.currentPath)}
              >
                {t("sidebar.openThisFolder")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
