import React, { useState, useRef, useEffect, useCallback } from "react";
import type { DetailTab } from "../components/RunDetailsPanel";

export type UtilityPanelType =
  | "git"
  | "agents"
  | "checkpoints"
  | "problems"
  | "run-center"
  | "debug";

export interface WorkspacePanelsOptions {
  viewportWidth: number;
  workspaceView: "chat" | "files";
  setWorkspaceView: (view: "chat" | "files") => void;
  mainLayoutRef: React.RefObject<HTMLDivElement | null>;
  onFormatDocument?: () => void;
}

export interface WorkspacePanelsReturn {
  // Panel visibilities
  sidebarVisible: boolean;
  setSidebarVisible: React.Dispatch<React.SetStateAction<boolean>>;
  chatVisible: boolean;
  setChatVisible: React.Dispatch<React.SetStateAction<boolean>>;
  terminalVisible: boolean;
  setTerminalVisible: React.Dispatch<React.SetStateAction<boolean>>;
  teamVisible: boolean;
  setTeamVisible: React.Dispatch<React.SetStateAction<boolean>>;
  runDetailsVisible: boolean;
  setRunDetailsVisible: React.Dispatch<React.SetStateAction<boolean>>;
  runDetailsTab: DetailTab;
  setRunDetailsTab: React.Dispatch<React.SetStateAction<DetailTab>>;
  editorAssistantVisible: boolean;
  setEditorAssistantVisible: React.Dispatch<React.SetStateAction<boolean>>;
  chatFocusNonce: number;
  setChatFocusNonce: React.Dispatch<React.SetStateAction<number>>;

  // Utility panels
  gitVisible: boolean;
  setGitVisible: React.Dispatch<React.SetStateAction<boolean>>;
  agentsVisible: boolean;
  setAgentsVisible: React.Dispatch<React.SetStateAction<boolean>>;
  checkpointsVisible: boolean;
  setCheckpointsVisible: React.Dispatch<React.SetStateAction<boolean>>;
  problemsVisible: boolean;
  setProblemsVisible: React.Dispatch<React.SetStateAction<boolean>>;
  runCenterVisible: boolean;
  setRunCenterVisible: React.Dispatch<React.SetStateAction<boolean>>;
  debugVisible: boolean;
  setDebugVisible: React.Dispatch<React.SetStateAction<boolean>>;

  // Mode and settings
  focusMode: boolean;
  setFocusMode: React.Dispatch<React.SetStateAction<boolean>>;
  settingsVisible: boolean;
  setSettingsVisible: React.Dispatch<React.SetStateAction<boolean>>;
  chatHistoryRequest: number;
  setChatHistoryRequest: React.Dispatch<React.SetStateAction<number>>;
  newConversationRequest: number;
  setNewConversationRequest: React.Dispatch<React.SetStateAction<number>>;

  // Derived layout states
  isLeftDockOpen: boolean;
  compactWorkspace: boolean;
  isMobileViewport: boolean;
  isTabletOrMobile: boolean;
  activeWorkspaceDrawer: string | null;
  workspaceDrawerOpen: boolean;
  compactModalDrawerOpen: boolean;

  // Actions & toggles
  captureDrawerTrigger: () => void;
  closeUtilityPanels: () => void;
  toggleFocusMode: () => void;
  focusChat: () => void;
  toggleChatPanel: () => void;
  handleToggleAiAssistant: () => void;
  toggleExplorerPanel: () => void;
  toggleUtilityPanel: (panel: UtilityPanelType, forceOpen?: boolean) => void;
  toggleTeamPanel: (forceOpen?: boolean) => void;
  toggleTerminalPanel: (forceOpen?: boolean) => void;
  closeWorkspaceDrawers: () => void;
  runPaletteCommand: (command: string) => void;
}

/**
 * 工作台各功能面板显示状态、响应式抽屉管理、无障碍隔离与面板切换 Hook
 */
export function useWorkspacePanels({
  viewportWidth,
  workspaceView,
  setWorkspaceView,
  mainLayoutRef,
  onFormatDocument,
}: WorkspacePanelsOptions): WorkspacePanelsReturn {
  const [sidebarVisible, setSidebarVisible] = useState(() => window.innerWidth > 1100);
  const [chatVisible, setChatVisible] = useState(() => window.innerWidth > 860);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [teamVisible, setTeamVisible] = useState(false);
  const [runDetailsVisible, setRunDetailsVisible] = useState(false);
  const [runDetailsTab, setRunDetailsTab] = useState<DetailTab>("changes");
  const [editorAssistantVisible, setEditorAssistantVisible] = useState(() => window.innerWidth > 1180);
  const [chatFocusNonce, setChatFocusNonce] = useState(0);

  const [focusMode, setFocusMode] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [chatHistoryRequest, setChatHistoryRequest] = useState(0);
  const [newConversationRequest, setNewConversationRequest] = useState(0);

  const [gitVisible, setGitVisible] = useState(false);
  const [agentsVisible, setAgentsVisible] = useState(false);
  const [checkpointsVisible, setCheckpointsVisible] = useState(false);
  const [problemsVisible, setProblemsVisible] = useState(false);
  const [runCenterVisible, setRunCenterVisible] = useState(false);
  const [debugVisible, setDebugVisible] = useState(false);

  const drawerTriggerRef = useRef<HTMLElement | null>(null);
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

  const focusChat = useCallback(() => {
    const switchingToChat = workspaceView !== "chat";
    setWorkspaceView("chat");
    setEditorAssistantVisible(false);
    setRunDetailsVisible(false);
    setChatVisible(true);
    const utilityOpen =
      gitVisible ||
      agentsVisible ||
      checkpointsVisible ||
      problemsVisible ||
      runCenterVisible ||
      debugVisible ||
      teamVisible;
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
  }, [
    agentsVisible,
    captureDrawerTrigger,
    checkpointsVisible,
    closeUtilityPanels,
    debugVisible,
    gitVisible,
    problemsVisible,
    runCenterVisible,
    teamVisible,
    workspaceView,
    setWorkspaceView,
  ]);

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
      gitVisible ||
      agentsVisible ||
      checkpointsVisible ||
      problemsVisible ||
      runCenterVisible ||
      debugVisible;
    const nextOpen = switchingToFiles || utilityOpen ? true : !sidebarVisible;
    if (nextOpen) setTeamVisible(false);
    if (nextOpen && window.innerWidth <= 1100) {
      captureDrawerTrigger();
      setTerminalVisible(false);
      if (window.innerWidth <= 860) setChatVisible(false);
    }
    closeUtilityPanels();
    setSidebarVisible(nextOpen);
  }, [
    agentsVisible,
    captureDrawerTrigger,
    checkpointsVisible,
    closeUtilityPanels,
    debugVisible,
    gitVisible,
    problemsVisible,
    runCenterVisible,
    sidebarVisible,
    workspaceView,
    setWorkspaceView,
  ]);

  const toggleUtilityPanel = useCallback(
    (panel: UtilityPanelType, forceOpen = false) => {
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
    [
      agentsVisible,
      captureDrawerTrigger,
      checkpointsVisible,
      debugVisible,
      gitVisible,
      problemsVisible,
      runCenterVisible,
    ]
  );

  const toggleTeamPanel = useCallback(
    (forceOpen = false) => {
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
    },
    [captureDrawerTrigger, closeUtilityPanels, teamVisible]
  );

  const toggleTerminalPanel = useCallback(
    (forceOpen = false) => {
      const nextOpen = forceOpen || !terminalVisible;
      if (nextOpen && window.innerWidth <= 1100) {
        captureDrawerTrigger();
        setSidebarVisible(false);
        setTeamVisible(false);
        closeUtilityPanels();
        if (window.innerWidth <= 860) setChatVisible(false);
      }
      setTerminalVisible(nextOpen);
    },
    [captureDrawerTrigger, closeUtilityPanels, terminalVisible]
  );

  const runPaletteCommand = useCallback(
    (command: string) => {
      switch (command) {
        case "format-document":
          onFormatDocument?.();
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
    [
      onFormatDocument,
      toggleChatPanel,
      toggleExplorerPanel,
      toggleFocusMode,
      toggleTeamPanel,
      toggleTerminalPanel,
      toggleUtilityPanel,
    ]
  );

  const isLeftDockOpen = Boolean(
    sidebarVisible ||
      gitVisible ||
      agentsVisible ||
      teamVisible ||
      checkpointsVisible ||
      problemsVisible ||
      runCenterVisible ||
      debugVisible
  );

  const compactWorkspace = viewportWidth <= 1100;
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
    if (viewportWidth <= 860) setChatVisible(activeWorkspaceDrawer === "chat");
  }, [activeWorkspaceDrawer, isMobileViewport, viewportWidth]);

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
        const storedTrigger =
          drawerTriggerRef.current && document.contains(drawerTriggerRef.current)
            ? drawerTriggerRef.current
            : null;
        const matchingTriggers = Array.from(
          document.querySelectorAll<HTMLElement>(`[data-drawer-trigger="${previousDrawer}"]`)
        );
        const trigger =
          storedTrigger && storedTrigger.offsetParent !== null
            ? storedTrigger
            : matchingTriggers.find((candidate) => candidate.offsetParent !== null) ||
              document.querySelector<HTMLElement>(".titlebar-mobile-command");
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
      const activeDrawer = layout.querySelector<HTMLElement>(
        `[data-workspace-drawer="${activeWorkspaceDrawer}"]`
      );
      if (!activeDrawer) return;
      const isolate = (container: HTMLElement) => {
        Array.from(container.children).forEach((child) => {
          if (!(child instanceof HTMLElement) || child.classList.contains("mobile-drawer-scrim")) return;
          if (child === activeDrawer) return;
          if (child.contains(activeDrawer)) {
            isolate(child);
            return;
          }
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
    return () => {
      observer.disconnect();
      clearBoundaries();
    };
  }, [activeWorkspaceDrawer, compactModalDrawerOpen, mainLayoutRef]);

  return {
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
    focusMode,
    setFocusMode,
    settingsVisible,
    setSettingsVisible,
    chatHistoryRequest,
    setChatHistoryRequest,
    newConversationRequest,
    setNewConversationRequest,
    isLeftDockOpen,
    compactWorkspace,
    isMobileViewport,
    isTabletOrMobile,
    activeWorkspaceDrawer,
    workspaceDrawerOpen,
    compactModalDrawerOpen,
    captureDrawerTrigger,
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
  };
}
