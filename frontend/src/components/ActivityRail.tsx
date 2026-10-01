import React from "react";
import {
  MessageSquare,
  Files,
  Search,
  GitBranch,
  Bot,
  Users,
  ShieldCheck,
  CircleAlert,
  TestTube2,
  Bug,
  TerminalSquare,
  Smartphone,
  Minus,
  Moon,
  Plus,
  Sun,
  Settings,
  ZoomIn,
  FolderOpen,
  LogOut,
  Globe,
} from "lucide-react";
import { useI18n } from "../i18n";
import type { UtilityPanelType } from "../hooks/useWorkspacePanels";
import "./ActivityRail.css";
import "./UserPopover.css";

export interface ActivityRailProps {
  workspaceView: "chat" | "files";
  sidebarVisible: boolean;
  gitVisible: boolean;
  webPreviewVisible?: boolean;
  agentsVisible: boolean;
  teamVisible: boolean;
  checkpointsVisible: boolean;
  problemsVisible: boolean;
  runCenterVisible: boolean;
  debugVisible: boolean;
  terminalVisible: boolean;
  mobilePairingVisible: boolean;
  settingsVisible: boolean;
  compactWorkspace: boolean;

  onFocusChat: () => void;
  onToggleExplorer: () => void;
  onToggleWebPreview?: () => void;
  onOpenWorkspaceSearch: () => void;
  onToggleUtilityPanel: (panel: UtilityPanelType) => void;
  onToggleTeamPanel: () => void;
  onToggleTerminalPanel: () => void;
  onOpenMobilePairing: () => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
  zoomPercent: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  onPickDesktopWorkspace: () => void;
  onLogout: () => void;

  changedFilesCount?: number;
  onlineMembersCount?: number;
  problemCounts?: { errors: number; warnings: number };
  desktopApp: boolean;
  platform: { isMacOS?: boolean };
  theme: "light" | "dark";
  username: string;
  isAdmin: boolean;
  teamRole?: string | null;
}

export const ActivityRail: React.FC<ActivityRailProps> = ({
  workspaceView,
  sidebarVisible,
  gitVisible,
  webPreviewVisible = false,
  agentsVisible,
  teamVisible,
  checkpointsVisible,
  problemsVisible,
  runCenterVisible,
  debugVisible,
  terminalVisible,
  mobilePairingVisible,
  settingsVisible,
  compactWorkspace,

  onFocusChat,
  onToggleExplorer,
  onToggleWebPreview,
  onOpenWorkspaceSearch,
  onToggleUtilityPanel,
  onToggleTeamPanel,
  onToggleTerminalPanel,
  onOpenMobilePairing,
  onOpenSettings,
  onToggleTheme,
  zoomPercent,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onPickDesktopWorkspace,
  onLogout,

  changedFilesCount = 0,
  onlineMembersCount = 0,
  problemCounts = { errors: 0, warnings: 0 },
  desktopApp,
  platform,
  theme,
  username,
  isAdmin,
  teamRole,
}) => {
  const { t } = useI18n();
  const totalProblems = problemCounts.errors + problemCounts.warnings;
  const isCompactModalActive =
    compactWorkspace && (agentsVisible || teamVisible || gitVisible || terminalVisible);

  return (
    <nav
      className="activity-rail"
      data-compact-modal-background
      inert={isCompactModalActive ? true : undefined}
      aria-hidden={isCompactModalActive ? true : undefined}
      aria-label={t("app.workspace")}
    >
      <button
        type="button"
        className={`activity-rail-btn${workspaceView === "chat" ? " active" : ""}`}
        onClick={onFocusChat}
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
        onClick={onToggleExplorer}
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
        onClick={onOpenWorkspaceSearch}
        title={`${t("search.title")} (${platform.isMacOS ? "⇧⌘F" : "Ctrl+Shift+F"})`}
        aria-label={t("search.title")}
      >
        <Search size={18} />
      </button>

      <button
        type="button"
        className={`activity-rail-btn${gitVisible ? " active" : ""}`}
        onClick={() => onToggleUtilityPanel("git")}
        title={t("git.title")}
        aria-label={t("git.title")}
        aria-pressed={gitVisible}
        data-drawer-trigger="git"
      >
        <GitBranch size={18} />
        {changedFilesCount > 0 && (
          <span className="activity-rail-badge">{changedFilesCount}</span>
        )}
      </button>

      <button
        type="button"
        className={`activity-rail-btn${webPreviewVisible && workspaceView === "files" ? " active" : ""}`}
        onClick={onToggleWebPreview}
        title={t("preview.title")}
        aria-label={t("preview.title")}
        aria-pressed={webPreviewVisible && workspaceView === "files"}
      >
        <Globe size={18} />
      </button>

      <button
        type="button"
        className={`activity-rail-btn${agentsVisible ? " active" : ""}`}
        onClick={() => onToggleUtilityPanel("agents")}
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
        onClick={onToggleTeamPanel}
        title={t("team.title")}
        aria-label={t("team.title")}
        aria-pressed={teamVisible}
        data-drawer-trigger="team"
      >
        <Users size={18} />
        {onlineMembersCount > 0 && (
          <span className="activity-rail-badge">{onlineMembersCount}</span>
        )}
      </button>

      <button
        type="button"
        className={`activity-rail-btn${checkpointsVisible ? " active" : ""}`}
        onClick={() => onToggleUtilityPanel("checkpoints")}
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
        onClick={() => onToggleUtilityPanel("problems")}
        title={t("problems.title")}
        aria-label={t("problems.title")}
        aria-pressed={problemsVisible}
        data-drawer-trigger="problems"
      >
        <CircleAlert size={18} />
        {totalProblems > 0 && (
          <span className="activity-rail-badge">{totalProblems}</span>
        )}
      </button>

      <button
        type="button"
        className={`activity-rail-btn${runCenterVisible ? " active" : ""}`}
        onClick={() => onToggleUtilityPanel("run-center")}
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
        onClick={() => onToggleUtilityPanel("debug")}
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
        onClick={onToggleTerminalPanel}
        title={t("app.toggleTerminal")}
        aria-label={t("app.toggleTerminal")}
        aria-pressed={terminalVisible}
        data-drawer-trigger="terminal"
      >
        <TerminalSquare size={18} />
      </button>

      <span className="activity-rail-spacer" />

      {!desktopApp && (
        <button
          type="button"
          className={`activity-rail-btn${mobilePairingVisible ? " active" : ""}`}
          onClick={onOpenMobilePairing}
          title="手机控制台"
          aria-label="手机控制台"
          aria-pressed={mobilePairingVisible}
        >
          <Smartphone size={18} />
        </button>
      )}

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
        onClick={onOpenSettings}
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
                <span className="user-popover-badge">
                  {isAdmin ? "管理员" : teamRole || "成员"}
                </span>
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
          <div className="user-popover-zoom-row">
            <span className="user-popover-zoom-label">
              <ZoomIn size={15} />
              <span>缩放 ({zoomPercent}%)</span>
            </span>
            <div className="user-popover-zoom-actions">
              <button
                type="button"
                className="user-popover-zoom-btn"
                onClick={onZoomOut}
                title="缩小 (Ctrl -)"
                aria-label="缩小"
              >
                <Minus size={11} strokeWidth={2.2} />
              </button>
              {zoomPercent !== 100 && (
                <button
                  type="button"
                  className="user-popover-zoom-btn reset"
                  onClick={onResetZoom}
                  title="重置 (Ctrl 0)"
                >
                  重置
                </button>
              )}
              <button
                type="button"
                className="user-popover-zoom-btn"
                onClick={onZoomIn}
                title="放大 (Ctrl +)"
                aria-label="放大"
              >
                <Plus size={11} strokeWidth={2.2} />
              </button>
            </div>
          </div>
          <button type="button" onClick={onOpenSettings}>
            <Settings size={15} />
            <span>{t("app.settings")}</span>
            <kbd className="user-popover-kbd">Ctrl+,</kbd>
          </button>
          {!desktopApp && (
            <button type="button" onClick={onOpenMobilePairing}>
              <Smartphone size={15} />
              <span>手机控制台</span>
            </button>
          )}
          <div className="user-popover-divider" />
          {desktopApp ? (
            <button type="button" onClick={onPickDesktopWorkspace}>
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
  );
};
