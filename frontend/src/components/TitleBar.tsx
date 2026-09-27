import React from "react";
import {
  Command,
  FolderOpen,
  LayoutGrid,
  LogOut,
  Maximize2,
  MessageSquare,
  Minimize2,
  Moon,
  PanelLeft,
  Settings,
  Smartphone,
  Sun,
} from "lucide-react";
import { useI18n } from "../i18n";
import { BrandMark } from "./BrandMark";
import type { AgentMode } from "../types";
import "./TitleBar.css";
import "./UserPopover.css";

export interface TitleBarProps {
  productName: string;
  workspaceDir: string;
  agentMode: AgentMode;
  workbenchTaskTitle?: string | null;
  isStreaming?: boolean;
  sidebarOffset?: number;
  platform: {
    isWeb: boolean;
    isMacOS: boolean;
    os: string;
    host: string;
  };
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onOpenCommandPalette: (target: "commands" | "files") => void;
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  workspaceView: "files" | "chat";
  editorAssistantVisible: boolean;
  chatVisible: boolean;
  onToggleAiAssistant: () => void;
  username: string;
  isAdmin?: boolean;
  teamRole?: string | null;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  density: "compact" | "normal";
  onToggleDensity: () => void;
  onOpenSettings: () => void;
  desktopApp?: boolean;
  onOpenMobilePairing?: () => void;
  onPickDesktopWorkspace?: () => void;
  onLogout?: () => void;
}

export const TitleBar: React.FC<TitleBarProps> = ({
  productName,
  workspaceDir,
  agentMode,
  workbenchTaskTitle,
  isStreaming,
  sidebarOffset,
  platform,
  isFullscreen,
  onToggleFullscreen,
  onOpenCommandPalette,
  sidebarVisible,
  onToggleSidebar,
  workspaceView,
  editorAssistantVisible,
  chatVisible,
  onToggleAiAssistant,
  username,
  isAdmin,
  teamRole,
  theme,
  onToggleTheme,
  density,
  onToggleDensity,
  onOpenSettings,
  desktopApp,
  onOpenMobilePairing,
  onPickDesktopWorkspace,
  onLogout,
}) => {
  const { t } = useI18n();

  return (
    <div className="titlebar">
      {/* 左侧：品牌与工作区完整路径（宽度随左侧侧边栏拖动联动对齐，胶囊始终位于拖动栏右侧） */}
      <div className="titlebar-left">
        <div
          className="titlebar-brand-slot"
          style={sidebarOffset && sidebarOffset > 50 ? { minWidth: `${sidebarOffset + 36}px` } : undefined}
        >
          <BrandMark
            size={26}
            title={productName}
            subtitle={workspaceDir}
            className="titlebar-brand"
          />
        </div>
        {workbenchTaskTitle && (
          <div
            className="workbench-task-pill"
            aria-live="polite"
          >
            <span className="workbench-task-mode">
              {t(`chat.mode.${agentMode}.label`)}
            </span>
            <span className="workbench-task-title" title={workbenchTaskTitle}>
              {workbenchTaskTitle}
            </span>
            {isStreaming && (
              <span className="workbench-task-streaming">
                <i />
                {t("chat.runPreparing")}
              </span>
            )}
          </div>
        )}
      </div>

      {/* 右侧：命令面板（极简化图标，悬停快捷键） + 视口切换 + 用户菜单 */}
      <div className="titlebar-right">
        <button
          type="button"
          className="titlebar-btn"
          onClick={() => onOpenCommandPalette("commands")}
          title={`${t("command.commandPalette")} (${platform.isMacOS ? "⌘⇧P" : "Ctrl+Shift+P"})`}
          aria-label={t("command.commandPalette")}
          data-drawer-trigger="command"
        >
          <Command size={17.5} strokeWidth={2.0} />
        </button>

        {platform.isWeb && (
          <button
            type="button"
            className={`titlebar-btn${isFullscreen ? " active" : ""}`}
            onClick={onToggleFullscreen}
            title={isFullscreen ? "退出全屏" : "全屏模式 (F11)"}
            aria-label={isFullscreen ? "退出全屏" : "全屏模式"}
          >
            {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        )}
        <button
          type="button"
          className={`titlebar-btn${sidebarVisible ? " active" : ""}`}
          onClick={onToggleSidebar}
          title={t("app.toggleSidebar")}
          aria-label={t("app.toggleSidebar")}
          aria-pressed={workspaceView === "files" && sidebarVisible}
          data-drawer-trigger="sidebar"
        >
          <PanelLeft size={16} />
        </button>
        <button
          type="button"
          className={`titlebar-btn${(workspaceView === "files" ? editorAssistantVisible : chatVisible) ? " active" : ""}`}
          onClick={onToggleAiAssistant}
          title={t("app.toggleAiChat")}
          aria-label={t("app.toggleAiChat")}
          aria-pressed={workspaceView === "files" ? editorAssistantVisible : chatVisible}
          data-drawer-trigger="chat"
        >
          <MessageSquare size={16} />
        </button>
        <details className="titlebar-user-menu">
          <summary className="titlebar-btn titlebar-user-btn" title={username} aria-label={username}>
            <span className="user-avatar" aria-hidden="true">
              {username.slice(0, 1).toUpperCase()}
            </span>
          </summary>
          <div className="titlebar-user-popover user-popover-shell">
            <div className="user-popover-header">
              <div className="user-popover-avatar">
                {username.slice(0, 1).toUpperCase()}
              </div>
              <div className="user-popover-info">
                <div className="user-popover-name-row">
                  <span className="user-popover-name">{username}</span>
                  <span className="user-popover-badge">{isAdmin ? "管理员" : (teamRole || "成员")}</span>
                </div>
                <span className="user-popover-sub">本地离线编码环境</span>
              </div>
            </div>
            <div className="user-popover-divider" />
            <button type="button" onClick={onToggleTheme}>
              {theme === "light" ? <Moon size={15} /> : <Sun size={15} />}
              <span>
                {t(theme === "light" ? "app.switchToDarkTheme" : "app.switchToLightTheme")}
              </span>
              <span className="user-popover-hint">{theme === "light" ? "深色" : "浅色"}</span>
            </button>
            <button type="button" onClick={onToggleDensity}>
              <LayoutGrid size={15} />
              <span>{density === "compact" ? "标准视图模式" : "紧凑密度模式"}</span>
            </button>
            <button type="button" onClick={onOpenSettings}>
              <Settings size={15} />
              <span>{t("app.settings")}</span>
              <kbd className="user-popover-kbd">Ctrl+,</kbd>
            </button>
            {!desktopApp && onOpenMobilePairing && (
              <button type="button" onClick={onOpenMobilePairing}>
                <Smartphone size={15} />
                <span>手机控制台</span>
              </button>
            )}
            <div className="user-popover-divider" />
            {desktopApp ? (
              onPickDesktopWorkspace && (
                <button type="button" onClick={() => void onPickDesktopWorkspace()}>
                  <FolderOpen size={15} />
                  <span>打开工作区…</span>
                </button>
              )
            ) : (
              onLogout && (
                <button type="button" className="user-popover-logout" onClick={onLogout}>
                  <LogOut size={15} />
                  <span>{t("app.logout")}</span>
                </button>
              )
            )}
          </div>
        </details>
      </div>
    </div>
  );
};
