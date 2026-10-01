import React, { lazy, Suspense, useState, useEffect, useCallback, useMemo, useRef } from "react";
import type * as monaco from "monaco-editor";
import { ChatPanel } from "./components/ChatPanel";
import { WorkbenchRightDock } from "./components/WorkbenchRightDock";
import { WorkbenchModals } from "./components/WorkbenchModals";
import type { DetailTab } from "./components/RunDetailsPanel";
import { WorkbenchSelect } from "./components/WorkbenchSelect";
import { StatusBar } from "./components/StatusBar";
import { Terminal } from "./components/Terminal";
import { LoginPage } from "./components/LoginPage";
import { LandingPage } from "./components/LandingPage";
import { BrandMark } from "./components/BrandMark";
import { TitleBar } from "./components/TitleBar";
import { ActivityRail } from "./components/ActivityRail";
import { WorkbenchLeftDock } from "./components/WorkbenchLeftDock";
import { WorkbenchEditorArea } from "./components/WorkbenchEditorArea";
import "./components/UserPopover.css";
import "./components/ActivityRail.css";
import "./components/Sidebar.css";
import "./components/CreateEntryDialog.css";
import { PRODUCT_NAME } from "./brand";
import type { CommandPaletteMode } from "./components/CommandPalette";
import { useModalDialogFocus } from "./components/useModalDialogFocus";
import type { DebugFrame } from "./hooks/useDebugger";
import { useEditorProblems } from "./hooks/useEditorProblems";
import { useEditorDiagnosticFeedback } from "./hooks/useEditorDiagnosticFeedback";
import { useRunChanges } from "./hooks/useRunChanges";
import type { RunReviewComment } from "./components/RunChangesReview";
import type { ContextReference } from "./types";
import { useFileSystem } from "./hooks/useFileSystem";
import type { WorkspaceSearchResult } from "./hooks/useFileSystem";
import { useAuth, type DesktopFolderPickResult } from "./hooks/useAuth";
import { useTeam } from "./hooks/useTeam";
import { usePlatformEnvironment } from "./hooks/usePlatformEnvironment";
import { useGlobalZoom } from "./hooks/useGlobalZoom";
import {
  usePanelLayout,
  FILES_ACTIVITY_WIDTH,
  FILES_HANDLE_WIDTH,
  FILES_EDITOR_MIN_WIDTH,
  FILES_SIDEBAR_MIN_WIDTH,
  FILES_SIDEBAR_MAX_WIDTH,
  FILES_ASSISTANT_MIN_WIDTH,
  FILES_ASSISTANT_MAX_WIDTH,
} from "./hooks/usePanelLayout";
import { useWorkbenchShortcuts } from "./hooks/useWorkbenchShortcuts";
import { useEditorTabs } from "./hooks/useEditorTabs";
import { useWorkspaceFiles } from "./hooks/useWorkspaceFiles";
import { useEditorSync } from "./hooks/useEditorSync";
import { useWorkspacePanels } from "./hooks/useWorkspacePanels";
import { useWorkbenchChat } from "./hooks/useWorkbenchChat";
import {
  normalizeWorkspaceRelativePath,
  isSameWorkspacePath,
  isPathEqualOrDescendant,
  remapMovedPath,
  pruneNestedPaths,
  collectVisiblePaths,
  isReadOnlyTeamRole,
  isDebuggablePath,
  buildClearedRemoteState,
} from "./utils/workspacePaths";
import {
  DefinitionLocation,
  FileNode,
  FileSelectionRange,
  FileUpdate,
  OpenFile,
  ReferenceLocation,
  SelectionInfo,
  TeamRole,
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
  Command,
  GitBranch,
  Bot,
  CircleAlert,
  ChevronRight,
  Columns2,
  FileCode2,
  Files,
  ShieldCheck,
  Bug,
  Users,
  X,
  Link2,
  Unlink2,
  Play,
  Search,
  Maximize2,
  Minimize2,
  FolderOpen,
} from "lucide-react";
import { useI18n } from "./i18n";
import {
  getMatchingFilePreviewRenderer,
  renderFilePreview,
} from "./plugins/runtime";
import type { FilePreviewMode } from "./plugins/types";
import "./App.css";
import { getEditorThemeName } from "./editor/themeNames";
import { DEFAULT_EDITOR_FONT_FAMILY, DEFAULT_EDITOR_FONT_OPTIONS } from "./editor/fontDefaults";
const MobileApp = lazy(() =>
  import("./mobile/MobileApp").then((module) => ({ default: module.MobileApp }))
);

const EDITOR_FONT_OPTIONS = [
  {
    label: "VS Code default",
    family: DEFAULT_EDITOR_FONT_FAMILY,
  },
  {
    label: "SF Mono",
    family: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
  },
  {
    label: "JetBrains Mono",
    family: "'JetBrains Mono', 'SF Mono', 'Menlo', 'Monaco', monospace",
  },
  {
    label: "Fira Code",
    family: "'Fira Code', 'SF Mono', 'Menlo', 'Monaco', monospace",
  },
  {
    label: "Cascadia Code",
    family: "'Cascadia Code', 'SF Mono', 'Menlo', 'Monaco', monospace",
  },
  {
    label: "Monaco",
    family: "'Monaco', 'Menlo', 'Courier New', monospace",
  },
];

export default function App() {
  if (window.location.pathname === "/mobile" || window.location.pathname.startsWith("/mobile/")) {
    return <Suspense fallback={null}><MobileApp /></Suspense>;
  }
  return <DesktopApp />;
}

function DesktopApp() {
  const { t } = useI18n();
  const auth = useAuth();
  const platform = usePlatformEnvironment(auth.user?.desktop);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("theme");
    return (saved as "light" | "dark") || "light";
  });
  const [editorFont, setEditorFont] = useState(() => {
    const saved = localStorage.getItem("editorFont");
    return saved || EDITOR_FONT_OPTIONS[0].family;
  });
  const [publicView, setPublicView] = useState<"landing" | "login">(() =>
    window.location.pathname === "/login" ? "login" : "landing"
  );
  const [sessionExpired, setSessionExpired] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.setAttribute("data-os", platform.os);
    document.documentElement.setAttribute("data-platform", platform.host);
    localStorage.setItem("theme", theme);
  }, [theme, platform.os, platform.host]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === "light" ? "dark" : "light"));
  }, []);

  const changeEditorFont = useCallback((fontFamily: string) => {
    setEditorFont(fontFamily);
    localStorage.setItem("editorFont", fontFamily);
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      const view = window.location.pathname === "/login" ? "login" : "landing";
      setPublicView(view);
      if (view === "landing") setSessionExpired(false);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const showPublicView = useCallback((view: "landing" | "login") => {
    const path = view === "login" ? "/login" : "/";
    window.history.pushState({}, "", path);
    setPublicView(view);
    if (view === "landing") setSessionExpired(false);
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  const endSession = useCallback((expired: boolean) => {
    setSessionExpired(expired);
    auth.logout();
    window.history.replaceState({}, "", "/login");
    setPublicView("login");
  }, [auth.logout]);
  const handleLogout = useCallback(() => endSession(false), [endSession]);
  const handleSessionExpired = useCallback(() => endSession(true), [endSession]);

  // Show loading while validating token
  if (auth.loading && auth.token) {
    return (
      <div className="login-page">
        <div className="login-card" style={{ textAlign: "center", padding: 40 }}>
          <BrandMark
            size={56}
            title={PRODUCT_NAME}
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
    if (publicView === "landing") {
      return (
        <LandingPage
          theme={theme}
          onToggleTheme={toggleTheme}
          onEnter={() => showPublicView("login")}
        />
      );
    }
    return (
      <LoginPage
        onLogin={async (username, password) => {
          setSessionExpired(false);
          return auth.login(username, password);
        }}
        onRegister={auth.register}
        onBack={() => showPublicView("landing")}
        initialError={sessionExpired ? t("login.sessionExpired") : undefined}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
    );
  }

  return (
    <AuthenticatedApp
      token={auth.token}
      username={auth.user.username}
      workspaceDir={auth.user.workspaceDir}
      isAdmin={auth.user.isAdmin}
      isolatedWindow={auth.user.isolated}
      desktopApp={auth.user.desktop}
      onLogout={handleLogout}
      onSessionExpired={handleSessionExpired}
      onChangeWorkspace={auth.changeWorkspace}
      onPickDesktopWorkspace={auth.pickDesktopWorkspace}
      theme={theme}
      onToggleTheme={toggleTheme}
      editorFont={editorFont}
      editorFontOptions={EDITOR_FONT_OPTIONS}
      onEditorFontChange={changeEditorFont}
    />
  );
}

interface AuthenticatedAppProps {
  token: string;
  username: string;
  workspaceDir: string;
  isAdmin: boolean;
  isolatedWindow: boolean;
  desktopApp: boolean;
  onLogout: () => void;
  onSessionExpired: () => void;
  onChangeWorkspace: (path: string) => Promise<boolean>;
  onPickDesktopWorkspace: () => Promise<DesktopFolderPickResult>;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  editorFont: string;
  editorFontOptions: typeof EDITOR_FONT_OPTIONS;
  onEditorFontChange: (fontFamily: string) => void;
}

interface EditorNavigationTarget extends FileSelectionRange {
  path: string;
  requestId: number;
}

interface EditorHighlightTarget extends FileSelectionRange {
  path: string;
  requestId: number;
}



function AuthenticatedApp({
  token,
  username,
  workspaceDir,
  isAdmin,
  isolatedWindow,
  desktopApp,
  onLogout,
  onSessionExpired,
  onChangeWorkspace,
  onPickDesktopWorkspace,
  theme,
  onToggleTheme,
  editorFont,
  editorFontOptions,
  onEditorFontChange,
}: AuthenticatedAppProps) {
  const { t } = useI18n();
  const platform = usePlatformEnvironment(desktopApp);
  const editorProblems = useEditorProblems();
  // --- State ---
  const [compareScrollLinked, setCompareScrollLinked] = useState(true);
  const [compareEditorMountVersion, setCompareEditorMountVersion] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [isFullscreen, setIsFullscreen] = useState(() => Boolean(typeof document !== "undefined" && document.fullscreenElement));

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }, []);

  const [workspaceView, setWorkspaceView] = useState<"chat" | "files">("files");
  const mainLayoutRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const compareEditorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const previewPaneRef = useRef<HTMLDivElement | null>(null);
  const navigationRequestRef = useRef(0);
  const highlightRequestRef = useRef(0);
  const editorViewStatesRef = useRef<
    Record<string, monaco.editor.ICodeEditorViewState | null>
  >({});

  const {
    sidebarVisible,
    setSidebarVisible,
    chatVisible,
    setChatVisible,
    terminalVisible,
    setTerminalVisible,
    teamVisible,
    setTeamVisible,
    runDetailsVisible,
    setRunDetailsVisible,
    runDetailsTab,
    setRunDetailsTab,
    editorAssistantVisible,
    setEditorAssistantVisible,
    chatFocusNonce,
    setChatFocusNonce,
    gitVisible,
    setGitVisible,
    agentsVisible,
    setAgentsVisible,
    checkpointsVisible,
    setCheckpointsVisible,
    problemsVisible,
    setProblemsVisible,
    runCenterVisible,
    setRunCenterVisible,
    debugVisible,
    setDebugVisible,
    settingsVisible,
    setSettingsVisible,
    chatHistoryRequest,
    newConversationRequest,
    setNewConversationRequest,
    isLeftDockOpen,
    compactWorkspace,
    isMobileViewport,
    activeWorkspaceDrawer,
    workspaceDrawerOpen,
    closeUtilityPanels,
    toggleFocusMode,
    focusChat,
    toggleChatPanel,
    handleToggleAiAssistant,
    toggleExplorerPanel,
    toggleUtilityPanel,
    toggleTeamPanel,
    toggleTerminalPanel,
    closeWorkspaceDrawers,
    runPaletteCommand,
  } = useWorkspacePanels({
    viewportWidth,
    workspaceView,
    setWorkspaceView,
    mainLayoutRef,
    onFormatDocument: useCallback(() => {
      void editorRef.current?.getAction("format-python-document")?.run();
    }, []),
  });

  const [folderOpenRequestId, setFolderOpenRequestId] = useState(0);
  const [commandPaletteMode, setCommandPaletteMode] = useState<CommandPaletteMode>("commands");
  const [commandPaletteVisible, setCommandPaletteVisible] = useState(false);
  const [workspaceSearchVisible, setWorkspaceSearchVisible] = useState(false);
  const [workspaceSearchScope, setWorkspaceSearchScope] = useState("");
  const [gitDiffRequest, setGitDiffRequest] = useState<{ path: string; id: number; runId?: string } | null>(null);
  const [webPreviewVisible, setWebPreviewVisible] = useState(false);

  const handleToggleWebPreview = useCallback(() => {
    setWebPreviewVisible((prev) => {
      const next = !prev;
      if (next && workspaceView === "files") {
        setEditorAssistantVisible(false);
        setRunDetailsVisible(false);
      }
      return next;
    });
  }, [workspaceView, setEditorAssistantVisible, setRunDetailsVisible]);

  const handleToggleAiAssistantWithMutualExclusion = useCallback(() => {
    if (workspaceView === "files") {
      setWebPreviewVisible(false);
    }
    handleToggleAiAssistant();
  }, [workspaceView, handleToggleAiAssistant]);
  const [confirmWorkspaceSwitch, setConfirmWorkspaceSwitch] = useState(false);
  const [breakpointsByPath, setBreakpointsByPath] = useState<Record<string, number[]>>({});
  const [debugStartRequest, setDebugStartRequest] = useState<{ id: number; path: string } | null>(null);
  const [debugActiveFrame, setDebugActiveFrame] = useState<DebugFrame | null>(null);
  const [problemCounts, setProblemCounts] = useState({ errors: 0, warnings: 0 });
  const [activeRunLabel, setActiveRunLabel] = useState<string | null>(null);
  const [mobilePairingVisible, setMobilePairingVisible] = useState(false);
  const [diffViewerPath, setDiffViewerPath] = useState<string | null>(null);
  const [cursorPos, setCursorPos] = useState({ line: 1, column: 1 });
  const [toast, setToast] = useState<string | null>(null);
  const [pickingWorkspace, setPickingWorkspace] = useState(false);
  const pickingWorkspaceRef = useRef(false);
  const [selectionInfo, setSelectionInfo] = useState<SelectionInfo | null>(null);
  const [editorNavigationTarget, setEditorNavigationTarget] =
    useState<EditorNavigationTarget | null>(null);
  const [editorHighlightTarget, setEditorHighlightTarget] =
    useState<EditorHighlightTarget | null>(null);
  const [referenceResult, setReferenceResult] = useState<{ symbol: string; references: ReferenceLocation[] } | null>(null);
  const fs = useFileSystem(token);

  useEffect(() => {
    setBreakpointsByPath({});
    setDebugStartRequest(null);
  }, [workspaceDir]);

  // --- Toast ---
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);

  const { zoomLevel, zoomPercent, zoomIn, zoomOut, resetZoom, setZoom } = useGlobalZoom(showToast);

  const team = useTeam(token, workspaceDir, (nextWorkspace) => {
    if (nextWorkspace !== workspaceDir) {
      void onChangeWorkspace(nextWorkspace);
    }
  });
  const readOnlyWorkspace = isReadOnlyTeamRole(team.activeTeam?.role);

  const inferConflictSource = useCallback(
    (
      path: string,
      options?: {
        preferredActor?: string;
        knownRemoteUpdatedAt?: number;
      }
    ): { source: "team_member" | "external" | "unknown"; actor?: string } => {
      const preferredActor = options?.preferredActor?.trim();
      if (preferredActor && preferredActor !== username) {
        return { source: "team_member", actor: preferredActor };
      }

      const activeTeam = team.activeTeam;
      if (!activeTeam) {
        return { source: "external", actor: undefined };
      }

      const matchingClaim = activeTeam.claims.find(
        (claim) => claim.path === path && claim.username !== username
      );
      if (matchingClaim) {
        return { source: "team_member", actor: matchingClaim.username };
      }

      const matchingPresence = activeTeam.presence.find(
        (entry) =>
          entry.online &&
          entry.username !== username &&
          entry.activeFilePath === path
      );
      if (matchingPresence) {
        return { source: "team_member", actor: matchingPresence.username };
      }

      const matchingActivity = activeTeam.activity.find((entry) => {
        const payloadPath =
          entry.payload && typeof entry.payload.path === "string"
            ? entry.payload.path
            : undefined;
        return (
          entry.type === "file_saved" &&
          entry.username !== username &&
          payloadPath === path &&
          (typeof options?.knownRemoteUpdatedAt !== "number" ||
            Math.abs(entry.createdAt - options.knownRemoteUpdatedAt) < 10_000)
        );
      });
      if (matchingActivity) {
        return { source: "team_member", actor: matchingActivity.username };
      }

      const hasOtherOnlineMembers = activeTeam.presence.some(
        (entry) => entry.online && entry.username !== username
      );
      if (hasOtherOnlineMembers) {
        return { source: "unknown", actor: undefined };
      }

      return { source: "external", actor: undefined };
    },
    [team.activeTeam, username]
  );

  const {
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
  } = useEditorTabs({
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
    onDeletedPaths: useCallback((deletedPaths: string[]) => {
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
    }, []),
  });

  const {
    fileTree,
    setFileTree,
    treeRefreshNonce,
    setTreeRefreshNonce,
    lastWorkspaceMtimeRef,
    loadTree,
    handleCreateEntry,
    handleCopyEntry,
    handleDeleteEntry,
    handleDeleteEntries,
    updateMovedPathsInEditor,
    handleRenameEntry,
    handleMoveEntry,
    handleDownloadEntry,
    handleUploadEntries,
  } = useWorkspaceFiles({
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
  });

  useEffect(() => {
    setReferenceResult(null);
  }, [activeFilePath]);

  const {
    sidebarWidth,
    setSidebarWidth,
    assistantWidth,
    setAssistantWidth,
    chatWidth,
    setChatWidth,
    terminalHeight,
    setTerminalHeight,
    draggingPanel,
    sidebarMaxWidth,
    assistantMaxWidth,
    effectiveSidebarWidth,
    fileDockWidth,
    chatDockWidth,
    effectiveAssistantWidth,
    handleResizeStart,
    handlePanelResizeKeyDown,
    handleTerminalResizeStart,
    handleTerminalResizeKeyDown,
    adjustTerminalHeight,
  } = usePanelLayout({
    viewportWidth,
    isLeftDockOpen,
    runDetailsVisible,
    editorAssistantVisible,
    webPreviewVisible,
    mainLayoutRef,
  });

  useEffect(() => {
    const handleViewportResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", handleViewportResize);
    return () => window.removeEventListener("resize", handleViewportResize);
  }, []);

  const openCommandPalette = useCallback((mode: CommandPaletteMode) => {
    setCommandPaletteMode(mode);
    setCommandPaletteVisible(true);
  }, []);




  const handleEditorViewStateChange = useCallback(
    (path: string, viewState: monaco.editor.ICodeEditorViewState | null) => {
      editorViewStatesRef.current[path] = viewState;
    },
    []
  );



  useEffect(() => {
    loadTree();
  }, [loadTree]);

  // Reset state when workspace changes
  useEffect(() => {
    setOpenFiles([]);
    setActiveFilePath(null);
    setPreviewModes({});
    setProblemCounts({ errors: 0, warnings: 0 });
    setActiveRunLabel(null);
    editorViewStatesRef.current = {};
    setEditorNavigationTarget(null);
    setEditorHighlightTarget(null);
    setWebPreviewVisible(false);
    loadTree();
  }, [loadTree, workspaceDir]);

  const handleWorkspaceRestored = useCallback(async () => {
    setOpenFiles([]);
    setActiveFilePath(null);
    setCompareFilePath(null);
    setTreeRefreshNonce((value) => value + 1);
    await loadTree();
  }, [loadTree]);

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

  const {
    chat,
    chatAttachmentDraft,
    chatDraftText,
    setChatDraftText,
    contextReferences,
    setContextReferences,
    attachmentSubmissionError,
    attachmentSubmissionNotice,
    pendingAttachmentVerificationIds,
    attachmentWarning,
    editedRetryNotice,
    clearChatConversation,
    loadChatConversation,
    switchConversation,
    handleApplyCode,
    handleChatSend,
    handleChatSteer,
    handleGitReview,
    handleNavigateToFileUpdate,
  } = useWorkbenchChat({
    token,
    workspaceDir,
    readOnlyWorkspace,
    activeFilePath,
    openFiles,
    setOpenFiles,
    setActiveFilePath,
    setWorkspaceView,
    setEditorHighlightTarget,
    setEditorNavigationTarget,
    highlightRequestRef,
    navigationRequestRef,
    editorRef,
    selectionInfo,
    fs,
    loadTree,
    focusChat,
    showToast,
    t,
    workspaceView,
    setRunDetailsVisible,
    setEditorAssistantVisible,
  });

  useEditorDiagnosticFeedback({ token, workspaceDir, file: activeFile, problems: editorProblems.problems, enabled: !readOnlyWorkspace });
  const changeReviewRunning = chat.runState?.status === "running" || chat.runState?.status === "queued";
  const editorChanges = useRunChanges({
    token,
    workspaceDir,
    runId: workspaceView === "files" && activeFile && chat.runState?.mode === "code" ? chat.runState.runId : undefined,
    running: changeReviewRunning,
    refreshKey: `${chat.runState?.status}:${chat.runState?.events.length || 0}`,
    onChanged: () => void handleWorkspaceRestored(),
  });
  useEffect(() => {
    editorChanges.setSelectedPath(
      activeFilePath && editorChanges.changes?.files.some((file) => file.path === activeFilePath)
        ? activeFilePath
        : null
    );
  }, [activeFilePath, editorChanges.changes?.revision, editorChanges.setSelectedPath]);

  const handleReviewComment = useCallback(
    (comment: RunReviewComment) => {
      const reference = `${comment.path}:${comment.startLine}-${comment.endLine} (${comment.side || "modified"}, revision ${comment.revision})`;
      setChatDraftText((current) => [current.trim(), `${reference}\n${comment.text}`].filter(Boolean).join("\n\n"));
      setContextReferences((current) =>
        current.some((item) => item.kind === "file" && item.path === comment.path)
          ? current
          : [...current, { kind: "file" as const, path: comment.path }].slice(-16)
      );
      if (workspaceView === "files") {
        setRunDetailsVisible(false);
        setEditorAssistantVisible(true);
      } else {
        setChatVisible(true);
      }
    },
    [workspaceView, setChatDraftText, setContextReferences, setEditorAssistantVisible, setRunDetailsVisible, setChatVisible]
  );

  const handleUndoLastTurn = useCallback(async () => {
    const users = chat.messages.filter((message) => message.role === "user" && message.requestId);
    const last = users[users.length - 1];
    const runId = chat.runState?.runId;
    const conversationId = chat.currentConversationId;
    if (chat.isStreaming || readOnlyWorkspace || !last?.requestId || !runId || !conversationId) {
      throw new Error(t("undoTurn.unavailable"));
    }
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Workspace-Dir": encodeURIComponent(workspaceDir),
    };
    const response = await fetch(
      `/api/chat/runs/${encodeURIComponent(runId)}/changes?requestId=${encodeURIComponent(last.requestId)}`,
      { headers }
    );
    const evidence = await response.json();
    if (!response.ok || !evidence.files?.length || evidence.unavailableReason) {
      throw new Error(evidence.error || t("undoTurn.unavailable"));
    }
    const reverted = await fetch(`/api/chat/runs/${encodeURIComponent(runId)}/revert`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: last.requestId,
        expectedRevision: evidence.revision,
        expectedWorkspace: workspaceDir,
        forkBeforeRequest: true,
      }),
    });
    const payload = await reverted.json();
    await handleWorkspaceRestored();
    if (!reverted.ok) throw new Error(payload.error || t("undoTurn.failed"));
    if (!payload.conversation?.id) throw new Error(t("undoTurn.failed"));
    if (chat.currentConversationId === conversationId) {
      await chat.loadConversation(payload.conversation.id);
      showToast(t("undoTurn.done"));
    }
    await chat.refreshConversations();
  }, [chat, handleWorkspaceRestored, readOnlyWorkspace, showToast, t, token, workspaceDir]);


  const getConflictSourceMessage = useCallback(
    (file: OpenFile): string | null => {
      if (file.remoteConflictSource === "team_member") {
        return file.remoteConflictActor
          ? t("app.conflictSourceTeamMember", {
              username: file.remoteConflictActor,
            })
          : t("app.conflictSourceTeamMemberUnknown");
      }
      if (file.remoteConflictSource === "external") {
        return t("app.conflictSourceExternal");
      }
      if (file.remoteConflictSource === "assistant_tool") {
        return t("app.conflictSourceAssistantTool", {
          actor: file.remoteConflictActor ? ` (${file.remoteConflictActor})` : "",
        });
      }
      if (file.remoteConflictSource === "unknown") {
        return t("app.conflictSourceUnknown");
      }
      return null;
    },
    [t]
  );

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    const pollWorkspaceChanges = async () => {
      try {
        const result = await fs.fetchChanges(lastWorkspaceMtimeRef.current);
        if (cancelled) {
          return;
        }

        if (result.changed) {
          lastWorkspaceMtimeRef.current = result.latestMtime;
          const currentActivePath = activeFilePath;
          const currentOpenFiles = openFiles;
          await loadTree();

          if (currentActivePath) {
            try {
              const next = await fs.readFileWithMeta(currentActivePath);
              if (cancelled) {
                return;
              }
              setOpenFiles((prev) =>
                prev.map((file) =>
                  file.path === currentActivePath && !file.modified
                    ? {
                        ...file,
                        content: next.content,
                        version: next.version,
                        updatedAt: next.updatedAt,
                        ...buildClearedRemoteState(),
                      }
                    : file.path === currentActivePath &&
                        file.modified &&
                        file.content !== next.content
                      ? (() => {
                          if (file.remoteContent === next.content) {
                            return file;
                          }
                          const sourceInfo =
                            next.source === "team_member" ||
                            next.source === "assistant_tool" ||
                            next.source === "external" ||
                            next.source === "unknown"
                              ? {
                                  source: next.source,
                                  actor: next.actor,
                                }
                              : inferConflictSource(currentActivePath, {
                                  knownRemoteUpdatedAt: next.updatedAt,
                                });
                          return {
                            ...file,
                            remoteUpdated: true,
                            remoteContent: next.content,
                            remoteVersion: next.version,
                            remoteUpdatedAt: next.updatedAt,
                            remoteConflictReason: "background",
                            remoteConflictSource: sourceInfo.source,
                            remoteConflictActor: sourceInfo.actor,
                          };
                        })()
                    : file
                )
              );
            } catch {
              // ignore missing active file during polling
            }
          }

          for (const file of currentOpenFiles) {
            if (file.path === currentActivePath) {
              continue;
            }
            try {
              const next = await fs.readFileWithMeta(file.path);
              if (cancelled) {
                return;
              }
              setOpenFiles((prev) =>
                prev.map((entry) =>
                  entry.path === file.path && !entry.modified
                    ? {
                        ...entry,
                        content: next.content,
                        version: next.version,
                        updatedAt: next.updatedAt,
                        ...buildClearedRemoteState(),
                      }
                    : entry.path === file.path &&
                        entry.modified &&
                        entry.content !== next.content
                      ? entry.remoteContent === next.content
                        ? {
                            ...entry,
                          }
                        : (() => {
                            const sourceInfo =
                              next.source === "team_member" ||
                              next.source === "assistant_tool" ||
                              next.source === "external" ||
                              next.source === "unknown"
                                ? {
                                    source: next.source,
                                    actor: next.actor,
                                  }
                                : inferConflictSource(file.path, {
                                    knownRemoteUpdatedAt: next.updatedAt,
                                  });
                            return {
                              ...entry,
                              remoteUpdated: true,
                              remoteContent: next.content,
                              remoteVersion: next.version,
                              remoteUpdatedAt: next.updatedAt,
                              remoteConflictReason: "background",
                              remoteConflictSource: sourceInfo.source,
                              remoteConflictActor: sourceInfo.actor,
                            };
                          })()
                    : entry
                )
              );
            } catch {
              // ignore deleted file during polling; tree refresh handles visibility
            }
          }
        } else {
          lastWorkspaceMtimeRef.current = Math.max(
            lastWorkspaceMtimeRef.current,
            result.latestMtime
          );
        }
      } catch {
        // best effort polling only
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(pollWorkspaceChanges, 1500);
        }
      }
    };

    timer = window.setTimeout(pollWorkspaceChanges, 1500);
    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [activeFilePath, fs, inferConflictSource, loadTree, openFiles]);



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

  const openSearchResult = useCallback(
    (result: WorkspaceSearchResult) => {
      void handleNavigateToLocation(result.path, {
        startLine: result.line,
        startColumn: result.column,
        endLine: result.line,
        endColumn: result.column + result.matchLength,
      });
    },
    [handleNavigateToLocation]
  );

  const handleFindDefinition = useCallback(
    async (symbol: string, currentPath: string): Promise<DefinitionLocation | null> => {
      return fs.findDefinition(symbol, currentPath);
    },
    [fs]
  );

  const handleFindReferences = useCallback(
    async (symbol: string, currentPath: string): Promise<ReferenceLocation[]> =>
      fs.findReferences(symbol, currentPath),
    [fs]
  );

  const handleReferencesFound = useCallback((symbol: string, references: ReferenceLocation[]) => {
    setReferenceResult({ symbol, references });
  }, []);



  const formatPythonDocument = useCallback(
    async (path: string, content: string): Promise<string> => {
      try {
        const result = await fs.formatPythonDocument(path, content);
        showToast(t(result.changed ? "app.fileFormatted" : "app.fileAlreadyFormatted"));
        return result.content;
      } catch (error) {
        showToast(t("app.failedToFormatFile", {
          error: error instanceof Error ? error.message : String(error),
        }));
        throw error;
      }
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


  const handleReloadRemoteVersion = useCallback(() => {
    if (!activeFilePath) return;
    setOpenFiles((prev) =>
      prev.map((file) =>
        file.path === activeFilePath
          ? {
              ...file,
              content: file.remoteContent ?? file.content,
              modified: false,
              version: file.remoteVersion ?? file.version,
              updatedAt: file.remoteUpdatedAt ?? file.updatedAt,
              ...buildClearedRemoteState(),
            }
          : file
      )
    );
    setDiffViewerPath(null);
    showToast(t("app.remoteVersionLoaded"));
  }, [activeFilePath, showToast, t]);

  const handleKeepLocalVersion = useCallback(() => {
    if (!activeFilePath) return;
    setOpenFiles((prev) =>
      prev.map((file) =>
        file.path === activeFilePath
          ? {
              ...file,
              remoteUpdated: false,
            }
          : file
      )
    );
    setDiffViewerPath(null);
    showToast(t("app.localVersionKept"));
  }, [activeFilePath, showToast, t]);

  const handleForceSaveAfterVersionConflict = useCallback(async () => {
    if (!activeFilePath) return;
    const file = openFiles.find((entry) => entry.path === activeFilePath);
    if (!file) return;
    try {
      const result = await fs.writeFile(file.path, file.content, true);
      setOpenFiles((prev) =>
        prev.map((entry) =>
          entry.path === activeFilePath
            ? {
                ...entry,
                modified: false,
                version: result.version,
                updatedAt: result.updatedAt,
                ...buildClearedRemoteState(),
              }
            : entry
        )
      );
      setDiffViewerPath(null);
    } catch {
      showToast(t("app.failedToSaveFile"));
    }
  }, [activeFilePath, fs, openFiles, showToast, t]);


  const handleOpenGitDiff = useCallback((path: string, runId?: string) => {
    setGitDiffRequest((current) => ({ path, runId, id: (current?.id || 0) + 1 }));
    toggleUtilityPanel("git", true);
  }, [toggleUtilityPanel]);

  // --- Track cursor position ---
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const disposable = editor.onDidChangeCursorPosition((e) => {
      setCursorPos({ line: e.position.lineNumber, column: e.position.column });
      team.sendPresence({
        activeFilePath,
        cursorLine: e.position.lineNumber,
        cursorColumn: e.position.column,
        activity: activeFilePath ? "editing" : "idle",
      });
    });
    return () => disposable.dispose();
  }, [activeFilePath, team]);

  useEffect(() => {
    team.sendPresence({
      activeFilePath,
      cursorLine: cursorPos.line,
      cursorColumn: cursorPos.column,
      activity: activeFilePath ? "viewing" : "idle",
    });
  }, [activeFilePath, cursorPos.column, cursorPos.line, team]);

  // --- Handle workspace change ---
  const handleChangeWorkspace = useCallback(
    async (path: string): Promise<boolean> => {
      const ok = await onChangeWorkspace(path);
      if (ok) {
        showToast(t("app.workspaceChanged"));
        void loadTree();
      } else {
        showToast(t("app.failedToChangeWorkspace"));
      }
      return ok;
    },
    [loadTree, onChangeWorkspace, showToast, t]
  );

  const handlePickDesktopWorkspace = useCallback(async (confirmed = false) => {
    if (pickingWorkspaceRef.current) return;
    if (!confirmed && openFiles.some((file) => file.modified)) {
      setConfirmWorkspaceSwitch(true);
      return;
    }
    pickingWorkspaceRef.current = true;
    setPickingWorkspace(true);
    try {
      const result = await onPickDesktopWorkspace();
      if (result.status === "selected") showToast(t("app.workspaceChanged"));
      if (result.status === "error") showToast(result.message || t("app.failedToChangeWorkspace"));
    } finally {
      pickingWorkspaceRef.current = false;
      setPickingWorkspace(false);
    }
  }, [onPickDesktopWorkspace, openFiles, showToast, t]);

  const handleOpenFolder = useCallback(() => {
    if (isolatedWindow) return;
    if (desktopApp) {
      void handlePickDesktopWorkspace();
    } else {
      setTeamVisible(false);
      closeUtilityPanels();
      setSidebarVisible(true);
      setFolderOpenRequestId((current) => current + 1);
    }
  }, [closeUtilityPanels, desktopApp, handlePickDesktopWorkspace, isolatedWindow]);

  // --- Global keyboard shortcuts & Escape cascade ---
  useWorkbenchShortcuts({
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
  });

  const toggleBreakpoint = useCallback((path: string, line: number) => {
    setBreakpointsByPath((previous) => {
      const current = previous[path] || [];
      const next = current.includes(line)
        ? current.filter((value) => value !== line)
        : [...current, line].sort((left, right) => left - right);
      if (next.length === 0) {
        const { [path]: _removed, ...rest } = previous;
        return rest;
      }
      return { ...previous, [path]: next };
    });
  }, []);
  const runCurrentFile = useCallback(async () => {
    if (!activeFile || !isDebuggablePath(activeFile.path)) return;
    if (activeFile.modified && !(await saveFile())) return;
    toggleUtilityPanel("debug", true);
    setDebugStartRequest((previous) => ({ id: (previous?.id || 0) + 1, path: activeFile.path }));
  }, [activeFile, saveFile, toggleUtilityPanel]);
  const compareFile =
    compareFilePath && compareFilePath !== activeFilePath
      ? openFiles.find((file) => file.path === compareFilePath) || null
      : null;

  const handleCompareEditorReady = useCallback(
    (mountedEditor: monaco.editor.IStandaloneCodeEditor | null) => {
      if (mountedEditor) setCompareEditorMountVersion((version) => version + 1);
    },
    []
  );

  useEffect(() => {
    if (compareFilePath && !compareFile) {
      setCompareFilePath(null);
    }
  }, [compareFile, compareFilePath]);

  const handleSelectTab = useCallback(
    (path: string) => {
      const canonicalPath = normalizeWorkspaceRelativePath(path, workspaceDir);
      if (isSameWorkspacePath(canonicalPath, compareFilePath, workspaceDir) && activeFilePath) {
        setCompareFilePath(activeFilePath);
      }
      setActiveFilePath(canonicalPath);
    },
    [activeFilePath, compareFilePath, workspaceDir]
  );
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
          readOnly: readOnlyWorkspace,
          onChange: handleEditorChange,
        })
      : null;

  useEditorSync({
    activeFile,
    readOnlyWorkspace,
    team,
    chat,
    selectionInfo,
    showToast,
    t,
    editorRef,
    compareEditorRef,
    previewPaneRef,
    compareFile,
    compareScrollLinked,
    compareEditorMountVersion,
    activePreviewMode,
  });

  const activeConflictFile =
    activeFile && activeFile.remoteUpdated && activeFile.modified ? activeFile : null;
  const diffViewerFile =
    diffViewerPath ? openFiles.find((file) => file.path === diffViewerPath) || null : null;
  const activeConflictSourceMessage = activeConflictFile
    ? getConflictSourceMessage(activeConflictFile)
    : null;
  const workspaceLabel = workspaceDir.split(/[\\/]/).filter(Boolean).pop() || workspaceDir;


  const activeConversation = chat.currentConversationId
    ? chat.conversations.find((conversation) => conversation.id === chat.currentConversationId)
    : null;
  const activeConversationTitle = activeConversation
    ? activeConversation.title.trim().startsWith("<think")
      ? activeConversation.preview.replace(/[#*_`]/g, "").trim().slice(0, 52)
      : activeConversation.title
    : null;
  const workbenchTaskTitle = chat.isStreaming
    ? t("chat.runInProgress")
    : activeConversationTitle || (workspaceView === "files" ? (activeFile ? activeFile.name : null) : null);

  return (
    <div
      className="app"
      data-os={platform.os}
      data-platform={platform.host}
    >
      {/* Title Bar */}
      <TitleBar
        productName={PRODUCT_NAME}
        workspaceDir={workspaceDir}
        agentMode={chat.agentMode}
        workbenchTaskTitle={workbenchTaskTitle}
        isStreaming={chat.isStreaming}
        sidebarOffset={sidebarVisible && workspaceView === "files" ? fileDockWidth : 0}
        platform={platform}
        isFullscreen={isFullscreen}
        onToggleFullscreen={toggleFullscreen}
        onOpenCommandPalette={openCommandPalette}
        sidebarVisible={sidebarVisible}
        onToggleSidebar={toggleExplorerPanel}
        workspaceView={workspaceView}
        editorAssistantVisible={editorAssistantVisible}
        chatVisible={chatVisible}
        onToggleAiAssistant={handleToggleAiAssistantWithMutualExclusion}
        webPreviewVisible={webPreviewVisible}
        onToggleWebPreview={handleToggleWebPreview}
        username={username}
        isAdmin={isAdmin}
        teamRole={team.activeTeam?.role || null}
        theme={theme}
        onToggleTheme={onToggleTheme}
        zoomPercent={zoomPercent}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onResetZoom={resetZoom}
        onOpenSettings={() => setSettingsVisible(true)}
        desktopApp={desktopApp}
        onOpenMobilePairing={() => setMobilePairingVisible(true)}
        onPickDesktopWorkspace={() => void onPickDesktopWorkspace()}
        onLogout={onLogout}
      />


      {/* Main Layout */}
      <div
        ref={mainLayoutRef}
        className={`main-layout workbench-view-${workspaceView}${runDetailsVisible ? " with-run-details" : ""}${
          ((workspaceView === "files" && (editorAssistantVisible || webPreviewVisible) && !runDetailsVisible) ||
           (workspaceView === "chat" && webPreviewVisible))
            ? " with-editor-assistant"
            : ""
        }`}
        style={{
          "--files-sidebar-width": `${fileDockWidth}px`,
          "--chat-sidebar-width": `${chatDockWidth}px`,
          "--files-sidebar-handle-width": isLeftDockOpen ? `${FILES_HANDLE_WIDTH}px` : "0px",
          "--files-assistant-width": `${effectiveAssistantWidth}px`,
        } as React.CSSProperties}
      >
        {workspaceDrawerOpen && (
          <button
            type="button"
            className="mobile-drawer-scrim"
            aria-label={t("app.closeDrawer")}
            onClick={closeWorkspaceDrawers}
          />
        )}
        <ActivityRail
          workspaceView={workspaceView}
          sidebarVisible={sidebarVisible}
          gitVisible={gitVisible}
          agentsVisible={agentsVisible}
          teamVisible={teamVisible}
          checkpointsVisible={checkpointsVisible}
          problemsVisible={problemsVisible}
          runCenterVisible={runCenterVisible}
          debugVisible={debugVisible}
          terminalVisible={terminalVisible}
          mobilePairingVisible={mobilePairingVisible}
          settingsVisible={settingsVisible}
          compactWorkspace={compactWorkspace}
          onFocusChat={focusChat}
          onToggleExplorer={toggleExplorerPanel}
          onOpenWorkspaceSearch={() => {
            setWorkspaceSearchScope("");
            setWorkspaceSearchVisible(true);
          }}
          onToggleUtilityPanel={toggleUtilityPanel}
          onToggleTeamPanel={() => toggleTeamPanel()}
          onToggleTerminalPanel={() => toggleTerminalPanel()}
          onOpenMobilePairing={() => setMobilePairingVisible(true)}
          onOpenSettings={() => setSettingsVisible(true)}
          onToggleTheme={onToggleTheme}
          zoomPercent={zoomPercent}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onResetZoom={resetZoom}
          onPickDesktopWorkspace={() => void onPickDesktopWorkspace()}
          onLogout={onLogout}
          changedFilesCount={chat.currentRunSummary?.changedFiles.length || 0}
          onlineMembersCount={team.activeTeam && team.activeTeam.onlineCount > 0 ? team.activeTeam.onlineCount : 0}
          problemCounts={problemCounts}
          desktopApp={desktopApp}
          platform={platform}
          theme={theme}
          username={username}
          isAdmin={isAdmin}
          teamRole={team.activeTeam?.role || null}
        />
        {isLeftDockOpen && (
          <WorkbenchLeftDock
            gitVisible={gitVisible}
            agentsVisible={agentsVisible}
            teamVisible={teamVisible}
            checkpointsVisible={checkpointsVisible}
            problemsVisible={problemsVisible}
            runCenterVisible={runCenterVisible}
            debugVisible={debugVisible}
            workspaceView={workspaceView}
            token={token}
            workspaceDir={workspaceDir}
            workspaceLabel={workspaceLabel}
            theme={theme}
            compactWorkspace={compactWorkspace}
            readOnlyWorkspace={readOnlyWorkspace}
            isolatedWindow={isolatedWindow}
            desktopApp={desktopApp}
            username={username}
            activeFilePath={activeFilePath}
            openFile={openFile}
            onNavigateToLocation={handleNavigateToLocation}
            onShowToast={showToast}
            gitDiffRequest={gitDiffRequest}
            onGitReview={handleGitReview}
            onOpenFollowUpRun={async (followUpRunId) => {
              await chat.loadRun(followUpRunId);
              setRunDetailsTab("delivery");
              setRunDetailsVisible(true);
              if (compactWorkspace) setGitVisible(false);
            }}
            onCloseGit={() => setGitVisible(false)}
            onCloseAgents={() => setAgentsVisible(false)}
            team={team}
            onCloseTeam={() => setTeamVisible(false)}
            onCloseCheckpoints={() => setCheckpointsVisible(false)}
            onWorkspaceRestored={handleWorkspaceRestored}
            onChangeWorkspace={handleChangeWorkspace}
            editorProblems={editorProblems.problems}
            onProblemCountsChange={setProblemCounts}
            onCloseProblems={() => setProblemsVisible(false)}
            onRunningChange={setActiveRunLabel}
            onCloseRunCenter={() => setRunCenterVisible(false)}
            cursorPos={cursorPos}
            breakpointsByPath={breakpointsByPath}
            onToggleBreakpoint={toggleBreakpoint}
            debugStartRequest={debugStartRequest}
            onActiveFrameChange={setDebugActiveFrame}
            onCloseDebug={() => setDebugVisible(false)}
            chat={chat}
            onNewTask={() => {
              setNewConversationRequest((value) => value + 1);
              setChatFocusNonce((value) => value + 1);
            }}
            onLoadConversation={loadChatConversation}
            fileTree={fileTree}
            onCreateEntry={handleCreateEntry}
            onCopyEntry={handleCopyEntry}
            onMoveEntry={handleMoveEntry}
            onDeleteEntry={handleDeleteEntry}
            onDeleteEntries={handleDeleteEntries}
            onRenameEntry={handleRenameEntry}
            onDownloadEntry={handleDownloadEntry}
            onUploadEntries={handleUploadEntries}
            onRefreshTree={loadTree}
            pickingWorkspace={pickingWorkspace}
            onPickDesktopWorkspace={handlePickDesktopWorkspace}
            folderOpenRequestId={folderOpenRequestId}
            onSearchInPath={(path) => {
              setWorkspaceSearchScope(path);
              setWorkspaceSearchVisible(true);
            }}
            fs={fs}
          />
        )}

        <div
          className={`resize-handle sidebar-resize-handle${!isLeftDockOpen ? " hidden" : ""}${draggingPanel === "sidebar" ? " dragging" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("sidebar.resize")}
          aria-valuemin={FILES_SIDEBAR_MIN_WIDTH}
          aria-valuemax={sidebarMaxWidth}
          aria-valuenow={effectiveSidebarWidth}
          tabIndex={isLeftDockOpen && viewportWidth > 780 ? 0 : -1}
          onMouseDown={(e) => handleResizeStart("sidebar", e)}
          onKeyDown={(e) => handlePanelResizeKeyDown("sidebar", e)}
        />

        <div className="workbench-center-viewport">
          <WorkbenchEditorArea
            workspaceView={workspaceView}
            openFiles={openFiles}
            activeFilePath={activeFilePath}
            workspaceDir={workspaceDir}
            onSelectTab={handleSelectTab}
            onCloseTab={closeTab}
            onCloseOtherTabs={closeOtherTabs}
            onCloseTabsToTheRight={closeTabsToTheRight}
            onCloseAllTabs={closeAllTabs}
            onShowToast={showToast}
            activeFile={activeFile}
            workspaceLabel={workspaceLabel}
            activePreviewRenderer={activePreviewRenderer}
            activePreviewMode={activePreviewMode}
            onSelectPreviewMode={setActivePreviewMode}
            editorAssistantVisible={editorAssistantVisible}
            onToggleEditorAssistant={() => {
              setRunDetailsVisible(false);
              setWebPreviewVisible(false);
              setEditorAssistantVisible((prev) => !prev);
            }}
            webPreviewVisible={webPreviewVisible}
            onToggleWebPreview={handleToggleWebPreview}
            terminalVisible={terminalVisible}
            onToggleTerminal={toggleTerminalPanel}
            runDetailsVisible={runDetailsVisible}
            onOpenChanges={() => {
              setEditorAssistantVisible(false);
              setWebPreviewVisible(false);
              setRunDetailsTab("changes");
              setRunDetailsVisible(true);
            }}
            onRunCurrent={() => void runCurrentFile()}
            readOnlyWorkspace={readOnlyWorkspace}
            compareFilePath={compareFilePath}
            onSelectCompareFile={(value) => setCompareFilePath(value)}
            compareFile={compareFile}
            compareScrollLinked={compareScrollLinked}
            onToggleCompareScrollLinked={() => setCompareScrollLinked((linked) => !linked)}
            onCloseCompare={() => setCompareFilePath(null)}
            activeConflictFile={activeConflictFile}
            activeConflictSourceMessage={activeConflictSourceMessage}
            onViewDiff={(path) => setDiffViewerPath(path)}
            onKeepLocalVersion={handleKeepLocalVersion}
            onReloadRemoteVersion={handleReloadRemoteVersion}
            onForceSaveAfterVersionConflict={handleForceSaveAfterVersionConflict}
            activeClaim={activeClaim}
            username={username}
            activeCollaborators={activeCollaborators}
            team={team}
            theme={theme}
            editorFont={editorFont}
            treeRefreshNonce={treeRefreshNonce}
            editorViewStatesRef={editorViewStatesRef}
            onEditorViewStateChange={handleEditorViewStateChange}
            onEditorChange={handleEditorChange}
            onSaveFile={() => void saveFile()}
            onFormatDocument={formatPythonDocument}
            fs={fs}
            breakpointsByPath={breakpointsByPath}
            debugActiveFrame={debugActiveFrame}
            onToggleBreakpoint={(path, line) => toggleBreakpoint(path, line)}
            onSelectionChange={handleSelectionChange}
            onNavigateToLocation={handleNavigateToLocation}
            onFindDefinition={handleFindDefinition}
            onFindReferences={handleFindReferences}
            onReferencesFound={handleReferencesFound}
            editorRef={editorRef}
            compareEditorRef={compareEditorRef}
            onCompareEditorReady={handleCompareEditorReady}
            editorNavigationTarget={editorNavigationTarget}
            editorHighlightTarget={editorHighlightTarget}
            onNavigationComplete={handleNavigationComplete}
            onHighlightComplete={handleHighlightComplete}
            previewPaneRef={previewPaneRef}
            activePreviewContent={activePreviewContent}
            fileTree={fileTree}
            onQuickOpen={() => openCommandPalette("files")}
            onOpenFolder={handleOpenFolder}
            folderPickerBusy={pickingWorkspace}
            onFocusChat={focusChat}
            onOpenFile={openFile}
            referenceResult={referenceResult}
            onCloseReference={() => setReferenceResult(null)}
          />

        <ChatPanel
          token={token}
          workspaceDir={workspaceDir}
          referenceFiles={fileTree}
          contextReferences={contextReferences}
          onContextReferencesChange={setContextReferences}
          isolatedWindow={isolatedWindow}
          messages={chat.messages}
          currentConversationId={chat.currentConversationId}
          conversations={chat.conversations}
          isStreaming={chat.isStreaming}
          activeRequestIds={chat.activeRequestIds}
          connected={chat.connected}
          aiHealth={chat.aiHealth}
          visible={chatVisible && workspaceView === "chat"}
          focusRequest={chatFocusNonce}
          agentMode={chat.agentMode}
          runtimeOptions={chat.runtimeOptions}
          selectedModelName={chat.selectedModelName}
          draftText={chatDraftText}
          onDraftTextChange={setChatDraftText}
          attachmentDraft={chatAttachmentDraft}
          attachmentWarning={attachmentWarning}
          attachmentDeliveryChecking={pendingAttachmentVerificationIds.size > 0}
          onRecheckAttachmentDelivery={() => void chat.recheckAttachmentSends()}
          attachmentSubmissionError={attachmentSubmissionError}
          attachmentSubmissionNotice={editedRetryNotice || attachmentSubmissionNotice}
          taskTitle={workbenchTaskTitle || t("workbench.newTask")}
          onAgentModeChange={chat.setAgentMode}
          onModelNameChange={chat.setSelectedModelName}
          currentRunSummary={chat.currentRunSummary}
          contextState={chat.contextState}
          contextManifest={chat.contextManifest}
          contextReadOnly={readOnlyWorkspace}
          mcpState={chat.mcpState}
          knowledgeState={chat.knowledgeState}
          historyRequest={chatHistoryRequest}
          newConversationRequest={newConversationRequest}
          onOpenSettings={() => setSettingsVisible(true)}
          collaboration={team.collaboration}
          activeFilePath={activeFilePath}
          onOpenCollaboration={() => toggleTeamPanel(true)}
          onOpenFile={openFile}
          onOpenDiff={handleOpenGitDiff}
          onOpenReviewFinding={(finding) => void handleNavigateToLocation(finding.path, {
            startLine: finding.line,
            startColumn: finding.column || 1,
            endLine: finding.line,
            endColumn: (finding.column || 1) + 1,
          })}
          historyLoading={chat.historyLoading}
          historyLoadingId={chat.historyLoadingId}
          historyError={chat.historyError}
          selectionInfo={selectionInfo}
          activeFileName={activeFile?.name || null}
          theme={theme}
          onReviewComment={handleReviewComment}
          onChangesApplied={() => void handleWorkspaceRestored()}
          onUndoLastTurn={chat.currentRunSummary?.changedFiles.length ? handleUndoLastTurn : undefined}
          onSend={handleChatSend}
          onSteer={handleChatSteer}
          onStop={chat.stopCurrentRun}
          onClear={clearChatConversation}
          onRetry={chat.retryLast}
          onLoadConversation={loadChatConversation}
          onDeleteConversation={chat.deleteConversation}
          onForkConversation={async (conversationId, upToTimestamp) => {
            try {
              const fork = await chat.forkConversation(conversationId, upToTimestamp);
              showToast(t("chat.forkCreated"));
              return fork;
            } catch (error) {
              showToast(error instanceof Error ? error.message : t("chat.forkFailed"));
              throw error;
            }
          }}
          onRefreshConversations={chat.refreshConversations}
          runState={chat.runState}
          runHistory={chat.runHistory}
          runHistoryLoading={chat.runHistoryLoading}
          runHistoryError={chat.runHistoryError}
          onLoadRun={chat.loadRun}
          onResumeRun={chat.resumeConversation}
          onRevertRun={async (runId, options) => {
            try {
              const result = await chat.revertRun(runId, options) as { mode?: string };
              await handleWorkspaceRestored();
              showToast(result.mode === "legacy-full-restore" ? t("chat.runRevertedLegacy") : t("chat.runReverted"));
              return result;
            } catch (error) {
              showToast(error instanceof Error ? error.message : t("chat.revertRunFailed"));
              throw error;
            }
          }}
          onApplyCode={handleApplyCode}
          onNavigateToFileUpdate={handleNavigateToFileUpdate}
          pendingApprovals={chat.pendingApprovals}
          onToolApproval={chat.respondToToolApproval}
          onApproveConversationTools={chat.approveConversationTools}
          onPlanAmendmentDecision={chat.decidePlanAmendment}
          style={chatVisible && workspaceView === "files" ? { width: chatWidth } : undefined}
        />

        {terminalVisible && (
          <div
            className={`terminal-resize-handle${draggingPanel === "terminal" ? " dragging" : ""}`}
            role="separator"
            aria-orientation="horizontal"
            aria-label={t("terminal.resize")}
            aria-valuemin={140}
            aria-valuemax={680}
            aria-valuenow={terminalHeight}
            tabIndex={0}
            onMouseDown={handleTerminalResizeStart}
            onKeyDown={handleTerminalResizeKeyDown}
          />
        )}
        <Terminal
          key={workspaceDir}
          visible={terminalVisible}
          style={{ height: terminalHeight }}
          token={token}
          disabled={readOnlyWorkspace}
          disabledReason={readOnlyWorkspace ? t("terminal.readOnlyDisabled") : null}
          drawerMode={isMobileViewport}
          onClose={() => setTerminalVisible(false)}
        />
      </div>
        {((workspaceView === "files" && (editorAssistantVisible || runDetailsVisible || webPreviewVisible)) ||
          (workspaceView === "chat" && webPreviewVisible)) && (
          <div
            className={`resize-handle assistant-resize-handle${draggingPanel === "assistant" ? " dragging" : ""}`}
            role="separator"
            aria-orientation="vertical"
            aria-label={t("workbench.resizeAssistant")}
            aria-valuemin={FILES_ASSISTANT_MIN_WIDTH}
            aria-valuemax={assistantMaxWidth}
            aria-valuenow={effectiveAssistantWidth}
            tabIndex={viewportWidth > 780 ? 0 : -1}
            onMouseDown={(e) => handleResizeStart("assistant", e)}
            onKeyDown={(e) => handlePanelResizeKeyDown("assistant", e)}
          />
        )}
        <WorkbenchRightDock
          workspaceView={workspaceView}
          editorAssistantVisible={editorAssistantVisible}
          runDetailsVisible={runDetailsVisible}
          webPreviewVisible={webPreviewVisible}
          setEditorAssistantVisible={setEditorAssistantVisible}
          setRunDetailsVisible={setRunDetailsVisible}
          setWebPreviewVisible={setWebPreviewVisible}
          runDetailsTab={runDetailsTab}
          setRunDetailsTab={setRunDetailsTab}
          token={token}
          workspaceDir={workspaceDir}
          chat={chat}
          problemCounts={problemCounts}
          openFile={openFile}
          onOpenGitDiff={handleOpenGitDiff}
          activeFilePath={activeFilePath}
          activeFile={activeFile}
          chatDraftText={chatDraftText}
          setChatDraftText={setChatDraftText}
          chatAttachmentDraft={chatAttachmentDraft}
          attachmentWarning={attachmentWarning}
          pendingAttachmentVerificationIds={pendingAttachmentVerificationIds}
          attachmentSubmissionError={attachmentSubmissionError}
          attachmentSubmissionNotice={attachmentSubmissionNotice}
          editedRetryNotice={editedRetryNotice}
          readOnlyWorkspace={readOnlyWorkspace}
          onSend={handleChatSend}
          onSteer={handleChatSteer}
          onNewConversation={clearChatConversation}
          contextReferences={contextReferences}
          onContextReferencesChange={setContextReferences}
          onUndoLastTurn={chat.currentRunSummary?.changedFiles.length ? handleUndoLastTurn : undefined}
          onReviewComment={handleReviewComment}
          onChangesApplied={() => void handleWorkspaceRestored()}
          onNavigateToLocation={handleNavigateToLocation}
          theme={theme}
          selectionInfo={selectionInfo}
          fileTree={fileTree}
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
        aiHealth={chat.aiHealth}
        teamName={team.activeTeam?.name || null}
        teamOnlineCount={team.activeTeam?.onlineCount}
        teamRole={team.activeTeam?.role || null}
        onOpenTeam={() => toggleTeamPanel(true)}
        readOnlyWorkspace={readOnlyWorkspace}
        errorCount={problemCounts.errors}
        warningCount={problemCounts.warnings}
        onOpenProblems={() => toggleUtilityPanel("problems", true)}
        activeRunLabel={activeRunLabel}
        onOpenRunCenter={() => toggleUtilityPanel("run-center", true)}
      />

      {/* Toast */}
      {toast && <div className="toast">{toast}</div>}

      <WorkbenchModals
        token={token}
        username={username}
        isAdmin={isAdmin}
        teamRole={team.activeTeam?.role || null}
        readOnlyWorkspace={readOnlyWorkspace}
        workspaceDir={workspaceDir}
        showToast={showToast}
        settingsVisible={settingsVisible}
        onCloseSettings={() => setSettingsVisible(false)}
        editorFont={editorFont}
        editorFontOptions={editorFontOptions}
        onEditorFontChange={onEditorFontChange}
        zoomLevel={zoomLevel}
        onZoomChange={setZoom}
        onResetZoom={resetZoom}
        mobilePairingVisible={mobilePairingVisible}
        desktopApp={desktopApp}
        onCloseMobilePairing={() => setMobilePairingVisible(false)}
        onSessionExpired={onSessionExpired}
        diffViewerFile={diffViewerFile}
        conflictSourceMessage={diffViewerFile ? getConflictSourceMessage(diffViewerFile) : null}
        theme={theme}
        onCloseDiffViewer={() => setDiffViewerPath(null)}
        onApplyMerge={(mergedContent) => {
          setOpenFiles((prev) =>
            prev.map((file) =>
              file.path === diffViewerFile?.path
                ? {
                    ...file,
                    content: mergedContent,
                    modified: true,
                    version: diffViewerFile.remoteVersion ?? file.version,
                    updatedAt: diffViewerFile.remoteUpdatedAt ?? file.updatedAt,
                    ...buildClearedRemoteState(),
                  }
                : file
            )
          );
          setDiffViewerPath(null);
          showToast(t("app.mergeApplied"));
        }}
        onKeepLocalVersion={handleKeepLocalVersion}
        onReloadRemoteVersion={handleReloadRemoteVersion}
        onForceSave={
          diffViewerFile?.remoteConflictReason === "save"
            ? () => void handleForceSaveAfterVersionConflict()
            : undefined
        }
        confirmIntent={
          confirmWorkspaceSwitch
            ? {
                id: "switch-workspace",
                title: t("sidebar.openFolder"),
                description: t("app.unsavedWorkspaceSwitch"),
                tone: "danger",
              }
            : claimSaveConfirmation
            ? {
                id: `claim-save:${claimSaveConfirmation.file.path}:${claimSaveConfirmation.username}`,
                title: t("team.confirmAction"),
                description: t("team.claimConflictConfirm", {
                  username: claimSaveConfirmation.username,
                }),
                confirmLabel: t("common.confirm"),
                tone: "danger",
              }
            : null
        }
        confirmBusy={confirmWorkspaceSwitch ? pickingWorkspace : claimSaveBusy}
        confirmError={confirmWorkspaceSwitch ? null : claimSaveError}
        onCloseConfirm={() => {
          if (confirmWorkspaceSwitch) {
            setConfirmWorkspaceSwitch(false);
          } else if (claimSaveConfirmation) {
            setClaimSaveConfirmation(null);
            setClaimSaveError(null);
            showToast(t("team.claimConflictCancelled"));
          }
        }}
        onConfirmAction={() => {
          if (confirmWorkspaceSwitch) {
            setConfirmWorkspaceSwitch(false);
            void handlePickDesktopWorkspace(true);
          } else if (claimSaveConfirmation) {
            void forceSaveClaimedFile();
          }
        }}
        commandPaletteVisible={commandPaletteVisible}
        commandPaletteMode={commandPaletteMode}
        fileTree={fileTree}
        onCloseCommandPalette={() => setCommandPaletteVisible(false)}
        onOpenFile={openFile}
        onRunPaletteCommand={runPaletteCommand}
        canFormatDocument={Boolean(activeFile?.language === "python" && !readOnlyWorkspace)}
        workspaceSearchVisible={workspaceSearchVisible}
        workspaceSearchScope={workspaceSearchScope}
        onCloseWorkspaceSearch={() => setWorkspaceSearchVisible(false)}
        onClearWorkspaceSearchScope={() => setWorkspaceSearchScope("")}
        onSearchWorkspace={fs.searchWorkspace}
        onCancelWorkspaceSearch={fs.cancelWorkspaceSearch}
        onOpenSearchResult={openSearchResult}
      />
    </div>
  );
}
