import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { FileNode, OpenFile, FileSelectionRange, getLanguage } from "../types";
import { FilePreviewMode } from "../plugins/types";
import { useFileSystem } from "./useFileSystem";
import { getDesktopBridge } from "../desktop/bridge";
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
  fs: ReturnType<typeof useFileSystem>;
  token?: string;
  workspaceDir?: string;
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
  treeLoadError: string | null;
  lastWorkspaceMtimeRef: React.MutableRefObject<number>;
  loadTree: () => Promise<boolean>;
  loadDirectory: (path: string) => Promise<boolean>;
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

function isDesktopLazyTree(): boolean {
  return getDesktopBridge()?.workspaceChanges === "cursor";
}

function mergeLoadedChildren(previous: FileNode[] = [], fresh: FileNode[] = []): FileNode[] {
  const previousByPath = new Map(previous.map((node) => [node.path, node]));

  return fresh.map((node) => {
    if (node.type !== "directory") return node;
    const previousNode = previousByPath.get(node.path);
    const childrenLoaded = previousNode?.childrenLoaded === true;
    if (!childrenLoaded) return node;
    return {
      ...node,
      children: previousNode.children || [],
      childrenLoaded: true,
    };
  });
}

export function replaceDirectoryChildren(nodes: FileNode[], path: string, children: FileNode[]): FileNode[] {
  let changed = false;
  const next = nodes.map((node) => {
    if (node.path === path && node.type === "directory") {
      changed = true;
      return { ...node, children, childrenLoaded: true };
    }
    if (node.type === "directory" && node.children) {
      const nextChildren = replaceDirectoryChildren(node.children, path, children);
      if (nextChildren !== node.children) {
        changed = true;
        return { ...node, children: nextChildren };
      }
    }
    return node;
  });
  return changed ? next : nodes;
}

export function isCurrentTreeRequest(options: {
  aborted: boolean;
  requestGeneration: number;
  currentGeneration: number;
  requestScope: string;
  currentScope: string;
}): boolean {
  return !options.aborted &&
    options.requestGeneration === options.currentGeneration &&
    options.requestScope === options.currentScope;
}

/**
 * 工作区文件树与文件系统增删改查、移动拖拽 Hook
 */
export function useWorkspaceFiles(options: UseWorkspaceFilesOptions): UseWorkspaceFilesReturn {
  const {
    fs,
    token = "",
    workspaceDir = "",
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
  const [treeLoadError, setTreeLoadError] = useState<string | null>(null);
  const lastWorkspaceMtimeRef = useRef(0);
  const rootAbortRef = useRef<AbortController | null>(null);
  const directoryAbortRef = useRef(new Map<string, AbortController>());
  const generationRef = useRef(0);
  const scopeKey = useMemo(() => `${token}\0${workspaceDir}`, [token, workspaceDir]);
  const currentScopeKeyRef = useRef(scopeKey);
  currentScopeKeyRef.current = scopeKey;

  useEffect(() => {
    if (!isDesktopLazyTree()) return;
    generationRef.current += 1;
    rootAbortRef.current?.abort();
    rootAbortRef.current = null;
    directoryAbortRef.current.forEach((controller) => controller.abort());
    directoryAbortRef.current.clear();
    setFileTree([]);
    setTreeLoadError(null);
  }, [scopeKey]);

  const loadTree = useCallback(async () => {
    const desktopLazy = isDesktopLazyTree();
    if (!desktopLazy) {
      try {
        const tree = await fs.fetchTree();
        setFileTree(tree);
        const visiblePaths = collectVisiblePaths(tree);
        setOpenFiles((prev) => prev.filter((file) => visiblePaths.has(file.path)));
        setActiveFilePath((prev) => (prev && visiblePaths.has(prev) ? prev : null));
        setDiffViewerPath((prev) => (prev && visiblePaths.has(prev) ? prev : null));
        setPreviewModes((prev) => {
          const next: Record<string, FilePreviewMode> = {};
          for (const [path, mode] of Object.entries(prev)) {
            if (visiblePaths.has(path)) {
              next[path] = mode;
            }
          }
          return next;
        });
        lastWorkspaceMtimeRef.current = Date.now();
        setTreeRefreshNonce((prev) => prev + 1);
        return true;
      } catch {
        showToast(t("app.failedToLoadFileTree"));
        return false;
      }
    }

    rootAbortRef.current?.abort();
    const controller = new AbortController();
    rootAbortRef.current = controller;
    const requestGeneration = generationRef.current;
    const requestScope = scopeKey;
    try {
      const tree = await fs.fetchTree({ signal: controller.signal, expectedWorkspaceDir: workspaceDir });
      if (!isCurrentTreeRequest({
        aborted: controller.signal.aborted,
        requestGeneration,
        currentGeneration: generationRef.current,
        requestScope,
        currentScope: currentScopeKeyRef.current,
      })) {
        return false;
      }
      setTreeLoadError(null);
      setFileTree((previous) => mergeLoadedChildren(previous, tree));
      setTreeRefreshNonce((prev) => prev + 1);
      return true;
    } catch {
      if (!controller.signal.aborted && requestGeneration === generationRef.current) {
        const message = t("app.failedToLoadFileTree");
        setTreeLoadError(message);
        showToast(message);
      }
      return false;
    } finally {
      if (rootAbortRef.current === controller) rootAbortRef.current = null;
    }
  }, [fs, scopeKey, setActiveFilePath, setDiffViewerPath, setOpenFiles, setPreviewModes, showToast, t]);

  const loadDirectory = useCallback(async (path: string) => {
    if (!isDesktopLazyTree()) return true;
    const requestGeneration = generationRef.current;
    const requestScope = scopeKey;
    directoryAbortRef.current.get(path)?.abort();
    const controller = new AbortController();
    directoryAbortRef.current.set(path, controller);
    try {
      const children = await fs.fetchTree({ path, signal: controller.signal, expectedWorkspaceDir: workspaceDir });
      if (!isCurrentTreeRequest({
        aborted: controller.signal.aborted,
        requestGeneration,
        currentGeneration: generationRef.current,
        requestScope,
        currentScope: currentScopeKeyRef.current,
      })) {
        return false;
      }
      setTreeLoadError(null);
      setFileTree((previous) => replaceDirectoryChildren(previous, path, children));
      return true;
    } catch {
      if (!controller.signal.aborted && requestGeneration === generationRef.current) {
        const message = t("app.failedToLoadFileTree");
        setTreeLoadError(message);
        showToast(message);
      }
      return false;
    } finally {
      if (directoryAbortRef.current.get(path) === controller) {
        directoryAbortRef.current.delete(path);
      }
    }
  }, [fs, scopeKey, showToast, t]);

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
    treeLoadError,
    lastWorkspaceMtimeRef,
    loadTree,
    loadDirectory,
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
