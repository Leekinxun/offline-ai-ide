import React, { useState, useCallback, useRef } from "react";
import { OpenFile, getLanguage, TeamClaim, TeamPresence } from "../types";
import { FilePreviewMode } from "../plugins/types";
import { useFileSystem } from "./useFileSystem";
import { useTeam } from "./useTeam";
import {
  normalizeWorkspaceRelativePath,
  isSameWorkspacePath,
  isPathEqualOrDescendant,
  buildClearedRemoteState,
} from "../utils/workspacePaths";

export type { FilePreviewMode };

export interface UseEditorTabsOptions {
  workspaceDir: string;
  fs: ReturnType<typeof useFileSystem>;
  team: ReturnType<typeof useTeam>;
  readOnlyWorkspace: boolean;
  username: string;
  showToast: (msg: string) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  inferConflictSource: (
    path: string,
    options?: { knownRemoteUpdatedAt?: number }
  ) => {
    source: "team_member" | "external" | "assistant_tool" | "unknown";
    actor?: string;
  };
  setDiffViewerPath: (path: string | null) => void;
  setWorkspaceView: (view: "chat" | "files") => void;
  setEditorAssistantVisible: React.Dispatch<React.SetStateAction<boolean>>;
  onDeletedPaths?: (deletedPaths: string[]) => void;
}

export interface UseEditorTabsReturn {
  openFiles: OpenFile[];
  setOpenFiles: React.Dispatch<React.SetStateAction<OpenFile[]>>;
  activeFilePath: string | null;
  setActiveFilePath: React.Dispatch<React.SetStateAction<string | null>>;
  compareFilePath: string | null;
  setCompareFilePath: React.Dispatch<React.SetStateAction<string | null>>;
  previewModes: Record<string, FilePreviewMode>;
  setPreviewModes: React.Dispatch<React.SetStateAction<Record<string, FilePreviewMode>>>;
  activeFile: OpenFile | null;
  activeClaim: TeamClaim | null;
  activeCollaborators: TeamPresence[];
  openFile: (rawPath: string) => Promise<void>;
  closeTab: (rawPath: string) => void;
  closeOtherTabs: (keepPath: string) => void;
  closeTabsToTheRight: (targetPath: string) => void;
  closeAllTabs: () => void;
  handleEditorChange: (value: string) => void;
  saveFile: () => Promise<boolean>;
  claimSaveConfirmation: { file: OpenFile; username: string } | null;
  setClaimSaveConfirmation: React.Dispatch<
    React.SetStateAction<{ file: OpenFile; username: string } | null>
  >;
  claimSaveBusy: boolean;
  claimSaveError: string | null;
  setClaimSaveError: React.Dispatch<React.SetStateAction<string | null>>;
  forceSaveClaimedFile: () => Promise<void>;
  removeDeletedEntriesFromState: (deletedPaths: string[]) => void;
}

/**
 * 工作区编辑器标签页与文件生命周期管理 Hook
 */
export function useEditorTabs(options: UseEditorTabsOptions): UseEditorTabsReturn {
  const {
    workspaceDir,
    fs,
    team,
    readOnlyWorkspace,
    username,
    showToast,
    t,
    inferConflictSource,
    setDiffViewerPath,
    setWorkspaceView,
    setEditorAssistantVisible,
    onDeletedPaths,
  } = options;

  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [compareFilePath, setCompareFilePath] = useState<string | null>(null);
  const [previewModes, setPreviewModes] = useState<Record<string, FilePreviewMode>>({});
  const [claimSaveConfirmation, setClaimSaveConfirmation] = useState<{
    file: OpenFile;
    username: string;
  } | null>(null);
  const [claimSaveBusy, setClaimSaveBusy] = useState(false);
  const [claimSaveError, setClaimSaveError] = useState<string | null>(null);

  const openingPathsRef = useRef<Set<string>>(new Set());

  const activeFile = openFiles.find((f) => f.path === activeFilePath) || null;

  const activeClaim =
    activeFilePath && team.activeTeam
      ? team.activeTeam.claims.find((claim) => isSameWorkspacePath(claim.path, activeFilePath, workspaceDir)) || null
      : null;

  const activeCollaborators =
    activeFilePath && team.activeTeam
      ? team.activeTeam.presence.filter(
          (entry) =>
            entry.online &&
            entry.username !== username &&
            isSameWorkspacePath(entry.activeFilePath, activeFilePath, workspaceDir)
        )
      : [];

  const openFile = useCallback(
    async (rawPath: string) => {
      setWorkspaceView("files");
      if (typeof window !== "undefined" && window.innerWidth > 1180) {
        setEditorAssistantVisible(true);
      }
      const canonicalPath = normalizeWorkspaceRelativePath(rawPath, workspaceDir);
      if (!canonicalPath) return;

      // 1. 若文件已在打开列表中，直接激活并聚焦
      const existing = openFiles.find((f) => isSameWorkspacePath(f.path, canonicalPath, workspaceDir));
      if (existing) {
        setActiveFilePath(existing.path);
        return;
      }

      // 2. 检查是否有针对该文件的网络拉取正在进行中（防并发双击/多重触发）
      if (openingPathsRef.current.has(canonicalPath)) {
        return;
      }

      openingPathsRef.current.add(canonicalPath);
      try {
        const next = await fs.readFileWithMeta(canonicalPath);
        const name = canonicalPath.split("/").pop() || canonicalPath;
        const language = getLanguage(name);
        const newFile: OpenFile = {
          path: canonicalPath,
          name,
          content: next.content,
          language,
          modified: false,
          version: next.version,
          updatedAt: next.updatedAt,
          ...buildClearedRemoteState(),
        };

        // 3. 终极防线：原子更新二次去重，坚决杜绝重复标签与僵尸 DOM 节点
        setOpenFiles((prev) => {
          const alreadyOpen = prev.some((f) => isSameWorkspacePath(f.path, canonicalPath, workspaceDir));
          if (alreadyOpen) {
            return prev;
          }
          return [...prev, newFile];
        });
        setActiveFilePath(canonicalPath);
      } catch {
        showToast(t("app.failedToOpenFile"));
      } finally {
        openingPathsRef.current.delete(canonicalPath);
      }
    },
    [fs, openFiles, setEditorAssistantVisible, setWorkspaceView, showToast, t, workspaceDir]
  );

  const closeTab = useCallback(
    (rawPath: string) => {
      const canonicalPath = normalizeWorkspaceRelativePath(rawPath, workspaceDir);
      setOpenFiles((prev) => {
        const filtered = prev.filter((f) => !isSameWorkspacePath(f.path, canonicalPath, workspaceDir));
        setPreviewModes((current) => {
          const next = { ...current };
          for (const key of Object.keys(next)) {
            if (isSameWorkspacePath(key, canonicalPath, workspaceDir)) {
              delete next[key];
            }
          }
          return next;
        });
        if (isSameWorkspacePath(activeFilePath, canonicalPath, workspaceDir)) {
          setActiveFilePath(
            filtered.length > 0 ? filtered[filtered.length - 1].path : null
          );
        }
        if (isSameWorkspacePath(compareFilePath, canonicalPath, workspaceDir)) {
          setCompareFilePath(null);
        }
        return filtered;
      });
    },
    [activeFilePath, compareFilePath, workspaceDir]
  );

  const closeOtherTabs = useCallback(
    (keepPath: string) => {
      const canonicalKeep = normalizeWorkspaceRelativePath(keepPath, workspaceDir);
      setOpenFiles((prev) => {
        const filtered = prev.filter((f) => isSameWorkspacePath(f.path, canonicalKeep, workspaceDir));
        setActiveFilePath(canonicalKeep);
        if (compareFilePath && !isSameWorkspacePath(compareFilePath, canonicalKeep, workspaceDir)) {
          setCompareFilePath(null);
        }
        return filtered;
      });
    },
    [compareFilePath, workspaceDir]
  );

  const closeTabsToTheRight = useCallback(
    (targetPath: string) => {
      const canonicalTarget = normalizeWorkspaceRelativePath(targetPath, workspaceDir);
      setOpenFiles((prev) => {
        const targetIndex = prev.findIndex((f) => isSameWorkspacePath(f.path, canonicalTarget, workspaceDir));
        if (targetIndex === -1) return prev;
        const filtered = prev.slice(0, targetIndex + 1);
        if (!filtered.some((f) => isSameWorkspacePath(f.path, activeFilePath, workspaceDir))) {
          setActiveFilePath(canonicalTarget);
        }
        if (compareFilePath && !filtered.some((f) => isSameWorkspacePath(f.path, compareFilePath, workspaceDir))) {
          setCompareFilePath(null);
        }
        return filtered;
      });
    },
    [activeFilePath, compareFilePath, workspaceDir]
  );

  const closeAllTabs = useCallback(() => {
    setOpenFiles([]);
    setActiveFilePath(null);
    setCompareFilePath(null);
  }, []);

  const handleEditorChange = useCallback(
    (value: string) => {
      if (readOnlyWorkspace) return;
      if (!activeFilePath) return;
      setOpenFiles((prev) =>
        prev.map((f) =>
          f.path === activeFilePath
            ? { ...f, content: value, modified: true }
            : f
        )
      );
    },
    [activeFilePath, readOnlyWorkspace]
  );

  const saveFile = useCallback(async (): Promise<boolean> => {
    if (readOnlyWorkspace) {
      showToast(t("team.readOnlySaveBlocked"));
      return false;
    }
    const file = openFiles.find((f) => f.path === activeFilePath);
    if (!file) return false;
    if (activeClaim && activeClaim.username !== username) {
      setClaimSaveConfirmation({ file, username: activeClaim.username });
      return false;
    }
    try {
      const result = await fs.writeFile(
        file.path,
        file.content,
        Boolean(activeClaim && activeClaim.username !== username),
        file.version
      );
      setOpenFiles((prev) =>
        prev.map((f) =>
          f.path === activeFilePath
            ? {
                ...f,
                modified: false,
                version: result.version,
                updatedAt: result.updatedAt,
                ...buildClearedRemoteState(),
              }
            : f
        )
      );
      return true;
    } catch (error) {
      const claimError = error as Error & {
        code?: string;
        claim?: { username: string };
        current?: {
          content: string;
          version: string;
          updatedAt: number;
          source?: "team_member" | "external" | "assistant_tool" | "unknown";
          actor?: string;
        };
      };
      if (claimError.code === "FILE_VERSION_CONFLICT" && claimError.current) {
        const sourceInfo =
          claimError.current.source === "team_member" ||
          claimError.current.source === "assistant_tool" ||
          claimError.current.source === "external" ||
          claimError.current.source === "unknown"
            ? {
                source: claimError.current.source,
                actor: claimError.current.actor,
              }
            : inferConflictSource(file.path, {
                knownRemoteUpdatedAt: claimError.current?.updatedAt,
              });
        setOpenFiles((prev) =>
          prev.map((entry) =>
            entry.path === file.path
              ? {
                  ...entry,
                  remoteUpdated: true,
                  remoteContent: claimError.current?.content ?? entry.remoteContent,
                  remoteVersion: claimError.current?.version ?? entry.remoteVersion,
                  remoteUpdatedAt: claimError.current?.updatedAt ?? entry.remoteUpdatedAt,
                  remoteConflictReason: "save",
                  remoteConflictSource: sourceInfo.source,
                  remoteConflictActor: sourceInfo.actor,
                }
              : entry
          )
        );
        setDiffViewerPath(file.path);
        showToast(t("app.remoteConflictTitle"));
        return false;
      }
      if (claimError.code === "TEAM_CLAIM_CONFLICT" && claimError.claim?.username) {
        setClaimSaveConfirmation({ file, username: claimError.claim.username });
        return false;
      }
      showToast(t("app.failedToSaveFile"));
      return false;
    }
  }, [
    activeClaim,
    activeFilePath,
    fs,
    inferConflictSource,
    openFiles,
    readOnlyWorkspace,
    setDiffViewerPath,
    showToast,
    t,
    username,
  ]);

  const forceSaveClaimedFile = useCallback(async () => {
    const pending = claimSaveConfirmation;
    if (!pending) return;
    setClaimSaveBusy(true);
    setClaimSaveError(null);
    try {
      const result = await fs.writeFile(pending.file.path, pending.file.content, true, pending.file.version);
      setOpenFiles((current) =>
        current.map((file) =>
          file.path === pending.file.path
            ? {
                ...file,
                modified: false,
                version: result.version,
                updatedAt: result.updatedAt,
                ...buildClearedRemoteState(),
              }
            : file
        )
      );
      setClaimSaveConfirmation(null);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : t("app.failedToSaveFile");
      setClaimSaveError(message);
      showToast(message);
    } finally {
      setClaimSaveBusy(false);
    }
  }, [claimSaveConfirmation, fs, showToast, t]);

  const removeDeletedEntriesFromState = useCallback((deletedPaths: string[]) => {
    setOpenFiles((prev) => {
      const filtered = prev.filter(
        (file) =>
          !deletedPaths.some((deletedPath) =>
            isPathEqualOrDescendant(file.path, deletedPath)
          )
      );

      setPreviewModes((current) => {
        const next = { ...current };
        let changed = false;

        for (const previewPath of Object.keys(next)) {
          if (
            deletedPaths.some((deletedPath) =>
              isPathEqualOrDescendant(previewPath, deletedPath)
            )
          ) {
            delete next[previewPath];
            changed = true;
          }
        }

        return changed ? next : current;
      });

      setActiveFilePath((previousPath) => {
        if (
          previousPath &&
          deletedPaths.some((deletedPath) =>
            isPathEqualOrDescendant(previousPath, deletedPath)
          )
        ) {
          return filtered.length > 0 ? filtered[filtered.length - 1].path : null;
        }
        return previousPath;
      });

      return filtered;
    });

    onDeletedPaths?.(deletedPaths);
  }, [onDeletedPaths]);

  return {
    openFiles,
    setOpenFiles,
    activeFilePath,
    setActiveFilePath,
    compareFilePath,
    setCompareFilePath,
    previewModes,
    setPreviewModes,
    activeFile,
    activeClaim,
    activeCollaborators,
    openFile,
    closeTab,
    closeOtherTabs,
    closeTabsToTheRight,
    closeAllTabs,
    handleEditorChange,
    saveFile,
    claimSaveConfirmation,
    setClaimSaveConfirmation,
    claimSaveBusy,
    claimSaveError,
    setClaimSaveError,
    forceSaveClaimedFile,
    removeDeletedEntriesFromState,
  };
}
