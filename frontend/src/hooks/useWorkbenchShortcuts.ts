import React, { useEffect } from "react";
import { CommandPaletteMode } from "../components/CommandPalette";
import { OpenFile } from "../types";

export interface WorkbenchShortcutsOptions {
  activeFile: OpenFile | null;
  saveFile: () => Promise<boolean | void> | void | boolean;
  openCommandPalette: (mode: CommandPaletteMode) => void;
  setWorkspaceSearchScope: (scope: string) => void;
  setWorkspaceSearchVisible: React.Dispatch<React.SetStateAction<boolean>>;
  toggleUtilityPanel: (panel: "git" | "agents" | "checkpoints" | "problems" | "run-center" | "debug", forceOpen?: boolean) => void;
  toggleExplorerPanel: () => void;
  toggleChatPanel: () => void;
  toggleTerminalPanel: () => void;
  toggleFocusMode: () => void;
  setChatVisible: React.Dispatch<React.SetStateAction<boolean>>;
  setNewConversationRequest: React.Dispatch<React.SetStateAction<number>>;
  switchConversation: (direction: -1 | 1) => void;

  // Escape key cascade handlers
  commandPaletteVisible: boolean;
  setCommandPaletteVisible: (visible: boolean) => void;
  workspaceSearchVisible: boolean;
  settingsVisible: boolean;
  setSettingsVisible: (visible: boolean) => void;
  diffViewerPath: string | null;
  setDiffViewerPath: (path: string | null) => void;
  checkpointsVisible: boolean;
  setCheckpointsVisible: (visible: boolean) => void;
  runCenterVisible: boolean;
  setRunCenterVisible: (visible: boolean) => void;
  debugVisible: boolean;
  setDebugVisible: (visible: boolean) => void;
  problemsVisible: boolean;
  setProblemsVisible: (visible: boolean) => void;
  viewportWidth: number;
  editorAssistantVisible: boolean;
  setEditorAssistantVisible: (visible: boolean) => void;
  runDetailsVisible: boolean;
  setRunDetailsVisible: (visible: boolean) => void;
  workspaceDrawerOpen: boolean;
  closeWorkspaceDrawers: () => void;
}

/**
 * 工作台全局快捷键监听 Hook：
 * 统一管理 Ctrl/Cmd 组合键（保存、命令面板、全局搜索、切换面板、新会话等）及 Esc 级联关闭逻辑
 */
export function useWorkbenchShortcuts(options: WorkbenchShortcutsOptions): void {
  const {
    activeFile,
    saveFile,
    openCommandPalette,
    setWorkspaceSearchScope,
    setWorkspaceSearchVisible,
    toggleUtilityPanel,
    toggleExplorerPanel,
    toggleChatPanel,
    toggleTerminalPanel,
    toggleFocusMode,
    setChatVisible,
    setNewConversationRequest,
    switchConversation,
    commandPaletteVisible,
    setCommandPaletteVisible,
    workspaceSearchVisible,
    settingsVisible,
    setSettingsVisible,
    diffViewerPath,
    setDiffViewerPath,
    checkpointsVisible,
    setCheckpointsVisible,
    runCenterVisible,
    setRunCenterVisible,
    debugVisible,
    setDebugVisible,
    problemsVisible,
    setProblemsVisible,
    viewportWidth,
    editorAssistantVisible,
    setEditorAssistantVisible,
    runDetailsVisible,
    setRunDetailsVisible,
    workspaceDrawerOpen,
    closeWorkspaceDrawers,
  } = options;

  // Esc 键级联关闭顶层浮层 / 抽屉
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;

      if (commandPaletteVisible) {
        setCommandPaletteVisible(false);
        return;
      }
      if (workspaceSearchVisible) {
        setWorkspaceSearchVisible(false);
        return;
      }
      if (settingsVisible) {
        setSettingsVisible(false);
        return;
      }
      if (diffViewerPath) {
        setDiffViewerPath(null);
        return;
      }
      if (checkpointsVisible) {
        setCheckpointsVisible(false);
        return;
      }
      if (runCenterVisible) {
        setRunCenterVisible(false);
        return;
      }
      if (debugVisible) {
        setDebugVisible(false);
        return;
      }
      if (problemsVisible) {
        setProblemsVisible(false);
        return;
      }
      if (viewportWidth <= 1180 && editorAssistantVisible) {
        setEditorAssistantVisible(false);
        return;
      }
      if (viewportWidth <= 1180 && runDetailsVisible) {
        setRunDetailsVisible(false);
        return;
      }

      if (workspaceDrawerOpen) {
        closeWorkspaceDrawers();
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [
    commandPaletteVisible,
    setCommandPaletteVisible,
    workspaceSearchVisible,
    setWorkspaceSearchVisible,
    settingsVisible,
    setSettingsVisible,
    diffViewerPath,
    setDiffViewerPath,
    checkpointsVisible,
    setCheckpointsVisible,
    runCenterVisible,
    setRunCenterVisible,
    debugVisible,
    setDebugVisible,
    problemsVisible,
    setProblemsVisible,
    viewportWidth,
    editorAssistantVisible,
    setEditorAssistantVisible,
    runDetailsVisible,
    setRunDetailsVisible,
    workspaceDrawerOpen,
    closeWorkspaceDrawers,
  ]);

  // 全局动作快捷键 (Ctrl+S, Ctrl+P, Ctrl+Shift+F, Ctrl+B, Ctrl+J, Ctrl+`, Alt+N, Alt+Arrow 等)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isShortcut = e.metaKey || e.ctrlKey;
      if (isShortcut && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (activeFile && activeFile.modified) {
          void saveFile();
        }
        return;
      }
      if (isShortcut && e.key.toLowerCase() === "p") {
        e.preventDefault();
        openCommandPalette(e.shiftKey ? "commands" : "files");
        return;
      }
      if (isShortcut && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setWorkspaceSearchScope("");
        setWorkspaceSearchVisible(true);
        return;
      }
      if (isShortcut && e.shiftKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        toggleUtilityPanel("problems");
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        toggleExplorerPanel();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "j") {
        e.preventDefault();
        toggleChatPanel();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "`") {
        e.preventDefault();
        toggleTerminalPanel();
        return;
      }
      if (isShortcut && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggleFocusMode();
        return;
      }
      if (isShortcut && e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setChatVisible(true);
        setNewConversationRequest((value) => value + 1);
        return;
      }
      if (isShortcut && e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        switchConversation(-1);
        return;
      }
      if (isShortcut && e.altKey && e.key === "ArrowRight") {
        e.preventDefault();
        switchConversation(1);
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    activeFile,
    saveFile,
    openCommandPalette,
    setWorkspaceSearchScope,
    setWorkspaceSearchVisible,
    toggleUtilityPanel,
    toggleExplorerPanel,
    toggleChatPanel,
    toggleTerminalPanel,
    toggleFocusMode,
    setChatVisible,
    setNewConversationRequest,
    switchConversation,
  ]);
}
