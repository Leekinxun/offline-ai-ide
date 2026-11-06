import React, { useState, useCallback, useRef } from "react";
import { FileNode, OpenFile, FileSelectionRange, getLanguage } from "../types";
import { FilePreviewMode } from "../plugins/types";
import { useFileSystem } from "./useFileSystem";
import { normalizeWorkspaceRelativePath, retainOpenFilesAfterTreeRefresh } from "../editor/fileUpdatePolicy";
import {
  collectVisiblePaths,
  pruneNestedPaths,
  remapMovedPath,
} from "../utils/workspacePaths";

export interface EditorNavigationTarget extends FileSelectionRange {
  path: string;
  requestId: number;
}

export interface EditorHighlightTarget extends FileSelectionRange {
  path: string;
  requestId: number;
}

export interface UseWorkspaceFilesOptions {
  workspaceDir: string;
  openFiles: OpenFile[];
  fs: ReturnType<typeof useFileSystem>;
  showToast: (msg: string) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  setOpenFiles: React.Dispatch<React.SetStateAction<OpenFile[]>>;
  setActiveFilePath: React.Dispatch<React.SetStateAction<string | null>>;
  setDiffViewerPath: React.Dispatch<React.SetStateAction<string | null>>;
  setPreviewModes: React.Dispatch<React.SetStateAction<Record<string, FilePreviewMode>>>;
  setEditorNavigationTarget: React.Dispatch<React.SetStateAction<EditorNavigationTarget | null>>;
  setEditorHighlightTarget: React.Dispatch<React.SetStateAction<EditorHighlightTarget | null>>;
  removeDeletedEntriesFromState: (deletedPaths: string[]) => void;
}

export interface UseWorkspaceFilesReturn {
  fileTree: FileNode[];
  setFileTree: React.Dispatch<React.SetStateAction<FileNode[]>>;
  treeRefreshNonce: number;
  setTreeRefreshNonce: React.Dispatch<React.SetStateAction<number>>;
  lastWorkspaceMtimeRef: React.MutableRefObject<number>;
  loadTree: () => Promise<void>;
  beginPreserveOpenPath: (path: string) => () => void;
  handleCreateEntry: (path: string, isDirectory: boolean) => Promise<void>;
  handleCopyEntry: (sourcePath: string, targetDirectory: string) => Promise<{ sourcePath: string; path: string; type: FileNode["type"] }>;
  handleDeleteEntry: (path: string) => Promise<void>;
  handleDeleteEntries: (paths: string[]) => Promise<void>;
  updateMovedPathsInEditor: (oldPath: string, newPath: string) => void;
  handleRenameEntry: (oldPath: string, newPath: string) => Promise<void>;
  handleMoveEntry: (sourcePath: string, targetDirectory: string) => Promise<{ sourcePath: string; path: string; type: FileNode["type"] }>;
  handleDownloadEntry: (path: string, type: FileNode["type"]) => Promise<void>;
  handleUploadEntries: (
    files: { path: string; file: File }[],
    options?: { overwrite?: boolean; targetPath?: string }
  ) => Promise<{ uploaded: number; overwritten: number }>;
}

/**
 * 工作区文件树与文件系统增删改查、移动拖拽 Hook
 */
export function useWorkspaceFiles(options: UseWorkspaceFilesOptions): UseWorkspaceFilesReturn {
  const {
    workspaceDir,
    openFiles,
    fs,
    showToast,
    t,
    setOpenFiles,
    setActiveFilePath,
    setDiffViewerPath,
    setPreviewModes,
    setEditorNavigationTarget,
    setEditorHighlightTarget,
    removeDeletedEntriesFromState,
  } = options;

  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [treeRefreshNonce, setTreeRefreshNonce] = useState(0);
  const lastWorkspaceMtimeRef = useRef(0);
  const openFilesRef = useRef(openFiles);
  openFilesRef.current = openFiles;
  const treeScopeRef = useRef({ workspaceDir, request: 0, pendingPaths: new Map<string, number>() });
  if (treeScopeRef.current.workspaceDir !== workspaceDir) treeScopeRef.current = { workspaceDir, request: 0, pendingPaths: new Map() };

  const beginPreserveOpenPath = useCallback((rawPath: string) => {
    const scope = treeScopeRef.current;
    const path = normalizeWorkspaceRelativePath(rawPath, workspaceDir);
    if (!path || scope.workspaceDir !== workspaceDir) return () => {};
    scope.pendingPaths.set(path, (scope.pendingPaths.get(path) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (scope.pendingPaths.get(path) || 1) - 1;
      if (remaining) scope.pendingPaths.set(path, remaining); else scope.pendingPaths.delete(path);
    };
  }, [workspaceDir]);

  const loadTree = useCallback(async () => {
    const scope = treeScopeRef.current;
    if (scope.workspaceDir !== workspaceDir) return;
    const request = ++scope.request;
    const isCurrent = () => scope === treeScopeRef.current && request === scope.request;
    try {
      const tree = await fs.fetchTree();
      if (!isCurrent()) return;
      setFileTree((previous) => isCurrent() ? tree : previous);
      const visiblePaths = collectVisiblePaths(tree);
      const pendingPaths = new Set(scope.pendingPaths.keys());
      const availablePaths = new Set(visiblePaths);
      for (const file of retainOpenFilesAfterTreeRefresh(openFilesRef.current, visiblePaths, workspaceDir, pendingPaths)) {
        availablePaths.add(normalizeWorkspaceRelativePath(file.path, workspaceDir));
      }
      const retainPath = (path: string | null) => path && availablePaths.has(normalizeWorkspaceRelativePath(path, workspaceDir)) ? path : null;
      setOpenFiles((previous) => isCurrent() ? retainOpenFilesAfterTreeRefresh(previous, visiblePaths, workspaceDir, pendingPaths) : previous);
      // Missing source tabs remain open while rename evidence is pending.
      setActiveFilePath((path) => isCurrent() ? retainPath(path) : path);
      setDiffViewerPath((path) => isCurrent() ? retainPath(path) : path);
      setPreviewModes((previousModes) => {
        if (!isCurrent()) return previousModes;
        return Object.fromEntries(Object.entries(previousModes).filter(([path]) => availablePaths.has(normalizeWorkspaceRelativePath(path, workspaceDir))));
      });
      lastWorkspaceMtimeRef.current = Date.now();
      setTreeRefreshNonce((prev) => prev + 1);
    } catch {
      if (isCurrent()) showToast(t("app.failedToLoadFileTree"));
    }
  }, [fs, setActiveFilePath, setDiffViewerPath, setOpenFiles, setPreviewModes, showToast, t, workspaceDir]);

  const handleCreateEntry = useCallback(
    async (path: string, isDirectory: boolean) => {
      await fs.createEntry(path, isDirectory);
    },
    [fs]
  );

  const handleCopyEntry = useCallback(
    async (sourcePath: string, targetDirectory: string) => {
      const result = await fs.copyEntry(sourcePath, targetDirectory);
      showToast(t("app.copiedEntry", { path: result.path }));
      return result;
    },
    [fs, showToast, t]
  );

  const handleDeleteEntry = useCallback(
    async (path: string) => {
      const deletedPaths: string[] = [];
      try {
        await fs.deleteEntry(path);
        deletedPaths.push(path);
      } finally {
        if (deletedPaths.length > 0) {
          removeDeletedEntriesFromState(deletedPaths);
        }
      }
    },
    [fs, removeDeletedEntriesFromState]
  );

  const handleDeleteEntries = useCallback(
    async (paths: string[]) => {
      const targets = pruneNestedPaths(paths);
      const deletedPaths: string[] = [];

      try {
        for (const path of targets) {
          await fs.deleteEntry(path);
          deletedPaths.push(path);
        }
      } finally {
        if (deletedPaths.length > 0) {
          removeDeletedEntriesFromState(deletedPaths);
        }
      }
    },
    [fs, removeDeletedEntriesFromState]
  );

  const updateMovedPathsInEditor = useCallback((oldPath: string, newPath: string) => {
    setPreviewModes((current) => {
      let changed = false;
      const next: typeof current = {};
      for (const [previewPath, mode] of Object.entries(current)) {
        const remappedPath = remapMovedPath(previewPath, oldPath, newPath);
        next[remappedPath] = mode;
        changed ||= remappedPath !== previewPath;
      }
      return changed ? next : current;
    });

    setOpenFiles((prev) =>
      prev.map((file) => {
        const path = remapMovedPath(file.path, oldPath, newPath);
        return path !== file.path
          ? {
              ...file,
              path,
              name: path.split("/").pop() || path,
              language: getLanguage(path.split("/").pop() || ""),
            }
          : file;
      })
    );

    setActiveFilePath((current) =>
      current ? remapMovedPath(current, oldPath, newPath) : current
    );

    setEditorNavigationTarget((current) =>
      current
        ? { ...current, path: remapMovedPath(current.path, oldPath, newPath) }
        : current
    );

    setEditorHighlightTarget((current) =>
      current
        ? { ...current, path: remapMovedPath(current.path, oldPath, newPath) }
        : current
    );
  }, [setActiveFilePath, setEditorHighlightTarget, setEditorNavigationTarget, setOpenFiles, setPreviewModes]);

  const handleRenameEntry = useCallback(
    async (oldPath: string, newPath: string) => {
      await fs.renameEntry(oldPath, newPath);
      updateMovedPathsInEditor(oldPath, newPath);
    },
    [fs, updateMovedPathsInEditor]
  );

  const handleMoveEntry = useCallback(
    async (sourcePath: string, targetDirectory: string) => {
      const result = await fs.moveEntry(sourcePath, targetDirectory);
      if (result.sourcePath !== result.path) {
        updateMovedPathsInEditor(result.sourcePath, result.path);
        showToast(t("app.movedEntry", { path: result.path }));
      }
      return result;
    },
    [fs, showToast, t, updateMovedPathsInEditor]
  );

  const handleDownloadEntry = useCallback(
    async (path: string, type: FileNode["type"]) => {
      const filename = await fs.downloadEntry(path, type);
      showToast(t("app.downloaded", { filename }));
    },
    [fs, showToast, t]
  );

  const handleUploadEntries = useCallback(
    async (
      files: { path: string; file: File }[],
      options?: { overwrite?: boolean; targetPath?: string }
    ) => {
      const result = await fs.uploadEntries(files, options);
      showToast(t("app.uploaded", { count: result.uploaded }));
      return result;
    },
    [fs, showToast, t]
  );

  return {
    fileTree,
    setFileTree,
    treeRefreshNonce,
    setTreeRefreshNonce,
    lastWorkspaceMtimeRef,
    loadTree,
    beginPreserveOpenPath,
    handleCreateEntry,
    handleCopyEntry,
    handleDeleteEntry,
    handleDeleteEntries,
    updateMovedPathsInEditor,
    handleRenameEntry,
    handleMoveEntry,
    handleDownloadEntry,
    handleUploadEntries,
  };
}
