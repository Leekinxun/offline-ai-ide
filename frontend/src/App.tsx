import React, { lazy, Suspense, useState, useEffect, useCallback, useMemo, useRef } from "react";
import type * as monaco from "monaco-editor";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { ChatPanel } from "./components/ChatPanel";
import { StatusBar } from "./components/StatusBar";
import { Terminal } from "./components/Terminal";
import { LoginPage } from "./components/LoginPage";
import { BrandMark } from "./components/BrandMark";
import { PRODUCT_NAME } from "./brand";
import { CommandPalette, CommandPaletteMode } from "./components/CommandPalette";
import { WorkspaceWelcome } from "./components/WorkspaceWelcome";
import { WorkspaceSearchPanel } from "./components/WorkspaceSearchPanel";
import { GitPanel } from "./components/GitPanel";
import { AgentBoard } from "./components/AgentBoard";
import { useFileSystem } from "./hooks/useFileSystem";
import type { WorkspaceSearchResult } from "./hooks/useFileSystem";
import { useChat } from "./hooks/useChat";
import { useAuth } from "./hooks/useAuth";
import { useTeam } from "./hooks/useTeam";
import {
  DefinitionLocation,
  FileNode,
  FileSelectionRange,
  FileUpdate,
  OpenFile,
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
  Users,
  Search,
  Command,
  Maximize2,
  Minimize2,
  GitBranch,
  Bot,
  ChevronRight,
} from "lucide-react";
import { useI18n } from "./i18n";
import {
  getMatchingFilePreviewRenderer,
  renderFilePreview,
} from "./plugins/runtime";
import type { FilePreviewMode } from "./plugins/types";
import "./App.css";
import { getEditorThemeName } from "./editor/themeNames";
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

const EDITOR_FONT_OPTIONS = [
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
  const { t } = useI18n();
  const auth = useAuth();
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("theme");
    return (saved as "light" | "dark") || "light";
  });
  const [editorFont, setEditorFont] = useState(() => {
    const saved = localStorage.getItem("editorFont");
    return saved || EDITOR_FONT_OPTIONS[0].family;
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === "light" ? "dark" : "light"));
  }, []);

  const changeEditorFont = useCallback((fontFamily: string) => {
    setEditorFont(fontFamily);
    localStorage.setItem("editorFont", fontFamily);
  }, []);

  // Show loading while validating token
  if (auth.loading) {
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
  onLogout: () => void;
  onChangeWorkspace: (path: string) => Promise<boolean>;
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
  onLogout,
  onChangeWorkspace,
  theme,
  onToggleTheme,
  editorFont,
  editorFontOptions,
  onEditorFontChange,
}: AuthenticatedAppProps) {
  const { t } = useI18n();
  // --- State ---
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(() => window.innerWidth > 860);
  const [chatVisible, setChatVisible] = useState(true);
  const [chatFocusNonce, setChatFocusNonce] = useState(0);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [teamVisible, setTeamVisible] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [commandPaletteMode, setCommandPaletteMode] = useState<CommandPaletteMode>("commands");
  const [commandPaletteVisible, setCommandPaletteVisible] = useState(false);
  const [workspaceSearchVisible, setWorkspaceSearchVisible] = useState(false);
  const [gitVisible, setGitVisible] = useState(false);
  const [agentsVisible, setAgentsVisible] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [diffViewerPath, setDiffViewerPath] = useState<string | null>(null);
  const [mergeSelections, setMergeSelections] = useState<Record<string, "local" | "remote">>(
    {}
  );
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
  const [treeRefreshNonce, setTreeRefreshNonce] = useState(0);
  const lastWorkspaceMtimeRef = useRef(0);

  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const draggingRef = useRef<"sidebar" | "chat" | null>(null);
  const navigationRequestRef = useRef(0);
  const highlightRequestRef = useRef(0);
  const editorViewStatesRef = useRef<
    Record<string, monaco.editor.ICodeEditorViewState | null>
  >({});
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const layoutBeforeFocusRef = useRef({ sidebar: true, chat: true, team: true });
  const fs = useFileSystem(token);

  // --- Toast ---
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);

  const toggleFocusMode = useCallback(() => {
    setFocusMode((current) => {
      if (current) {
        setSidebarVisible(layoutBeforeFocusRef.current.sidebar);
        setChatVisible(layoutBeforeFocusRef.current.chat);
        setTeamVisible(layoutBeforeFocusRef.current.team);
      } else {
        layoutBeforeFocusRef.current = {
          sidebar: sidebarVisible,
          chat: chatVisible,
          team: teamVisible,
        };
        setSidebarVisible(false);
        setChatVisible(false);
        setTeamVisible(false);
      }
      return !current;
    });
  }, [chatVisible, sidebarVisible, teamVisible]);

  const openCommandPalette = useCallback((mode: CommandPaletteMode) => {
    setCommandPaletteMode(mode);
    setCommandPaletteVisible(true);
  }, []);

  const focusChat = useCallback(() => {
    setChatVisible(true);
    setChatFocusNonce((value) => value + 1);
  }, []);

  const runPaletteCommand = useCallback(
    (command: string) => {
      switch (command) {
        case "focus":
          toggleFocusMode();
          break;
        case "explorer":
          setSidebarVisible((value) => !value);
          break;
        case "terminal":
          setTerminalVisible((value) => !value);
          break;
        case "chat":
          setChatVisible((value) => !value);
          break;
        default:
          break;
      }
    },
    [toggleFocusMode]
  );


  const handleEditorViewStateChange = useCallback(
    (path: string, viewState: monaco.editor.ICodeEditorViewState | null) => {
      editorViewStatesRef.current[path] = viewState;
    },
    []
  );

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
    editorViewStatesRef.current = {};
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
        version: undefined,
        updatedAt: undefined,
        ...buildClearedRemoteState(),
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
    async (path: string) => {
      const existing = openFiles.find((f) => f.path === path);
      if (existing) {
        setActiveFilePath(path);
        return;
      }

      try {
        const next = await fs.readFileWithMeta(path);
        const name = path.split("/").pop() || path;
        const language = getLanguage(name);
        const newFile: OpenFile = {
          path,
          name,
          content: next.content,
          language,
          modified: false,
          version: next.version,
          updatedAt: next.updatedAt,
          ...buildClearedRemoteState(),
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

  const openSearchResult = useCallback(
    (result: WorkspaceSearchResult) => {
      void handleNavigateToLocation(result.path, {
        startLine: result.line,
        startColumn: result.column,
        endLine: result.line,
        endColumn: result.column + 1,
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

  const saveFile = useCallback(async () => {
    if (readOnlyWorkspace) {
      showToast(t("team.readOnlySaveBlocked"));
      return;
    }
    const file = openFiles.find((f) => f.path === activeFilePath);
    if (!file) return;
    if (activeClaim && activeClaim.username !== username) {
      const confirmed = window.confirm(
        t("team.claimConflictConfirm", {
          username: activeClaim.username,
        })
      );
      if (!confirmed) {
        showToast(t("team.claimConflictCancelled"));
        return;
      }
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
      showToast(t("app.fileSaved"));
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
        return;
      }
      if (claimError.code === "TEAM_CLAIM_CONFLICT" && claimError.claim?.username) {
        const confirmed = window.confirm(
          t("team.claimConflictConfirm", {
            username: claimError.claim.username,
          })
        );
        if (!confirmed) {
          showToast(t("team.claimConflictCancelled"));
          return;
        }
        try {
          const result = await fs.writeFile(file.path, file.content, true, file.version);
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
          showToast(t("app.fileSaved"));
          return;
        } catch {
          showToast(t("app.failedToSaveFile"));
          return;
        }
      }
      showToast(t("app.failedToSaveFile"));
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

  const handleUploadEntries = useCallback(
    async (
      files: { path: string; file: File }[],
      overwrite = false
    ) => {
      const result = await fs.uploadEntries(files, { overwrite });
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
      showToast(t("app.fileSaved"));
    } catch {
      showToast(t("app.failedToSaveFile"));
    }
  }, [activeFilePath, fs, openFiles, showToast, t]);

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

  const handleChatSteer = useCallback(
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
      chat.sendSteering(message, context);
    },
    [chat, openFiles, activeFilePath, selectionInfo]
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
      const isShortcut = e.metaKey || e.ctrlKey;
      if (isShortcut && e.key.toLowerCase() === "p") {
        e.preventDefault();
        openCommandPalette(e.shiftKey ? "commands" : "files");
        return;
      }
      if (isShortcut && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setWorkspaceSearchVisible(true);
        return;
      }
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
      if (isShortcut && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggleFocusMode();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openCommandPalette, toggleFocusMode]);

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
  const activeConflictFile =
    activeFile && activeFile.remoteUpdated && activeFile.modified ? activeFile : null;
  const diffViewerFile =
    diffViewerPath ? openFiles.find((file) => file.path === diffViewerPath) || null : null;
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

  return (
    <div className="app">
      {/* Title Bar */}
      <div className="titlebar">
        <div className="titlebar-left">
          <BrandMark
            size={22}
            title={PRODUCT_NAME}
            subtitle={t("app.offline")}
            className="titlebar-brand"
          />
          <div className="workspace-breadcrumb" title={workspaceDir}>
            <span className="workspace-breadcrumb-label">{t("app.workspace")}</span>
            <strong>{workspaceLabel}</strong>
          </div>
        </div>
        <div className="titlebar-command-bar">
          <button type="button" className="titlebar-command-btn" onClick={() => openCommandPalette("files")}>
            <Search size={14} />
            <span>{t("command.quickOpen")}</span>
            <kbd>⌘P</kbd>
          </button>
          <button type="button" className="titlebar-command-btn" onClick={() => openCommandPalette("commands")}>
            <Command size={14} />
            <span>{t("command.commandPalette")}</span>
            <kbd>⌘⇧P</kbd>
          </button>
          <button type="button" className="titlebar-command-btn" onClick={() => setWorkspaceSearchVisible(true)}>
            <Search size={14} />
            <span>{t("search.title")}</span>
            <kbd>⌘⇧F</kbd>
          </button>
        </div>
        <div className="titlebar-right">
          <div className="titlebar-context-actions">
            <span className="user-badge">{username}</span>
            <button
              className={`titlebar-btn${focusMode ? " active" : ""}`}
              onClick={toggleFocusMode}
              title={t(focusMode ? "app.exitFocusMode" : "app.focusMode")}
            >
              {focusMode ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
            </button>
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
          </div>
          <div className="titlebar-panel-actions">
            <button
              className={`titlebar-btn${teamVisible ? " active" : ""}`}
              onClick={() => setTeamVisible((v) => !v)}
              title={t("team.title")}
            >
              <Users size={17} />
            </button>
            <button
              className={`titlebar-btn${gitVisible ? " active" : ""}`}
              onClick={() => setGitVisible((value) => !value)}
              title={t("git.title")}
            >
              <GitBranch size={17} />
            </button>
            <button
              className={`titlebar-btn${agentsVisible ? " active" : ""}`}
              onClick={() => setAgentsVisible((value) => !value)}
              title={t("agents.title")}
            >
              <Bot size={17} />
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
          </div>
          <div className="titlebar-session-actions">
            <button
              className="titlebar-btn"
              onClick={onLogout}
              title={t("app.logout")}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </div>

      <Suspense fallback={null}>
        <SettingsModal
          token={token}
          currentUsername={username}
          isAdmin={isAdmin}
          visible={settingsVisible}
          editorFont={editorFont}
          editorFontOptions={editorFontOptions}
          onEditorFontChange={onEditorFontChange}
          onClose={() => setSettingsVisible(false)}
          onShowToast={showToast}
        />
      </Suspense>

      {/* Main Layout */}
      <div className="main-layout">
        {(sidebarVisible || chatVisible || teamVisible || gitVisible || agentsVisible || terminalVisible) && (
          <button
            type="button"
            className="mobile-drawer-scrim"
            aria-label={t("common.close")}
            onClick={() => {
              setSidebarVisible(false);
              setChatVisible(false);
              setTeamVisible(false);
              setGitVisible(false);
              setAgentsVisible(false);
              setTerminalVisible(false);
            }}
          />
        )}
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
          onUploadEntries={handleUploadEntries}
          onRefreshTree={loadTree}
          workspaceDir={workspaceDir}
          onChangeWorkspace={handleChangeWorkspace}
          token={token}
          activeTeam={team.activeTeam}
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
          {activeFile && (
            <div className="editor-context-bar">
              <div className="editor-context-path" title={activeFile.path}>
                <span>{workspaceLabel}</span>
                <ChevronRight size={12} />
                <code>{activeFile.path}</code>
              </div>
              <div className="editor-context-statuses">
                {activeFile.modified && (
                  <span className="editor-context-status modified">
                    {t("editor.unsaved")}
                  </span>
                )}
                {activeFile.remoteUpdated && (
                  <span className="editor-context-status remote">
                    {t("editor.remoteUpdated")}
                  </span>
                )}
              </div>
            </div>
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
                  fontFamily={editorFont}
                  readOnly={readOnlyWorkspace}
                  openFiles={openFiles}
                  refreshNonce={treeRefreshNonce}
                  viewState={editorViewStatesRef.current[activeFile.path] || null}
                  onViewStateChange={handleEditorViewStateChange}
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
              <WorkspaceWelcome
                workspaceDir={workspaceDir}
                tree={fileTree}
                openFiles={openFiles}
                onQuickOpen={() => openCommandPalette("files")}
                onFocusChat={focusChat}
                onOpenTerminal={() => setTerminalVisible(true)}
                onOpenFile={openFile}
              />
            )}
            </Suspense>
          </div>
          <Terminal
            key={workspaceDir}
            visible={terminalVisible}
            token={token}
            disabled={readOnlyWorkspace}
            disabledReason={readOnlyWorkspace ? t("terminal.readOnlyDisabled") : null}
          />
        </div>

        {teamVisible && (
          <div className="team-sidebar" role="complementary" aria-label={t("team.title")}>
            <Suspense fallback={<div className="panel-loading">{t("common.loading")}</div>}>
              <TeamPanel
              teams={team.teams}
              activeTeam={team.activeTeam}
              currentUsername={username}
              connected={team.connected}
              loading={team.loading}
              error={team.error}
              activeFilePath={activeFilePath}
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
                const confirmed = window.confirm(
                  t("team.transferOwnerConfirm", { username: memberUsername })
                );
                if (!confirmed) return;
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
                const confirmed = window.confirm(
                  t("team.removeMemberConfirm", { username: memberUsername })
                );
                if (!confirmed) return;
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
                const confirmed = window.confirm(
                  t("team.leaveTeamConfirm", { name: leavingTeamName })
                );
                if (!confirmed) return;
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
              />
            </Suspense>
          </div>
        )}

        <GitPanel
          visible={gitVisible}
          token={token}
          workspaceDir={workspaceDir}
          onOpenFile={openFile}
          onAskReview={handleGitReview}
          onClose={() => setGitVisible(false)}
        />
        <AgentBoard
          visible={agentsVisible}
          token={token}
          onClose={() => setAgentsVisible(false)}
        />

        <div
          className={`resize-handle${!chatVisible ? " hidden" : ""}${draggingRef.current === "chat" ? " dragging" : ""}`}
          onMouseDown={(e) => handleResizeStart("chat", e)}
        />

        <ChatPanel
          messages={chat.messages}
          currentConversationId={chat.currentConversationId}
          conversations={chat.conversations}
          isStreaming={chat.isStreaming}
          activeRequestIds={chat.activeRequestIds}
          connected={chat.connected}
          visible={chatVisible}
          focusRequest={chatFocusNonce}
          agentMode={chat.agentMode}
          onAgentModeChange={chat.setAgentMode}
          currentRunSummary={chat.currentRunSummary}
          contextState={chat.contextState}
          mcpState={chat.mcpState}
          knowledgeState={chat.knowledgeState}
          onOpenFile={openFile}
          historyLoading={chat.historyLoading}
          historyLoadingId={chat.historyLoadingId}
          historyError={chat.historyError}
          selectionInfo={selectionInfo}
          activeFileName={activeFile?.name || null}
          onSend={handleChatSend}
          onSteer={handleChatSteer}
          onStop={chat.stopCurrentRun}
          onClear={chat.clearMessages}
          onRetry={chat.retryLast}
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
        teamName={team.activeTeam?.name || null}
        teamOnlineCount={team.activeTeam?.onlineCount}
        teamRole={team.activeTeam?.role || null}
        readOnlyWorkspace={readOnlyWorkspace}
      />

      {/* Toast */}
      {toast && <div className="toast">{toast}</div>}

      {diffViewerFile && diffViewerFile.remoteContent !== undefined && (
        <div
          className="settings-modal-overlay"
          onClick={() => {
            setDiffViewerPath(null);
            setMergeSelections({});
          }}
        >
          <div
            className="settings-modal diff-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="settings-modal-header">
              <div className="settings-modal-title">
                <h2>{t("app.diffViewerTitle")}</h2>
              </div>
              <button
                className="settings-modal-close"
                onClick={() => {
                  setDiffViewerPath(null);
                  setMergeSelections({});
                }}
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
                    fontSize: 13,
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

      <CommandPalette
        visible={commandPaletteVisible}
        mode={commandPaletteMode}
        tree={fileTree}
        onClose={() => setCommandPaletteVisible(false)}
        onOpenFile={openFile}
        onRunCommand={runPaletteCommand}
      />
      <WorkspaceSearchPanel
        visible={workspaceSearchVisible}
        onClose={() => setWorkspaceSearchVisible(false)}
        onSearch={fs.searchWorkspace}
        onOpenResult={openSearchResult}
      />
    </div>
  );
}
