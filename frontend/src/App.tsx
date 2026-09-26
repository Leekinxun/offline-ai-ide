import React, { lazy, Suspense, useState, useEffect, useCallback, useMemo, useRef } from "react";
import type * as monaco from "monaco-editor";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { EditorToolbar } from "./components/EditorToolbar";
import { ChatPanel } from "./components/ChatPanel";
import { TaskSidebar } from "./components/TaskSidebar";
import { RunDetailsPanel } from "./components/RunDetailsPanel";
import type { DetailTab } from "./components/RunDetailsPanel";
import { EditorAssistantPanel } from "./components/EditorAssistantPanel";
import { WorkbenchSelect } from "./components/WorkbenchSelect";
import { useChatAttachmentDraft } from "./components/ChatAttachmentPicker";
import { StatusBar } from "./components/StatusBar";
import { Terminal } from "./components/Terminal";
import { LoginPage } from "./components/LoginPage";
import { LandingPage } from "./components/LandingPage";
import { BrandMark } from "./components/BrandMark";
import { TitleBar } from "./components/TitleBar";
import "./components/UserPopover.css";
import "./components/ActivityRail.css";
import "./components/Sidebar.css";
import { PRODUCT_NAME } from "./brand";
import { CommandPalette, CommandPaletteMode } from "./components/CommandPalette";
import { WorkspaceWelcome } from "./components/WorkspaceWelcome";
import { WorkspaceSearchPanel } from "./components/WorkspaceSearchPanel";
import { ActionConfirmDialog } from "./components/ActionConfirmDialog";
import { useModalDialogFocus } from "./components/useModalDialogFocus";
import { GitPanel } from "./components/GitPanel";
import { AgentBoard } from "./components/AgentBoard";
import { CheckpointPanel } from "./components/CheckpointPanel";
import { ProblemsPanel } from "./components/ProblemsPanel";
import { RunCenterPanel } from "./components/RunCenterPanel";
import { DebugPanel } from "./components/DebugPanel";
import { ReferencePanel } from "./components/ReferencePanel";
import type { DebugFrame } from "./hooks/useDebugger";
import { useEditorProblems } from "./hooks/useEditorProblems";
import { useFileSystem } from "./hooks/useFileSystem";
import type { WorkspaceSearchResult } from "./hooks/useFileSystem";
import { useChat, type AttachmentSendReconciliation, type RejectedAttachmentSend } from "./hooks/useChat";
import { useAuth, type DesktopFolderPickResult } from "./hooks/useAuth";
import { useTeam } from "./hooks/useTeam";
import { usePlatformEnvironment } from "./hooks/usePlatformEnvironment";
import { useViewportBreakpoint } from "./hooks/useViewportBreakpoint";
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
  TestTube2,
  Bug,
  Users,
  X,
  Link2,
  Unlink2,
  Play,
  Search,
  Smartphone,
  Maximize2,
  Minimize2,
  FolderOpen,
  LayoutGrid,
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
import {
  applyHunkSelections,
  buildConflictHunks,
  countRemoteSelections,
  formatLineRange,
} from "./utils/conflicts";

const SettingsModal = lazy(() =>
  import("./components/SettingsModal").then((module) => ({ default: module.SettingsModal }))
);
const Editor = lazy(() =>
  import("./components/Editor").then((module) => ({ default: module.Editor }))
);
const TeamPanel = lazy(() =>
  import("./components/TeamPanel").then((module) => ({ default: module.TeamPanel }))
);
const DiffEditor = lazy(() =>
  import("@monaco-editor/react").then((module) => ({ default: module.DiffEditor }))
);
const MobileApp = lazy(() =>
  import("./mobile/MobileApp").then((module) => ({ default: module.MobileApp }))
);
const DesktopMobilePairing = lazy(() =>
  import("./mobile/DesktopMobilePairing").then((module) => ({ default: module.DesktopMobilePairing }))
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

async function sha256Text(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const FILES_ACTIVITY_WIDTH = 56;
const FILES_HANDLE_WIDTH = 6;
const FILES_EDITOR_MIN_WIDTH = 360;
const FILES_EDITOR_IDEAL_MIN_WIDTH = 500;
const FILES_SIDEBAR_MIN_WIDTH = 180;
const FILES_SIDEBAR_MAX_WIDTH = 500;
const FILES_ASSISTANT_MIN_WIDTH = 280;
const FILES_ASSISTANT_MAX_WIDTH = 720;

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
  const viewport = useViewportBreakpoint();
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

  const [userDensityOverride, setUserDensityOverride] = useState<"normal" | "compact" | null>(() => {
    return (localStorage.getItem("user-density") as "normal" | "compact" | null) || null;
  });
  const currentDensity = userDensityOverride || viewport.recommendedDensity;

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.setAttribute("data-os", platform.os);
    document.documentElement.setAttribute("data-platform", platform.host);
    document.documentElement.setAttribute("data-density", currentDensity);
    localStorage.setItem("theme", theme);
  }, [theme, platform.os, platform.host, currentDensity]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === "light" ? "dark" : "light"));
  }, []);

  const toggleDensity = useCallback(() => {
    setUserDensityOverride((prev) => {
      const next = (prev || viewport.recommendedDensity) === "compact" ? "normal" : "compact";
      localStorage.setItem("user-density", next);
      return next;
    });
  }, [viewport.recommendedDensity]);

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
      density={currentDensity}
      onToggleDensity={toggleDensity}
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
  density: "normal" | "compact";
  onToggleDensity: () => void;
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

/**
 * 规范化工作区相对路径：
 * 1. 统一正反斜杠；
 * 2. 若误传工作区绝对路径，自动剥离工作区前缀；
 * 3. 剔除前导 `./` 和多余的正斜杠 `/`，保证全局使用纯净唯一的相对路径。
 */
function normalizeWorkspaceRelativePath(rawPath: string, workspaceDir?: string): string {
  if (!rawPath) return "";
  let normalized = rawPath.replace(/\\/g, "/").trim();
  if (workspaceDir) {
    const wsNormalized = workspaceDir.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalized.toLowerCase().startsWith(wsNormalized.toLowerCase() + "/")) {
      normalized = normalized.slice(wsNormalized.length + 1);
    }
  }
  return normalized.replace(/^\.\//, "").replace(/^\/+/, "");
}

function isSameWorkspacePath(left: string | null | undefined, right: string | null | undefined, workspaceDir?: string): boolean {
  if (!left || !right) return left === right;
  return normalizeWorkspaceRelativePath(left, workspaceDir) === normalizeWorkspaceRelativePath(right, workspaceDir);
}

function isPathEqualOrDescendant(candidate: string, target: string): boolean {
  return candidate === target || candidate.startsWith(`${target}/`);
}

function remapMovedPath(candidate: string, oldPath: string, newPath: string): string {
  if (candidate === oldPath) return newPath;
  return candidate.startsWith(`${oldPath}/`)
    ? `${newPath}${candidate.slice(oldPath.length)}`
    : candidate;
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

function collectVisiblePaths(nodes: FileNode[]): Set<string> {
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

function isReadOnlyTeamRole(role: TeamRole | null | undefined): boolean {
  return role === "viewer";
}

function isDebuggablePath(path: string): boolean {
  return /\.(?:js|mjs|cjs|py|pyw)$/i.test(path);
}

function buildClearedRemoteState(): Pick<
  OpenFile,
  | "remoteUpdated"
  | "remoteContent"
  | "remoteVersion"
  | "remoteUpdatedAt"
  | "remoteConflictReason"
  | "remoteConflictSource"
  | "remoteConflictActor"
> {
  return {
    remoteUpdated: false,
    remoteContent: undefined,
    remoteVersion: undefined,
    remoteUpdatedAt: undefined,
    remoteConflictReason: undefined,
    remoteConflictSource: undefined,
    remoteConflictActor: undefined,
  };
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
  density,
  onToggleDensity,
  editorFont,
  editorFontOptions,
  onEditorFontChange,
}: AuthenticatedAppProps) {
  const { t } = useI18n();
  const platform = usePlatformEnvironment(desktopApp);
  const viewport = useViewportBreakpoint();
  const editorProblems = useEditorProblems();
  // --- State ---
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [compareFilePath, setCompareFilePath] = useState<string | null>(null);
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
  const [sidebarVisible, setSidebarVisible] = useState(() => window.innerWidth > 1100);
  const [folderOpenRequestId, setFolderOpenRequestId] = useState(0);
  const [chatVisible, setChatVisible] = useState(() => window.innerWidth > 860);
  const [runDetailsVisible, setRunDetailsVisible] = useState(false);
  const [runDetailsTab, setRunDetailsTab] = useState<DetailTab>("changes");
  const [editorAssistantVisible, setEditorAssistantVisible] = useState(() => window.innerWidth > 1180);
  const [chatFocusNonce, setChatFocusNonce] = useState(0);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [teamVisible, setTeamVisible] = useState(false);
  const [, setFocusMode] = useState(false);
  const [commandPaletteMode, setCommandPaletteMode] = useState<CommandPaletteMode>("commands");
  const [commandPaletteVisible, setCommandPaletteVisible] = useState(false);
  const [chatHistoryRequest, setChatHistoryRequest] = useState(0);
  const [newConversationRequest, setNewConversationRequest] = useState(0);
  const [workspaceSearchVisible, setWorkspaceSearchVisible] = useState(false);
  const [workspaceSearchScope, setWorkspaceSearchScope] = useState("");
  const [gitVisible, setGitVisible] = useState(false);
  const [gitDiffRequest, setGitDiffRequest] = useState<{ path: string; id: number } | null>(null);
  const [agentsVisible, setAgentsVisible] = useState(false);
  const [checkpointsVisible, setCheckpointsVisible] = useState(false);
  const [problemsVisible, setProblemsVisible] = useState(false);
  const [runCenterVisible, setRunCenterVisible] = useState(false);
  const [debugVisible, setDebugVisible] = useState(false);
  const [breakpointsByPath, setBreakpointsByPath] = useState<Record<string, number[]>>({});
  const [debugStartRequest, setDebugStartRequest] = useState<{ id: number; path: string } | null>(null);
  const [debugActiveFrame, setDebugActiveFrame] = useState<DebugFrame | null>(null);
  const [problemCounts, setProblemCounts] = useState({ errors: 0, warnings: 0 });
  const [activeRunLabel, setActiveRunLabel] = useState<string | null>(null);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [mobilePairingVisible, setMobilePairingVisible] = useState(false);
  const [diffViewerPath, setDiffViewerPath] = useState<string | null>(null);
  const [claimSaveConfirmation, setClaimSaveConfirmation] = useState<{ file: OpenFile; username: string } | null>(null);
  const [claimSaveBusy, setClaimSaveBusy] = useState(false);
  const [claimSaveError, setClaimSaveError] = useState<string | null>(null);
  const [mergeSelections, setMergeSelections] = useState<Record<string, "local" | "remote">>(
    {}
  );
  const [cursorPos, setCursorPos] = useState({ line: 1, column: 1 });
  const [toast, setToast] = useState<string | null>(null);
  const [pickingWorkspace, setPickingWorkspace] = useState(false);
  const pickingWorkspaceRef = useRef(false);
  const openingPathsRef = useRef<Set<string>>(new Set());
  const [selectionInfo, setSelectionInfo] = useState<SelectionInfo | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(286);
  const [assistantWidth, setAssistantWidth] = useState(400);
  const [draggingPanel, setDraggingPanel] = useState<"sidebar" | "assistant" | "chat" | "terminal" | null>(null);
  const [chatWidth, setChatWidth] = useState(380);
  const [terminalHeight, setTerminalHeight] = useState(260);
  const [previewModes, setPreviewModes] = useState<Record<string, FilePreviewMode>>(
    {}
  );
  const [editorNavigationTarget, setEditorNavigationTarget] =
    useState<EditorNavigationTarget | null>(null);
  const [editorHighlightTarget, setEditorHighlightTarget] =
    useState<EditorHighlightTarget | null>(null);
  const [referenceResult, setReferenceResult] = useState<{ symbol: string; references: ReferenceLocation[] } | null>(null);
  const [treeRefreshNonce, setTreeRefreshNonce] = useState(0);
  const lastWorkspaceMtimeRef = useRef(0);
  const savedBufferContentRef = useRef<Record<string, string>>({});
  const collaborationBufferVersionRef = useRef<Record<string, number>>({});

  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const compareEditorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const previewPaneRef = useRef<HTMLDivElement | null>(null);
  const isSyncingScrollRef = useRef<"editor" | "preview" | null>(null);
  const syncScrollTimerRef = useRef<number | null>(null);
  const draggingRef = useRef<"sidebar" | "assistant" | "chat" | "terminal" | null>(null);
  const panelWidthsRef = useRef({ sidebar: sidebarWidth, assistant: assistantWidth });
  const navigationRequestRef = useRef(0);
  const highlightRequestRef = useRef(0);
  const editorViewStatesRef = useRef<
    Record<string, monaco.editor.ICodeEditorViewState | null>
  >({});
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const startWidthRef = useRef(0);
  const startHeightRef = useRef(0);
  const drawerTriggerRef = useRef<HTMLElement | null>(null);
  const mainLayoutRef = useRef<HTMLDivElement>(null);
  const previousDrawerRef = useRef<string | null>(null);
  const layoutBeforeFocusRef = useRef({
    sidebar: true,
    chat: true,
    team: false,
    git: false,
    agents: false,
    checkpoints: false,
    problems: false,
    runCenter: false,
    debug: false,
  });
  const fs = useFileSystem(token);

  useEffect(() => {
    setBreakpointsByPath({});
    setDebugStartRequest(null);
  }, [workspaceDir]);

  useEffect(() => {
    setReferenceResult(null);
  }, [activeFilePath]);

  // --- Toast ---
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);

  const compactWorkspace = viewportWidth <= 1100;
  const narrowWorkspace = viewportWidth <= 860;
  // Media-query thresholds follow the viewport; panel budgets use the actual
  // content width, which can be smaller with classic Windows scrollbars.
  const layoutAvailableWidth = Math.min(viewportWidth, document.documentElement.clientWidth || viewportWidth);
  const isLeftDockOpen = Boolean(sidebarVisible || gitVisible || agentsVisible || teamVisible || checkpointsVisible || problemsVisible || runCenterVisible || debugVisible);

  const isLaptopOrCompact = viewportWidth < 1440;
  const responsiveDefaultSidebarWidth = isLaptopOrCompact ? Math.min(sidebarWidth, 240) : sidebarWidth;
  const responsiveDefaultAssistantWidth = isLaptopOrCompact ? Math.min(assistantWidth, 340) : assistantWidth;

  const dockedRightWidth = viewportWidth > 1180
    ? runDetailsVisible ? (isLaptopOrCompact ? 340 : 400) : editorAssistantVisible ? responsiveDefaultAssistantWidth : 0
    : 0;

  // 黄金编辑区保底空间：大屏保留 520px，中屏保留 460px，紧凑模式保留至少 360px
  const reservedEditorBudget = viewportWidth > 1440 ? 520 : viewportWidth > 1180 ? 460 : FILES_EDITOR_MIN_WIDTH;

  const sidebarMaxWidth = Math.max(FILES_SIDEBAR_MIN_WIDTH, Math.min(
    FILES_SIDEBAR_MAX_WIDTH,
    layoutAvailableWidth - FILES_ACTIVITY_WIDTH - FILES_HANDLE_WIDTH
      - (dockedRightWidth ? dockedRightWidth + FILES_HANDLE_WIDTH : 0)
      - reservedEditorBudget
  ));
  const effectiveSidebarWidth = isLeftDockOpen ? Math.min(responsiveDefaultSidebarWidth, sidebarMaxWidth) : 0;
  const fileDockWidth = effectiveSidebarWidth;
  const chatDockWidth = isLeftDockOpen ? (isLaptopOrCompact ? 250 : effectiveSidebarWidth) : 0;
  const assistantMaxWidth = viewportWidth > 1180
    ? Math.max(FILES_ASSISTANT_MIN_WIDTH, Math.min(
        FILES_ASSISTANT_MAX_WIDTH,
        layoutAvailableWidth - FILES_ACTIVITY_WIDTH
          - fileDockWidth - (isLeftDockOpen ? FILES_HANDLE_WIDTH : 0)
          - FILES_HANDLE_WIDTH - reservedEditorBudget
      ))
    : Math.min(FILES_ASSISTANT_MAX_WIDTH, Math.max(FILES_ASSISTANT_MIN_WIDTH, layoutAvailableWidth - FILES_ACTIVITY_WIDTH));
  const effectiveAssistantWidth = Math.min(responsiveDefaultAssistantWidth, assistantMaxWidth);
  panelWidthsRef.current = { sidebar: fileDockWidth, assistant: effectiveAssistantWidth };

  useEffect(() => {
    const handleViewportResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", handleViewportResize);
    return () => window.removeEventListener("resize", handleViewportResize);
  }, []);

  const captureDrawerTrigger = useCallback(() => {
    if (document.activeElement instanceof HTMLElement) {
      drawerTriggerRef.current = document.activeElement;
    }
  }, []);

  const closeUtilityPanels = useCallback(() => {
    setGitVisible(false);
    setAgentsVisible(false);
    setCheckpointsVisible(false);
    setProblemsVisible(false);
    setRunCenterVisible(false);
    setDebugVisible(false);
  }, []);

  const toggleFocusMode = useCallback(() => {
    setFocusMode((current) => {
      if (current) {
        setSidebarVisible(layoutBeforeFocusRef.current.sidebar);
        setChatVisible(layoutBeforeFocusRef.current.chat);
        setTeamVisible(layoutBeforeFocusRef.current.team);
        setGitVisible(layoutBeforeFocusRef.current.git);
        setAgentsVisible(layoutBeforeFocusRef.current.agents);
        setCheckpointsVisible(layoutBeforeFocusRef.current.checkpoints);
        setProblemsVisible(layoutBeforeFocusRef.current.problems);
        setRunCenterVisible(layoutBeforeFocusRef.current.runCenter);
        setDebugVisible(layoutBeforeFocusRef.current.debug);
      } else {
        layoutBeforeFocusRef.current = {
          sidebar: sidebarVisible,
          chat: chatVisible,
          team: teamVisible,
          git: gitVisible,
          agents: agentsVisible,
          checkpoints: checkpointsVisible,
          problems: problemsVisible,
          runCenter: runCenterVisible,
          debug: debugVisible,
        };
        setSidebarVisible(false);
        setChatVisible(false);
        setTeamVisible(false);
        setGitVisible(false);
        setAgentsVisible(false);
        setCheckpointsVisible(false);
        setProblemsVisible(false);
        setRunCenterVisible(false);
        setDebugVisible(false);
      }
      return !current;
    });
  }, [
    agentsVisible,
    chatVisible,
    checkpointsVisible,
    gitVisible,
    problemsVisible,
    runCenterVisible,
    debugVisible,
    sidebarVisible,
    teamVisible,
  ]);

  const openCommandPalette = useCallback((mode: CommandPaletteMode) => {
    setCommandPaletteMode(mode);
    setCommandPaletteVisible(true);
  }, []);

  const focusChat = useCallback(() => {
    const switchingToChat = workspaceView !== "chat";
    setWorkspaceView("chat");
    setEditorAssistantVisible(false);
    setRunDetailsVisible(false);
    setChatVisible(true);
    const utilityOpen =
      gitVisible || agentsVisible || checkpointsVisible || problemsVisible || runCenterVisible || debugVisible || teamVisible;
    if (switchingToChat) {
      closeUtilityPanels();
      setTeamVisible(false);
      setSidebarVisible(true);
    } else if (utilityOpen) {
      closeUtilityPanels();
      setTeamVisible(false);
      setSidebarVisible(true);
    } else {
      setSidebarVisible((prev) => !prev);
    }
    if (window.innerWidth <= 860) {
      captureDrawerTrigger();
      setSidebarVisible(false);
      setTeamVisible(false);
      setTerminalVisible(false);
      closeUtilityPanels();
    }
    setChatFocusNonce((value) => value + 1);
  }, [agentsVisible, captureDrawerTrigger, checkpointsVisible, closeUtilityPanels, debugVisible, gitVisible, problemsVisible, runCenterVisible, teamVisible, workspaceView]);

  const toggleChatPanel = useCallback(() => {
    const nextOpen = !chatVisible;
    if (nextOpen && window.innerWidth <= 860) {
      captureDrawerTrigger();
      setSidebarVisible(false);
      setTeamVisible(false);
      setTerminalVisible(false);
      closeUtilityPanels();
    }
    setChatVisible(nextOpen);
  }, [captureDrawerTrigger, chatVisible, closeUtilityPanels]);

  const handleToggleAiAssistant = useCallback(() => {
    if (workspaceView === "files") {
      setRunDetailsVisible(false);
      setEditorAssistantVisible((prev) => !prev);
    } else {
      toggleChatPanel();
    }
  }, [workspaceView, toggleChatPanel]);

  const toggleExplorerPanel = useCallback(() => {
    const switchingToFiles = workspaceView !== "files";
    setWorkspaceView("files");
    if (switchingToFiles && window.innerWidth > 1180) setEditorAssistantVisible(true);
    const utilityOpen =
      gitVisible || agentsVisible || checkpointsVisible || problemsVisible || runCenterVisible || debugVisible;
    const nextOpen = switchingToFiles || utilityOpen ? true : !sidebarVisible;
    if (nextOpen) setTeamVisible(false);
    if (nextOpen && window.innerWidth <= 1100) {
      captureDrawerTrigger();
      setTerminalVisible(false);
      if (window.innerWidth <= 860) setChatVisible(false);
    }
    closeUtilityPanels();
    setSidebarVisible(nextOpen);
  }, [agentsVisible, captureDrawerTrigger, checkpointsVisible, closeUtilityPanels, debugVisible, gitVisible, problemsVisible, runCenterVisible, sidebarVisible, workspaceView]);

  const toggleUtilityPanel = useCallback(
    (
      panel: "git" | "agents" | "checkpoints" | "problems" | "run-center" | "debug",
      forceOpen = false
    ) => {
      const isOpen =
        panel === "git"
          ? gitVisible
          : panel === "agents"
            ? agentsVisible
            : panel === "checkpoints"
              ? checkpointsVisible
              : panel === "problems"
                ? problemsVisible
                : panel === "run-center"
                  ? runCenterVisible
                  : debugVisible;
      const nextOpen = forceOpen || !isOpen;
      if (nextOpen) {
        setSidebarVisible(false);
        setTeamVisible(false);
        if (window.innerWidth <= 1100) {
          captureDrawerTrigger();
          setTerminalVisible(false);
        }
        if (window.innerWidth <= 860) {
          setChatVisible(false);
        }
      }
      setGitVisible(panel === "git" && nextOpen);
      setAgentsVisible(panel === "agents" && nextOpen);
      setCheckpointsVisible(panel === "checkpoints" && nextOpen);
      setProblemsVisible(panel === "problems" && nextOpen);
      setRunCenterVisible(panel === "run-center" && nextOpen);
      setDebugVisible(panel === "debug" && nextOpen);
    },
    [agentsVisible, captureDrawerTrigger, checkpointsVisible, debugVisible, gitVisible, problemsVisible, runCenterVisible]
  );

  const toggleTeamPanel = useCallback((forceOpen = false) => {
    const nextOpen = forceOpen || !teamVisible;
    if (nextOpen) {
      setSidebarVisible(false);
      closeUtilityPanels();
    }
    if (nextOpen && window.innerWidth <= 1100) {
      captureDrawerTrigger();
      setTerminalVisible(false);
      if (window.innerWidth <= 860) setChatVisible(false);
    }
    setTeamVisible(nextOpen);
  }, [captureDrawerTrigger, closeUtilityPanels, teamVisible]);

  const toggleTerminalPanel = useCallback((forceOpen = false) => {
    const nextOpen = forceOpen || !terminalVisible;
    if (nextOpen && window.innerWidth <= 1100) {
      captureDrawerTrigger();
      setSidebarVisible(false);
      setTeamVisible(false);
      closeUtilityPanels();
      if (window.innerWidth <= 860) setChatVisible(false);
    }
    setTerminalVisible(nextOpen);
  }, [captureDrawerTrigger, closeUtilityPanels, terminalVisible]);

  const runPaletteCommand = useCallback(
    (command: string) => {
      switch (command) {
        case "format-document":
          void editorRef.current?.getAction("format-python-document")?.run();
          break;
        case "focus":
          toggleFocusMode();
          break;
        case "explorer":
          toggleExplorerPanel();
          break;
        case "terminal":
          toggleTerminalPanel();
          break;
        case "chat":
          toggleChatPanel();
          break;
        case "new-conversation":
          setChatVisible(true);
          setNewConversationRequest((value) => value + 1);
          break;
        case "history":
          setChatVisible(true);
          setChatHistoryRequest((value) => value + 1);
          break;
        case "settings":
        case "mcp":
        case "knowledge":
          setSettingsVisible(true);
          break;
        case "git":
          toggleUtilityPanel("git", true);
          break;
        case "agents":
          toggleUtilityPanel("agents", true);
          break;
        case "checkpoints":
          toggleUtilityPanel("checkpoints", true);
          break;
        case "problems":
          toggleUtilityPanel("problems", true);
          break;
        case "run-center":
          toggleUtilityPanel("run-center", true);
          break;
        case "debug":
          toggleUtilityPanel("debug", true);
          break;
        case "team":
          toggleTeamPanel(true);
          break;
        default:
          break;
      }
    },
    [toggleChatPanel, toggleExplorerPanel, toggleFocusMode, toggleTeamPanel, toggleTerminalPanel, toggleUtilityPanel]
  );

  const isMobileViewport = viewportWidth <= 640;
  const isTabletOrMobile = viewportWidth <= 860;
  const activeWorkspaceDrawer = isTabletOrMobile
    ? teamVisible
      ? "team"
      : agentsVisible
        ? "agents"
        : gitVisible
          ? "git"
          : checkpointsVisible
            ? "checkpoints"
            : problemsVisible
              ? "problems"
              : runCenterVisible
                ? "run-center"
                : debugVisible
                  ? "debug"
                  : isMobileViewport && sidebarVisible
                    ? "sidebar"
                    : isMobileViewport && chatVisible
                      ? "chat"
                      : null
    : null;
  const workspaceDrawerOpen = activeWorkspaceDrawer !== null;
  const compactModalDrawerOpen = isTabletOrMobile && (agentsVisible || teamVisible || gitVisible);
  const previousCompactWorkspaceRef = useRef(isMobileViewport);

  useEffect(() => {
    const becameMobile = isMobileViewport && !previousCompactWorkspaceRef.current;
    previousCompactWorkspaceRef.current = isMobileViewport;
    if (!becameMobile) return;
    setSidebarVisible(activeWorkspaceDrawer === "sidebar");
    setTeamVisible(activeWorkspaceDrawer === "team");
    setAgentsVisible(activeWorkspaceDrawer === "agents");
    setGitVisible(activeWorkspaceDrawer === "git");
    setCheckpointsVisible(activeWorkspaceDrawer === "checkpoints");
    setProblemsVisible(activeWorkspaceDrawer === "problems");
    setRunCenterVisible(activeWorkspaceDrawer === "run-center");
    setDebugVisible(activeWorkspaceDrawer === "debug");
    if (narrowWorkspace) setChatVisible(activeWorkspaceDrawer === "chat");
  }, [activeWorkspaceDrawer, isMobileViewport, narrowWorkspace]);

  const closeWorkspaceDrawers = useCallback(() => {
    if (isMobileViewport) {
      setSidebarVisible(false);
      setChatVisible(false);
    }
    setTeamVisible(false);
    closeUtilityPanels();
  }, [closeUtilityPanels, isMobileViewport]);

  useEffect(() => {
    const previousDrawer = previousDrawerRef.current;
    previousDrawerRef.current = activeWorkspaceDrawer;

    if (activeWorkspaceDrawer && activeWorkspaceDrawer !== previousDrawer) {
      requestAnimationFrame(() => {
        const drawer = document.querySelector<HTMLElement>(
          `[data-workspace-drawer="${activeWorkspaceDrawer}"]`
        );
        drawer?.focus();
      });
      return;
    }

    if (!activeWorkspaceDrawer && previousDrawer) {
      requestAnimationFrame(() => {
        const storedTrigger = drawerTriggerRef.current && document.contains(drawerTriggerRef.current)
          ? drawerTriggerRef.current
          : null;
        const matchingTriggers = Array.from(
          document.querySelectorAll<HTMLElement>(`[data-drawer-trigger="${previousDrawer}"]`)
        );
        const trigger = storedTrigger && storedTrigger.offsetParent !== null
          ? storedTrigger
          : matchingTriggers.find((candidate) => candidate.offsetParent !== null)
            || document.querySelector<HTMLElement>(".titlebar-mobile-command");
        trigger?.focus();
        drawerTriggerRef.current = null;
      });
    }
  }, [activeWorkspaceDrawer]);

  useEffect(() => {
    const layout = mainLayoutRef.current;
    if (!layout) return;
    const clearBoundaries = () => {
      layout.querySelectorAll<HTMLElement>('[data-compact-modal-inert="true"]').forEach((element) => {
        element.removeAttribute("inert");
        element.removeAttribute("aria-hidden");
        element.removeAttribute("data-compact-modal-inert");
      });
    };
    const applyBoundaries = () => {
      clearBoundaries();
      if (!compactModalDrawerOpen || !activeWorkspaceDrawer) return;
      const activeDrawer = layout.querySelector<HTMLElement>(`[data-workspace-drawer="${activeWorkspaceDrawer}"]`);
      if (!activeDrawer) return;
      const isolate = (container: HTMLElement) => {
        Array.from(container.children).forEach((child) => {
          if (!(child instanceof HTMLElement) || child.classList.contains("mobile-drawer-scrim")) return;
          if (child === activeDrawer) return;
          if (child.contains(activeDrawer)) { isolate(child); return; }
          child.setAttribute("inert", "");
          child.setAttribute("aria-hidden", "true");
          child.setAttribute("data-compact-modal-inert", "true");
        });
      };
      isolate(layout);
    };
    applyBoundaries();
    const observer = new MutationObserver(applyBoundaries);
    observer.observe(layout, { childList: true, subtree: true });
    return () => { observer.disconnect(); clearBoundaries(); };
  }, [activeWorkspaceDrawer, compactModalDrawerOpen]);

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
        setMergeSelections({});
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
    agentsVisible,
    chatVisible,
    checkpointsVisible,
    problemsVisible,
    runCenterVisible,
    debugVisible,
    commandPaletteVisible,
    closeWorkspaceDrawers,
    diffViewerPath,
    gitVisible,
    settingsVisible,
    sidebarVisible,
    teamVisible,
    workspaceSearchVisible,
    workspaceDrawerOpen,
    editorAssistantVisible,
    runDetailsVisible,
    viewportWidth,
  ]);


  const handleEditorViewStateChange = useCallback(
    (path: string, viewState: monaco.editor.ICodeEditorViewState | null) => {
      editorViewStatesRef.current[path] = viewState;
    },
    []
  );

  // --- Resize drag handling ---
  const handleResizeStart = useCallback(
    (panel: "sidebar" | "assistant" | "chat", e: React.MouseEvent) => {
      if (e.button !== 0 || viewportWidth <= 780) return;
      e.preventDefault();
      draggingRef.current = panel;
      setDraggingPanel(panel);
      startXRef.current = e.clientX;
      startWidthRef.current = panel === "sidebar"
        ? effectiveSidebarWidth
        : panel === "assistant" ? effectiveAssistantWidth : chatWidth;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [chatWidth, effectiveAssistantWidth, effectiveSidebarWidth, viewportWidth]
  );

  const handlePanelResizeKeyDown = useCallback((panel: "sidebar" | "assistant", event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 40 : 16;
    let next: number;
    if (event.key === "Home") next = panel === "sidebar" ? FILES_SIDEBAR_MIN_WIDTH : FILES_ASSISTANT_MIN_WIDTH;
    else if (event.key === "End") next = panel === "sidebar" ? sidebarMaxWidth : assistantMaxWidth;
    else if (event.key === "ArrowLeft") next = panel === "sidebar" ? effectiveSidebarWidth - step : effectiveAssistantWidth + step;
    else if (event.key === "ArrowRight") next = panel === "sidebar" ? effectiveSidebarWidth + step : effectiveAssistantWidth - step;
    else return;
    event.preventDefault();
    if (panel === "sidebar") {
      setSidebarWidth(Math.max(FILES_SIDEBAR_MIN_WIDTH, Math.min(sidebarMaxWidth, next)));
    } else {
      setAssistantWidth(Math.max(FILES_ASSISTANT_MIN_WIDTH, Math.min(assistantMaxWidth, next)));
    }
  }, [assistantMaxWidth, effectiveAssistantWidth, effectiveSidebarWidth, sidebarMaxWidth]);

  const handleTerminalResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = "terminal";
      setDraggingPanel("terminal");
      startYRef.current = e.clientY;
      startHeightRef.current = terminalHeight;
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [terminalHeight]
  );

  const adjustTerminalHeight = useCallback((delta: number) => {
    const maxHeight = Math.max(260, Math.min(680, window.innerHeight - 140));
    setTerminalHeight((height) => Math.max(160, Math.min(maxHeight, height + delta)));
  }, []);

  const handleTerminalResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowUp") {
        event.preventDefault();
        adjustTerminalHeight(24);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        adjustTerminalHeight(-24);
      } else if (event.key === "Home") {
        event.preventDefault();
        setTerminalHeight(160);
      } else if (event.key === "End") {
        event.preventDefault();
        setTerminalHeight(Math.max(260, Math.min(680, window.innerHeight - 140)));
      }
    },
    [adjustTerminalHeight]
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const delta = e.clientX - startXRef.current;
      if (draggingRef.current === "sidebar") {
        const layout = mainLayoutRef.current;
        const width = layout?.clientWidth || window.innerWidth;
        const rightWidth = window.innerWidth > 1180 && (layout?.classList.contains("with-run-details") || layout?.classList.contains("with-editor-assistant"))
          ? panelWidthsRef.current.assistant
          : 0;
        const maxWidth = Math.max(FILES_SIDEBAR_MIN_WIDTH, Math.min(
          FILES_SIDEBAR_MAX_WIDTH,
          width - FILES_ACTIVITY_WIDTH - FILES_HANDLE_WIDTH
            - (rightWidth ? rightWidth + FILES_HANDLE_WIDTH : 0)
            - FILES_EDITOR_MIN_WIDTH
        ));
        setSidebarWidth(Math.max(FILES_SIDEBAR_MIN_WIDTH, Math.min(maxWidth, startWidthRef.current + delta)));
      } else if (draggingRef.current === "assistant") {
        const width = mainLayoutRef.current?.clientWidth || window.innerWidth;
        const maxWidth = window.innerWidth > 1180
          ? Math.max(FILES_ASSISTANT_MIN_WIDTH, Math.min(
              FILES_ASSISTANT_MAX_WIDTH,
              width - FILES_ACTIVITY_WIDTH
                - (panelWidthsRef.current.sidebar ? panelWidthsRef.current.sidebar + FILES_HANDLE_WIDTH : 0)
                - FILES_HANDLE_WIDTH - FILES_EDITOR_MIN_WIDTH
            ))
          : Math.min(FILES_ASSISTANT_MAX_WIDTH, Math.max(FILES_ASSISTANT_MIN_WIDTH, width - FILES_ACTIVITY_WIDTH));
        setAssistantWidth(Math.max(FILES_ASSISTANT_MIN_WIDTH, Math.min(maxWidth, startWidthRef.current - delta)));
      } else if (draggingRef.current === "chat") {
        setChatWidth(Math.max(250, Math.min(600, startWidthRef.current - delta)));
      } else {
        const verticalDelta = startYRef.current - e.clientY;
        const maxHeight = Math.max(260, Math.min(680, window.innerHeight - 140));
        setTerminalHeight(
          Math.max(160, Math.min(maxHeight, startHeightRef.current + verticalDelta))
        );
      }
    };
    const onMouseUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = null;
      setDraggingPanel(null);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("blur", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("blur", onMouseUp);
      draggingRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);

  // --- Load file tree ---
  const loadTree = useCallback(async () => {
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
    setProblemCounts({ errors: 0, warnings: 0 });
    setActiveRunLabel(null);
    editorViewStatesRef.current = {};
    setEditorNavigationTarget(null);
    setEditorHighlightTarget(null);
    loadTree();
  }, [loadTree, workspaceDir]);

  const applyFileUpdateToTabs = useCallback(
    (update: FileUpdate, ensureOpen: boolean) => {
      const canonicalPath = normalizeWorkspaceRelativePath(update.path, workspaceDir);
      const name = canonicalPath.split("/").pop() || canonicalPath;
      const nextFile: OpenFile = {
        path: canonicalPath,
        name,
        content: update.content,
        language: getLanguage(name),
        modified: false,
        version: undefined,
        updatedAt: undefined,
        ...buildClearedRemoteState(),
      };

      setOpenFiles((prev) => {
        const existingIndex = prev.findIndex((file) => isSameWorkspacePath(file.path, canonicalPath, workspaceDir));
        if (existingIndex >= 0) {
          return prev.map((file, idx) => (idx === existingIndex ? nextFile : file));
        }
        return ensureOpen ? [...prev, nextFile] : prev;
      });
    },
    [workspaceDir]
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
      void (async () => {
        try {
          const next = await fs.readFileWithMeta(update.path);
          setOpenFiles((prev) =>
            prev.map((file) =>
              file.path === update.path
                ? {
                  ...file,
                  content: next.content,
                  version: next.version,
                  updatedAt: next.updatedAt,
                  ...buildClearedRemoteState(),
                }
              : file
            )
          );
        } catch {
          // best effort only
        }
      })();
    },
    [activeFilePath, applyFileUpdateToTabs, fs, loadTree]
  );

  const handleNavigateToFileUpdate = useCallback(
    (update: FileUpdate) => {
      setWorkspaceView("files");
      applyFileUpdateToTabs(update, true);
      setActiveFilePath(update.path);
      void loadTree();
      void (async () => {
        try {
          const next = await fs.readFileWithMeta(update.path);
          setOpenFiles((prev) =>
            prev.map((file) =>
              file.path === update.path
                ? {
                  ...file,
                  content: next.content,
                  version: next.version,
                  updatedAt: next.updatedAt,
                  ...buildClearedRemoteState(),
                }
              : file
            )
          );
        } catch {
          // best effort only
        }
      })();

      if (!update.selection) return;
      navigationRequestRef.current += 1;
      setEditorNavigationTarget({
        path: update.path,
        requestId: navigationRequestRef.current,
        ...update.selection,
      });
    },
    [applyFileUpdateToTabs, fs, loadTree]
  );

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

  const chatAttachmentDraft = useChatAttachmentDraft(token);
  const [chatDraftText, setChatDraftText] = useState("");
  const [attachmentSubmissionError, setAttachmentSubmissionError] = useState<string | null>(null);
  const [attachmentSubmissionNotice, setAttachmentSubmissionNotice] = useState<string | null>(null);
  const [pendingAttachmentVerificationIds, setPendingAttachmentVerificationIds] = useState<Set<string>>(() => new Set());
  const [attachmentRetryRequests, setAttachmentRetryRequests] = useState<Array<{ requestId: string; content: string; attachmentIds: string[] }>>([]);
  const handleAttachmentSendRejected = useCallback((rejected: RejectedAttachmentSend) => {
    chatAttachmentDraft.restore(rejected.attachments);
    setChatDraftText((current) => rejected.content
      ? current ? `${rejected.content}\n\n${current}` : rejected.content
      : current);
    setAttachmentSubmissionError(rejected.error);
    setAttachmentSubmissionNotice(null);
    if (rejected.uncertain) {
      setPendingAttachmentVerificationIds((current) => new Set(current).add(rejected.requestId));
    } else {
      setAttachmentRetryRequests((current) => [
        ...current.filter((item) => item.requestId !== rejected.requestId),
        { requestId: rejected.requestId, content: rejected.content, attachmentIds: rejected.attachments.map((attachment) => attachment.id) },
      ]);
    }
  }, [chatAttachmentDraft.restore]);
  const handleAttachmentSendReconciled = useCallback((result: AttachmentSendReconciliation) => {
    if (result.status === "persisted" || result.status === "missing") {
      setPendingAttachmentVerificationIds((current) => {
        const next = new Set(current);
        next.delete(result.requestId);
        return next;
      });
    }
    if (result.status === "persisted") {
      setAttachmentRetryRequests((current) => current.filter((item) => item.requestId !== result.requestId));
      chatAttachmentDraft.removeRefs(result.attachments.map((attachment) => attachment.id));
      if (result.content) {
        setChatDraftText((current) => {
          if (current === result.content) return "";
          if (current.startsWith(`${result.content}\n\n`)) return current.slice(result.content.length + 2);
          if (current.endsWith(`\n\n${result.content}`)) return current.slice(0, -result.content.length - 2);
          const middle = `\n\n${result.content}\n\n`;
          return current.includes(middle) ? current.replace(middle, "\n\n") : current;
        });
      }
      setAttachmentSubmissionError(null);
      setAttachmentSubmissionNotice(t("chat.attachmentFoundInHistory"));
    } else if (result.status === "missing") {
      setAttachmentRetryRequests((current) => [
        ...current.filter((item) => item.requestId !== result.requestId),
        { requestId: result.requestId, content: result.content, attachmentIds: result.attachments.map((attachment) => attachment.id) },
      ]);
      setAttachmentSubmissionError(t("chat.attachmentUnknownSafeRetry"));
      setAttachmentSubmissionNotice(null);
    } else {
      setAttachmentSubmissionError(t(result.status === "processing"
        ? "chat.attachmentStillProcessing"
        : "chat.attachmentStatusUnavailable"));
      setAttachmentSubmissionNotice(null);
    }
  }, [chatAttachmentDraft.removeRefs, t]);
  const chat = useChat(token, workspaceDir, handleAiFileUpdate, handleAttachmentSendRejected, handleAttachmentSendReconciled);
  const selectedChatModelName = chat.selectedModelName
    || chat.runtimeOptions.modeModels[chat.agentMode]
    || chat.runtimeOptions.defaultModelName;
  const selectedChatModelCapabilities = chat.runtimeOptions.modelInputCapabilities[selectedChatModelName];
  const draftReadyAttachmentIds = new Set(chatAttachmentDraft.readyRefs.map((attachment) => attachment.id));
  const matchingAttachmentRetries = attachmentRetryRequests.filter((entry) =>
    entry.attachmentIds.some((id) => draftReadyAttachmentIds.has(id))
  );
  const draftAttachmentIdsInOrder = chatAttachmentDraft.readyRefs.map((attachment) => attachment.id);
  const matchingRetryIsUnchanged = matchingAttachmentRetries.length === 1
    && chatDraftText.trim() === matchingAttachmentRetries[0].content
    && draftAttachmentIdsInOrder.length === matchingAttachmentRetries[0].attachmentIds.length
    && draftAttachmentIdsInOrder.every((id, index) => id === matchingAttachmentRetries[0].attachmentIds[index]);
  const editedRetryNotice = matchingAttachmentRetries.length === 1 && !matchingRetryIsUnchanged
    ? t("chat.attachmentEditedNewRequest")
    : null;
  const attachmentWarning = pendingAttachmentVerificationIds.size > 0
    ? attachmentSubmissionError || t("chat.attachmentCheckingHistory")
    : matchingAttachmentRetries.length > 1
      ? t("chat.attachmentMultipleRetries")
      : chatAttachmentDraft.readyRefs.some((attachment) => attachment.kind === "image")
    && selectedChatModelCapabilities?.supportsImageInput === false
    ? t("chat.attachmentImageUnsupported")
    : chatAttachmentDraft.readyRefs.some((attachment) => attachment.kind === "pdf")
      && selectedChatModelCapabilities?.supportsPdfInput === false
      ? t("chat.attachmentPdfUnsupported")
      : null;

  const clearChatConversation = useCallback(() => {
    chatAttachmentDraft.clear();
    setChatDraftText("");
    setAttachmentSubmissionError(null);
    setAttachmentSubmissionNotice(null);
    setPendingAttachmentVerificationIds(new Set());
    setAttachmentRetryRequests([]);
    chat.clearMessages();
  }, [chatAttachmentDraft.clear, chat.clearMessages]);
  const loadChatConversation = useCallback((conversationId: string) => {
    chatAttachmentDraft.clear();
    setChatDraftText("");
    setAttachmentSubmissionError(null);
    setAttachmentSubmissionNotice(null);
    setPendingAttachmentVerificationIds(new Set());
    setAttachmentRetryRequests([]);
    return chat.loadConversation(conversationId);
  }, [chatAttachmentDraft.clear, chat.loadConversation]);
  const previousChatConversationIdRef = useRef(chat.currentConversationId);
  useEffect(() => {
    const previousId = previousChatConversationIdRef.current;
    if (previousId !== chat.currentConversationId && previousId !== null) {
      chatAttachmentDraft.clear();
      setChatDraftText("");
      setAttachmentSubmissionError(null);
      setAttachmentSubmissionNotice(null);
      setPendingAttachmentVerificationIds(new Set());
      setAttachmentRetryRequests([]);
    }
    previousChatConversationIdRef.current = chat.currentConversationId;
  }, [chat.currentConversationId, chatAttachmentDraft.clear]);
  useEffect(() => {
    chatAttachmentDraft.clear();
    setChatDraftText("");
    setAttachmentSubmissionError(null);
    setAttachmentSubmissionNotice(null);
    setPendingAttachmentVerificationIds(new Set());
    setAttachmentRetryRequests([]);
  }, [workspaceDir, chatAttachmentDraft.clear]);

  useEffect(() => {
    if (workspaceView !== "files" || chat.pendingApprovals.length === 0) return;
    setRunDetailsVisible(false);
    setEditorAssistantVisible(true);
  }, [chat.pendingApprovals.length, workspaceView]);
  const switchConversation = useCallback(
    (direction: -1 | 1) => {
      if (chat.isStreaming || chat.conversations.length === 0) return;
      const currentIndex = chat.conversations.findIndex(
        (conversation) => conversation.id === chat.currentConversationId
      );
      const startIndex = currentIndex >= 0 ? currentIndex : 0;
      const nextIndex = (startIndex + direction + chat.conversations.length) % chat.conversations.length;
      void loadChatConversation(chat.conversations[nextIndex].id);
    },
    [chat, loadChatConversation]
  );
  const team = useTeam(token, workspaceDir, (nextWorkspace) => {
    if (nextWorkspace !== workspaceDir) {
      void onChangeWorkspace(nextWorkspace);
    }
  });
  const readOnlyWorkspace = isReadOnlyTeamRole(team.activeTeam?.role);
  const activeClaim =
    activeFilePath && team.activeTeam
      ? team.activeTeam.claims.find((claim) => claim.path === activeFilePath) || null
      : null;
  const activeCollaborators =
    activeFilePath && team.activeTeam
      ? team.activeTeam.presence.filter(
          (entry) =>
            entry.online &&
            entry.username !== username &&
            entry.activeFilePath === activeFilePath
        )
      : [];

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

  // --- File operations ---
  const openFile = useCallback(
    async (rawPath: string) => {
      setWorkspaceView("files");
      if (window.innerWidth > 1180) setEditorAssistantVisible(true);
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
    [fs, openFiles, showToast, t, workspaceDir]
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
      setOpenFiles((current) => current.map((file) => file.path === pending.file.path ? { ...file, modified: false, version: result.version, updatedAt: result.updatedAt, ...buildClearedRemoteState() } : file));
      setClaimSaveConfirmation(null);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : t("app.failedToSaveFile");
      setClaimSaveError(message);
      showToast(message);
    } finally {
      setClaimSaveBusy(false);
    }
  }, [claimSaveConfirmation, fs, showToast, t]);

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
    }, []);

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
      if (readOnlyWorkspace) {
        showToast(t("team.readOnlyApplyBlocked"));
        return;
      }
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
    [activeFilePath, readOnlyWorkspace, showToast, t]
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
    setMergeSelections({});
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
    setMergeSelections({});
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
      setMergeSelections({});
    } catch {
      showToast(t("app.failedToSaveFile"));
    }
  }, [activeFilePath, fs, openFiles, showToast, t]);

  // --- Chat: send with file + selection context ---
  const handleChatSend = useCallback(
    (message: string) => {
      if (chatAttachmentDraft.blocked || attachmentWarning) return false;
      const activeFile = openFiles.find((f) => f.path === activeFilePath);
      const context = activeFile
        ? {
            path: activeFile.path,
            content: activeFile.content,
            language: activeFile.language,
            selection: selectionInfo?.text,
            dirty: activeFile.modified,
            selectionRange: selectionInfo
              ? { startLine: selectionInfo.startLine, endLine: selectionInfo.endLine }
              : undefined,
          }
        : undefined;
      const retryRequestId = matchingAttachmentRetries.length === 1
        && message === matchingAttachmentRetries[0].content
        && chatAttachmentDraft.readyRefs.length === matchingAttachmentRetries[0].attachmentIds.length
        && chatAttachmentDraft.readyRefs.every((attachment, index) => attachment.id === matchingAttachmentRetries[0].attachmentIds[index])
        ? matchingAttachmentRetries[0].requestId
        : undefined;
      const sent = chat.sendMessage(message, context, undefined, chatAttachmentDraft.readyRefs, retryRequestId);
      if (sent) {
        if (matchingAttachmentRetries.length) {
          const consumedIds = new Set(matchingAttachmentRetries.map((item) => item.requestId));
          setAttachmentRetryRequests((current) => current.filter((item) => !consumedIds.has(item.requestId)));
        }
        chatAttachmentDraft.clear();
        setChatDraftText("");
        setAttachmentSubmissionError(null);
        setAttachmentSubmissionNotice(null);
      }
      return sent;
    },
    [chat, chatAttachmentDraft.blocked, chatAttachmentDraft.readyRefs, chatAttachmentDraft.clear, attachmentWarning, matchingAttachmentRetries, openFiles, activeFilePath, selectionInfo]
  );

  const handleChatSteer = useCallback(
    (message: string) => {
      if (pendingAttachmentVerificationIds.size > 0) return false;
      const activeFile = openFiles.find((f) => f.path === activeFilePath);
      const context = activeFile
        ? {
            path: activeFile.path,
            content: activeFile.content,
            language: activeFile.language,
            selection: selectionInfo?.text,
            dirty: activeFile.modified,
            selectionRange: selectionInfo
              ? { startLine: selectionInfo.startLine, endLine: selectionInfo.endLine }
              : undefined,
          }
        : undefined;
      return chat.sendSteering(message, context);
    },
    [chat, pendingAttachmentVerificationIds.size, openFiles, activeFilePath, selectionInfo]
  );

  const handleGitReview = useCallback(() => {
    chat.setAgentMode("review");
    focusChat();
    chat.sendMessage(
      "Review the current Git changes. Identify correctness issues, regressions, missing tests, and give findings ordered by severity.",
      undefined,
      "review"
    );
  }, [chat, focusChat]);

  const handleOpenGitDiff = useCallback((path: string) => {
    setGitDiffRequest((current) => ({ path, id: (current?.id || 0) + 1 }));
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

  const handlePickDesktopWorkspace = useCallback(async () => {
    if (pickingWorkspaceRef.current) return;
    if (openFiles.some((file) => file.modified) && !window.confirm(t("app.unsavedWorkspaceSwitch"))) {
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

  // --- Global keyboard shortcuts ---
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
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "j") {
        e.preventDefault();
        toggleChatPanel();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "`") {
        e.preventDefault();
        toggleTerminalPanel();
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
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openCommandPalette, switchConversation, toggleChatPanel, toggleExplorerPanel, toggleFocusMode, toggleTerminalPanel, toggleUtilityPanel]);

  // --- Derived ---
  const activeFile = openFiles.find((f) => f.path === activeFilePath) || null;

  useEffect(() => {
    if (!activeFile || readOnlyWorkspace || !activeFile.version) return;
    if (!activeFile.modified) {
      savedBufferContentRef.current[activeFile.path] = activeFile.content;
      const registeredVersion = collaborationBufferVersionRef.current[activeFile.path];
      if (registeredVersion !== undefined) {
        team.closeBuffer(activeFile.path, registeredVersion);
        delete collaborationBufferVersionRef.current[activeFile.path];
      }
      return;
    }
    const savedContent = savedBufferContentRef.current[activeFile.path];
    if (savedContent === undefined) return;
    const timer = window.setTimeout(() => {
      const version = (collaborationBufferVersionRef.current[activeFile.path] || 0) + 1;
      void Promise.all([sha256Text(activeFile.content), sha256Text(savedContent)]).then(([digest, savedDigest]) => {
        if (team.registerBuffer({ path: activeFile.path, version, digest, savedDigest, baseDigest: savedDigest, revision: activeFile.version! })) {
          collaborationBufferVersionRef.current[activeFile.path] = version;
        }
      }).catch((reason) => showToast(reason instanceof Error ? reason.message : t("collaboration.bufferFailed")));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [activeFile?.content, activeFile?.modified, activeFile?.path, activeFile?.version, readOnlyWorkspace, showToast, t, team.closeBuffer, team.registerBuffer]);

  useEffect(() => {
    if (!activeFile) return;
    const timer = window.setTimeout(() => {
      void chat.contextManifest.preview({
        path: activeFile.path,
        content: activeFile.content,
        language: activeFile.language,
        selection: selectionInfo?.text,
        dirty: activeFile.modified,
        selectionRange: selectionInfo
          ? { startLine: selectionInfo.startLine, endLine: selectionInfo.endLine }
          : undefined,
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [activeFile?.language, activeFile?.modified, activeFile?.path, chat.contextManifest.preview, selectionInfo?.endLine, selectionInfo?.startLine, selectionInfo?.text]);
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
    if (!compareFile || !compareScrollLinked) return;
    const primary = editorRef.current;
    const reference = compareEditorRef.current;
    if (!primary || !reference) return;

    const expectedScroll = new Map<
      monaco.editor.IStandaloneCodeEditor,
      { scrollTop?: number; scrollLeft?: number }
    >();
    const mirrorScroll = (
      source: monaco.editor.IStandaloneCodeEditor,
      target: monaco.editor.IStandaloneCodeEditor,
      syncVertical: boolean,
      syncHorizontal: boolean
    ) => {
      const sourceLayout = source.getLayoutInfo();
      const targetLayout = target.getLayoutInfo();
      const sourceVerticalRange = Math.max(0, source.getScrollHeight() - sourceLayout.height);
      const targetVerticalRange = Math.max(0, target.getScrollHeight() - targetLayout.height);
      const sourceHorizontalRange = Math.max(0, source.getScrollWidth() - sourceLayout.contentWidth);
      const targetHorizontalRange = Math.max(0, target.getScrollWidth() - targetLayout.contentWidth);
      const position = {
        ...(syncVertical
          ? { scrollTop: sourceVerticalRange > 0
              ? (source.getScrollTop() / sourceVerticalRange) * targetVerticalRange
              : 0 }
          : {}),
        ...(syncHorizontal
          ? { scrollLeft: sourceHorizontalRange > 0
              ? (source.getScrollLeft() / sourceHorizontalRange) * targetHorizontalRange
              : 0 }
          : {}),
      };
      const changesVertical = position.scrollTop !== undefined &&
        Math.abs(position.scrollTop - target.getScrollTop()) > 0.5;
      const changesHorizontal = position.scrollLeft !== undefined &&
        Math.abs(position.scrollLeft - target.getScrollLeft()) > 0.5;
      if (!changesVertical && !changesHorizontal) return;
      expectedScroll.set(target, position);
      target.setScrollPosition(position);
    };

    const listen = (
      source: monaco.editor.IStandaloneCodeEditor,
      target: monaco.editor.IStandaloneCodeEditor
    ) => source.onDidScrollChange((event) => {
      const expected = expectedScroll.get(source);
      if (expected) {
        const matchesTop = expected.scrollTop === undefined || Math.abs(expected.scrollTop - event.scrollTop) <= 0.5;
        const matchesLeft = expected.scrollLeft === undefined || Math.abs(expected.scrollLeft - event.scrollLeft) <= 0.5;
        expectedScroll.delete(source);
        if (matchesTop && matchesLeft) return;
      }
      mirrorScroll(source, target, event.scrollTopChanged, event.scrollLeftChanged);
    });
    const primaryScroll = listen(primary, reference);
    const referenceScroll = listen(reference, primary);
    mirrorScroll(primary, reference, true, true);
    return () => {
      primaryScroll.dispose();
      referenceScroll.dispose();
    };
  }, [compareEditorMountVersion, compareFile, compareScrollLinked]);

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

  // 预览分栏模式双向同步滚动（支持 Markdown 与 JSON 视觉解析器）
  useEffect(() => {
    if (activePreviewMode !== "split" || !activeFile) {
      return;
    }

    const editor = editorRef.current;
    const previewContainer = previewPaneRef.current;
    if (!editor || !previewContainer) {
      return;
    }

    const findScrollableElement = (): HTMLElement | null => {
      if (!previewContainer) return null;
      const candidates = [
        previewContainer.querySelector<HTMLElement>(".json-preview-tree"),
        previewContainer.querySelector<HTMLElement>(".external-markdown-preview"),
        previewContainer.querySelector<HTMLElement>(".file-preview-surface"),
        previewContainer.querySelector<HTMLElement>("[data-scroll-container]"),
      ];
      for (const el of candidates) {
        if (el && el.scrollHeight > el.clientHeight) return el;
      }
      const all = previewContainer.querySelectorAll<HTMLElement>("*");
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (el.scrollHeight > el.clientHeight + 2) {
          const style = window.getComputedStyle(el);
          if (style.overflowY === "auto" || style.overflowY === "scroll") {
            return el;
          }
        }
      }
      if (previewContainer.scrollHeight > previewContainer.clientHeight) {
        return previewContainer;
      }
      return candidates.find(Boolean) || (previewContainer.firstElementChild as HTMLElement) || previewContainer;
    };

    let scrollEl = findScrollableElement();

    const clearSyncTimer = () => {
      if (syncScrollTimerRef.current !== null) {
        window.cancelAnimationFrame(syncScrollTimerRef.current);
        syncScrollTimerRef.current = null;
      }
    };

    // 1. Monaco 编辑器滚动 -> 驱动预览侧滚动
    const handleEditorScroll = editor.onDidScrollChange((event) => {
      if (!event.scrollTopChanged) return;
      if (isSyncingScrollRef.current === "preview") return;

      if (!scrollEl || scrollEl.scrollHeight <= scrollEl.clientHeight) {
        scrollEl = findScrollableElement();
      }
      if (!scrollEl) return;

      const editorScrollable = editor.getScrollHeight() - editor.getLayoutInfo().height;
      const previewScrollable = scrollEl.scrollHeight - scrollEl.clientHeight;
      if (editorScrollable <= 0 || previewScrollable <= 0) return;

      const ratio = editor.getScrollTop() / editorScrollable;
      const targetScrollTop = ratio * previewScrollable;

      if (Math.abs(scrollEl.scrollTop - targetScrollTop) > 1) {
        isSyncingScrollRef.current = "editor";
        scrollEl.scrollTop = targetScrollTop;
        clearSyncTimer();
        syncScrollTimerRef.current = window.requestAnimationFrame(() => {
          isSyncingScrollRef.current = null;
        });
      }
    });

    // 2. 预览侧滚动 -> 驱动 Monaco 编辑器滚动 (使用 capture 监听捕获子元素滚动)
    const handlePreviewScroll = (e: Event) => {
      if (isSyncingScrollRef.current === "editor") return;
      const target = (e.target as HTMLElement) || scrollEl;
      if (!target || target === editor.getDomNode()?.parentElement) return;

      const previewScrollable = target.scrollHeight - target.clientHeight;
      const editorScrollable = editor.getScrollHeight() - editor.getLayoutInfo().height;
      if (previewScrollable <= 0 || editorScrollable <= 0) return;

      const ratio = target.scrollTop / previewScrollable;
      const targetScrollTop = ratio * editorScrollable;

      if (Math.abs(editor.getScrollTop() - targetScrollTop) > 1) {
        isSyncingScrollRef.current = "preview";
        editor.setScrollTop(targetScrollTop);
        clearSyncTimer();
        syncScrollTimerRef.current = window.requestAnimationFrame(() => {
          isSyncingScrollRef.current = null;
        });
      }
    };

    previewContainer.addEventListener("scroll", handlePreviewScroll, {
      capture: true,
      passive: true,
    });

    return () => {
      handleEditorScroll.dispose();
      previewContainer.removeEventListener("scroll", handlePreviewScroll, {
        capture: true,
      });
      clearSyncTimer();
      isSyncingScrollRef.current = null;
    };
  }, [activeFile?.path, activeFile?.content, activePreviewMode, editorRef]);
  const activeConflictFile =
    activeFile && activeFile.remoteUpdated && activeFile.modified ? activeFile : null;
  const diffViewerFile =
    diffViewerPath ? openFiles.find((file) => file.path === diffViewerPath) || null : null;
  const closeDiffViewer = useCallback(() => {
    setDiffViewerPath(null);
    setMergeSelections({});
  }, []);
  const diffDialogRef = useModalDialogFocus<HTMLDivElement>({
    open: Boolean(diffViewerFile?.remoteContent !== undefined),
    onClose: closeDiffViewer,
  });
  const conflictSourceMessage = diffViewerFile ? getConflictSourceMessage(diffViewerFile) : null;
  const conflictHunks = useMemo(
    () =>
      diffViewerFile?.remoteContent !== undefined
        ? buildConflictHunks(diffViewerFile.content, diffViewerFile.remoteContent)
        : [],
    [diffViewerFile?.content, diffViewerFile?.remoteContent]
  );
  const activeConflictSourceMessage = activeConflictFile
    ? getConflictSourceMessage(activeConflictFile)
    : null;
  const workspaceLabel = workspaceDir.split(/[\\/]/).filter(Boolean).pop() || workspaceDir;

  useEffect(() => {
    if (!diffViewerFile || diffViewerFile.remoteContent === undefined) {
      setMergeSelections({});
      return;
    }

    setMergeSelections((current) => {
      const next: Record<string, "local" | "remote"> = {};
      for (const hunk of conflictHunks) {
        next[hunk.id] = current[hunk.id] || "local";
      }
      return next;
    });
  }, [conflictHunks, diffViewerFile]);

  const mergedConflictContent =
    diffViewerFile && diffViewerFile.remoteContent !== undefined
      ? applyHunkSelections(diffViewerFile.content, conflictHunks, mergeSelections)
      : null;
  const remoteSelectedCount = countRemoteSelections(conflictHunks, mergeSelections);
  const handleUseAllRemoteBlocks = useCallback(() => {
    setMergeSelections(
      Object.fromEntries(
        conflictHunks.map((hunk) => [hunk.id, "remote" as const])
      )
    );
  }, [conflictHunks]);

  const handleKeepAllLocalBlocks = useCallback(() => {
    setMergeSelections(
      Object.fromEntries(
        conflictHunks.map((hunk) => [hunk.id, "local" as const])
      )
    );
  }, [conflictHunks]);

  const handleApplyMergedResult = useCallback(() => {
    if (!diffViewerFile || mergedConflictContent === null) return;
    setOpenFiles((prev) =>
      prev.map((file) =>
        file.path === diffViewerFile.path
          ? {
              ...file,
              content: mergedConflictContent,
              modified: true,
              version: diffViewerFile.remoteVersion ?? file.version,
              updatedAt: diffViewerFile.remoteUpdatedAt ?? file.updatedAt,
              ...buildClearedRemoteState(),
            }
          : file
      )
    );
    setDiffViewerPath(null);
    setMergeSelections({});
    showToast(t("app.mergeApplied"));
  }, [diffViewerFile, mergedConflictContent, showToast, t]);

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
      data-density={viewport.recommendedDensity}
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
        onToggleAiAssistant={handleToggleAiAssistant}
        username={username}
        isAdmin={isAdmin}
        teamRole={team.activeTeam?.role || null}
        theme={theme}
        onToggleTheme={onToggleTheme}
        density={density}
        onToggleDensity={onToggleDensity}
        onOpenSettings={() => setSettingsVisible(true)}
        desktopApp={desktopApp}
        onOpenMobilePairing={() => setMobilePairingVisible(true)}
        onPickDesktopWorkspace={() => void onPickDesktopWorkspace()}
        onLogout={onLogout}
      />

      <Suspense fallback={null}>
        <SettingsModal
          token={token}
          currentUsername={username}
          isAdmin={isAdmin}
          teamRole={team.activeTeam?.role || null}
          readOnlyWorkspace={readOnlyWorkspace}
          workspaceId={workspaceDir}
          visible={settingsVisible}
          editorFont={editorFont}
          editorFontOptions={editorFontOptions}
          onEditorFontChange={onEditorFontChange}
          onClose={() => setSettingsVisible(false)}
          onShowToast={showToast}
        />
        {mobilePairingVisible && !desktopApp && <DesktopMobilePairing token={token} onClose={() => setMobilePairingVisible(false)} onSessionExpired={onSessionExpired} />}
      </Suspense>

      {/* Main Layout */}
      <div
        ref={mainLayoutRef}
        className={`main-layout workbench-view-${workspaceView}${runDetailsVisible ? " with-run-details" : ""}${workspaceView === "files" && editorAssistantVisible && !runDetailsVisible ? " with-editor-assistant" : ""}`}
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
        <nav className="activity-rail" data-compact-modal-background inert={compactWorkspace && (agentsVisible || teamVisible || gitVisible || terminalVisible) ? true : undefined} aria-hidden={compactWorkspace && (agentsVisible || teamVisible || gitVisible || terminalVisible) ? true : undefined} aria-label={t("app.workspace")}>
          <button
            type="button"
            className={`activity-rail-btn${workspaceView === "chat" ? " active" : ""}`}
            onClick={focusChat}
            title={t("workbench.aiTasks")}
            aria-label={t("workbench.aiTasks")}
            aria-pressed={workspaceView === "chat"}
            data-drawer-trigger="chat"
          >
            <MessageSquare size={18} />
          </button>
          <button
            type="button"
            className={`activity-rail-btn${workspaceView === "files" && sidebarVisible ? " active" : ""}`}
            onClick={toggleExplorerPanel}
            title={t("sidebar.explorer")}
            aria-label={t("sidebar.explorer")}
            aria-pressed={workspaceView === "files" && sidebarVisible}
            data-drawer-trigger="sidebar"
          >
            <Files size={18} />
          </button>
          <button
            type="button"
            className="activity-rail-btn"
            onClick={() => {
              setWorkspaceSearchScope("");
              setWorkspaceSearchVisible(true);
            }}
            title={`${t("search.title")} (${platform.isMacOS ? "⇧⌘F" : "Ctrl+Shift+F"})`}
            aria-label={t("search.title")}
          >
            <Search size={18} />
          </button>
          <button
            type="button"
            className={`activity-rail-btn${gitVisible ? " active" : ""}`}
            onClick={() => toggleUtilityPanel("git")}
            title={t("git.title")}
            aria-label={t("git.title")}
            aria-pressed={gitVisible}
            data-drawer-trigger="git"
          >
            <GitBranch size={18} />
            {(chat.currentRunSummary?.changedFiles.length || 0) > 0 && (
              <span className="activity-rail-badge">{chat.currentRunSummary?.changedFiles.length}</span>
            )}
          </button>
          <button
            type="button"
            className={`activity-rail-btn${agentsVisible ? " active" : ""}`}
            onClick={() => toggleUtilityPanel("agents")}
            title={t("agents.title")}
            aria-label={t("agents.title")}
            aria-pressed={agentsVisible}
            data-drawer-trigger="agents"
          >
            <Bot size={18} />
          </button>
          <button
            type="button"
            className={`activity-rail-btn${teamVisible ? " active" : ""}`}
            onClick={() => toggleTeamPanel()}
            title={t("team.title")}
            aria-label={t("team.title")}
            aria-pressed={teamVisible}
            data-drawer-trigger="team"
          >
            <Users size={18} />
            {team.activeTeam && team.activeTeam.onlineCount > 0 && (
              <span className="activity-rail-badge">{team.activeTeam.onlineCount}</span>
            )}
          </button>
          <button
            type="button"
            className={`activity-rail-btn${checkpointsVisible ? " active" : ""}`}
            onClick={() => toggleUtilityPanel("checkpoints")}
            title={t("checkpoint.aria")}
            aria-label={t("checkpoint.aria")}
            aria-pressed={checkpointsVisible}
            data-drawer-trigger="checkpoints"
          >
            <ShieldCheck size={18} />
          </button>
          <button
            type="button"
            className={`activity-rail-btn${problemsVisible ? " active" : ""}`}
            onClick={() => toggleUtilityPanel("problems")}
            title={t("problems.title")}
            aria-label={t("problems.title")}
            aria-pressed={problemsVisible}
            data-drawer-trigger="problems"
          >
            <CircleAlert size={18} />
            {(problemCounts.errors + problemCounts.warnings) > 0 && <span className="activity-rail-badge">{problemCounts.errors + problemCounts.warnings}</span>}
          </button>
          <button
            type="button"
            className={`activity-rail-btn${runCenterVisible ? " active" : ""}`}
            onClick={() => toggleUtilityPanel("run-center")}
            title={t("runCenter.aria")}
            aria-label={t("runCenter.aria")}
            aria-pressed={runCenterVisible}
            data-drawer-trigger="run-center"
          >
            <TestTube2 size={18} />
          </button>
          <button
            type="button"
            className={`activity-rail-btn${debugVisible ? " active" : ""}`}
            onClick={() => toggleUtilityPanel("debug")}
            title={t("debug.aria")}
            aria-label={t("debug.aria")}
            aria-pressed={debugVisible}
            data-drawer-trigger="debug"
          >
            <Bug size={18} />
          </button>
          <button
            type="button"
            className={`activity-rail-btn${terminalVisible ? " active" : ""}`}
            onClick={() => toggleTerminalPanel()}
            title={t("app.toggleTerminal")}
            aria-label={t("app.toggleTerminal")}
            aria-pressed={terminalVisible}
            data-drawer-trigger="terminal"
          >
            <TerminalSquare size={18} />
          </button>
          <span className="activity-rail-spacer" />
          {!desktopApp && <button
            type="button"
            className={`activity-rail-btn${mobilePairingVisible ? " active" : ""}`}
            onClick={() => setMobilePairingVisible(true)}
            title="手机控制台"
            aria-label="手机控制台"
            aria-pressed={mobilePairingVisible}
          >
            <Smartphone size={18} />
          </button>}
          <button
            type="button"
            className="activity-rail-btn"
            onClick={onToggleTheme}
            title={t(theme === "light" ? "app.switchToDarkTheme" : "app.switchToLightTheme")}
            aria-label={t(theme === "light" ? "app.switchToDarkTheme" : "app.switchToLightTheme")}
          >
            {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
          </button>
          <button
            type="button"
            className={`activity-rail-btn${settingsVisible ? " active" : ""}`}
            onClick={() => setSettingsVisible(true)}
            title={t("app.settings")}
            aria-label={t("app.settings")}
            aria-pressed={settingsVisible}
          >
            <Settings size={18} />
          </button>
          <details className="activity-user-menu">
            <summary className="activity-user-avatar" title={username} aria-label={username}>
              {username.slice(0, 1).toUpperCase()}
            </summary>
            <div className="activity-user-popover user-popover-shell">
              <div className="user-popover-header">
                <div className="user-popover-avatar">
                  {username.slice(0, 1).toUpperCase()}
                </div>
                <div className="user-popover-info">
                  <div className="user-popover-name-row">
                    <span className="user-popover-name">{username}</span>
                    <span className="user-popover-badge">{isAdmin ? "管理员" : (team.activeTeam?.role || "成员")}</span>
                  </div>
                  <span className="user-popover-sub">本地离线编码环境</span>
                </div>
              </div>
              <div className="user-popover-divider" />
              <button type="button" onClick={onToggleTheme}>
                {theme === "light" ? <Moon size={15} /> : <Sun size={15} />}
                <span>{t(theme === "light" ? "app.switchToDarkTheme" : "app.switchToLightTheme")}</span>
                <span className="user-popover-hint">{theme === "light" ? "深色" : "浅色"}</span>
              </button>
              <button type="button" onClick={onToggleDensity}>
                <LayoutGrid size={15} />
                <span>{density === "compact" ? "标准视图模式" : "紧凑密度模式"}</span>
              </button>
              <button type="button" onClick={() => setSettingsVisible(true)}>
                <Settings size={15} />
                <span>{t("app.settings")}</span>
                <kbd className="user-popover-kbd">Ctrl+,</kbd>
              </button>
              {!desktopApp && (
                <button type="button" onClick={() => setMobilePairingVisible(true)}>
                  <Smartphone size={15} />
                  <span>手机控制台</span>
                </button>
              )}
              <div className="user-popover-divider" />
              {desktopApp ? (
                <button type="button" onClick={() => void onPickDesktopWorkspace()}>
                  <FolderOpen size={15} />
                  <span>打开工作区…</span>
                </button>
              ) : (
                <button type="button" className="user-popover-logout" onClick={onLogout}>
                  <LogOut size={15} />
                  <span>{t("app.logout")}</span>
                </button>
              )}
            </div>
          </details>
        </nav>
        {isLeftDockOpen && (
          <aside className="workbench-left-dock" aria-label={t("sidebar.explorer")}>
            {gitVisible ? (
              <GitPanel
                key={`git:${workspaceDir}`}
                visible={true}
                token={token}
                workspaceDir={workspaceDir}
                theme={theme}
                drawerMode={compactWorkspace}
                readOnly={readOnlyWorkspace}
                conversationId={chat.currentConversationId}
                runId={chat.runState?.runId || null}
                requestedDiffPath={gitDiffRequest?.path}
                requestedDiffId={gitDiffRequest?.id}
                onOpenFile={openFile}
                onAskReview={handleGitReview}
                onFollowUpCreated={(result) => { showToast(`${t("delivery.taskCreated", { id: result.taskId })} · ${result.followUpRunId.slice(0, 12)}`); }}
                onOpenFollowUpRun={async (followUpRunId) => {
                  await chat.loadRun(followUpRunId);
                  setRunDetailsTab("delivery");
                  setRunDetailsVisible(true);
                  if (compactWorkspace) setGitVisible(false);
                }}
                onClose={() => setGitVisible(false)}
              />
            ) : agentsVisible ? (
              <AgentBoard
                key={`agents:${workspaceDir}`}
                visible={true}
                token={token}
                drawerMode={compactWorkspace}
                onClose={() => setAgentsVisible(false)}
              />
            ) : teamVisible ? (
              <div className="team-sidebar workspace-drawer-host" style={{ height: "100%", width: "100%" }}>
                <Suspense fallback={<div className="panel-loading">{t("common.loading")}</div>}>
                  <TeamPanel
                    teams={team.teams}
                    activeTeam={team.activeTeam}
                    currentUsername={username}
                    connected={team.connected}
                    loading={team.loading}
                    error={team.error}
                    activeFilePath={activeFilePath}
                    collaboration={team.collaboration}
                    drawerMode={compactWorkspace}
                    onClose={() => setTeamVisible(false)}
                    onRefresh={team.refresh}
                    onCreateTeam={async (name) => {
                      try {
                        await team.createTeam(name);
                        showToast(t("team.createdToast", { name }));
                      } catch (error) {
                        showToast(error instanceof Error ? error.message : t("sidebar.operationFailed"));
                        throw error;
                      }
                    }}
                    onJoinTeam={async (code) => {
                      try {
                        const joined = await team.joinTeam(code);
                        showToast(t("team.joinedToast", { name: joined.name }));
                      } catch (error) {
                        showToast(error instanceof Error ? error.message : t("sidebar.operationFailed"));
                        throw error;
                      }
                    }}
                    onSwitchTeam={async (teamId) => {
                      try {
                        const switched = await team.switchTeam(teamId);
                        showToast(t("team.switchedToast", { name: switched.name }));
                      } catch (error) {
                        showToast(error instanceof Error ? error.message : t("sidebar.operationFailed"));
                        throw error;
                      }
                    }}
                    onCreateInvite={async (teamId, role: TeamRole) => {
                      try {
                        const invite = await team.createInvite(teamId, role);
                        showToast(t("team.inviteCreatedToast", { code: invite.code }));
                        return invite.code;
                      } catch (error) {
                        showToast(error instanceof Error ? error.message : t("sidebar.operationFailed"));
                        throw error;
                      }
                    }}
                    onUpdateMemberRole={async (memberUsername, role) => {
                      if (!team.activeTeam) return;
                      try {
                        await team.updateMemberRole(team.activeTeam.id, memberUsername, role);
                        showToast(
                          t("team.roleUpdatedToast", {
                            username: memberUsername,
                            role,
                          })
                        );
                      } catch (error) {
                        showToast(error instanceof Error ? error.message : t("sidebar.operationFailed"));
                        throw error;
                      }
                    }}
                    onTransferOwnership={async (memberUsername) => {
                      if (!team.activeTeam) return;
                      try {
                        await team.transferOwnership(team.activeTeam.id, memberUsername);
                        showToast(t("team.ownerTransferredToast", { username: memberUsername }));
                      } catch (error) {
                        showToast(error instanceof Error ? error.message : t("sidebar.operationFailed"));
                        throw error;
                      }
                    }}
                    onRemoveMember={async (memberUsername) => {
                      if (!team.activeTeam) return;
                      try {
                        await team.removeMember(team.activeTeam.id, memberUsername);
                        showToast(t("team.memberRemovedToast", { username: memberUsername }));
                      } catch (error) {
                        showToast(error instanceof Error ? error.message : t("sidebar.operationFailed"));
                        throw error;
                      }
                    }}
                    onLeaveTeam={async () => {
                      if (!team.activeTeam) return;
                      const leavingTeamName = team.activeTeam.name;
                      try {
                        await team.leaveTeam(team.activeTeam.id);
                        showToast(t("team.leftTeamToast", { name: leavingTeamName }));
                      } catch (error) {
                        showToast(error instanceof Error ? error.message : t("sidebar.operationFailed"));
                        throw error;
                      }
                    }}
                    onToggleClaim={async (path, claimed) => {
                      if (!team.activeTeam) return;
                      await team.setClaim(team.activeTeam.id, path, claimed);
                      showToast(
                        claimed
                          ? t("team.claimedToast", { path })
                          : t("team.releasedToast", { path })
                      );
                    }}
                    onAddComment={team.addCollaborationComment}
                    onCreateReview={team.createCollaborationReview}
                    onCreateMergePreview={team.createMergePreview}
                    onDecideMerge={team.decideMerge}
                  />
                </Suspense>
              </div>
            ) : checkpointsVisible ? (
              <CheckpointPanel
                key={`checkpoints:${workspaceDir}`}
                visible={true}
                token={token}
                workspaceDir={workspaceDir}
                conversationId={chat.currentConversationId}
                runId={chat.runState?.runId || null}
                readOnly={readOnlyWorkspace}
                onClose={() => setCheckpointsVisible(false)}
                onRestored={handleWorkspaceRestored}
                onOpenWorktree={async (path) => {
                  await handleChangeWorkspace(path);
                }}
                onNotify={showToast}
              />
            ) : problemsVisible ? (
              <ProblemsPanel
                key={`problems:${workspaceDir}`}
                visible={true}
                token={token}
                editorProblems={editorProblems.problems}
                onCountsChange={setProblemCounts}
                onOpenLocation={(problem) => void handleNavigateToLocation(problem.path, {
                  startLine: problem.line,
                  startColumn: problem.column,
                  endLine: problem.line,
                  endColumn: problem.column + 1,
                })}
                onClose={() => setProblemsVisible(false)}
              />
            ) : runCenterVisible ? (
              <RunCenterPanel
                key={`run:${workspaceDir}`}
                visible={true}
                token={token}
                onRunningChange={setActiveRunLabel}
                onOpenLocation={(failure) => void handleNavigateToLocation(failure.path, {
                  startLine: failure.line,
                  startColumn: failure.column,
                  endLine: failure.line,
                  endColumn: failure.column + 1,
                })}
                onClose={() => setRunCenterVisible(false)}
              />
            ) : debugVisible ? (
              <DebugPanel
                key={`debug:${workspaceDir}`}
                visible={true}
                token={token}
                activeFilePath={activeFilePath}
                cursorLine={cursorPos.line}
                breakpointsByPath={breakpointsByPath}
                onToggleBreakpoint={toggleBreakpoint}
                startRequest={debugStartRequest}
                onOpenLocation={(frame) => void handleNavigateToLocation(frame.path, {
                  startLine: frame.line,
                  startColumn: frame.column,
                  endLine: frame.line,
                  endColumn: frame.column + 1,
                })}
                onActiveFrameChange={setDebugActiveFrame}
                onClose={() => setDebugVisible(false)}
              />
            ) : workspaceView === "chat" ? (
              <TaskSidebar
                workspaceLabel={workspaceLabel}
                workspaceDir={workspaceDir}
                conversations={chat.conversations}
                currentConversationId={chat.currentConversationId}
                contextState={chat.contextState}
                loading={chat.historyLoading}
                loadingId={chat.historyLoadingId}
                isStreaming={chat.isStreaming}
                onNewTask={() => {
                  setNewConversationRequest((value) => value + 1);
                  setChatFocusNonce((value) => value + 1);
                }}
                onLoadConversation={loadChatConversation}
                onDeleteConversation={chat.deleteConversation}
                onRefresh={chat.refreshConversations}
              />
            ) : (
              <Sidebar
                tree={fileTree}
                activeFilePath={activeFilePath}
                visible={true}
                onFileSelect={openFile}
                onCreateEntry={handleCreateEntry}
                onCopyEntry={handleCopyEntry}
                onMoveEntry={handleMoveEntry}
                onDeleteEntry={handleDeleteEntry}
                onDeleteEntries={handleDeleteEntries}
                onRenameEntry={handleRenameEntry}
                onDownloadEntry={handleDownloadEntry}
                onUploadEntries={handleUploadEntries}
                onRefreshTree={loadTree}
                workspaceDir={workspaceDir}
                workspaceLocked={isolatedWindow}
                desktopApp={desktopApp}
                folderPickerBusy={pickingWorkspace}
                onPickDesktopWorkspace={handlePickDesktopWorkspace}
                folderOpenRequestId={folderOpenRequestId}
                onChangeWorkspace={handleChangeWorkspace}
                onSearchInPath={(path) => {
                  setWorkspaceSearchScope(path);
                  setWorkspaceSearchVisible(true);
                }}
                onSearchContent={fs.searchWorkspace}
                onCancelContentSearch={fs.cancelWorkspaceSearch}
                token={token}
                activeTeam={team.activeTeam}
              />
            )}
          </aside>
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

        <div className={`editor-area${workspaceView === "chat" ? " workbench-surface-hidden" : ""}`}>
          <TabBar
            openFiles={openFiles}
            activeFilePath={activeFilePath}
            workspaceDir={workspaceDir}
            onSelectTab={handleSelectTab}
            onCloseTab={closeTab}
            onCloseOtherTabs={closeOtherTabs}
            onCloseTabsToTheRight={closeTabsToTheRight}
            onCloseAllTabs={closeAllTabs}
            onShowToast={showToast}
          />
          {activeFile && (
            <EditorToolbar
              activeFile={activeFile}
              workspaceLabel={workspaceLabel}
              hasPreview={Boolean(activePreviewRenderer)}
              activePreviewMode={activePreviewMode}
              onSelectPreviewMode={setActivePreviewMode}
              editorAssistantVisible={editorAssistantVisible}
              onToggleEditorAssistant={() => {
                setRunDetailsVisible(false);
                setEditorAssistantVisible((prev) => !prev);
              }}
              terminalVisible={terminalVisible}
              onToggleTerminal={toggleTerminalPanel}
              runDetailsVisible={runDetailsVisible}
              onOpenChanges={() => {
                setEditorAssistantVisible(false);
                setRunDetailsTab("changes");
                setRunDetailsVisible(true);
              }}
              canRunCurrent={isDebuggablePath(activeFile.path)}
              onRunCurrent={() => void runCurrentFile()}
              readOnlyWorkspace={readOnlyWorkspace}
              openFiles={openFiles}
              compareFilePath={compareFilePath}
              onSelectCompareFile={(value) => setCompareFilePath(value)}
              compareFileActive={Boolean(compareFile)}
              compareScrollLinked={compareScrollLinked}
              onToggleCompareScrollLinked={() => setCompareScrollLinked((linked) => !linked)}
              onCloseCompare={() => setCompareFilePath(null)}
            />
          )}
          <div className="editor-main">
            {activeConflictFile && (
              <div className="editor-conflict-banner">
                <div className="editor-conflict-copy">
                  <strong>{t("app.remoteConflictTitle")}</strong>
                  <span>
                    {activeConflictFile.remoteConflictReason === "save"
                      ? t("app.saveVersionConflictMessage")
                      : t("app.remoteConflictMessage")}
                  </span>
                  {activeConflictSourceMessage && (
                    <span className="editor-conflict-source">
                      {activeConflictSourceMessage}
                    </span>
                  )}
                </div>
                <div className="editor-conflict-actions">
                  <button
                    className="editor-conflict-btn"
                    onClick={() => setDiffViewerPath(activeConflictFile.path)}
                  >
                    {t("app.viewDiff")}
                  </button>
                  <button
                    className="editor-conflict-btn"
                    onClick={handleKeepLocalVersion}
                  >
                    {t("app.keepLocalVersion")}
                  </button>
                  <button
                    className="editor-conflict-btn primary"
                    onClick={handleReloadRemoteVersion}
                  >
                    {t("app.loadRemoteVersion")}
                  </button>
                  {activeConflictFile.remoteConflictReason === "save" && (
                    <button
                      className="editor-conflict-btn danger"
                      onClick={() => void handleForceSaveAfterVersionConflict()}
                    >
                      {t("app.overwriteRemoteVersion")}
                    </button>
                  )}
                </div>
              </div>
            )}
            {!activeConflictFile &&
              ((activeClaim && activeClaim.username !== username) ||
                activeCollaborators.length > 0) &&
              activeFilePath && (
                <div className="editor-collaboration-banner">
                  <div className="editor-conflict-copy">
                    <strong>{t("team.collaborationNoticeTitle")}</strong>
                    <span>
                      {activeClaim && activeClaim.username !== username
                        ? t("team.collaborationClaimNotice", {
                            username: activeClaim.username,
                          })
                        : activeCollaborators.length > 0
                          ? t("team.collaborationPresenceNotice", {
                              usernames: activeCollaborators
                                .map((entry) => entry.username)
                                .join(", "),
                            })
                          : t("team.unclaimed")}
                    </span>
                  </div>
                </div>
              )}
            <Suspense fallback={<div className="panel-loading">{t("common.loading")}</div>}>
            {activeFile ? (
              compareFile ? (
                <div className="editor-compare-workbench" aria-label={t("editor.compareView")}>
                  <section className="editor-compare-pane" aria-label={t("editor.comparePrimary")}>
                    <div className="editor-compare-pane-header">
                      <span>{t("editor.comparePrimary")}</span>
                      <strong title={activeFile.path}>{activeFile.name}</strong>
                    </div>
                    <Editor
                      key={`editor:${activeFile.path}`}
                      content={activeFile.content}
                      language={activeFile.language}
                      path={activeFile.path}
                      collaboration={team.collaboration}
                      theme={theme}
                      fontFamily={editorFont}
                      readOnly={readOnlyWorkspace}
                      openFiles={openFiles}
                      refreshNonce={treeRefreshNonce}
                      viewState={editorViewStatesRef.current[activeFile.path] || null}
                      onViewStateChange={handleEditorViewStateChange}
                      onChange={handleEditorChange}
                      onSave={saveFile}
                      onFormat={formatPythonDocument}
                      onValidateDocument={fs.checkPythonDocument}
                      breakpoints={isDebuggablePath(activeFile.path) ? breakpointsByPath[activeFile.path] || [] : []}
                      debugExecutionLine={debugActiveFrame?.path === activeFile.path ? debugActiveFrame.line : undefined}
                      onToggleBreakpoint={isDebuggablePath(activeFile.path) && !readOnlyWorkspace ? (line) => toggleBreakpoint(activeFile.path, line) : undefined}
                      onSelectionChange={handleSelectionChange}
                      onNavigateToLocation={handleNavigateToLocation}
                      onFindDefinition={handleFindDefinition}
                      editorRef={editorRef}
                      onEditorReady={handleCompareEditorReady}
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
                  </section>
                  <div className="editor-compare-divider" aria-hidden="true" />
                  <section className="editor-compare-pane" aria-label={t("editor.compareReference")}>
                    <div className="editor-compare-pane-header">
                      <span>{t("editor.compareReference")}</span>
                      <strong title={compareFile.path}>{compareFile.name}</strong>
                    </div>
                    <Editor
                      key={`compare:${compareFile.path}`}
                      content={compareFile.content}
                      language={compareFile.language}
                      path={compareFile.path}
                      collaboration={team.collaboration}
                      theme={theme}
                      fontFamily={editorFont}
                      readOnly
                      openFiles={openFiles}
                      refreshNonce={treeRefreshNonce}
                      viewState={editorViewStatesRef.current[compareFile.path] || null}
                      onViewStateChange={handleEditorViewStateChange}
                      onChange={() => undefined}
                      onSave={() => undefined}
                      onFormat={formatPythonDocument}
                      onValidateDocument={fs.checkPythonDocument}
                      debugExecutionLine={debugActiveFrame?.path === compareFile.path ? debugActiveFrame.line : undefined}
                      onSelectionChange={() => undefined}
                      onNavigateToLocation={handleNavigateToLocation}
                      onFindDefinition={handleFindDefinition}
                      editorRef={compareEditorRef}
                      onEditorReady={handleCompareEditorReady}
                      navigationTarget={
                        editorNavigationTarget?.path === compareFile.path
                          ? editorNavigationTarget
                          : null
                      }
                      highlightTarget={
                        editorHighlightTarget?.path === compareFile.path
                          ? editorHighlightTarget
                          : null
                      }
                      onNavigationComplete={handleNavigationComplete}
                      onHighlightComplete={handleHighlightComplete}
                    />
                  </section>
                </div>
              ) : activePreviewRenderer ? (
                <div className="editor-workbench">
                  <div
                    className={`editor-workbench-body mode-${activePreviewMode}`}
                  >
                    {activePreviewMode !== "preview" && (
                      <div className="editor-workbench-pane">
                        <Editor
                          key={`editor:${activeFile.path}`}
                          content={activeFile.content}
                          language={activeFile.language}
                          path={activeFile.path}
                          collaboration={team.collaboration}
                          theme={theme}
                          fontFamily={editorFont}
                          readOnly={readOnlyWorkspace}
                          openFiles={openFiles}
                          refreshNonce={treeRefreshNonce}
                          viewState={
                            editorViewStatesRef.current[activeFile.path] || null
                          }
                          onViewStateChange={handleEditorViewStateChange}
                          onChange={handleEditorChange}
                          onSave={saveFile}
                          onFormat={formatPythonDocument}
                          onValidateDocument={fs.checkPythonDocument}
                          breakpoints={isDebuggablePath(activeFile.path) ? breakpointsByPath[activeFile.path] || [] : []}
                          debugExecutionLine={debugActiveFrame?.path === activeFile.path ? debugActiveFrame.line : undefined}
                          onToggleBreakpoint={isDebuggablePath(activeFile.path) && !readOnlyWorkspace ? (line) => toggleBreakpoint(activeFile.path, line) : undefined}
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
                      <div
                        className="editor-workbench-pane editor-preview-pane"
                        ref={previewPaneRef}
                      >
                        {activePreviewContent}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <Editor
                  key={`editor:${activeFile.path}`}
                  content={activeFile.content}
                  language={activeFile.language}
                  path={activeFile.path}
                  collaboration={team.collaboration}
                  theme={theme}
                  fontFamily={editorFont}
                  readOnly={readOnlyWorkspace}
                  openFiles={openFiles}
                  refreshNonce={treeRefreshNonce}
                  viewState={editorViewStatesRef.current[activeFile.path] || null}
                  onViewStateChange={handleEditorViewStateChange}
                  onChange={handleEditorChange}
                  onSave={saveFile}
                  onFormat={formatPythonDocument}
                  onValidateDocument={fs.checkPythonDocument}
                  breakpoints={isDebuggablePath(activeFile.path) ? breakpointsByPath[activeFile.path] || [] : []}
                  debugExecutionLine={debugActiveFrame?.path === activeFile.path ? debugActiveFrame.line : undefined}
                  onToggleBreakpoint={isDebuggablePath(activeFile.path) && !readOnlyWorkspace ? (line) => toggleBreakpoint(activeFile.path, line) : undefined}
                  onSelectionChange={handleSelectionChange}
                  onNavigateToLocation={handleNavigateToLocation}
                  onFindDefinition={handleFindDefinition}
                  onFindReferences={handleFindReferences}
                  onReferencesFound={handleReferencesFound}
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
              <WorkspaceWelcome
                workspaceDir={workspaceDir}
                tree={fileTree}
                openFiles={openFiles}
                onQuickOpen={() => openCommandPalette("files")}
                onOpenFolder={handleOpenFolder}
                folderPickerBusy={pickingWorkspace}
                onFocusChat={focusChat}
                onOpenTerminal={() => toggleTerminalPanel(true)}
                onOpenFile={openFile}
              />
            )}
            </Suspense>
            {referenceResult && (
              <ReferencePanel
                symbol={referenceResult.symbol}
                references={referenceResult.references}
                onNavigate={(path, selection) => void handleNavigateToLocation(path, selection)}
                onClose={() => setReferenceResult(null)}
              />
            )}
          </div>
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

        <div
          className={`resize-handle${!chatVisible || workspaceView === "chat" ? " hidden" : ""}${draggingPanel === "chat" ? " dragging" : ""}`}
          onMouseDown={(e) => handleResizeStart("chat", e)}
        />

        <ChatPanel
          token={token}
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
        {workspaceView === "files" && (editorAssistantVisible || runDetailsVisible) && (
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
        {workspaceView === "files" && (editorAssistantVisible || runDetailsVisible) && (
          <aside
            className="workbench-right-dock"
            aria-label={runDetailsVisible ? t("workbench.runDetails") : t("workbench.editorAssistant")}
          >
            {runDetailsVisible ? (
              <RunDetailsPanel
                token={token}
                workspaceDir={workspaceDir}
                visible={runDetailsVisible}
                summary={chat.currentRunSummary}
                runState={chat.runState}
                errorCount={problemCounts.errors}
                warningCount={problemCounts.warnings}
                contextManifest={chat.contextManifest}
                activeTab={runDetailsTab}
                onTabChange={setRunDetailsTab}
                onOpenFile={openFile}
                onOpenDiff={handleOpenGitDiff}
                onClose={() => {
                  setRunDetailsVisible(false);
                  if (workspaceView === "files" && window.innerWidth > 1180) setEditorAssistantVisible(true);
                }}
              />
            ) : (
              <EditorAssistantPanel
                token={token}
                visible={true}
                activeFilePath={activeFilePath}
                activeFileDirty={Boolean(activeFile?.modified)}
                messages={chat.messages}
                connected={chat.connected}
                isStreaming={chat.isStreaming}
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
                runState={chat.runState}
                currentRunSummary={chat.currentRunSummary}
                contextManifest={chat.contextManifest}
                contextReadOnly={readOnlyWorkspace}
                pendingApprovals={chat.pendingApprovals}
                onAgentModeChange={chat.setAgentMode}
                onModelNameChange={chat.setSelectedModelName}
                onSend={handleChatSend}
                onSteer={handleChatSteer}
                onStop={chat.stopCurrentRun}
                onResume={chat.resumeConversation}
                onNewConversation={clearChatConversation}
                onToolApproval={chat.respondToToolApproval}
                onApproveConversationTools={chat.approveConversationTools}
                onPlanAmendmentDecision={chat.decidePlanAmendment}
                onClose={() => setEditorAssistantVisible(false)}
              />
            )}
          </aside>
        )}
        {workspaceView === "chat" && runDetailsVisible && (
          <RunDetailsPanel
            token={token}
            workspaceDir={workspaceDir}
            visible={runDetailsVisible}
            summary={chat.currentRunSummary}
            runState={chat.runState}
            errorCount={problemCounts.errors}
            warningCount={problemCounts.warnings}
            contextManifest={chat.contextManifest}
            activeTab={runDetailsTab}
            onTabChange={setRunDetailsTab}
            onOpenFile={openFile}
            onOpenDiff={handleOpenGitDiff}
            onClose={() => setRunDetailsVisible(false)}
          />
        )}
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

      {diffViewerFile && diffViewerFile.remoteContent !== undefined && (
          <div
            className="settings-modal-overlay"
          onClick={closeDiffViewer}
        >
          <div
            ref={diffDialogRef}
            tabIndex={-1}
            className="settings-modal diff-modal panel-shell"
            role="dialog"
            aria-modal="true"
            aria-labelledby="diff-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="settings-modal-header">
              <div className="settings-modal-title">
                <h2 id="diff-modal-title">{t("app.diffViewerTitle")}</h2>
              </div>
              <button
                className="settings-modal-close"
                aria-label={t("common.close")}
                title={t("common.close")}
                onClick={closeDiffViewer}
              >
                ×
              </button>
            </div>
            <div className="diff-modal-meta">
              <span>{diffViewerFile.path}</span>
              {conflictSourceMessage && (
                <span className="diff-modal-source">{conflictSourceMessage}</span>
              )}
            </div>
            <div className="diff-modal-body">
              <Suspense fallback={<div className="panel-loading">{t("common.loading")}</div>}>
                <DiffEditor
                  height="100%"
                  original={diffViewerFile.remoteContent}
                  modified={diffViewerFile.content}
                  language={diffViewerFile.language}
                  theme={getEditorThemeName(theme)}
                  options={{
                    readOnly: true,
                    renderSideBySide: true,
                    minimap: { enabled: false },
                    ...DEFAULT_EDITOR_FONT_OPTIONS,
                    fontFamily: editorFont,
                    automaticLayout: true,
                  }}
                />
              </Suspense>
            </div>
            <div className="diff-merge-panel">
              <div className="diff-merge-header">
                <div>
                  <strong>{t("app.mergeConflictBlocks")}</strong>
                  <p>{t("app.mergeConflictBlocksHint")}</p>
                </div>
                <div className="diff-merge-summary">
                  <span className="diff-merge-count">
                    {t("app.mergeRemoteSelectedCount", {
                      count: remoteSelectedCount,
                      total: conflictHunks.length,
                    })}
                  </span>
                  {conflictHunks.length > 0 && (
                    <div className="diff-merge-bulk-actions">
                      <button className="dialog-btn" onClick={handleKeepAllLocalBlocks}>
                        {t("app.mergeKeepAllLocal")}
                      </button>
                      <button className="dialog-btn" onClick={handleUseAllRemoteBlocks}>
                        {t("app.mergeUseAllRemote")}
                      </button>
                    </div>
                  )}
                </div>
              </div>
              {conflictHunks.length === 0 ? (
                <div className="diff-merge-empty">{t("app.mergeNoBlocks")}</div>
              ) : (
                <div className="diff-merge-list">
                  {conflictHunks.map((hunk, index) => {
                    const selection = mergeSelections[hunk.id] || "local";
                    return (
                      <div key={hunk.id} className="diff-hunk-card">
                        <div className="diff-hunk-head">
                          <span className="diff-hunk-index">#{index + 1}</span>
                          <span className="diff-hunk-selection">
                            {selection === "remote"
                              ? t("app.mergeBlockRemote")
                              : t("app.mergeBlockLocal")}
                          </span>
                        </div>
                        <div className="diff-hunk-columns">
                          <div className="diff-hunk-side">
                            <div className="diff-hunk-label">
                              {t("app.mergeLocalSnippet", {
                                range: formatLineRange(hunk.localStart, hunk.localEnd),
                              })}
                            </div>
                            <pre className="diff-hunk-code">
                              {hunk.localLines.join("\n") || " "}
                            </pre>
                            <button
                              className={`dialog-btn${
                                selection === "local" ? " primary" : ""
                              }`}
                              onClick={() =>
                                setMergeSelections((prev) => ({
                                  ...prev,
                                  [hunk.id]: "local",
                                }))
                              }
                            >
                              {t("app.mergeKeepLocalBlock")}
                            </button>
                          </div>
                          <div className="diff-hunk-side">
                            <div className="diff-hunk-label">
                              {t("app.mergeRemoteSnippet", {
                                range: formatLineRange(hunk.remoteStart, hunk.remoteEnd),
                              })}
                            </div>
                            <pre className="diff-hunk-code">
                              {hunk.remoteLines.join("\n") || " "}
                            </pre>
                            <button
                              className={`dialog-btn${
                                selection === "remote" ? " primary" : ""
                              }`}
                              onClick={() =>
                                setMergeSelections((prev) => ({
                                  ...prev,
                                  [hunk.id]: "remote",
                                }))
                              }
                            >
                              {t("app.mergeUseRemoteBlock")}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="dialog-actions diff-modal-actions">
              <button className="dialog-btn primary" onClick={handleApplyMergedResult}>
                {t("app.mergeApplyResult")}
              </button>
              <button className="dialog-btn" onClick={handleKeepLocalVersion}>
                {t("app.keepLocalVersion")}
              </button>
              <button className="dialog-btn" onClick={handleReloadRemoteVersion}>
                {t("app.loadRemoteVersion")}
              </button>
              {diffViewerFile.remoteConflictReason === "save" && (
                <button
                  className="dialog-btn primary"
                  onClick={() => void handleForceSaveAfterVersionConflict()}
                >
                  {t("app.overwriteRemoteVersion")}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <ActionConfirmDialog
        intent={claimSaveConfirmation ? { id: `claim-save:${claimSaveConfirmation.file.path}:${claimSaveConfirmation.username}`, title: t("team.confirmAction"), description: t("team.claimConflictConfirm", { username: claimSaveConfirmation.username }), confirmLabel: t("common.confirm"), tone: "danger" } : null}
        busy={claimSaveBusy}
        error={claimSaveError}
        onClose={() => { setClaimSaveConfirmation(null); setClaimSaveError(null); showToast(t("team.claimConflictCancelled")); }}
        onConfirm={() => forceSaveClaimedFile()}
      />

      <CommandPalette
        visible={commandPaletteVisible}
        mode={commandPaletteMode}
        tree={fileTree}
        onClose={() => setCommandPaletteVisible(false)}
        onOpenFile={openFile}
        onRunCommand={runPaletteCommand}
        canFormatDocument={Boolean(activeFile?.language === "python" && !readOnlyWorkspace)}
      />
      <WorkspaceSearchPanel
        visible={workspaceSearchVisible}
        tree={fileTree}
        scopePath={workspaceSearchScope}
        onClose={() => setWorkspaceSearchVisible(false)}
        onClearScope={() => setWorkspaceSearchScope("")}
        onSearch={fs.searchWorkspace}
        onCancelSearch={fs.cancelWorkspaceSearch}
        onOpenResult={openSearchResult}
      />
    </div>
  );
}
