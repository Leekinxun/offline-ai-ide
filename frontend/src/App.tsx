import React, { useState, useEffect, useCallback, useRef } from "react";
import * as monaco from "monaco-editor";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { Editor } from "./components/Editor";
import { ChatPanel } from "./components/ChatPanel";
import { StatusBar } from "./components/StatusBar";
import { Terminal } from "./components/Terminal";
import { LoginPage } from "./components/LoginPage";
import { SettingsModal } from "./components/SettingsModal";
import { BrandMark } from "./components/BrandMark";
import { useFileSystem } from "./hooks/useFileSystem";
import { useChat } from "./hooks/useChat";
import { useAuth } from "./hooks/useAuth";
import {
  DefinitionLocation,
  FileNode,
  FileSelectionRange,
  FileUpdate,
  OpenFile,
  SelectionInfo,
  getLanguage,
} from "./types";
import {
  PanelLeft,
  MessageSquare,
  TerminalSquare,
  LogOut,
  Settings,
  Moon,
  Sun,
} from "lucide-react";
import { useI18n } from "./i18n";
import {
  getMatchingFilePreviewRenderer,
  renderFilePreview,
} from "./plugins/runtime";
import type { FilePreviewMode } from "./plugins/types";
import "./App.css";

export default function App() {
  const { t } = useI18n();
  const auth = useAuth();
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("theme");
    return (saved as "light" | "dark") || "light";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === "light" ? "dark" : "light"));
  }, []);

  // Show loading while validating token
  if (auth.loading) {
    return (
      <div className="login-page">
        <div className="login-card" style={{ textAlign: "center", padding: 40 }}>
          <BrandMark
            size={56}
            title="AI IDE"
            subtitle={t("app.loadingWorkspace")}
            stacked
            className="loading-brand"
          />
        </div>
      </div>
    );
  }

  // Show login if not authenticated
  if (!auth.token || !auth.user) {
    return <LoginPage onLogin={auth.login} />;
  }

  return (
    <AuthenticatedApp
      token={auth.token}
      username={auth.user.username}
      workspaceDir={auth.user.workspaceDir}
      isAdmin={auth.user.isAdmin}
      onLogout={auth.logout}
      onChangeWorkspace={auth.changeWorkspace}
      theme={theme}
      onToggleTheme={toggleTheme}
    />
  );
}

interface AuthenticatedAppProps {
  token: string;
  username: string;
  workspaceDir: string;
  isAdmin: boolean;
  onLogout: () => void;
  onChangeWorkspace: (path: string) => Promise<boolean>;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}

interface EditorNavigationTarget extends FileSelectionRange {
  path: string;
  requestId: number;
}

interface EditorHighlightTarget extends FileSelectionRange {
  path: string;
  requestId: number;
}

function isPathEqualOrDescendant(candidate: string, target: string): boolean {
  return candidate === target || candidate.startsWith(`${target}/`);
}

function pruneNestedPaths(paths: string[]): string[] {
  const uniquePaths = Array.from(new Set(paths.filter(Boolean))).sort(
    (left, right) => left.length - right.length || left.localeCompare(right)
  );
  const pruned: string[] = [];

  for (const currentPath of uniquePaths) {
    if (pruned.some((path) => isPathEqualOrDescendant(currentPath, path))) {
      continue;
    }
    pruned.push(currentPath);
  }

  return pruned;
}

function AuthenticatedApp({
  token,
  username,
  workspaceDir,
  isAdmin,
  onLogout,
  onChangeWorkspace,
  theme,
  onToggleTheme,
}: AuthenticatedAppProps) {
  const { t } = useI18n();
  // --- State ---
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [chatVisible, setChatVisible] = useState(true);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [cursorPos, setCursorPos] = useState({ line: 1, column: 1 });
  const [toast, setToast] = useState<string | null>(null);
  const [selectionInfo, setSelectionInfo] = useState<SelectionInfo | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [chatWidth, setChatWidth] = useState(340);
  const [previewModes, setPreviewModes] = useState<Record<string, FilePreviewMode>>(
    {}
  );
  const [editorNavigationTarget, setEditorNavigationTarget] =
    useState<EditorNavigationTarget | null>(null);
  const [editorHighlightTarget, setEditorHighlightTarget] =
    useState<EditorHighlightTarget | null>(null);

  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const draggingRef = useRef<"sidebar" | "chat" | null>(null);
  const navigationRequestRef = useRef(0);
  const highlightRequestRef = useRef(0);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const fs = useFileSystem(token);

  // --- Toast ---
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);

  // --- Resize drag handling ---
  const handleResizeStart = useCallback(
    (panel: "sidebar" | "chat", e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = panel;
      startXRef.current = e.clientX;
      startWidthRef.current = panel === "sidebar" ? sidebarWidth : chatWidth;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [sidebarWidth, chatWidth]
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const delta = e.clientX - startXRef.current;
      if (draggingRef.current === "sidebar") {
        setSidebarWidth(Math.max(150, Math.min(500, startWidthRef.current + delta)));
      } else {
        setChatWidth(Math.max(250, Math.min(600, startWidthRef.current - delta)));
      }
    };
    const onMouseUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // --- Load file tree ---
  const loadTree = useCallback(async () => {
    try {
      const tree = await fs.fetchTree();
      setFileTree(tree);
    } catch {
      showToast(t("app.failedToLoadFileTree"));
    }
  }, [fs, showToast, t]);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  // Reset state when workspace changes
  useEffect(() => {
    setOpenFiles([]);
    setActiveFilePath(null);
    setPreviewModes({});
    setEditorNavigationTarget(null);
    setEditorHighlightTarget(null);
    loadTree();
  }, [loadTree, workspaceDir]);

  const applyFileUpdateToTabs = useCallback(
    (update: FileUpdate, ensureOpen: boolean) => {
      const name = update.path.split("/").pop() || update.path;
      const nextFile: OpenFile = {
        path: update.path,
        name,
        content: update.content,
        language: getLanguage(name),
        modified: false,
      };

      setOpenFiles((prev) => {
        const existingIndex = prev.findIndex((file) => file.path === update.path);
        if (existingIndex >= 0) {
          return prev.map((file) => (file.path === update.path ? nextFile : file));
        }
        return ensureOpen ? [...prev, nextFile] : prev;
      });
    },
    []
  );

  const handleAiFileUpdate = useCallback(
    (update: FileUpdate) => {
      applyFileUpdateToTabs(update, false);
      if (update.selection && activeFilePath === update.path) {
        highlightRequestRef.current += 1;
        setEditorHighlightTarget({
          path: update.path,
          requestId: highlightRequestRef.current,
          ...update.selection,
        });
      }
      void loadTree();
    },
    [activeFilePath, applyFileUpdateToTabs, loadTree]
  );

  const handleNavigateToFileUpdate = useCallback(
    (update: FileUpdate) => {
      applyFileUpdateToTabs(update, true);
      setActiveFilePath(update.path);
      void loadTree();

      if (!update.selection) return;
      navigationRequestRef.current += 1;
      setEditorNavigationTarget({
        path: update.path,
        requestId: navigationRequestRef.current,
        ...update.selection,
      });
    },
    [applyFileUpdateToTabs, loadTree]
  );

  const handleNavigationComplete = useCallback((requestId: number) => {
    setEditorNavigationTarget((prev) =>
      prev?.requestId === requestId ? null : prev
    );
  }, []);

  const handleHighlightComplete = useCallback((requestId: number) => {
    setEditorHighlightTarget((prev) =>
      prev?.requestId === requestId ? null : prev
    );
  }, []);

  const chat = useChat(token, workspaceDir, handleAiFileUpdate);

  // --- File operations ---
  const openFile = useCallback(
    async (path: string) => {
      const existing = openFiles.find((f) => f.path === path);
      if (existing) {
        setActiveFilePath(path);
        return;
      }

      try {
        const content = await fs.readFile(path);
        const name = path.split("/").pop() || path;
        const language = getLanguage(name);
        const newFile: OpenFile = {
          path,
          name,
          content,
          language,
          modified: false,
        };
        setOpenFiles((prev) => [...prev, newFile]);
        setActiveFilePath(path);
      } catch {
        showToast(t("app.failedToOpenFile"));
      }
    },
    [openFiles, fs, showToast, t]
  );

  const handleNavigateToLocation = useCallback(
    async (path: string, selection: FileSelectionRange) => {
      await openFile(path);
      navigationRequestRef.current += 1;
      setEditorNavigationTarget({
        path,
        requestId: navigationRequestRef.current,
        ...selection,
      });
    },
    [openFile]
  );

  const handleFindDefinition = useCallback(
    async (symbol: string, currentPath: string): Promise<DefinitionLocation | null> => {
      return fs.findDefinition(symbol, currentPath);
    },
    [fs]
  );

  const closeTab = useCallback(
    (path: string) => {
      setOpenFiles((prev) => {
        const filtered = prev.filter((f) => f.path !== path);
        setPreviewModes((current) => {
          if (!Object.prototype.hasOwnProperty.call(current, path)) {
            return current;
          }

          const next = { ...current };
          delete next[path];
          return next;
        });
        if (activeFilePath === path) {
          setActiveFilePath(
            filtered.length > 0 ? filtered[filtered.length - 1].path : null
          );
        }
        return filtered;
      });
    },
    [activeFilePath]
  );

  const handleEditorChange = useCallback(
    (value: string) => {
      if (!activeFilePath) return;
      setOpenFiles((prev) =>
        prev.map((f) =>
          f.path === activeFilePath
            ? { ...f, content: value, modified: true }
            : f
        )
      );
    },
    [activeFilePath]
  );

  const saveFile = useCallback(async () => {
    const file = openFiles.find((f) => f.path === activeFilePath);
    if (!file) return;
    try {
      await fs.writeFile(file.path, file.content);
      setOpenFiles((prev) =>
        prev.map((f) =>
          f.path === activeFilePath ? { ...f, modified: false } : f
        )
      );
      showToast(t("app.fileSaved"));
    } catch {
      showToast(t("app.failedToSaveFile"));
    }
  }, [activeFilePath, openFiles, fs, showToast, t]);

  const handleCreateEntry = useCallback(
    async (path: string, isDirectory: boolean) => {
      await fs.createEntry(path, isDirectory);
    },
    [fs]
  );

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

    setEditorNavigationTarget((prev) =>
      prev &&
      deletedPaths.some((deletedPath) =>
        isPathEqualOrDescendant(prev.path, deletedPath)
      )
        ? null
        : prev
    );

    setEditorHighlightTarget((prev) =>
      prev &&
      deletedPaths.some((deletedPath) =>
        isPathEqualOrDescendant(prev.path, deletedPath)
      )
        ? null
        : prev
    );
  }, []);

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

  const handleRenameEntry = useCallback(
    async (oldPath: string, newPath: string) => {
      await fs.renameEntry(oldPath, newPath);
      setPreviewModes((current) => {
        if (!Object.prototype.hasOwnProperty.call(current, oldPath)) {
          return current;
        }

        const next = { ...current, [newPath]: current[oldPath] };
        delete next[oldPath];
        return next;
      });
      setOpenFiles((prev) =>
        prev.map((f) =>
          f.path === oldPath
            ? {
                ...f,
                path: newPath,
                name: newPath.split("/").pop() || newPath,
                language: getLanguage(newPath.split("/").pop() || ""),
              }
            : f
        )
      );
      if (activeFilePath === oldPath) {
        setActiveFilePath(newPath);
      }
    },
    [fs, activeFilePath]
  );

  const handleDownloadEntry = useCallback(
    async (path: string, type: FileNode["type"]) => {
      const filename = await fs.downloadEntry(path, type);
      showToast(t("app.downloaded", { filename }));
    },
    [fs, showToast, t]
  );

  // --- Selection tracking ---
  const handleSelectionChange = useCallback(
    (selection: SelectionInfo | null) => {
      setSelectionInfo(selection);
    },
    []
  );

  // --- Chat: apply code to editor ---
  const handleApplyCode = useCallback(
    (code: string) => {
      if (!activeFilePath || !editorRef.current) {
        showToast(t("app.noFileOpenToApply"));
        return;
      }
      const editor = editorRef.current;
      const selection = editor.getSelection();
      if (selection && !selection.isEmpty()) {
        editor.executeEdits("ai-apply", [
          { range: selection, text: code, forceMoveMarkers: true },
        ]);
      } else {
        const model = editor.getModel();
        if (model) {
          const fullRange = model.getFullModelRange();
          editor.executeEdits("ai-apply", [
            { range: fullRange, text: code, forceMoveMarkers: true },
          ]);
        }
      }
      showToast(t("app.codeApplied"));
    },
    [activeFilePath, showToast, t]
  );

  // --- Chat: send with file + selection context ---
  const handleChatSend = useCallback(
    (message: string) => {
      const activeFile = openFiles.find((f) => f.path === activeFilePath);
      const context = activeFile
        ? {
            path: activeFile.path,
            content: activeFile.content,
            language: activeFile.language,
            selection: selectionInfo?.text,
          }
        : undefined;
      chat.sendMessage(message, context);
    },
    [chat, openFiles, activeFilePath, selectionInfo]
  );

  // --- Track cursor position ---
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const disposable = editor.onDidChangeCursorPosition((e) => {
      setCursorPos({ line: e.position.lineNumber, column: e.position.column });
    });
    return () => disposable.dispose();
  });

  // --- Handle workspace change ---
  const handleChangeWorkspace = useCallback(
    async (path: string) => {
      const ok = await onChangeWorkspace(path);
      if (ok) {
        showToast(t("app.workspaceChanged"));
      } else {
        showToast(t("app.failedToChangeWorkspace"));
      }
    },
    [onChangeWorkspace, showToast, t]
  );

  // --- Global keyboard shortcuts ---
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        setSidebarVisible((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "j") {
        e.preventDefault();
        setChatVisible((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "`") {
        e.preventDefault();
        setTerminalVisible((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // --- Derived ---
  const activeFile = openFiles.find((f) => f.path === activeFilePath) || null;
  const activePreviewRenderer = activeFile
    ? getMatchingFilePreviewRenderer({
        path: activeFile.path,
        content: activeFile.content,
        language: activeFile.language,
      })
    : null;
  const activePreviewMode =
    activeFile && activePreviewRenderer
      ? previewModes[activeFile.path] ||
        activePreviewRenderer.defaultMode ||
        "split"
      : "edit";
  const setActivePreviewMode = useCallback(
    (mode: FilePreviewMode) => {
      if (!activeFile) {
        return;
      }

      setPreviewModes((current) => ({
        ...current,
        [activeFile.path]: mode,
      }));
    },
    [activeFile]
  );
  const activePreviewContent =
    activeFile && activePreviewRenderer
      ? renderFilePreview(activePreviewRenderer, {
          path: activeFile.path,
          content: activeFile.content,
          language: activeFile.language,
          theme,
        })
      : null;

  return (
    <div className="app">
      {/* Title Bar */}
      <div className="titlebar">
        <div className="titlebar-left">
          <BrandMark
            size={22}
            title="AI IDE"
            subtitle={t("app.offline")}
            className="titlebar-brand"
          />
        </div>
        <div className="titlebar-right">
          <span className="user-badge">{username}</span>
          <button
            className={`titlebar-btn${settingsVisible ? " active" : ""}`}
            onClick={() => setSettingsVisible(true)}
            title={t("app.settings")}
          >
            <Settings size={17} />
          </button>
          <button
            className="titlebar-btn"
            onClick={onToggleTheme}
            title={
              theme === "light"
                ? t("app.switchToDarkTheme")
                : t("app.switchToLightTheme")
            }
          >
            {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
          </button>
          <button
            className={`titlebar-btn${sidebarVisible ? " active" : ""}`}
            onClick={() => setSidebarVisible((v) => !v)}
            title={t("app.toggleSidebar")}
          >
            <PanelLeft size={17} />
          </button>
          <button
            className={`titlebar-btn${terminalVisible ? " active" : ""}`}
            onClick={() => setTerminalVisible((v) => !v)}
            title={t("app.toggleTerminal")}
          >
            <TerminalSquare size={17} />
          </button>
          <button
            className={`titlebar-btn${chatVisible ? " active" : ""}`}
            onClick={() => setChatVisible((v) => !v)}
            title={t("app.toggleAiChat")}
          >
            <MessageSquare size={17} />
          </button>
          <button
            className="titlebar-btn"
            onClick={onLogout}
            title={t("app.logout")}
          >
            <LogOut size={17} />
          </button>
        </div>
      </div>

      <SettingsModal
        token={token}
        currentUsername={username}
        isAdmin={isAdmin}
        visible={settingsVisible}
        onClose={() => setSettingsVisible(false)}
        onShowToast={showToast}
      />

      {/* Main Layout */}
      <div className="main-layout">
        <Sidebar
          tree={fileTree}
          activeFilePath={activeFilePath}
          visible={sidebarVisible}
          onFileSelect={openFile}
          onCreateEntry={handleCreateEntry}
          onDeleteEntry={handleDeleteEntry}
          onDeleteEntries={handleDeleteEntries}
          onRenameEntry={handleRenameEntry}
          onDownloadEntry={handleDownloadEntry}
          onRefreshTree={loadTree}
          workspaceDir={workspaceDir}
          onChangeWorkspace={handleChangeWorkspace}
          token={token}
          style={sidebarVisible ? { width: sidebarWidth } : undefined}
        />

        <div
          className={`resize-handle${!sidebarVisible ? " hidden" : ""}${draggingRef.current === "sidebar" ? " dragging" : ""}`}
          onMouseDown={(e) => handleResizeStart("sidebar", e)}
        />

        <div className="editor-area">
          <TabBar
            openFiles={openFiles}
            activeFilePath={activeFilePath}
            onSelectTab={setActiveFilePath}
            onCloseTab={closeTab}
          />
          <div className="editor-main">
            {activeFile ? (
              activePreviewRenderer ? (
                <div className="editor-workbench">
                  <div className="editor-workbench-toolbar">
                    <div className="editor-workbench-segmented">
                      <button
                        type="button"
                        className={`editor-workbench-btn${
                          activePreviewMode === "edit" ? " active" : ""
                        }`}
                        onClick={() => setActivePreviewMode("edit")}
                        aria-pressed={activePreviewMode === "edit"}
                      >
                        {t("editor.modeEdit")}
                      </button>
                      <button
                        type="button"
                        className={`editor-workbench-btn${
                          activePreviewMode === "preview" ? " active" : ""
                        }`}
                        onClick={() => setActivePreviewMode("preview")}
                        aria-pressed={activePreviewMode === "preview"}
                      >
                        {t("editor.modePreview")}
                      </button>
                      <button
                        type="button"
                        className={`editor-workbench-btn${
                          activePreviewMode === "split" ? " active" : ""
                        }`}
                        onClick={() => setActivePreviewMode("split")}
                        aria-pressed={activePreviewMode === "split"}
                      >
                        {t("editor.modeSplit")}
                      </button>
                    </div>
                  </div>
                  <div
                    className={`editor-workbench-body mode-${activePreviewMode}`}
                  >
                    {activePreviewMode !== "preview" && (
                      <div className="editor-workbench-pane">
                        <Editor
                          content={activeFile.content}
                          language={activeFile.language}
                          path={activeFile.path}
                          theme={theme}
                          openFiles={openFiles}
                          onChange={handleEditorChange}
                          onSave={saveFile}
                          onSelectionChange={handleSelectionChange}
                          onNavigateToLocation={handleNavigateToLocation}
                          onFindDefinition={handleFindDefinition}
                          editorRef={editorRef}
                          navigationTarget={
                            editorNavigationTarget?.path === activeFile.path
                              ? editorNavigationTarget
                              : null
                          }
                          highlightTarget={
                            editorHighlightTarget?.path === activeFile.path
                              ? editorHighlightTarget
                              : null
                          }
                          onNavigationComplete={handleNavigationComplete}
                          onHighlightComplete={handleHighlightComplete}
                        />
                      </div>
                    )}
                    {activePreviewMode === "split" && (
                      <div className="editor-workbench-divider" />
                    )}
                    {activePreviewMode !== "edit" && (
                      <div className="editor-workbench-pane editor-preview-pane">
                        {activePreviewContent}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <Editor
                  content={activeFile.content}
                  language={activeFile.language}
                  path={activeFile.path}
                  theme={theme}
                  openFiles={openFiles}
                  onChange={handleEditorChange}
                  onSave={saveFile}
                  onSelectionChange={handleSelectionChange}
                  onNavigateToLocation={handleNavigateToLocation}
                  onFindDefinition={handleFindDefinition}
                  editorRef={editorRef}
                  navigationTarget={
                    editorNavigationTarget?.path === activeFile.path
                      ? editorNavigationTarget
                      : null
                  }
                  highlightTarget={
                    editorHighlightTarget?.path === activeFile.path
                      ? editorHighlightTarget
                      : null
                  }
                  onNavigationComplete={handleNavigationComplete}
                  onHighlightComplete={handleHighlightComplete}
                />
              )
            ) : (
              <div className="editor-empty">
                <BrandMark size={54} className="editor-empty-brand" />
                <span className="editor-empty-text">
                  {t("app.openFileToStart")}
                </span>
              </div>
            )}
          </div>
          <Terminal
            key={workspaceDir}
            visible={terminalVisible}
            token={token}
          />
        </div>

        <div
          className={`resize-handle${!chatVisible ? " hidden" : ""}${draggingRef.current === "chat" ? " dragging" : ""}`}
          onMouseDown={(e) => handleResizeStart("chat", e)}
        />

        <ChatPanel
          messages={chat.messages}
          currentConversationId={chat.currentConversationId}
          conversations={chat.conversations}
          isStreaming={chat.isStreaming}
          connected={chat.connected}
          visible={chatVisible}
          historyLoading={chat.historyLoading}
          historyLoadingId={chat.historyLoadingId}
          historyError={chat.historyError}
          selectionInfo={selectionInfo}
          activeFileName={activeFile?.name || null}
          onSend={handleChatSend}
          onClear={chat.clearMessages}
          onLoadConversation={chat.loadConversation}
          onRefreshConversations={chat.refreshConversations}
          onApplyCode={handleApplyCode}
          onNavigateToFileUpdate={handleNavigateToFileUpdate}
          style={chatVisible ? { width: chatWidth } : undefined}
        />
      </div>

      {/* Status Bar */}
      <StatusBar
        activeFile={
          activeFile
            ? { path: activeFile.path, language: activeFile.language }
            : null
        }
        cursorPosition={cursorPos}
        connected={chat.connected}
      />

      {/* Toast */}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
